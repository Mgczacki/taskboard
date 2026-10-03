// HTTP and WebSocket routes for the processes (task-procs.ts) and the browser (task-browser.ts) of each task,
// and the steps that end them when a task is archived, suspended or removed, and start them again on resume.
// A group owns no processes and no browser. Deleting a group, or taking a task out of it, stops nothing.
import type express from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import * as agents from './agents.ts';
import * as store from './store.ts';
import * as procs from './task-procs.ts';
import * as browser from './task-browser.ts';
import * as messageQueue from './message-queue.ts';
import * as signins from './browser-signins.ts';
import * as memory from './memory.ts';
import * as summary from './runtime-summary.ts';
import * as machines from './machines.ts';
import * as transfer from './transfer.ts';

export const taskOwner = (t: store.Task) => procs.taskOwner(t, agents.baseEnv(t));

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

// The running browser and process counts of every task, sent to the dashboard as a "runtime" event when they change.
// Changes come from the process and browser modules. A timer also reads tmux every 10 s for tasks with running
// processes, so a process that exits by itself, or a Chrome that crashes, leaves the count without a page open.
let lastCounts = '';
export const runtimeCounts = () => summary.counts(taskOwner);
export function watchCounts(send: (counts: Record<string, summary.Count>) => void) {
  let timer: NodeJS.Timeout | null = null;
  const check = () => {
    timer = null;
    const c = runtimeCounts(), json = JSON.stringify(c);
    if (json !== lastCounts) { lastCounts = json; send(c); }
  };
  const soon = () => { if (!timer) timer = setTimeout(check, 300); };
  procs.onChange(soon);
  browser.onChange(soon);
  store.onTaskChange(soon);
  store.onTaskRemoved(soon);
  setInterval(() => {
    for (const t of store.all()) {
      if (!summary.local(t)) continue;
      const o = taskOwner(t);
      if (procs.load(o).some(p => p.state === 'running' || p.state === 'starting')) void procs.refresh(o).catch(() => {});
    }
    soon();
  }, 10000).unref();
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

// A task browser without an agent command or a dashboard viewer for the time set on the Settings page stops. Its
// pages are saved. The next tool call of the agent, or a start on the dashboard, starts it again with those pages.
// A start that failed and a Chrome that ended by itself also go into the task log, with the useful lines of chrome.log.
export const watchBrowserIdle = () => {
  browser.watchIdle();
  browser.onProblem((id, message, lines) => {
    if (!store.get(id)) return; // the template browser has no task
    try { store.appendLog(id, { did: `Task browser: ${message}${lines.length ? ` Chrome log: ${lines.slice(-3).join(' | ')}` : ''}`, next: 'The browser starts again at the next tool call, or with Start the browser (Retry) in the Browser tab.' }); } catch { /* the task folder is gone */ }
  });
  // the agent's request for help in its browser: the task list shows it, and Done types the user's note to the agent
  browser.onAsk(id => { if (store.get(id)) store.touch(id); });
  browser.onAskDone((id, ask, note) => {
    const t = store.get(id); if (!t) return;
    const text = `The user finished in the browser what you asked for ("${ask.reason}").${note ? ` Their note: ${note}` : ''} Look at the page again before you go on.`;
    void messageQueue.send(t, text, { from: 'you', kind: 'message' }).catch(e => console.error(`task ${id}: the browser answer was not delivered: ${(e as Error).message}`));
  });
};
// the agent's open request for help in the browser of a task (for the task list), or undefined
export const browserAsk = (id: string) => browser.askOf(id)?.reason;

type Fail = (res: express.Response, e: unknown) => void;
// Who may change the processes or the browser of a task: the dashboard, tb from the user's own shell (token, no task),
// the controller, and the task's own agent. Another task's agent may not.
function mayChange(req: express.Request, taskIds: string[]) {
  const actor = req.get('x-tb-actor') || '';
  return !actor || actor === 'controller' || taskIds.includes(actor);
}
const dashboardOnly = (req: express.Request) => !!req.get('origin') && !req.get('x-tb-actor') && !req.get('x-taskboard-token');
// The dashboard of a paired machine that shows a task of this machine (index.ts signs such a request like a transfer,
// transfer.ts peer). Only the routes of one task browser accept it: sound, reset and the sign-ins of that browser.
const peerDashboard = (req: express.Request) => { if (!req.get('x-taskboard-peer-signature')) return false; try { transfer.peer(req); return true; } catch { return false; } };
const dashboardOrPeer = (req: express.Request) => dashboardOnly(req) || peerDashboard(req);

export function mount(app: express.Express, fail: Fail) {
  // The browsers and processes of the given tasks, with memory, for a view that is open on the dashboard.
  // A group view sends the ids of its tasks: each item names the task that owns it.
  app.get('/api/runtime', async (req, res) => {
    const ids = String(req.query.tasks || '').split(',').filter(Boolean).slice(0, 200);
    try { const list = await summary.items(ids, taskOwner); res.json({ items: list, total: summary.total(list) }); } catch (e) { fail(res, e); }
  });
  app.get('/api/runtime/counts', (_req, res) => res.json(runtimeCounts()));

  const owner = (req: express.Request): { o: procs.Owner; cwd?: string; ids: string[] } | null => {
    const t = store.get(String(req.params.id)); if (!t) return null;
    return { o: taskOwner(t), cwd: t.cwd, ids: [t.id] };
  };
  app.get('/api/tasks/:id/procs', async (req, res) => {
    const x = owner(req); if (!x) return res.status(404).end();
    try {
      const list = await procs.refresh(x.o);
      const on = (p: procs.Proc) => p.state === 'running' || p.state === 'starting';
      const mem = await memory.byGroup(list.filter(on).map(p => p.pid || 0).filter(Boolean));
      res.json(list.map(p => ({ ...p, memMb: on(p) ? summary.memMb(mem, p.pid) : null })));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/tasks/:id/procs', async (req, res) => {
    const x = owner(req); if (!x) return res.status(404).end();
    if (!mayChange(req, x.ids)) return res.status(403).json({ error: 'An agent can start processes only for its own task.' });
    const b = req.body || {};
    const cwd = typeof b.cwd === 'string' && b.cwd ? b.cwd : x.cwd;
    if (!cwd) return fail(res, 'Give the folder to run the command in (--cwd).');
    try { res.json(await procs.start(x.o, { name: b.name, command: b.command, cwd, stop: b.stop || undefined, port: b.port === undefined || b.port === '' ? undefined : Number(b.port), startedBy: req.get('x-tb-actor') ? 'agent' : 'user', path: b.path })); } catch (e) { fail(res, e); }
  });
  app.post('/api/tasks/:id/procs/:name/:action', async (req, res) => {
    const x = owner(req); if (!x) return res.status(404).end();
    if (!mayChange(req, x.ids)) return res.status(403).json({ error: 'An agent can change processes only for its own task.' });
    try {
      const name = procs.checkName(String(req.params.name));
      if (req.params.action === 'stop') res.json(await procs.stop(x.o, name));
      else if (req.params.action === 'remove') res.json(await procs.stop(x.o, name, true));
      else if (req.params.action === 'restart' || req.params.action === 'start') res.json(await procs.restart(x.o, name));
      else res.status(404).end();
    } catch (e) { fail(res, e); }
  });
  app.get('/api/tasks/:id/procs/:name/log', (req, res) => {
    const x = owner(req); if (!x) return res.status(404).end();
    try { res.type('text/plain').send(procs.readTail(procs.logFile(x.o, procs.checkName(String(req.params.name))), Math.min(Number(req.query.bytes) || 65536, 1 << 20))); } catch (e) { fail(res, e); }
  });

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
  // sound on or off for one browser (task or template): only the dashboard changes it
  const sound = async (req: express.Request, res: express.Response, id: string) => {
    if (!(id === browser.TEMPLATE ? dashboardOnly(req) : dashboardOrPeer(req))) return res.status(403).json({ error: 'The sound of a browser is changed on the dashboard.' });
    try { const r = await browser.setSound(id, req.body?.on === true); res.json({ ...(await browser.status(id)), restarted: r.restarted }); }
    catch (e) { fail(res, e); }
  };
  app.post('/api/tasks/:id/browser/sound', async (req, res) => { const t = task(req, res); if (t) await sound(req, res, t.id); });
  // The agent asks the user for help in its browser (tb browser ask "<reason>"), or takes the request back (reason
  // empty). An agent can ask only in its own task's browser.
  app.post('/api/tasks/:id/browser/ask', (req, res) => {
    const t = task(req, res); if (!t) return;
    if (!mayChange(req, [t.id])) return res.status(403).json({ error: 'An agent can ask for help only in its own task browser.' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    res.json({ ask: browser.setAsk(t.id, reason || null) });
  });
  // A file for the browser view: an image of a paste, a file for a page's file chooser, or a file dropped on the view
  // (task-browser.ts addUpload). Only the dashboard posts files. The body is { name, type, data } with data in base64.
  app.post('/api/tasks/:id/browser/upload', (req, res) => {
    const id = String(req.params.id);
    if (!(id === browser.TEMPLATE ? dashboardOnly(req) : dashboardOrPeer(req))) return res.status(403).json({ error: 'Only the dashboard sends files to a browser view.' });
    if (id !== browser.TEMPLATE && !store.get(id)) return res.status(404).json({ error: 'No such task.' });
    const data = typeof req.body?.data === 'string' ? Buffer.from(req.body.data, 'base64') : null;
    if (!data?.length) return fail(res, 'The file is empty.');
    try { res.json({ id: browser.addUpload(id, String(req.body?.name || 'file'), String(req.body?.type || ''), data) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/browser-template/sound', (req, res) => sound(req, res, browser.TEMPLATE));
  // ---------- shared sign-ins (browser-signins.ts) ----------
  // Only the dashboard calls these. They return site names, counts and dates, never a cookie value. The lists use POST
  // because a browser sends no Origin header with a same-origin GET.
  const signinRoute = (path: string, fn: (req: express.Request) => Promise<unknown>) => app.post(path, async (req, res) => {
    if (!(path.startsWith('/api/tasks/') ? dashboardOrPeer(req) : dashboardOnly(req))) return res.status(403).json({ error: 'Shared sign-ins are changed only on the dashboard.' });
    try { res.json(await fn(req)); } catch (e) { fail(res, e); }
  });
  const taskId = (req: express.Request) => { const t = store.get(String(req.params.id)); if (!t) throw new Error('No such task.'); return t.id; };
  signinRoute('/api/tasks/:id/browser/signins/sites', async req => ({ sites: await signins.sites(taskId(req)) }));
  signinRoute('/api/tasks/:id/browser/signins/save-template', async req => signins.saveAsTemplate(taskId(req)));
  signinRoute('/api/tasks/:id/browser/signins/sync', async req => signins.syncFromTemplate(taskId(req), Array.isArray(req.body?.sites) ? req.body.sites.map(String) : []));
  signinRoute('/api/tasks/:id/browser/signins/shared', async req => { const id = taskId(req); signins.setShared(id, req.body?.on === true); return browser.status(id); });
  signinRoute('/api/browser-signins/overview', async () => {
    const o = await signins.overview();
    return { ...o, browsers: o.browsers.map(b => { const t = store.get(b.id); return { ...b, num: t?.num, title: t?.title, status: t?.status }; }) };
  });
  signinRoute('/api/browser-signins/remove', async req => { await signins.removeSite(String(req.body?.site || '')); return signins.overview(); });
  signinRoute('/api/browser-signins/sign-out-all', async () => signins.signOutAll());
  signinRoute('/api/browser-signins/live', async req => signins.setLive({ live: typeof req.body?.live === 'boolean' ? req.body.live : undefined, liveSites: Array.isArray(req.body?.liveSites) ? req.body.liveSites : undefined }));
  // Send the template's sign-ins of the chosen sites to a paired machine (the request is signed like a transfer). The
  // other machine writes them into its template (POST /api/browser-signins/import below).
  signinRoute('/api/browser-signins/send', async req => {
    const m = machines.get(String(req.body?.machine || ''));
    if (!m) throw new Error('Choose a linked machine.');
    const url = new URL(m.url);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${m.name} has no HTTPS address. Sign-ins go only over HTTPS or to a machine on this computer.`);
    const cookies = await signins.exportSites(Array.isArray(req.body?.sites) ? req.body.sites.map(String) : []);
    const path = '/api/browser-signins/import';
    const r = transfer.signedRequest(path, { cookies });
    const res = await machines.call(m, 'POST', path, r.payload, r.headers, 60000);
    if (res.status >= 400) throw new Error(`${m.name}: ${typeof res.data === 'object' ? res.data.error : String(res.data)}`);
    return { machine: m.name, sites: res.data.sites as string[], cookies: res.data.cookies as number };
  });
  // Sign-ins from a paired machine (signed, transfer.ts peer) go into this machine's template.
  app.post('/api/browser-signins/import', async (req, res) => {
    try { transfer.peer(req); } catch (e) { return res.status(403).json({ error: (e as Error).message }); }
    try { res.json(await signins.importCookies(req.body?.cookies)); } catch (e) { fail(res, e); }
  });
  signinRoute('/api/browser-template/window', async () => { await browser.openTemplateWindow(); return browser.status(browser.TEMPLATE); });
  app.post('/api/tasks/:id/browser/:action', async (req, res) => {
    const t = task(req, res); if (!t) return;
    if (!mayChange(req, [t.id])) return res.status(403).json({ error: 'An agent can change only its own task browser.' });
    try {
      if (req.params.action === 'start') { if (t.status === 'archived') throw new Error('The task is archived.'); await browser.ensure(t.id); }
      else if (req.params.action === 'stop') await browser.stop(t.id);
      else if (req.params.action === 'reset') { if (!dashboardOrPeer(req)) return res.status(403).json({ error: 'The browser is reset from the template on the dashboard.' }); await browser.resetFromTemplate(t.id); }
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
