import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// Taskboard server: tasks API, hook endpoints, live terminals and a change stream for the UI.
// Listens on 127.0.0.1 only. Browser requests must come from the Taskboard UI's own origin;
// hook scripts authenticate with the token in ~/.taskboard/token.
import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import * as agents from './agents.ts';
import { HOME, HOST, PORT, ROOT, TB_DIR, TOKEN, URL_BASE } from './config.ts';
import * as docs from './docs.ts';
import * as events from './events.ts';
import * as groups from './groups.ts';
import * as importer from './importer.ts';
import * as approvals from './approvals.ts';
import * as ask from './ask.ts';
import * as accounts from './accounts.ts';
import * as external from './external.ts';
import * as machines from './machines.ts';
import * as machine from './machine.ts';
import * as trust from './trust.ts';
import * as agyReview from './agy-review.ts';
import { acquire } from './lock.ts';
import { ROLE, installRuntimeFiles, refuseReason } from './instance.ts';
import { hostname } from 'node:os';
import WebSocket from 'ws';
import { messageLevelsChanged, mountMail } from './mail/routes.ts';
import { mountReview, pendingFor, pendingForPath } from './review.ts';
import { attach } from './pty.ts';
import * as store from './store.ts';
import * as stats from './stats.ts';
import * as tmux from './tmux.ts';

const execFileP = promisify(execFile);
// a development checkout never runs as the real Taskboard, and a sandbox never uses the real one's port, folders or tmux
const refused = refuseReason();
if (refused) { console.error(refused); process.exit(1); }
// Bind the port before doing anything else. The kernel lets only one process hold it and frees it when that process
// dies, so a second server stops here, before it has touched a task file, tmux or the controller.
const app = express();
const server = createServer(app);
await new Promise<void>(resolve => {
  server.once('error', e => { console.error(`${new Date().toISOString()} cannot listen on ${URL_BASE}: ${e.message}. Another Taskboard server is probably running; not starting a second one.`); process.exit(1); });
  server.listen(PORT, HOST, () => resolve());
});
// the lock file only records which process serves this TB_DIR (and refuses a second server on another port)
const other = acquire();
if (other) { console.error(`Taskboard is already running here: process ${other.pid}, ${other.url} (started ${other.started}). Not starting a second server.`); process.exit(1); }
store.loadAll();
groups.load();
// "open in another terminal" used to be a status; it is now only the openElsewhere field, and the status is read from the transcript
for (const t of store.all()) if (t.openElsewhere && (t.status as string) === 'elsewhere' || t.openElsewhere && t.status === 'suspended')
  store.update(t.id, { status: 'idle', transcript: t.transcript || importer.transcriptFor(t.agent, t.sessionId || '') });
installRuntimeFiles();
agents.writeClaudeSettings();
agents.installAgyPlugin();
await agents.configureIfRunning();

app.use(express.json({ limit: '2mb' }));

const ALLOWED_ORIGINS = new Set([URL_BASE, `http://localhost:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
const originOk = (o?: string) => !o || ALLOWED_ORIGINS.has(o);
const tokenOk = (req: express.Request) => req.get('x-taskboard-token') === TOKEN;

// ---------- hooks (from agents) ----------
app.post('/api/hooks/claude', (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  res.json(events.claudeEvent(req.body.taskId, req.body.input || {}));
});
// Usage windows from the Claude Code status line of a Taskboard session; stored on that task's account.
app.post('/api/hooks/usage', (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  const t = store.get(String(req.body.taskId || '')); const rl = req.body.rate_limits || {};
  if (t && t.agent === 'claude' && !events.movingTasks.has(t.id)) {
    const w = (label: string, x: any) => x && typeof x.used_percentage === 'number' ? [{ label, usedPct: Math.round(x.used_percentage), resetsAt: x.resets_at ? x.resets_at * 1000 : undefined }] : [];
    const windows = [...w('5-hour', rl.five_hour), ...w('weekly', rl.seven_day)];
    if (windows.length) accounts.setUsage(t.account || accounts.defaultFor(t.agent).id, { windows, at: new Date().toISOString(), source: 'Claude Code status line' });
  }
  res.json({});
});
app.post('/api/hooks/antigravity', async (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  const taskId = String(req.body.taskId || '');
  const event = String(req.body.event || '');
  const input = req.body.input || {};
  const result = events.antigravityEvent(taskId, event, input);
  if (event === 'PreToolUse' && machine.get().permissions.autoReview) {
    const t = store.get(taskId);
    if (t?.agent === 'antigravity') return res.json({ output: await agyReview.review(t, input) });
  }
  res.json(result);
});
// Quota from the Antigravity status line of a Taskboard session: one bucket per model family ("gemini-weekly",
// "3p-weekly"), each with remaining_fraction (1 = unused) and reset_time. Stored on that task's account.
app.post('/api/hooks/agy-usage', (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  const t = store.get(String(req.body.taskId || '')); const q = req.body.quota || {};
  if (t && t.agent === 'antigravity' && !events.movingTasks.has(t.id)) {
    const windows = Object.entries(q).filter(([, w]: [string, any]) => typeof w?.remaining_fraction === 'number')
      .map(([k, w]: [string, any]) => ({ label: k.replace(/-/g, ' '), usedPct: Math.round((1 - w.remaining_fraction) * 100), resetsAt: Date.parse(w.reset_time) || undefined }));
    if (windows.length) accounts.setUsage(t.account || accounts.defaultFor(t.agent).id, { windows, at: new Date().toISOString(), source: 'Antigravity status line', plan: req.body.plan || undefined });
  }
  res.json({});
});
app.post('/api/hooks/codex', (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  events.codexEvent(req.body.taskId, req.body.payload || {}); res.json({});
});
app.post('/api/hooks/bell', (req, res) => {
  if (!tokenOk(req)) return res.status(401).end();
  events.bell(String(req.query.session || '')); res.json({});
});

// ---------- UI API ----------
// Browser requests must come from Taskboard's own page. Anything else that changes state (tb, scripts) must send the token.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (origin ? !originOk(origin) : !tokenOk(req)) return res.status(403).json({ error: origin ? 'origin not allowed' : 'token required (see ~/.taskboard/token)' });
  next();
});

// Actions the controller agent takes on other agents wait for your approval on the dashboard.
// tb sends x-tb-actor with the calling task's id; the controller's requests get a 202 and an approval id to wait on.
async function guarded(req: express.Request, res: express.Response, summary: string, detail: string, action: approvals.Approval['action'], run: () => Promise<unknown>, describe: (r: any) => string) {
  // the dashboard (a browser origin) acts directly; any agent — the controller or another task, identified by `tb`'s
  // x-tb-actor — waits for your approval. (Agents run as you and can read the token, so this guards against mistakes,
  // not against an agent that deliberately calls the API without `tb`.)
  const actor = req.get('x-tb-actor') || '';
  // Settings page: the controller and other agents can each be allowed to act without an approval card
  const p = machine.get().permissions;
  const needs = actor === 'controller' ? p.controllerNeedsApproval : p.agentsNeedApproval;
  if (req.get('origin') || !actor || !needs) { try { res.json(await run()); } catch (e) { fail(res, e); } return; }
  const a = approvals.request({ actor, action, summary, detail, payload: req.body }, async () => describe(await run()));
  if (store.get(actor)) store.update(actor, { status: 'needs-you', ask: `Approve: ${summary}`, statusSource: 'Waiting for your approval on the dashboard.' });
  res.status(202).json({ approval: a });
}
app.get('/api/approvals', (_req, res) => res.json(approvals.all()));
app.get('/api/stats', (req, res) => {
  try { res.json(stats.get(String(req.query.timeZone || 'UTC'))); } catch { res.status(400).json({ error: 'Invalid time zone.' }); }
});
app.get('/api/approvals/:id', (req, res) => { const a = approvals.get(req.params.id); a ? res.json(a) : res.status(404).end(); });
app.post('/api/approvals/:id/:decision', async (req, res, next) => {
  // any other word (return) is a different route; it must never count as Deny
  if (!['approve', 'deny'].includes(req.params.decision)) return next();
  // only you, from the dashboard, can decide
  if (!req.get('origin')) return res.status(403).json({ error: 'approvals are decided on the dashboard' });
  const a = await approvals.decide(req.params.id, req.params.decision === 'approve'); a ? res.json(a) : res.status(404).end();
});
// Send a message card back with a comment: to the controller (incoming) or to the agent that wrote the draft (outgoing).
app.post('/api/approvals/:id/return', async (req, res) => {
  if (!req.get('origin')) return res.status(403).json({ error: 'approvals are decided on the dashboard' });
  try { const a = await approvals.giveBack(req.params.id, String(req.body.comment || '')); a ? res.json(a) : res.status(404).end(); } catch (e) { fail(res, e); }
});
// A release always needs a dashboard decision, even when other task actions run without approval.
app.post('/api/release/request', (req, res) => {
  const actor = req.get('x-tb-actor') || '';
  const task = store.get(actor);
  if (!/^[a-zA-Z0-9_-]+$/.test(actor) || !task || task.role === 'controller')
    return res.status(403).json({ error: 'A Taskboard task must request the release.' });
  const approval = approvals.request({ actor, action: 'release', summary: 'release Taskboard',
    detail: `Task: #${task.num} ${task.title}\nCommand: pnpm release`, payload: {} }, async () => {
    const dir = join(TB_DIR, 'release-permits');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, actor + '.json'), JSON.stringify({ taskId: actor, expiresAt: Date.now() + 120_000 }), { mode: 0o600 });
    return `Task #${task.num} may run pnpm release once within two minutes.`;
  });
  store.update(actor, { status: 'needs-you', ask: 'Approve: release Taskboard', statusSource: 'Waiting for your approval on the dashboard.' });
  res.status(202).json({ approval });
});

// ---------- other machines ----------
// Requests for a task id like "studio~fix-12" go to that machine's Taskboard server with its token.
// The controller's actions on other machines still wait for your approval here.
const GUARDED = /^\/api\/tasks(\/[^/]+\/(send|status|kill))?$/;
app.use('/api', async (req, res, next) => {
  let target: { machine: string; path: string } | null = null;
  const m = req.path.match(/^\/tasks\/([^/]+)(\/.*)?$/);
  if (m) { const s = machines.split(decodeURIComponent(m[1])); if (s) target = { machine: s.machine, path: `/api/tasks/${encodeURIComponent(s.id)}${m[2] || ''}` }; }
  if (!target && req.path === '/tasks' && req.method === 'POST' && req.body?.machine && req.body.machine !== 'local') target = { machine: req.body.machine, path: '/api/tasks' };
  if (!target && req.query.machine && req.query.machine !== 'local' && ['/folders', '/file', '/browse'].includes(req.path)) target = { machine: String(req.query.machine), path: '/api' + req.path };
  if (!target) return next();
  const mc = machines.get(target.machine); if (!mc) return res.status(404).json({ error: `Unknown machine ${target.machine}` });
  const qs = new URLSearchParams(req.query as Record<string, string>); qs.delete('machine');
  const path = target.path + (qs.toString() ? '?' + qs : '');
  const body = req.method === 'GET' ? undefined : { ...req.body, machine: undefined };
  const forward = async () => { const r = await machines.call(mc, req.method, path, body); if (r.status >= 400) throw new Error(typeof r.data === 'object' ? r.data.error : String(r.data)); return r; };
  try {
    if (req.method !== 'GET' && req.get('x-tb-actor') === 'controller' && GUARDED.test(target.path.replace(/\/api\/tasks\/[^/]+/, '/api/tasks/x'))) {
      const summary = `${target.path.endsWith('/send') ? 'type into' : target.path === '/api/tasks' ? `start “${req.body.title}” on` : 'change a task on'} ${mc.name}`;
      const a = approvals.request({ actor: 'controller', action: target.path === '/api/tasks' ? 'new' : 'send', summary, detail: JSON.stringify(body, null, 2), payload: body }, async () => { await forward(); return `Done on ${mc.name}.`; });
      store.update('controller', { status: 'needs-you', ask: `Approve: ${summary}`, statusSource: 'Waiting for your approval on the dashboard.' });
      return res.status(202).json({ approval: a });
    }
    const r = await machines.call(mc, req.method, path, body);
    if (r.type.includes('json')) {
      const tagIds = (x: any) => x && typeof x === 'object' && typeof x.id === 'string' && x.session ? { ...x, id: mc.id + machines.SEP + x.id, machine: { id: mc.id, name: mc.name } } : x;
      res.status(r.status).json(tagIds(r.data));
    } else res.status(r.status).type(r.type).send(r.data);
  } catch (e) { res.status(502).json({ error: `${mc.name}: ${e instanceof Error ? e.message : String(e)}` }); }
});
// This machine: its name, the server, and the controller (tb info, the dashboard, other machines).
const info = () => {
  const c = store.get('controller');
  return { role: ROLE, root: ROOT, machine: machine.get().name, host: hostname(), url: URL_BASE, pid: process.pid, settings: machine.get(),
    controller: c ? { agent: c.agent, account: c.account, status: c.status, remoteUrl: c.agent === 'claude' && machine.get().controller.remoteControl ? c.remoteUrl : undefined, label: machine.controllerLabel() } : null,
    tasks: store.all().filter(t => t.role !== 'controller' && t.status !== 'archived').length };
};
app.get('/api/info', (_req, res) => res.json(info()));
// Changes to the controller name, model, or Remote Control setting apply at its next restart between turns.
app.patch('/api/info', async (req, res) => {
  if (!req.get('origin') || req.get('x-tb-actor')) return res.status(403).json({ error: 'Machine settings are changed on the dashboard.' });
  try {
    const { name, routingRules, autostart, remoteControl, controllerModels, controllerNeedsApproval, agentsNeedApproval, trustWorkspaces, autoReview, askAgent, askAccount, askModel, reviewAccount, reviewModel, messageIncoming, messageOutgoing, confirmLowerControl } = req.body;
    // A higher message level gives the user less control. The page asks first and then sends confirmLowerControl.
    const current = machine.get().messages;
    if (confirmLowerControl !== true && ((messageIncoming ?? 0) > current.incoming || (messageOutgoing ?? 0) > current.outgoing))
      return res.status(400).json({ error: 'Confirm on the Settings page before you give the controller more control over messages.' });
    if (askAgent && !['claude', 'codex'].includes(askAgent)) return res.status(400).json({ error: 'Antigravity does not have verified read-only Ask controls.' });
    const agent = askAgent || machine.get().ask.agent;
    if (askAccount && accounts.get(askAccount)?.agent !== agent) return res.status(400).json({ error: `Pick a ${agent} account for questions.` });
    if (askModel && (typeof askModel !== 'string' || !(agent === 'claude' ? ['sonnet', 'haiku', 'opus'].includes(askModel) : /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(askModel))))
      return res.status(400).json({ error: 'Pick a valid model for questions.' });
    if (reviewAccount && accounts.get(reviewAccount)?.agent !== 'claude') return res.status(400).json({ error: 'Pick a Claude Code account for auto review.' });
    machine.update({ name, routingRules, autostart, remoteControl, controllerModels, controllerNeedsApproval, agentsNeedApproval, trustWorkspaces, autoReview, askAgent, askAccount, askModel, reviewAccount, reviewModel, messageIncoming, messageOutgoing });
    if (messageIncoming !== undefined || messageOutgoing !== undefined) messageLevelsChanged();
    if (trustWorkspaces === false) trust.restore();
    res.json(info());
  } catch (e) { fail(res, e); }
});
app.get('/api/machines', (_req, res) => res.json([{ id: 'local', name: machine.get().name, url: URL_BASE, local: true, online: true }, ...machines.all().map(m => ({ id: m.id, name: m.name, url: m.url, online: !!machines.stateOf(m.id)?.online, latency: machines.stateOf(m.id)?.latency, lastSeen: machines.stateOf(m.id)?.lastSeen, error: machines.stateOf(m.id)?.error, tasks: machines.stateOf(m.id)?.tasks.length || 0 }))]));
app.post('/api/machines', async (req, res) => {
  const { name, url, token } = req.body; if (!name || !url || !token) return fail(res, 'name, url and token are required');
  try { const r = await machines.call({ id: 'x', name, url: String(url).replace(/\/+$/, ''), token }, 'GET', '/api/machines'); if (r.status !== 200) throw new Error(`the server answered ${r.status}`); }
  catch (e) { return fail(res, `Could not reach ${url}: ${e instanceof Error ? e.message : e}`); }
  const m = machines.add(name, url, token); res.json({ id: m.id, name: m.name, url: m.url });
});
app.delete('/api/machines/:id', (req, res) => { machines.remove(req.params.id); res.json({}); });

const view = (t: store.Task) => ({ ...t, docs: docs.counts(t.id), waitMin: Math.round((Date.now() - Date.parse(t.statusAt)) / 60000), attach: `tmux -L taskboard attach -t ${t.session}`, ...(t.agent === 'antigravity' ? { tokenEstimate: stats.taskEstimate(t) } : {}) });
const fail = (res: express.Response, e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) });

app.get('/api/tasks', (_req, res) => res.json([...store.all().map(view), ...machines.remoteTasks()]));
app.get('/api/tasks/:id/token-estimate', (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found.' });
  res.json({ tokens: stats.taskEstimate(t) });
});
app.post('/api/controller/start', async (_req, res) => { try { res.json(view(await agents.startController())); } catch (e) { fail(res, e); } });
// Which account the controller runs on: chosen by you on the dashboard only (not by the controller or tb).
app.post('/api/controller/account', async (req, res) => {
  if (!req.get('origin')) return res.status(403).json({ error: 'The controller account is chosen on the dashboard.' });
  try { res.json(view(await agents.setControllerAccount(String(req.body.account || '')))); } catch (e) { fail(res, e); }
});
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, desc, agent, folder, worktree, branch, parent, account, model } = req.body;
    if (!title || !folder || !['claude', 'codex', 'antigravity'].includes(agent)) throw new Error('title, folder and agent are required');
    await guarded(req, res, `start “${title}” (${agents.agentName(agent)})`, `Folder: ${folder}${worktree ? ` · new worktree ${branch || ''}` : ''}\nAccount: ${account && account !== 'auto' ? account : 'automatic'}\nModel: ${model || 'agent default'}\nPrompt: ${desc || title}`, 'new',
      async () => {
        const t = await agents.startTask({ title, desc: desc || title, agent, folder, worktree, branch, parent, account, model });
        if (req.body.group) { const g = groups.all().find(x => x.name === req.body.group || x.id === req.body.group) || groups.create(String(req.body.group)); groups.update(g.id, { tasks: [...g.tasks, t.id] }); }
        return view(t);
      }, (t: any) => `Started #${t.num} ${t.title} in ${t.cwd}${req.body.group ? ` (group ${req.body.group})` : ''}`);
  } catch (e) { fail(res, e); }
});
app.post('/api/tasks/:id/status', async (req, res) => {
  const s = req.body.status;
  if (!['idle', 'parked', 'archived'].includes(s)) return fail(res, 'status must be idle, parked or archived');
  const t0 = store.get(req.params.id); if (!t0) return res.status(404).end();
  await guarded(req, res, `${s === 'archived' ? 'archive' : s === 'parked' ? 'park' : 'unpark'} #${t0.num} ${t0.title}`, '', 'status',
    async () => view(store.update(t0.id, { status: s, statusSource: `Set at ${new Date().toTimeString().slice(0, 5)}.` })!), () => `#${t0.num} is now ${s}.`);
});
app.post('/api/tasks/:id/seen', (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  store.update(t.id, { seenAt: new Date().toISOString(), ...(t.status === 'unread' ? { status: 'idle' as const } : {}) });
  res.json({});
});
app.post('/api/tasks/:id/resume', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  try { res.json(view(await agents.resumeTask(t, !!req.body.force))); } catch (e) { fail(res, e); }
});
// Move a session from another terminal to here. Stopping that process cuts off a turn in progress, so
// when: 'after-turn' only records the wish; watchElsewhere() does the move once the transcript shows the turn ended.
app.post('/api/tasks/:id/takeover', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  try {
    if (req.body.when === 'cancel') return res.json(view(store.update(t.id, { moveWhenDone: undefined })!));
    if (req.body.when === 'after-turn' && t.openElsewhere && !['idle', 'unread'].includes(t.status))
      return res.json(view(store.update(t.id, { moveWhenDone: true })!));
    res.json(view(await agents.takeOver(t)));
  } catch (e) { fail(res, e); }
});
// Restart the agent (same conversation). when: 'after-turn' waits until its current turn has ended; 'cancel' undoes that.
app.post('/api/tasks/:id/restart', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  if (t.openElsewhere) return fail(res, 'This session runs in another terminal; use “Move it here” instead.');
  if (req.body.when === 'cancel') return res.json(view(store.update(t.id, { restartWhenDone: undefined })!));
  if (req.body.when === 'after-turn' && !['suspended', 'stopped'].includes(t.status) && !betweenTurns(t)) return res.json(view(store.update(t.id, { restartWhenDone: true })!));
  try { await restartTask(t); res.json(view(store.get(t.id)!)); } catch (e) { fail(res, e); }
});
mountReview(app);
// A notice from the mail module (a proposed task, a comment from an approval card) goes into the task's Taskboard inbox.
// An idle agent is told at once; a busy one learns at its next prompt.
mountMail(app, { notify: async (taskId, name, text) => {
  docs.upload(taskId, name, Buffer.from(text));
  const t = store.get(taskId); const pending = docs.pendingInboxNotice(taskId);
  if (!t || t.status !== 'idle' || !pending) return;
  await agents.sendTaskText(t, pending.notice);
  docs.acknowledgeInboxNotice(taskId, pending.names);
} });

// ---------- accounts ----------
const acctView = async (a: accounts.Account, fresh = false) => ({ ...a, status: await accounts.status(a, fresh), running: store.all().filter(t => (t.account || accounts.defaultFor(t.agent).id) === a.id && !['archived', 'parked', 'suspended'].includes(t.status)).length });
app.get('/api/accounts', async (req, res) => res.json(await Promise.all(accounts.all().map(a => acctView(a, req.query.fresh === '1')))));
app.post('/api/accounts', async (req, res) => { try { const { agent, name } = req.body; if (!['claude', 'codex'].includes(agent) || !name) throw new Error('agent and name are required'); res.json(await acctView(accounts.create(agent, String(name)))); } catch (e) { fail(res, e); } });
app.patch('/api/accounts/:id', (req, res) => { try { const a = accounts.update(req.params.id, req.body); a ? res.json(a) : res.status(404).end(); } catch (e) { fail(res, e); } });
app.delete('/api/accounts/:id', (req, res) => { try { accounts.remove(req.params.id); res.json({}); } catch (e) { fail(res, e); } });
app.post('/api/accounts/:id/login', async (req, res) => { const a = accounts.get(req.params.id); if (!a) return res.status(404).end(); try { res.json({ session: await agents.utilSession('login', a) }); } catch (e) { fail(res, e); } });
app.post('/api/accounts/:id/clear-limit', (req, res) => { accounts.clearLimited(req.params.id); res.json({}); });
// Limit resets are used only by you, from the dashboard: requests without a browser origin (tb, agents) are refused.
app.post('/api/accounts/:id/reset', async (req, res) => {
  if (!req.get('origin')) return res.status(403).json({ error: 'Limit resets can only be used from the dashboard.' });
  const a = accounts.get(req.params.id); if (!a) return res.status(404).end();
  if (a.agent === 'codex') return res.json({ open: 'https://chatgpt.com/codex/settings/usage', note: 'Codex has no command-line reset; spend banked resets in the Codex app or on the usage page.' });
  if (a.agent === 'antigravity') return res.json({ open: 'https://antigravity.google/docs/cli/credits/', note: 'Antigravity has no limit reset. Its quota resets on its own; run /credits in agy to see or buy AI credits.' });
  try { res.json({ session: await agents.utilSession('reset', a) }); } catch (e) { fail(res, e); }
});
app.post('/api/tasks/:id/move-account', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  const account = accounts.get(req.body.account);
  if (!account) return fail(res, new Error('Unknown account.'));
  if (req.body.instruction !== undefined && typeof req.body.instruction !== 'string') return fail(res, new Error('The move instruction must be text.'));
  const instruction = req.body.instruction || '';
  await guarded(req, res, `move #${t.num} to ${account.name}`, `Continue with ${agents.agentName(account.agent)} in ${t.cwd}.\n${instruction}`, 'move',
    async () => view(await agents.moveAccount(t, account.id, instruction)), r => `Moved #${r.num} to ${account.name} (${r.agent}).`);
});

// ---------- groups ----------
app.get('/api/groups', (_req, res) => res.json(groups.all()));
app.post('/api/groups', (req, res) => {
  const name = String(req.body.name || '').trim(); if (!name) return fail(res, 'name is required');
  res.json(groups.create(name, req.body.tasks || []));
});
app.patch('/api/groups/:id', (req, res) => {
  const { name, color, tasks, add, remove } = req.body; const g = groups.get(req.params.id); if (!g) return res.status(404).end();
  let list = tasks ?? g.tasks;
  if (add) list = [...list, ...[].concat(add)];
  if (remove) list = list.filter((t: string) => ![].concat(remove).includes(t as never));
  res.json(groups.update(g.id, { ...(name ? { name } : {}), ...(color ? { color } : {}), tasks: list }));
});
app.delete('/api/groups/:id', (req, res) => { const g = groups.remove(req.params.id); g ? res.json(g) : res.status(404).end(); });
app.post('/api/groups/restore', (req, res) => { groups.restore(req.body); res.json({}); });

app.get('/api/import', async (_req, res) => {
  try { res.json(await importer.candidates(new Set(store.all().flatMap(t => [t.sessionId, ...(t.pastSessions || [])]).filter(Boolean) as string[]))); } catch (e) { fail(res, e); }
});
app.post('/api/import', (req, res) => {
  const made: unknown[] = [], errors: string[] = [];
  for (const c of req.body.items || []) { try { made.push(view(agents.importSession(c))); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); } }
  res.json({ made, errors });
});
app.post('/api/tasks/:id/send', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  const text = String(req.body.text || '');
  if (t.role === 'controller') { try { await tmux.sendKeys(t.session, text); res.json({}); } catch (e) { fail(res, e); } return; }
  await guarded(req, res, `type into #${t.num} ${t.title}`, text, 'send', async () => {
    const delivery = await agents.sendTaskText(t, text);
    store.update(t.id, { status: 'working', ask: '', statusSource: `Message sent by you${delivery.resumed ? ' after resuming the task' : ''}.` });
    return delivery;
  }, () => `Typed into #${t.num}.`);
});
app.post('/api/tasks/:id/kill', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  await guarded(req, res, `end and archive #${t.num} ${t.title}`, '', 'kill',
    async () => { await tmux.killSession(t.session); return view(store.update(t.id, { status: 'archived', statusSource: 'Session ended and archived.' })!); }, () => `#${t.num} ended and archived.`);
});
// Remove a task from Taskboard (dashboard only). Ends its tmux session unless it runs in another terminal; the note
// and folder go to ~/.taskboard/trash, and the conversation files of Claude Code / Codex stay where they are.
app.delete('/api/tasks/:id', async (req, res) => {
  if (!req.get('origin')) return res.status(403).json({ error: 'Tasks are removed on the dashboard.' });
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  if (t.role === 'controller') return fail(res, 'The controller cannot be removed.');
  try {
    if (!t.openElsewhere) await tmux.killSession(t.session);
    for (const g of groups.groupsOf(t.id)) groups.update(g.id, { tasks: g.tasks.filter(x => x !== t.id) });
    store.remove(t.id);
    res.json({});
  } catch (e) { fail(res, e); }
});
// ---------- inbox / outbox ----------
// Files you drop on a task (raw body, name in ?name=) go into its inbox.
app.post('/api/tasks/:id/inbox/upload', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  try { const path = docs.upload(t.id, String(req.query.name || 'file'), req.body as Buffer); store.touch(t.id); res.json({ path }); } catch (e) { fail(res, e); }
});
app.get('/api/tasks/:id/docs', (req, res) => { if (!store.get(req.params.id)) return res.status(404).end(); res.json(docs.docsFor(req.params.id)); });
app.get('/api/tasks/:id/document-link', (req, res) => {
  const doc = docs.resolveDocumentLink(String(req.params.id), String(req.query.path || ''));
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json({ ...doc, reviewId: pendingForPath(doc.path)?.id });
});
app.get('/api/document-link', (req, res) => {
  const link = docs.resolveViewerLink(String(req.query.source || ''), String(req.query.href || ''));
  if (link.kind === 'document' && link.document) return res.json({ ...link, document: { ...link.document, reviewId: pendingForPath(link.document.path)?.id } });
  res.json(link);
});
app.get('/api/document-image', (req, res) => {
  const image = docs.resolveDocumentImage(String(req.query.source || ''), String(req.query.path || ''));
  if (!image) return res.status(404).send('Image not found');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'");
  res.type(image.type).sendFile(image.path);
});
app.post('/api/open-local-file', (req, res) => {
  if (!req.get('origin') || !originOk(req.get('origin')) || req.get('x-taskboard-token') || req.get('x-tb-actor')) return res.status(403).json({ error: 'Only the dashboard can open local files.' });
  const path = docs.openableLocalPath(String(req.body.path || ''));
  if (!path) return res.status(403).json({ error: 'Taskboard cannot open this file. It must be a regular, non-executable file inside the vault or a Taskboard worktree.' });
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], error => {
    if (error) return res.status(500).json({ error: 'The operating system could not open this file.' });
    res.json({ opened: path });
  });
});
app.get('/api/docs/edges', (_req, res) => res.json(docs.edges()));
app.get('/api/docs/all', (_req, res) => res.json(Object.fromEntries(store.all().map(t => [t.id, docs.docsFor(t.id).outbox.map(d => ({ name: d.name, path: d.path, kind: d.kind, mtime: d.mtime }))]))));
app.post('/api/docs/send', async (req, res) => {
  let path: string | undefined;
  try {
    const { from, name, to } = req.body; if (!store.get(from) || !store.get(to)) throw new Error('unknown task');
    path = docs.send(from, name, to); store.touch(from); store.touch(to);
    const target = store.get(to)!;
    const pending = docs.pendingInboxNotice(to)!;
    const delivery = await agents.sendTaskText(target, pending.notice);
    docs.acknowledgeInboxNotice(to, pending.names);
    store.update(to, { status: 'working', ask: '', statusSource: 'An inbox file was sent to the agent.' });
    res.json({ path, resumed: delivery.resumed });
  } catch (e) { fail(res, path ? `The file was copied to ${path}, but the agent was not told: ${e instanceof Error ? e.message : e}` : e); }
});
app.post('/api/tasks/:id/inbox/remove', (req, res) => { docs.removeFromInbox(req.params.id, req.body.name); store.touch(req.params.id); res.json({}); });
// New inbox files the agent has not been told about (for `tb inbox wait`). Clears the pending list,
// so the prompt hook does not report the same files again.
app.post('/api/tasks/:id/inbox/take', (req, res) => {
  if (!store.get(req.params.id)) return res.status(404).json({ error: 'no such task' });
  res.json({ files: docs.takePending(req.params.id) });
});
// Type the inbox notice into the agent's terminal (needed for Codex, which has no prompt hook here, and for an idle
// Antigravity task, which is told only at the end of a turn).
app.post('/api/tasks/:id/inbox/tell', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  const pending = docs.pendingInboxNotice(t.id); if (!pending) return res.json({ told: false });
  try {
    const delivery = await agents.sendTaskText(t, pending.notice);
    docs.acknowledgeInboxNotice(t.id, pending.names);
    store.update(t.id, { status: 'working', ask: '', statusSource: 'Inbox notice sent to the agent.' });
    res.json({ told: true, resumed: delivery.resumed });
  } catch (e) { fail(res, e); }
});
// Files from the vault. Served as a sandboxed document (opaque origin), so an agent-written HTML page
// cannot call Taskboard's API.
app.get('/api/file', (req, res) => {
  const p = docs.safePath(String(req.query.path || '')); if (!p) return res.status(404).send('Not found');
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-forms');
  res.set('X-Content-Type-Options', 'nosniff');
  if (/\.html?$/i.test(p)) res.type('text/html'); else if (/\.(md|markdown|txt|log|json)$/i.test(p)) res.type('text/plain; charset=utf-8');
  res.sendFile(p);
});

// What changed since you last opened the task: log entries, files changed in its folder, commits.
app.get('/api/tasks/:id/since', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  const since = t.seenAt ? Date.parse(t.seenAt) : Date.parse(t.created);
  const entries: string[] = [];
  for (const block of store.readLog(t.id).split(/\n(?=## )/)) {
    const m = block.match(/^## (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/);
    if (m && Date.parse(m[1].replace(' ', 'T')) >= since - 60000) entries.push(block.trim());
  }
  const run = async (args: string[]) => { try { return (await execFileP('git', ['-C', t.cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { return ''; } };
  const files: string[] = [];
  for (const line of (await run(['status', '--porcelain'])).split('\n')) {
    const f = line.slice(3).trim(); if (!f) continue;
    try { if (statSync(join(t.cwd, f.replace(/^"|"$/g, ''))).mtimeMs >= since) files.push(f); } catch { files.push(f + ' (deleted)'); }
  }
  const commits = (await run(['log', `--since=${new Date(since).toISOString()}`, '--pretty=format:%h %s', '-n', '20'])).split('\n').filter(Boolean);
  res.json({ since: new Date(since).toISOString(), first: !t.seenAt, entries, files: files.slice(0, 40), commits });
});

app.get('/api/tasks/:id/log', (req, res) => res.type('text/markdown').send(store.readLog(req.params.id)));
// Questions about a task, answered by a separate read-only agent (server/ask.ts). The dashboard asks, directly or through
// another machine's Taskboard server (which sends no origin and no x-tb-actor); agents do not, because each question
// uses the account's usage.
app.get('/api/tasks/:id/ask', (req, res) => { if (!store.get(req.params.id)) return res.status(404).end(); res.json(ask.get(req.params.id)); });
app.post('/api/tasks/:id/ask', async (req, res) => {
  if (!req.get('origin') && req.get('x-tb-actor')) return res.status(403).json({ error: 'Questions are asked on the dashboard.' });
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  const q = String(req.body?.question || '').trim(); if (!q) return fail(res, 'Type a question.');
  try { res.json(await ask.ask(t, q)); } catch (e) { fail(res, e); }
});
app.post('/api/tasks/:id/ask/stop', (req, res) => { ask.stop(req.params.id); res.json({ ok: true }); });
app.delete('/api/tasks/:id/ask', (req, res) => { if (!store.get(req.params.id)) return res.status(404).end(); res.json(ask.clear(req.params.id)); });
app.get('/api/tasks/:id/peek', async (req, res) => {
  const t = store.get(req.params.id); if (!t) return res.status(404).end();
  res.type('text/plain').send(await tmux.capture(t.session, Math.min(500, Number(req.query.lines) || 30)));
});

// Folders to start in: the ones you used, most used first, plus git repositories found one level under ~ and ~/Documents/Repositories.
// Folder browser for the New task dialog: the subfolders of one folder (hidden ones only when asked).
app.get('/api/browse', (req, res) => {
  const raw = String(req.query.path || '~');
  const dir = raw === '~' || raw === '' ? HOME : raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw;
  try {
    const hidden = req.query.hidden === '1';
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter(d => (d.isDirectory() || (d.isSymbolicLink() && (() => { try { return statSync(join(dir, d.name)).isDirectory(); } catch { return false; } })())) && (hidden || !d.name.startsWith('.')))
      .map(d => ({ name: d.name, git: existsSync(join(dir, d.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const parent = dir === '/' ? null : join(dir, '..');
    res.json({ path: dir, home: HOME, parent, git: existsSync(join(dir, '.git')), dirs });
  } catch (e) { fail(res, `Cannot open ${dir}: ${e instanceof Error ? e.message : e}`); }
});
app.get('/api/folders', (_req, res) => {
  const used = Object.entries(store.state.folders).map(([path, f]) => ({ path, ...f }));
  const found: string[] = [];
  for (const base of [HOME, join(HOME, 'Documents', 'Repositories'), join(HOME, 'code')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const p = join(base, d);
      try { if (!d.startsWith('.') && statSync(p).isDirectory() && existsSync(join(p, '.git'))) found.push(p.replace(HOME, '~')); } catch { /* unreadable */ }
    }
  }
  res.json({ used: used.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.uses - a.uses), found: found.filter(p => !store.state.folders[p]) });
});
app.post('/api/folders/pin', (req, res) => {
  const { path, pinned } = req.body; const f = store.state.folders[path] || { uses: 0, last: '' };
  store.state.folders[path] = { ...f, pinned: !!pinned }; store.saveState(); res.json({});
});
app.get('/api/ui', (_req, res) => res.json(store.state.ui));
app.put('/api/ui', (req, res) => { store.state.ui = { ...store.state.ui, ...req.body }; store.saveState(); res.json({}); });

// ---------- UI files ----------
const dist = join(ROOT, 'web', 'dist');
if (existsSync(dist)) {
  // index.html must be checked on every load so a rebuilt interface is picked up; the hashed assets can be cached
  app.use(express.static(dist, { setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(join(dist, 'index.html')); });
}

// ---------- websockets: /ws/events (changes) and /ws/term?task=<id> ----------
// Identifies the interface build this server serves (a hash of web/dist/index.html, which names the bundle files). A page
// that connected to an older build reloads itself after a release (see web/src/api.ts).
const BUILD_ID = (() => { try { return createHash('sha1').update(readFileSync(join(ROOT, 'web', 'dist', 'index.html'))).digest('hex').slice(0, 12); } catch { return 'none'; } })();
const wss = new WebSocketServer({ noServer: true });
const eventClients = new Set<import('ws').WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', URL_BASE);
  // the dashboard is identified by its origin; anything else (another Taskboard server) must present the token
  if (req.headers.origin ? !originOk(req.headers.origin) : (url.searchParams.get('token') !== TOKEN && req.headers['x-taskboard-token'] !== TOKEN)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', build: BUILD_ID }));
      ws.send(JSON.stringify({ type: 'tasks', tasks: [...store.all().map(view), ...machines.remoteTasks()] }));
      ws.send(JSON.stringify({ type: 'groups', groups: groups.all() }));
      ws.send(JSON.stringify({ type: 'approvals', approvals: approvals.all() }));
      const opened = new Set<string>();
      ws.on('message', m => {
        // the UI reports which tasks are open, so a finished turn in an open task goes straight to "idle"
        try { const x = JSON.parse(m.toString()); if (x.type === 'viewing') { opened.forEach(id => events.viewing.delete(id)); opened.clear(); for (const id of x.ids || []) { opened.add(id); events.viewing.add(id); } } } catch { /* ignore */ }
      });
      ws.on('close', () => { eventClients.delete(ws); opened.forEach(id => events.viewing.delete(id)); });
    } else if (url.pathname === '/ws/term') {
      const remote = machines.split(url.searchParams.get('task') || '');
      if (remote) {
        // pipe this terminal to the other machine's Taskboard server
        const mc = machines.get(remote.machine); if (!mc) return ws.close(4004, 'unknown machine');
        const up = new WebSocket(`${mc.url.replace(/^http/, 'ws')}/ws/term?task=${encodeURIComponent(remote.id)}&cols=${url.searchParams.get('cols') || 120}&rows=${url.searchParams.get('rows') || 40}&token=${encodeURIComponent(mc.token)}`);
        const queue: string[] = [];
        up.on('open', () => { queue.forEach(q => up.send(q)); queue.length = 0; });
        up.on('message', d => { if (ws.readyState === ws.OPEN) ws.send(d.toString()); });
        up.on('close', () => ws.close()); up.on('error', () => ws.close(4502, 'machine unreachable'));
        ws.on('message', d => { const s = d.toString(); if (up.readyState === up.OPEN) up.send(s); else queue.push(s); });
        ws.on('close', () => up.close());
        return;
      }
      const util = url.searchParams.get('session') || '';
      if (util.startsWith('util-')) return attach(ws, util, Number(url.searchParams.get('cols')) || 120, Number(url.searchParams.get('rows')) || 40);
      const t = store.get(url.searchParams.get('task') || '');
      if (!t) return ws.close(4004, 'no such task');
      attach(ws, t.session, Number(url.searchParams.get('cols')) || 120, Number(url.searchParams.get('rows')) || 40);
    } else ws.close();
  });
});

// outbox / inbox files changed on disk → refresh that task's counts in every window
const pendingTouch = new Map<string, NodeJS.Timeout>();
try {
  const watcher = (await import('node:fs')).watch(store.taskDir(''), { recursive: true }, (_ev, file) => {
    const m = String(file || '').match(/^([^/]+)\/(inbox|outbox)\//); if (!m) return;
    clearTimeout(pendingTouch.get(m[1])); pendingTouch.set(m[1], setTimeout(() => store.touch(m[1]), 300));
  });
  watcher.on('error', e => console.error('watch', e));
} catch (e) { console.error('watch', e); }
approvals.onApprovalsChange(() => {
  for (const t of store.all()) {
    if (!approvals.pendingFor(t.id).length && t.status === 'needs-you' && t.ask?.startsWith('Approve:'))
      store.update(t.id, { status: 'working', ask: '', statusSource: 'Your decision was sent back to the task.' });
  }
  const msg = JSON.stringify({ type: 'approvals', approvals: approvals.all() });
  for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg);
});
accounts.onAccountsChange(() => { for (const c of eventClients) if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: 'accounts' })); });
machines.onRemoteChange(changed => {
  const msgs = changed.map(t => JSON.stringify({ type: 'task', task: t }));
  msgs.push(JSON.stringify({ type: 'machines' }));
  for (const c of eventClients) if (c.readyState === c.OPEN) msgs.forEach(m => c.send(m));
});
groups.onGroupsChange(() => {
  const msg = JSON.stringify({ type: 'groups', groups: groups.all() });
  for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg);
});
store.onTaskRemoved(id => {
  const msg = JSON.stringify({ type: 'removed', id });
  for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg);
});
store.onTaskChange(t => {
  const msg = JSON.stringify({ type: 'task', task: view(t) });
  for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg);
});

// ---------- watch tmux: sessions that ended, Codex output after a finished turn ----------
// A session open in a terminal Taskboard does not own: follow it through its process and its transcript file.
const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };
function watchElsewhere(t: store.Task) {
  const e = t.openElsewhere;
  const running = !!e && importer.alive(e.pid);
  if (!running) {
    store.update(t.id, { status: 'suspended', openElsewhere: undefined, statusSource: `Closed in ${e?.tty || 'the other terminal'} at ${new Date().toTimeString().slice(0, 5)}. Open this task to resume it here.` });
    return;
  }
  if (!t.transcript) return;
  const r = external.readState(t.agent, t.transcript);
  if (!r) return;
  // No hooks run in that terminal, so the status comes from the last records of the transcript:
  // - the turn ended → done (unread until you open the task)
  // - a tool call has had no result for 10 s → probably an approval prompt in that terminal
  // - the file changed in the last 15 s, or the last record is a prompt or tool result → working
  const quietFor = Date.now() - r.mtime, where = `${e!.tty} (process ${e!.pid})`, at = new Date(r.mtime).toTimeString().slice(0, 5);
  let patch: Partial<store.Task>;
  if (r.state === 'finished') {
    const already = t.status === 'unread' || t.status === 'idle';
    patch = { status: already ? t.status : events.viewing.has(t.id) ? 'idle' : 'unread', ask: '', now: r.text || t.now, statusSource: `Turn ended at ${at} in ${where}. Read from the transcript.` };
  } else if (r.state === 'tool' && waitingForApproval(t, e!.pid, r)) {
    patch = { status: 'needs-you', ask: `Probably waiting for your approval in ${e!.tty}: ${r.tool}`, statusSource: `A tool call has had no result since ${at} and no command is running under it, in ${where}.` };
  } else if (r.state === 'tool' && Date.now() - (r.toolAt || r.mtime) > 30000) {
    patch = { status: 'working', ask: '', statusSource: `Running ${r.tool} since ${at} in ${where} (a long command, or waiting for approval there).` };
  } else if (r.state === 'aborted') {
    patch = { status: 'idle', ask: '', statusSource: `Turn interrupted in ${where}.` };
  } else if (quietFor < 15000 || r.state === 'busy' || r.state === 'tool') {
    patch = { status: 'working', ask: '', statusSource: `Running in ${where}.` };
  } else {
    patch = { status: 'idle', ask: '', statusSource: `Running in ${where} · no output since ${at}.` };
  }
  if (Object.entries(patch).some(([k, v]) => (t as any)[k] !== v)) store.update(t.id, patch);
  if (t.moveWhenDone && (r.state === 'finished' || r.state === 'aborted') && quietFor >= QUIET_MS && !movingNow.has(t.id)) {
    movingNow.add(t.id);
    agents.takeOver(store.get(t.id)!).then(() => store.update(t.id, { moveWhenDone: undefined }))
      .catch(err => store.update(t.id, { moveWhenDone: undefined, statusSource: `Could not move it here: ${err instanceof Error ? err.message : err}` }))
      .finally(() => movingNow.delete(t.id));
  }
}
const movingNow = new Set<string>();
// A tool call without a result is an approval prompt only if it has waited 30 s, is not a timed wait still within its
// time (Codex), and — for Claude Code, which runs each command as a child shell — no command shell is running under it.
function waitingForApproval(t: store.Task, pid: number, r: external.TranscriptState) {
  const since = Date.now() - (r.toolAt || r.mtime);
  if (since < 30000 || (r.waitMs && since < r.waitMs + 10000)) return false;
  if (t.agent === 'codex') return false; // Codex runs commands in its background service, so a running command cannot be told apart
  let kids = '';
  try { kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').join(','); } catch { return true; } // pgrep exits 1 when there are none
  try { return !/(^|\/)(zsh|bash|sh) -c /m.test(execFileSync('ps', ['-o', 'command=', '-p', kids], { encoding: 'utf8' })); } catch { return false; }
}

// The controller is always running while Taskboard runs (unless you turned that off or archived it): if its session
// is gone or the agent exited, start it again (at most once a minute). Its Remote Control address is read from its screen.
let controllerStartedAt = 0;
async function keepController(t: store.Task, s?: { dead: boolean }) {
  if (agents.launching.has(t.id) || t.status === 'archived') return;
  if ((!s || s.dead) && machine.get().controller.autostart) {
    if (Date.now() - controllerStartedAt < 60000) return;
    controllerStartedAt = Date.now();
    try { await agents.startController(); console.log('controller restarted'); } catch (e) { console.error('controller restart failed', e); }
    return;
  }
  // Restart for a changed name, model, or Remote Control setting between turns.
  if (s && !s.dead && t.launchedAs !== agents.controllerLaunchKey(t.agent) && betweenTurns(t) && Date.now() - controllerStartedAt > 60000) {
    controllerStartedAt = Date.now();
    await tmux.killSession(t.session); store.update(t.id, { remoteUrl: undefined });
    try { await agents.startController(); console.log('controller restarted with new settings'); } catch (e) { console.error('controller restart failed', e); }
    return;
  }
  // the controller folder is Taskboard's own (it only holds the controller instructions): accept the CLI's
  // "trust this folder" question there, so an unattended start (at login, after a crash) does not stop on it
  // (also after a change of the controller's account on the Accounts page, which launches it without a restart here)
  if (s && !s.dead && Date.now() - Math.max(controllerStartedAt, store.launchedAt.get(t.id) || 0) < 120000) {
    const screen = await tmux.capture(t.session, 40);
    if (t.agent === 'claude' && /Yes, I trust this folder/.test(screen)) { await tmux.tmux('send-keys', '-t', '=' + t.session + ':', 'Down'); await tmux.tmux('send-keys', '-t', '=' + t.session + ':', 'Enter'); return; }
    if (t.agent === 'codex' && /Trust this folder\?/.test(screen) && /Trust and continue/.test(screen)) { await tmux.tmux('send-keys', '-t', '=' + t.session + ':', 'Enter'); return; }
    if (t.agent === 'antigravity' && /Do you trust the contents of this project\?/.test(screen) && /Yes, I trust this folder/.test(screen)) { await tmux.tmux('send-keys', '-t', '=' + t.session + ':', 'Enter'); return; }
  }
  if (s && !s.dead && t.agent === 'claude' && machine.get().controller.remoteControl) {
    const m = (await tmux.capture(t.session, 60)).match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/);
    if (m && m[0] !== t.remoteUrl) store.update(t.id, { remoteUrl: m[0] });
  }
}

// Restart an agent in tmux with the current command line; it resumes the same conversation.
async function restartTask(t: store.Task) {
  store.update(t.id, { restartWhenDone: undefined });
  await tmux.killSession(t.session);
  try { await agents.resumeTask(store.get(t.id)!, true); } catch (e) { store.update(t.id, { status: 'suspended', statusSource: `Restart failed: ${e instanceof Error ? e.message : e}` }); }
}

// "Between turns" as far as the server can tell: idle or unread, and neither the status nor the transcript changed for
// 15 s. A prompt typed in the last moment can still race with this (the CLIs give no way to hold input); 15 s makes it
// unlikely instead of likely.
const QUIET_MS = 15000;
function betweenTurns(t: store.Task) {
  if (!['idle', 'unread'].includes(t.status)) return false;
  let last = Date.parse(t.statusAt) || 0;
  try { if (t.transcript) last = Math.max(last, statSync(t.transcript).mtimeMs); } catch { /* moved */ }
  return Date.now() - Math.max(last, store.launchedAt.get(t.id) || 0) >= QUIET_MS;
}
let lastListWarn = 0;
// first: the run at server start, before the status is read from the transcripts (see below)
async function reconcile(first = false) {
  const sessions = await tmux.listSessions();
  if (!sessions) { if (Date.now() - lastListWarn > 60000) { lastListWarn = Date.now(); console.error(`${new Date().toISOString()} tmux did not answer; skipping status checks`); } return; }
  const byName = new Map(sessions.map(s => [s.name, s]));
  for (const t of store.all()) {
    if (t.role === 'controller') { await keepController(t, byName.get(t.session)); continue; }
    if (t.openElsewhere && !['archived', 'parked'].includes(t.status)) { watchElsewhere(t); continue; }
    if (['archived', 'parked'].includes(t.status) || agents.launching.has(t.id)) continue;
    const s = byName.get(t.session);
    // marked suspended but its session is running (for example after a listing problem): take it back
    if (t.status === 'suspended') {
      if (s && !s.dead && !t.openElsewhere) store.update(t.id, { status: 'idle', interrupted: undefined, statusSource: `Found its session running at ${new Date().toTimeString().slice(0, 5)}.` });
      continue;
    }
    // missing from the list: confirm with tmux directly before treating the session as gone
    if (!s && (await tmux.hasSession(t.session)) !== false) continue;
    if (!s) { store.update(t.id, { status: 'suspended', interrupted: t.status === 'working' ? 'The session ended while the agent was working.' : undefined, statusSource: 'The tmux session is gone (restart or crash). Opening the task resumes it.' }); continue; }
    if (s.dead) { store.update(t.id, { status: 'suspended', statusSource: 'The agent exited. Resume to continue the conversation.' }); continue; }
    if (!!t.unscrollable !== s.unscrollable) store.update(t.id, { unscrollable: s.unscrollable || undefined });
    // Questions the CLIs ask before any hook can fire (trust this folder, sign in, update) are read from the screen:
    // during the first 90 s after the agent was launched, and afterwards for as long as such a question keeps the task
    // in "needs you". Only the bottom 15 non-empty lines of the visible screen count (where a question waiting for an
    // answer sits); history and answered text further up must not bring it back.
    const launched = store.launchedAt.get(t.id) || Date.parse(t.created) || 0;
    const screenQuestion = t.status === 'needs-you' && t.statusSource?.startsWith(events.SCREEN_SOURCE);
    if (screenQuestion || (Date.now() - launched < 90000 && !events.sessionStarted.has(t.id) && ['working', 'idle'].includes(t.status)))
      events.screenCheck(t, (await tmux.capture(t.session, 0)).split('\n').filter(l => l.trim()).slice(-15).join('\n'));
    // Antigravity: type in the first prompt once the trust question is answered; read approval questions from the screen
    // while a tool call waits (agy has no event for either)
    if (t.agent === 'antigravity' && (agents.pendingPrompt.has(t.id) || t.status === 'working')) {
      const screen = (await tmux.capture(t.session, 0)).split('\n').filter(l => l.trim()).slice(-20).join('\n');
      await agents.typePendingPrompt(t, screen);
      events.agyApprovalCheck(store.get(t.id)!, screen);
    }
    if (t.agent === 'codex' && t.sessionId) {
      let tr = t.transcript;
      if (!tr) { tr = importer.transcriptFor('codex', t.sessionId, (accounts.get(t.account) || accounts.defaultFor('codex')).dir); if (tr) store.update(t.id, { transcript: tr }); }
      let mtime = 0;
      // at start, a rollout file that changed while the server was down is read by the transcript check instead
      try { if (tr) { mtime = statSync(tr).mtimeMs; if (!first) events.codexActivity(t, mtime); } } catch { /* moved */ }
      // Questions Codex asks while it keeps working are only visible on screen. Read the screen while they are open,
      // and for 10 s after the rollout file or the status changed (the questions appear right after the call is written).
      const c = store.get(t.id)!;
      if (events.codexQuestionsOpen(c) || Date.now() - Math.max(mtime, Date.parse(c.statusAt) || 0) < 10000)
        events.codexQuestionCheck(c, (await tmux.capture(c.session, 0)).split('\n').filter(l => l.trim()).slice(-15).join('\n'));
    }
    // after the activity checks above, so a new Codex turn is seen first
    const cur = store.get(t.id)!;
    if (cur.restartWhenDone && betweenTurns(cur)) { await restartTask(cur); continue; }
  }
}
await reconcile(true);
// Events sent while the server was down are lost; take the status from the transcripts once at start.
for (const t of store.all()) {
  if (!t.transcript || t.openElsewhere || !['working', 'needs-you', 'idle', 'unread', 'review'].includes(t.status)) continue;
  const r = external.readState(t.agent, t.transcript); if (!r) continue;
  const newer = (r.at ?? 0) > (Date.parse(t.statusAt) || 0); // compare conversation records, not file writes
  if (r.state === 'finished' && ['working', 'needs-you'].includes(t.status) && newer) {
    const pending = pendingFor(t.id); // a document still waiting for review
    store.update(t.id, { status: pending ? 'review' : 'unread', ask: pending ? `Review ${pending.name}` : '', now: r.text || t.now, statusSource: 'Turn ended while Taskboard was restarting (read from the transcript).' });
  }
  else if ((r.state === 'busy' || r.state === 'tool') && ['idle', 'unread', 'review'].includes(t.status) && newer)
    store.update(t.id, { status: 'working', statusSource: 'Started working while Taskboard was restarting (read from the transcript).' });
}
// start the controller together with Taskboard
if (machine.get().controller.autostart && store.get('controller')?.status !== 'archived') {
  controllerStartedAt = Date.now();
  agents.startController().then(() => console.log(`controller running as “${machine.controllerLabel()}”`)).catch(e => console.error('controller start failed', e));
}
// Codex usage: read from each Codex account's newest session file every minute
accounts.refreshCodexUsage();
setInterval(() => accounts.refreshCodexUsage(), 60000);
setInterval(() => reconcile().catch(e => console.error('reconcile', e)), 2000);
// "waiting N min" changes over time; push a refresh every minute
setInterval(() => { const msg = JSON.stringify({ type: 'tasks', tasks: [...store.all().map(view), ...machines.remoteTasks()] }); for (const c of eventClients) if (c.readyState === c.OPEN) c.send(msg); }, 60000);

console.log(`Taskboard on ${URL_BASE}  (vault ${store.taskDir('').replace(/\/$/, '')})`);
