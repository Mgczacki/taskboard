// HTTP and WebSocket routes for the processes (task-procs.ts) and the browser (task-browser.ts) of tasks and groups,
// and the steps that end them when a task is archived, suspended or removed, and start them again on resume.
import type express from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import * as agents from './agents.ts';
import { TB_DIR, TOKEN_FILE, URL_BASE } from './config.ts';
import * as groups from './groups.ts';
import * as store from './store.ts';
import * as procs from './task-procs.ts';
import * as browser from './task-browser.ts';

const groupEnv = (): Record<string, string> => ({ TB_URL: URL_BASE, TB_TOKEN_FILE: TOKEN_FILE, PATH: `${join(TB_DIR, 'bin')}:${process.env.PATH || '/usr/bin:/bin'}` });
export const taskOwner = (t: store.Task) => procs.taskOwner(t, agents.baseEnv(t));
export const groupOwner = (id: string) => procs.groupOwner(id, groupEnv());

// Archive ("stopped") and idle suspend ("suspended"): end the task's processes and close its browser.
export async function stopTaskRuntime(t: store.Task, state: 'stopped' | 'suspended') {
  const errors: string[] = [];
  try { await procs.stopAll(taskOwner(t), state); } catch (e) { errors.push(`processes: ${(e as Error).message}`); }
  try { await browser.stop(t.id, { suspended: state === 'suspended' }); } catch (e) { errors.push(`browser: ${(e as Error).message}`); }
  if (errors.length) console.error(`${new Date().toISOString()} #${t.num}: could not end everything: ${errors.join('; ')}`);
}
export async function removeTaskRuntime(t: store.Task) {
  await stopTaskRuntime(t, 'stopped');
  await browser.remove(t.id).catch(() => {});
}
export async function removeGroupRuntime(id: string) {
  const o = groupOwner(id);
  await procs.stopAll(o, 'stopped').catch(e => console.error('group processes', id, e));
  procs.forget(o);
}

// A task that leaves "suspended" (any resume path) starts the processes and the browser that the suspend ended.
const lastStatus = new Map<string, store.Status>();
export function watchResume() {
  for (const t of store.all()) lastStatus.set(t.id, t.status);
  store.onTaskChange(t => {
    const before = lastStatus.get(t.id); lastStatus.set(t.id, t.status);
    if (before !== 'suspended' || ['suspended', 'archived', 'parked'].includes(t.status)) return;
    void procs.resumeSuspended(taskOwner(t)).catch(e => console.error(`#${t.num}: processes did not start again`, e));
    if (browser.readMeta(t.id).suspended) void browser.ensure(t.id).catch(e => console.error(`#${t.num}: browser did not start again`, e));
  });
}

type Fail = (res: express.Response, e: unknown) => void;
// Who may change the processes or the browser of a task: the dashboard, tb from the user's own shell (token, no task),
// the controller, and the task's own agent. Another task's agent may not.
function mayChange(req: express.Request, taskIds: string[]) {
  const actor = req.get('x-tb-actor') || '';
  return !actor || actor === 'controller' || taskIds.includes(actor);
}
const dashboardOnly = (req: express.Request) => !!req.get('origin') && !req.get('x-tb-actor') && !req.get('x-taskboard-token');

export function mount(app: express.Express, fail: Fail) {
  const owner = (req: express.Request, kind: string): { o: procs.Owner; cwd?: string; ids: string[] } | null => {
    if (kind === 'tasks') {
      const t = store.get(String(req.params.id)); if (!t) return null;
      return { o: taskOwner(t), cwd: t.cwd, ids: [t.id] };
    }
    const g = groups.get(String(req.params.id)); if (!g) return null;
    const first = g.tasks.map(id => store.get(id)).find(Boolean);
    return { o: groupOwner(g.id), cwd: first?.cwd, ids: g.tasks };
  };
  for (const k of ['tasks', 'groups']) {
    app.get(`/api/${k}/:id/procs`, async (req, res) => {
      const x = owner(req, k); if (!x) return res.status(404).end();
      try { res.json(await procs.refresh(x.o)); } catch (e) { fail(res, e); }
    });
    app.post(`/api/${k}/:id/procs`, async (req, res) => {
      const x = owner(req, k); if (!x) return res.status(404).end();
      if (!mayChange(req, x.ids)) return res.status(403).json({ error: 'An agent can start processes only for its own task or its own groups.' });
      const b = req.body || {};
      const cwd = typeof b.cwd === 'string' && b.cwd ? b.cwd : x.cwd;
      if (!cwd) return fail(res, 'Give the folder to run the command in (--cwd).');
      try { res.json(await procs.start(x.o, { name: b.name, command: b.command, cwd, stop: b.stop || undefined, port: b.port === undefined || b.port === '' ? undefined : Number(b.port), startedBy: req.get('x-tb-actor') ? 'agent' : 'user', path: b.path })); } catch (e) { fail(res, e); }
    });
    app.post(`/api/${k}/:id/procs/:name/:action`, async (req, res) => {
      const x = owner(req, k); if (!x) return res.status(404).end();
      if (!mayChange(req, x.ids)) return res.status(403).json({ error: 'An agent can change processes only for its own task or its own groups.' });
      try {
        const name = procs.checkName(String(req.params.name));
        if (req.params.action === 'stop') res.json(await procs.stop(x.o, name));
        else if (req.params.action === 'remove') res.json(await procs.stop(x.o, name, true));
        else if (req.params.action === 'restart' || req.params.action === 'start') res.json(await procs.restart(x.o, name));
        else res.status(404).end();
      } catch (e) { fail(res, e); }
    });
    app.get(`/api/${k}/:id/procs/:name/log`, (req, res) => {
      const x = owner(req, k); if (!x) return res.status(404).end();
      try { res.type('text/plain').send(procs.readTail(procs.logFile(x.o, procs.checkName(String(req.params.name))), Math.min(Number(req.query.bytes) || 65536, 1 << 20))); } catch (e) { fail(res, e); }
    });
  }

  // ---------- browser ----------
  const task = (req: express.Request, res: express.Response) => { const t = store.get(String(req.params.id)); if (!t) { res.status(404).end(); return null; } return t; };
  app.get('/api/tasks/:id/browser', async (req, res) => { const t = task(req, res); if (t) res.json(await browser.status(t.id)); });
  app.get('/api/tasks/:id/browser/shot', async (req, res) => {
    const t = task(req, res); if (!t) return;
    const data = await browser.shot(t.id).catch(() => null);
    if (!data) return res.status(204).end();
    res.type('image/jpeg').setHeader('Cache-Control', 'no-store'); res.send(data);
  });
  app.post('/api/tasks/:id/browser/open', async (req, res) => {
    const t = task(req, res); if (!t) return;
    if (!mayChange(req, [t.id])) return res.status(403).json({ error: 'An agent can open pages only in its own task browser.' });
    if (t.status === 'archived') return fail(res, 'The task is archived.');
    try { res.json(await browser.openTab(t.id, String(req.body?.url || 'about:blank'))); } catch (e) { fail(res, e); }
  });
  app.post('/api/tasks/:id/browser/:action', async (req, res) => {
    const t = task(req, res); if (!t) return;
    if (!mayChange(req, [t.id])) return res.status(403).json({ error: 'An agent can change only its own task browser.' });
    try {
      if (req.params.action === 'start') { if (t.status === 'archived') throw new Error('The task is archived.'); await browser.ensure(t.id); }
      else if (req.params.action === 'stop') await browser.stop(t.id);
      else if (req.params.action === 'reset') { if (!dashboardOnly(req)) return res.status(403).json({ error: 'The browser is reset from the template on the dashboard.' }); await browser.resetFromTemplate(t.id); }
      else return res.status(404).end();
      res.json(await browser.status(t.id));
    } catch (e) { fail(res, e); }
  });
  // the template profile that new task browsers copy: only the dashboard opens and closes it
  app.get('/api/browser-template', async (_req, res) => res.json({ ...(await browser.status(browser.TEMPLATE)), check: await browser.check() }));
  app.post('/api/browser-template/:action', async (req, res) => {
    if (!dashboardOnly(req)) return res.status(403).json({ error: 'The template browser is opened on the dashboard.' });
    try {
      if (req.params.action === 'start') await browser.ensure(browser.TEMPLATE);
      else if (req.params.action === 'stop') await browser.stop(browser.TEMPLATE);
      else return res.status(404).end();
      res.json(await browser.status(browser.TEMPLATE));
    } catch (e) { fail(res, e); }
  });
}

// ---------- WebSockets ----------
// /ws/cdp/<task id>?key=…: the agents' DevTools connection. Checked before the dashboard's origin check, because the
// MCP server sends no origin and no Taskboard token, only the key of its task.
const cdpWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
export function upgradeCdp(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
  const m = url.pathname.match(/^\/ws\/cdp\/([^/]+)$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const t = store.get(id);
  if (!t || url.searchParams.get('key') !== browser.cdpKey(id) || t.status === 'archived') { socket.destroy(); return true; }
  cdpWss.handleUpgrade(req, socket, head, ws => browser.proxyAgent(ws, id));
  return true;
}
// /ws/browser?id=<task id or "template">&start=1: the dashboard's view of a browser (after the origin check)
export function viewBrowser(ws: import('ws').WebSocket, url: URL) {
  const id = url.searchParams.get('id') || '';
  const t = store.get(id);
  if (id !== browser.TEMPLATE && !t) return ws.close(4004, 'no such task');
  browser.attachViewer(ws, id, url.searchParams.get('start') === '1' && t?.status !== 'archived');
}
