// "Ask task to refresh" on a stale merge card (task 390), on a test Taskboard server with its own port, folders and
// tmux socket, a temporary repository and fake tasks. Nothing here uses the real Taskboard or a real repository.
// The rules of the card are in tests/stale-merge-cards.test.ts. This file covers the routes, the real Git heads, the
// timer that finds a stale card without a click, and the message to the task (also to a parked task).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-stale-merge-srv-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), workspace = join(root, 'workspace');
for (const d of [tbdir, join(vault, 'tasks'), workspace, join(root, 'code')]) mkdirSync(d, { recursive: true });
const socket = `tb-stale-merge-${process.pid}`;
// this test can run inside a Taskboard task: drop the variables of that task and of the real server
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

const main = join(root, 'code', 'app');
mkdirSync(main);
git(main, 'init', '-q', '-b', 'master'); git(main, 'config', 'user.email', 'stale-test@example.invalid'); git(main, 'config', 'user.name', 'Stale Test');
writeFileSync(join(main, 'readme.txt'), 'app\n'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'start');
const wt = (n: number) => { const p = join(root, 'code', `app-wt-${n}`); git(main, 'worktree', 'add', '-q', '-b', `task/t${n}`, p); return realpathSync(p); };
const w1 = wt(1), w2 = wt(2);
const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', `add ${file}`); return git(cwd, 'rev-parse', 'HEAD'); };
const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');

const taskNote = (f: Record<string, string | number | boolean>) => writeFileSync(join(vault, 'tasks', `${f.id}.md`),
  `---\n${Object.entries({ created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', statusAt: '2026-01-01T00:00:00.000Z', ...f }).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n# ${f.title}\n`);
const testAccounts = ['claude', 'codex'].map(agent => ({ id: `${agent}-test`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: false, maxParallel: 8, created: new Date().toISOString() }));
for (const a of testAccounts) mkdirSync(a.dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(testAccounts));
for (const [n, cwd] of [[1, w1], [2, w2]] as const) {
  taskNote({ id: `t${n}`, num: n, title: `Task ${n}`, agent: 'codex', account: 'codex-test', status: 'idle', cwd, folder: realpathSync(main), branch: `task/t${n}`, worktree: true, session: `task-${n}` });
  mkdirSync(join(vault, 'tasks', `t${n}`), { recursive: true });
}
taskNote({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', role: 'controller', status: 'idle', cwd: workspace, folder: workspace, session: 'controller' });
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'stale-test', controller: { autostart: false, remoteControl: false } }));

test('a stale merge card: found without a click, closed as stale and not denied, the task is asked for a new request', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'stale-test', TASKBOARD_STALE_CHECK_MS: '200' };
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
    // a request of a task carries the token of that task (server/task-token.ts); the controller has its own token
    const tokens = JSON.parse(readFileSync(join(tbdir, 'task-tokens.json'), 'utf8')) as Record<string, string>;
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const as = (actor: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': actor, ...(actor === 'controller' ? { 'x-tb-mail-controller': controllerToken } : { 'x-tb-task-token': tokens[actor] }) });
    const user = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const card = async (id: string) => (await (await fetch(`${base}/api/approvals/${id}`)).json());
    const task = async (id: string) => (await (await fetch(`${base}/api/tasks`, { headers: as('controller') })).json()).find((t: { id: string }) => t.id === id);
    const until = async <T>(what: string, read: () => Promise<T | undefined | false>) => {
      for (let i = 0; i < 100; i++) { const v = await read(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
      throw new Error(`timeout: ${what}\n${output}`);
    };
    const queue = (id: string) => { try { return JSON.parse(readFileSync(join(vault, 'tasks', id, 'message-queue.json'), 'utf8')) as { text: string; state: string; reason: string }[]; } catch { return []; } };

    // ---------- 1. stale master (the case of task 381), and the task is parked ----------
    const b1 = commit(w1, 'one.txt', 'one\n'), m0 = head(main);
    const first = await post('/api/git/merge-request', {}, as('t1'));
    const c1 = first.data.approval;
    assert.ok(c1?.id, JSON.stringify(first) + output);
    assert.match(c1.detail, new RegExp(`Branch head: ${b1}\\nMaster head: ${m0}`));
    const m1 = commit(main, 'other.txt', 'another task merged\n');
    const stale1 = await until('the timer marks the card stale', async () => { const c = await card(c1.id); return c.staleFacts ? c : undefined; });
    assert.equal(stale1.state, 'pending');
    assert.equal(stale1.staleFacts, `Local master moved after this card was made. The card shows master ${m0.slice(0, 8)}. Master is now ${m1.slice(0, 8)}. The branch head did not change (${b1.slice(0, 8)}).`);
    assert.match((await task('t1')).statusSource, /The merge card is stale\. Local master moved.*Ask task to refresh/);
    // Approve merges nothing against the changed master
    const approved = await post(`/api/approvals/${c1.id}/approve`, {}, user);
    assert.equal(approved.data.state, 'pending'); assert.equal(head(main), m1);
    // only the user refreshes a card, on the dashboard
    assert.equal((await post(`/api/approvals/${c1.id}/refresh`, {}, as('t1'))).status, 403);
    assert.equal((await post(`/api/approvals/${c1.id}/refresh`, {}, as('controller'))).status, 403);
    // the user parks the task before the click
    const parked = await post('/api/tasks/t1/status', { status: 'parked' }, user);
    assert.equal(parked.status, 200, JSON.stringify(parked.data) + output);
    assert.equal((await task('t1')).status, 'parked');
    assert.equal((await card(c1.id)).state, 'pending', 'the card of a parked task still waits');
    const r1 = await post(`/api/approvals/${c1.id}/refresh`, { origin: { from: 'waiting', target: 'refresh', shownMs: 9000 } }, user);
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.equal(r1.data.state, 'stale');
    assert.match(r1.data.result, /This is not a denial\. The user did not reject the branch\. Nothing was merged\. Local master moved/);
    assert.match(r1.data.detail, new RegExp(`Master head: ${m0}`), 'the closed card keeps the old heads');
    assert.equal(r1.data.decidedBy.origin.target, 'refresh');
    assert.equal(head(main), m1, 'nothing was merged');
    // refresh delivery: the parked task keeps the message in its queue, and the card says so
    const told = await until('the card records the delivery', async () => (await card(c1.id)).delivery as string | undefined);
    assert.match(told, /The message waits in the queue of task #1\. #1 is parked\. Taskboard types the message after the user resumes #1\./);
    const q1 = queue('t1');
    assert.equal(q1.length, 1); assert.equal(q1[0].state, 'queued');
    assert.match(q1[0].text, new RegExp(`^Taskboard card ${c1.id} version \\S+: closed as stale, not denied\\. The user closed this merge card because it is stale\\.`));
    assert.match(q1[0].text, new RegExp(`Master is now ${m1.slice(0, 8)}.*Run tb git rebase, or inspect the change if you must\\. Then run tb git merge-request\\.`));
    assert.doesNotMatch(q1[0].text, /Denied by the user|: denied/);
    assert.equal((await task('t1')).status, 'parked', 'the task stays parked');
    // repeated refresh: the card stays as it is and the task gets no second message
    const again = await post(`/api/approvals/${c1.id}/refresh`, {}, user);
    assert.equal(again.status, 200); assert.equal(again.data.state, 'stale');
    assert.equal((await post(`/api/approvals/${c1.id}/deny`, {}, user)).data.state, 'stale', 'a late Deny does not turn the record into a denial');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(queue('t1').length, 1);
    const audit = readFileSync(join(tbdir, 'approval-decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.card === c1.id);
    assert.deepEqual(audit.map(l => [l.event, l.state, l.origin?.target]), [['refresh', 'stale', 'refresh']]);

    // ---------- 2. fresh approval: a new card with the current heads, and only its approval merges ----------
    const c2 = (await post('/api/git/merge-request', {}, as('t1'))).data.approval;
    assert.ok(c2?.id, output); assert.notEqual(c2.id, c1.id);
    assert.equal(c2.state, 'pending'); assert.equal(c2.staleFacts, undefined);
    assert.match(c2.detail, new RegExp(`Branch head: ${b1}\\nMaster head: ${m1}`));
    assert.equal(head(main), m1, 'the new card merges nothing before the user approves it');
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await card(c2.id)).staleFacts, undefined, 'the timer leaves a card that matches alone');
    assert.equal((await card(c1.id)).state, 'stale', 'the old card stays in the record');
    const done = await post(`/api/approvals/${c2.id}/approve`, {}, user);
    assert.equal(done.data.state, 'approved', JSON.stringify(done.data));
    assert.match(done.data.result, /Merged task\/t1 into local master/);
    assert.equal(git(main, 'rev-parse', 'HEAD^2'), git(w1, 'rev-parse', 'HEAD'));

    // ---------- 3. stale branch ----------
    const m2 = head(main), b2 = commit(w2, 'two.txt', 'two\n');
    const c3 = (await post('/api/git/merge-request', {}, as('t2'))).data.approval;
    assert.ok(c3?.id, output);
    const b3 = commit(w2, 'three.txt', 'three\n');
    const stale3 = await until('the timer marks the branch card stale', async () => { const c = await card(c3.id); return c.staleFacts ? c : undefined; });
    assert.equal(stale3.staleFacts, `The task branch moved after this card was made. The card shows branch head ${b2.slice(0, 8)}. The branch head is now ${b3.slice(0, 8)}. Master did not change (${m2.slice(0, 8)}).`);
    // a new request while the stale card still waits: the same card shows the current heads, with no stale facts
    const c3b = (await post('/api/git/merge-request', {}, as('t2'))).data.approval;
    assert.equal(c3b.id, c3.id); assert.equal(c3b.staleFacts, undefined); assert.match(c3b.detail, new RegExp(`Branch head: ${b3}`));
    assert.equal((await post(`/api/approvals/${c3.id}/refresh`, {}, user)).status, 409, 'a card that matches is not closed');
    assert.equal((await card(c3.id)).state, 'pending');

    // ---------- 4. user denial stays a denial ----------
    const b4 = commit(w2, 'four.txt', 'four\n');
    await until('the card is stale again', async () => (await card(c3.id)).staleFacts as string | undefined);
    const denied = await post(`/api/approvals/${c3.id}/deny`, {}, user);
    assert.equal(denied.data.state, 'denied'); assert.equal(denied.data.result, 'Denied by the user.');
    assert.equal((await post(`/api/approvals/${c3.id}/refresh`, {}, user)).data.state, 'denied');
    assert.equal(head(main), m2); assert.equal(head(w2), b4);
    const q2 = await until('the task gets the denial', async () => { const q = queue('t2'); return q.length ? q : undefined; });
    assert.match(q2[0].text, new RegExp(`^Taskboard card ${c3.id} version \\S+: denied\\. Denied by the user\\.`));
    assert.doesNotMatch(q2[0].text, /stale/);

    // ---------- 5. refresh delivery to a task that is not parked: Taskboard tries to type the message at once ----------
    const c5 = (await post('/api/git/merge-request', {}, as('t2'))).data.approval;
    assert.ok(c5?.id, output); assert.notEqual(c5.id, c3.id);
    const m5 = commit(main, 'later.txt', 'master moved again\n');
    const r5 = await post(`/api/approvals/${c5.id}/refresh`, {}, user);
    assert.equal(r5.data.state, 'stale', JSON.stringify(r5.data));
    // the fake task has no agent: the message is typed, queued or failed, and the card says which
    const told5 = await until('the card records the delivery', async () => (await card(c5.id)).delivery as string | undefined);
    assert.match(told5, /task #2/);
    const sent = await until('the message is in the queue file', async () => queue('t2').find(q => q.text.includes(`card ${c5.id} `)));
    assert.match(sent.text, new RegExp(`closed as stale, not denied\\..*Master is now ${m5.slice(0, 8)}`));
    assert.equal(head(main), m5);
  } finally {
    await new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill(); });
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
