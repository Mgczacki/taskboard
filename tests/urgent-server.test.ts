// Urgent mode (server/urgent.ts) on a test Taskboard server with its own port, folders and tmux socket, a temporary
// repository and fake tasks. Nothing here uses the real Taskboard. Only the user (a dashboard request) or the controller
// (its token and the user's chat message) turns urgent mode on or off. A task in urgent mode gets each card approved
// at once and has no permit limits.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-urgent-srv-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), workspace = join(root, 'workspace');
for (const d of [tbdir, join(vault, 'tasks'), workspace, join(root, 'code')]) mkdirSync(d, { recursive: true });
const socket = `tb-urgent-${process.pid}`;
// this test can run inside a Taskboard task: drop the variables of that task and of the real server
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

const main = join(root, 'code', 'app');
mkdirSync(main);
git(main, 'init', '-q', '-b', 'master'); git(main, 'config', 'user.email', 'urgent-test@example.invalid'); git(main, 'config', 'user.name', 'Urgent Test');
writeFileSync(join(main, 'readme.txt'), 'app\n'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'start');
const wt = (n: number) => { const p = join(root, 'code', `app-wt-${n}`); git(main, 'worktree', 'add', '-q', '-b', `task/t${n}`, p); return realpathSync(p); };
const w1 = wt(1), w2 = wt(2);
const taskNote = (f: Record<string, string | number | boolean>) => writeFileSync(join(vault, 'tasks', `${f.id}.md`),
  `---\n${Object.entries({ created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', statusAt: '2026-01-01T00:00:00.000Z', ...f }).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n# ${f.title}\n`);
const accounts = [{ id: 'codex-test', agent: 'codex', name: 'codex', dir: join(root, 'accounts', 'codex'), isDefault: false, maxParallel: 8, created: new Date().toISOString() }];
mkdirSync(accounts[0].dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(accounts));
const realMain = realpathSync(main);
for (const [n, cwd] of [[1, w1], [2, w2]] as const) {
  taskNote({ id: `t${n}`, num: n, title: `Task ${n}`, agent: 'codex', account: 'codex-test', status: 'idle', cwd, folder: realMain, branch: `task/t${n}`, worktree: true, session: `task-${n}` });
  mkdirSync(join(vault, 'tasks', `t${n}`), { recursive: true });
}
const TOKENS = { t1: 'a'.repeat(64), t2: 'b'.repeat(64) };
writeFileSync(join(tbdir, 'task-tokens.json'), JSON.stringify(TOKENS));
const transcript = join(root, 'controller.jsonl');
writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'What waits on me?' } }) + '\n');
const userSays = (text: string) => writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: text } }) + '\n', { flag: 'a' });
taskNote({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', role: 'controller', status: 'idle', cwd: workspace, folder: workspace, session: 'controller', transcript });
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'urgent-test', controller: { autostart: false, remoteControl: false } }));

test('only the user or the controller turns urgent mode on or off, and a task in urgent mode has no Taskboard restrictions', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'urgent-test' };
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', b => { output += b.toString(); }); child.stderr!.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null || i > 150) throw new Error(`the test server did not start\n${output}`);
      try { if ((await fetch(base + '/api/info')).ok) break; } catch { /* the server starts */ }
      await new Promise(r => setTimeout(r, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const as = (actor: 't1' | 't2') => ({ 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-task-token': TOKENS[actor] });
    const controller = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'controller', 'x-tb-mail-controller': controllerToken };
    const user = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const get = async (path: string, headers: Record<string, string> = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
    const card = async (id: string) => (await get(`/api/approvals/${id}`)).data;
    const settled = async (id: string) => {
      for (let i = 0; i < 100; i++) { const c = await card(id); if (!['pending', 'running'].includes(c.state)) return c; await new Promise(r => setTimeout(r, 50)); }
      return card(id);
    };
    const on = { on: true, reason: 'Fix the outage' };
    const record = join(tbdir, 'urgent', 't1.json');

    // ---------- 1. a task cannot turn urgent mode on, also not for itself and not with a dashboard origin ----------
    assert.equal((await post('/api/tasks/t1/urgent', on, as('t1'))).status, 403, 'the task itself');
    assert.equal((await post('/api/tasks/t2/urgent', on, as('t1'))).status, 403, 'another task');
    assert.equal((await post('/api/tasks/t1/urgent', on, { ...as('t1'), origin: base })).status, 403, 'a task token with the dashboard origin');
    assert.equal((await post('/api/tasks/t1/urgent', on, { 'content-type': 'application/json', 'x-taskboard-token': token })).status, 403, 'the main token without an origin');
    assert.equal((await post('/api/tasks/t1/urgent', on, { ...controller, 'x-tb-mail-controller': 'f'.repeat(64) })).status, 403, 'the controller header without the controller token');
    assert.ok(!existsSync(record), 'urgent mode is off by default');

    // ---------- 2. the controller needs the user's chat message ----------
    let r = await post('/api/tasks/t1/urgent', on, controller);
    assert.equal(r.status, 403); assert.match(r.data.error, /--user-request/);
    r = await post('/api/tasks/t1/urgent', { ...on, userRequest: 'turn on urgent mode for task 1' }, controller);
    assert.equal(r.status, 403, 'words that the user did not write'); assert.match(r.data.error, /not one user message/);
    userSays('turn on urgent mode for 2');
    r = await post('/api/tasks/t1/urgent', { ...on, userRequest: 'turn on urgent mode for 2' }, controller);
    assert.equal(r.status, 403, 'the message names another task'); assert.match(r.data.error, /must name task 1/);
    userSays('urgent mode for task 1 please');
    r = await post('/api/tasks/t1/urgent', { ...on, userRequest: 'urgent mode for task 1 please' }, controller);
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.urgent.by, 'controller');
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).taskId, 't1', 'the guard reads this record');
    assert.equal((await post('/api/tasks/t1/urgent', { on: false }, controller)).data.off, true);
    r = await post('/api/tasks/t1/urgent', { ...on, userRequest: 'urgent mode for task 1 please' }, controller);
    assert.equal(r.status, 403, 'one message turns it on once'); assert.match(r.data.error, /already turned on/);
    assert.equal((await post('/api/tasks/controller/urgent', on, user)).status, 400, 'the controller has no urgent mode');

    // ---------- 3. the user turns it on; a task reads only its own record ----------
    assert.equal((await post('/api/tasks/t1/urgent', { on: true, reason: '' }, user)).status, 400, 'a reason is required');
    r = await post('/api/tasks/t1/urgent', on, user);
    assert.equal(r.status, 200); assert.equal(r.data.urgent.by, 'user');
    assert.equal((await get('/api/tasks/t1/urgent', as('t1'))).data.urgent.reason, 'Fix the outage');
    assert.equal((await get('/api/tasks/t1/urgent', as('t2'))).status, 403);
    assert.equal((await get('/api/tasks')).data.find((t: { id: string }) => t.id === 't1').urgent.by, 'user', 'the dashboard sees it');
    assert.equal((await post('/api/tasks/t1/urgent', { on: false }, as('t1'))).status, 403, 'the task cannot turn it off');

    // ---------- 4. in urgent mode: two permits at once, each approved and run without a user decision ----------
    const p1 = await post('/api/permits', { reason: 'check', steps: [{ command: 'true', cwd: w1 }] }, as('t1'));
    const p2 = await post('/api/permits', { reason: 'check again', steps: [{ command: 'true', cwd: w1 }] }, as('t1'));
    assert.equal(p1.status, 202, JSON.stringify(p1.data)); assert.equal(p2.status, 202, 'no limit of one pending permit');
    for (const p of [p1, p2]) {
      const c = await settled(p.data.permit.approvalId);
      assert.equal(c.state, 'approved', JSON.stringify(c)); assert.equal(c.decidedBy.by, 'urgent');
    }
    // a merge into local master runs without a click
    writeFileSync(join(w1, 'one.txt'), 'one\n'); git(w1, 'add', '-A'); git(w1, 'commit', '-q', '-m', 'one');
    const m = await post('/api/git/merge-request', {}, as('t1'));
    assert.equal((await settled(m.data.approval.id)).state, 'approved', output);
    assert.equal(git(main, 'show', 'master:one.txt'), 'one');

    // ---------- 5. a task without urgent mode keeps the limits and the cards ----------
    const q1 = await post('/api/permits', { reason: 'check', steps: [{ command: 'true', cwd: w2 }] }, as('t2'));
    assert.equal(q1.status, 202);
    assert.equal((await card(q1.data.permit.approvalId)).state, 'pending', 'the card of t2 waits for the user');
    const q2 = await post('/api/permits', { reason: 'check again', steps: [{ command: 'true', cwd: w2 }] }, as('t2'));
    assert.equal(q2.status, 400); assert.match(q2.data.error, /already has a pending permit/);

    // ---------- 6. the user turns it off: the limits apply again, and the audit log has each event ----------
    r = await post('/api/tasks/t1/urgent', { on: false, reason: 'done' }, user);
    assert.equal(r.data.off, true); assert.ok(!existsSync(record));
    const p3 = await post('/api/permits', { reason: 'after', steps: [{ command: 'true', cwd: w1 }] }, as('t1'));
    assert.equal((await card(p3.data.permit.approvalId)).state, 'pending', 'a card waits again');
    assert.equal((await post('/api/permits', { reason: 'after 2', steps: [{ command: 'true', cwd: w1 }] }, as('t1'))).status, 400);
    const audit = readFileSync(join(tbdir, 'urgent-mode.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(audit.map(a => a.event), ['on', 'off', 'on', 'card', 'card', 'card', 'off']);
    assert.equal(audit[0].userRequest, 'urgent mode for task 1 please');
    assert.deepEqual(audit.filter(a => a.event === 'card').map(a => a.action), ['permit', 'permit', 'git-merge']);
    assert.match(readFileSync(join(vault, 'tasks', 't1', 'log.md'), 'utf8'), /Urgent mode turned on by the user/);
  } finally {
    await new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill(); });
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
