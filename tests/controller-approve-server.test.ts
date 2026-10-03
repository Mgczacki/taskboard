// The controller approves dashboard cards on the user's request (tb approvals list, tb approve), on a test Taskboard
// server with its own port, folders and tmux socket, temporary repositories with a bare remote, and fake tasks.
// Nothing here uses the real Taskboard or a real repository. No restart card is approved: that would run the
// restart script. The rules themselves are in tests/controller-approve.test.ts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-ctl-approve-srv-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), workspace = join(root, 'workspace');
for (const d of [tbdir, join(vault, 'tasks'), workspace, join(root, 'code'), join(root, 'remotes'), join(root, 'reference')]) mkdirSync(d, { recursive: true });
const socket = `tb-ctl-approve-${process.pid}`;
// this test can run inside a Taskboard task: drop the variables of that task and of the real server
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

// one repository with a bare remote, and a worktree for each of the tasks #1, #2 and #3
const main = join(root, 'code', 'app'), bare = join(root, 'remotes', 'app.git');
mkdirSync(main);
git(main, 'init', '-q', '-b', 'master'); git(main, 'config', 'user.email', 'ctl-test@example.invalid'); git(main, 'config', 'user.name', 'Controller Test');
writeFileSync(join(main, 'readme.txt'), 'app\n'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'start');
git(root, 'init', '-q', '--bare', '-b', 'master', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', '-q', 'origin', 'master');
const wt = (n: number) => { const p = join(root, 'code', `app-wt-${n}`); git(main, 'worktree', 'add', '-q', '-b', `task/t${n}`, p); return realpathSync(p); };
const w1 = wt(1), w2 = wt(2), w3 = wt(3);
const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', `add ${file}`); return git(cwd, 'rev-parse', 'HEAD'); };

const taskNote = (f: Record<string, string | number | boolean>) => writeFileSync(join(vault, 'tasks', `${f.id}.md`),
  `---\n${Object.entries({ created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', statusAt: '2026-01-01T00:00:00.000Z', ...f }).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n# ${f.title}\n`);
const testAccounts = ['claude', 'codex'].map(agent => ({ id: `${agent}-test`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: false, maxParallel: 8, created: new Date().toISOString() }));
for (const a of testAccounts) mkdirSync(a.dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(testAccounts));
const realMain = realpathSync(main);
for (const [n, cwd] of [[1, w1], [2, w2], [3, w3]] as const) {
  taskNote({ id: `t${n}`, num: n, title: `Task ${n}`, agent: 'codex', account: 'codex-test', status: 'idle', cwd, folder: realMain, branch: `task/t${n}`, worktree: true, session: `task-${n}` });
  mkdirSync(join(vault, 'tasks', `t${n}`), { recursive: true });
}
taskNote({ id: 'plain', num: 4, title: 'Research', agent: 'claude', account: 'claude-test', status: 'idle', cwd: workspace, folder: workspace, session: 'task-4' });
mkdirSync(join(vault, 'tasks', 'plain'), { recursive: true });
const transcript = join(root, 'controller.jsonl');
writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'What waits on me?' } }) + '\n');
// the user writes a message in the controller chat
const userSays = (text: string) => writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: text } }) + '\n', { flag: 'a' });
taskNote({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', role: 'controller', status: 'idle', cwd: workspace, folder: workspace, session: 'controller', transcript });
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'ctl-test', controller: { autostart: false, remoteControl: false } }));

test('the controller approves dashboard cards only on the user\'s request in its chat', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'ctl-test' };
  let output = '';
  const startServer = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', b => { output += b.toString(); }); child.stderr!.on('data', b => { output += b.toString(); });
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/info')).ok) return child; } catch { /* the server starts */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`the test server did not start\n${output}`);
  };
  const stopServer = (child: ChildProcess) => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
  let child = await startServer();
  try {
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const as = (actor: string) => ({ 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': actor });
    const controller = { ...as('controller'), 'x-tb-mail-controller': controllerToken };
    const user = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const patch = async (body: unknown) => (await fetch(base + '/api/info', { method: 'PATCH', headers: user, body: JSON.stringify(body) })).json();
    const card = async (id: string) => (await (await fetch(`${base}/api/approvals/${id}`)).json());
    const list = async () => (await (await fetch(base + '/api/controller/approvals', { headers: controller })).json()).cards as { id: string; version: string; head?: string; range?: string; kind: string; label?: string; userOnly?: string; controllerMayApprove: boolean; task: { num: number } | null }[];
    const listed = async (id: string) => { const c = (await list()).find(x => x.id === id); assert.ok(c, `card ${id} is not in the list\n${output}`); return c!; };
    const approve = async (id: string, userRequest: string, o: { version?: string; head?: string; headers?: Record<string, string> } = {}) => {
      const c = (await list()).find(x => x.id === id);
      return post(`/api/approvals/${id}/controller-approve`, { userRequest, version: o.version ?? c?.version, head: o.head ?? c?.head }, o.headers || controller);
    };
    const tb = (args: string[], actor: string, withToken = actor === 'controller') => new Promise<{ code: number | null; out: string }>(resolve => {
      const p = spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...clean, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: actor, ...(withToken ? { TB_MAIL_CONTROLLER_TOKEN: controllerToken } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { out += b; }); p.on('close', code => resolve({ code, out }));
    });

    // ---------- 1. merge cards: who may call ----------
    commit(w1, 'one.txt', 'one\n');
    const m1 = (await post('/api/git/merge-request', {}, as('t1'))).data.approval;
    assert.ok(m1?.id, output);
    commit(w2, 'two.txt', 'two\n');
    const m2 = (await post('/api/git/merge-request', {}, as('t2'))).data.approval;
    assert.equal((await fetch(base + '/api/controller/approvals', { headers: as('t1') })).status, 403, 'a task cannot list the cards');
    const l1 = await listed(m1.id);
    assert.equal(l1.kind, 'merge');
    assert.equal(l1.head, git(w1, 'rev-parse', 'HEAD'));
    assert.equal(l1.range, `${git(main, 'rev-parse', 'HEAD')}..${l1.head}`);
    assert.equal(l1.task?.num, 1);
    const tbList = await tb(['approvals', 'list'], 'controller');
    assert.equal(tbList.code, 0, tbList.out);
    assert.ok(tbList.out.includes(`${m1.id}  merge into local master  #1 Task 1`), tbList.out);
    assert.ok(tbList.out.includes(`--version ${l1.version} --head ${l1.head!.slice(0, 12)}`), tbList.out);
    // an agent is refused: tb in a task, the route as a task, a task that sets the controller header, a wrong token
    userSays(`approve ${m1.id}`);
    const inTask = await tb(['approve', m1.id, '--version', l1.version, '--head', l1.head!, '--user-request', `approve ${m1.id}`], 't1');
    assert.equal(inTask.code, 1); assert.match(inTask.out, /controller only/);
    assert.equal((await approve(m1.id, `approve ${m1.id}`, { headers: as('t1') })).status, 403, 'a task');
    assert.equal((await approve(m1.id, `approve ${m1.id}`, { headers: as('controller') })).status, 403, 'the controller header without the controller token');
    assert.equal((await approve(m1.id, `approve ${m1.id}`, { headers: { ...as('controller'), 'x-tb-mail-controller': 'f'.repeat(64) } })).status, 403, 'a wrong token');
    const fakeTb = await tb(['approve', m1.id, '--version', l1.version, '--head', l1.head!, '--user-request', `approve ${m1.id}`], 'controller', false);
    assert.equal(fakeTb.code, 1, 'TASK_ID=controller without the controller token'); assert.match(fakeTb.out, /Only the (user and the )?controller/);
    assert.equal((await card(m1.id)).state, 'pending');

    // ---------- 2. refusals of the message, the version, the head and the setting ----------
    let r = await approve(m1.id, `please approve ${m1.id} now`);
    assert.equal(r.status, 403); assert.match(r.data.error, /not one user message/);
    userSays('approve it');
    r = await approve(m1.id, 'approve it');
    assert.equal(r.status, 403); assert.match(r.data.error, /must name the card id/);
    userSays(`approve ${m2.id}`);
    r = await approve(m1.id, `approve ${m2.id}`);
    assert.equal(r.status, 403, 'another card id'); assert.match(r.data.error, new RegExp(m1.id));
    userSays('approve all');
    assert.match((await approve(m1.id, 'approve all')).data.error, /names no card/);
    r = await approve(m1.id, `approve ${m1.id}`, { version: '000000000000' });
    assert.equal(r.status, 409); assert.match(r.data.error, /version is different.*tb approvals list again/);
    r = await approve(m1.id, `approve ${m1.id}`, { head: git(w2, 'rev-parse', 'HEAD') });
    assert.equal(r.status, 409); assert.match(r.data.error, /--head/);
    await patch({ controllerApprovals: { merge: false } });
    assert.equal((await listed(m1.id)).controllerMayApprove, false);
    r = await approve(m1.id, `approve ${m1.id}`);
    assert.equal(r.status, 403); assert.match(r.data.error, /Settings > Controller approvals/);
    await patch({ controllerApprovals: { merge: true } });
    // the branch moved after the card was made: refused, and the card stays for the user
    commit(w1, 'one-more.txt', 'more\n');
    r = await approve(m1.id, `approve ${m1.id}`);
    assert.equal(r.status, 409); assert.match(r.data.error, /moved.*Nothing ran/s);
    assert.equal((await card(m1.id)).state, 'pending');
    await post(`/api/approvals/${m1.id}/deny`, {}, user);

    // ---------- 3. a merge approved with the task number and the kind ----------
    const m1b = (await post('/api/git/merge-request', {}, as('t1'))).data.approval;
    const head1 = git(w1, 'rev-parse', 'HEAD');
    const l1b = await listed(m1b.id);
    userSays('Approve 1 - merge it');
    const merged = await tb(['approve', m1b.id, '--version', l1b.version, '--head', head1.slice(0, 7), '--user-request', 'Approve 1 - merge it'], 'controller');
    assert.equal(merged.code, 0, merged.out + output);
    assert.match(merged.out, new RegExp(`Approved: merge into local master card ${m1b.id} of task #1 \\(task/t1 at ${head1.slice(0, 12)}\\)`));
    assert.match(merged.out, /Reminder: the words must be the user's own message/);
    assert.match(merged.out, /Tell the user in one or two lines/);
    assert.ok(git(main, 'log', '--format=%H', '-5').includes(head1), 'master holds the commit of task 1');
    const done = await card(m1b.id);
    assert.equal(done.state, 'approved');
    assert.deepEqual({ by: done.decidedBy.by, userRequest: done.decidedBy.userRequest }, { by: 'controller', userRequest: 'Approve 1 - merge it' });
    const rows = readFileSync(join(tbdir, 'controller-approvals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const row = rows.find(x => x.card === m1b.id);
    assert.equal(row.userRequest, 'Approve 1 - merge it'); assert.equal(row.head, head1); assert.equal(row.version, l1b.version);
    assert.deepEqual(row.named, { by: 'task', key: 't1:merge' }); assert.equal(row.controller.agent, 'claude'); assert.equal(row.state, 'approved');
    assert.match(readFileSync(join(vault, 'tasks', 't1', 'log.md'), 'utf8'), /The controller approved the merge into local master card .* on the user's request: "Approve 1 - merge it"/);
    // the other merge card is now behind master: the controller cannot approve it, and nothing ran
    userSays(`merge ${m2.id}`);
    r = await approve(m2.id, `merge ${m2.id}`);
    assert.equal(r.status, 409); assert.match(r.data.error, /master moved|moved/);
    await post(`/api/approvals/${m2.id}/deny`, {}, user);

    // ---------- 4. one message for two permit cards; a reuse is refused ----------
    const p1 = (await post('/api/permits', { reason: 'say one', steps: [{ command: 'echo one' }] }, as('t1'))).data.permit;
    const p2 = (await post('/api/permits', { reason: 'say two', steps: [{ command: 'echo two' }] }, as('t2'))).data.permit;
    const permitCard = async (permitId: string) => (await (await fetch(base + '/api/approvals')).json()).find((a: { payload?: { permitId?: string } }) => a.payload?.permitId === permitId);
    const c1 = await permitCard(p1.id), c2 = await permitCard(p2.id);
    const both = 'Yes, approve the permits of 1 and 2';
    userSays(both);
    r = await approve(c1.id, both);
    assert.equal(r.status, 200, JSON.stringify(r.data) + output); assert.equal(r.data.approval.state, 'approved');
    r = await approve(c2.id, both);
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.approval.state, 'approved');
    assert.equal((await card(c2.id)).decidedBy.userRequest, both);
    const p3 = (await post('/api/permits', { reason: 'say three', steps: [{ command: 'echo three' }] }, as('t1'))).data.permit;
    const c3 = await permitCard(p3.id);
    r = await approve(c3.id, both);
    assert.equal(r.status, 403); assert.match(r.data.error, /already approved a permit card of this task/);
    await post(`/api/permits/${p3.id}/decide`, { approve: false }, user);

    // ---------- 5. a push, then a force push after a repair ----------
    const h3 = commit(w3, 'three.txt', 'three\n');
    const push1 = await post('/api/git/push-request', { reason: 'Publish task 3' }, as('t3'));
    assert.equal(push1.status, 202, JSON.stringify(push1.data) + output);
    const pc = await listed(push1.data.approval.id);
    assert.equal(pc.kind, 'push'); assert.equal(pc.head, h3); assert.equal(pc.range, `(new branch)..${h3}`);
    userSays('push 3');
    r = await approve(pc.id, 'push 3');
    assert.equal(r.status, 200, JSON.stringify(r.data) + output);
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task/t3').split(/\s/)[0], h3);
    const repaired = await post('/api/git/repair', { mode: 'squash', base: 'origin/master', message: 'Task 3 in one commit' }, as('t3'));
    assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
    const h3b = git(w3, 'rev-parse', 'HEAD');
    const push2 = await post('/api/git/push-request', { reason: 'Publish the repaired branch' }, as('t3'));
    assert.equal(push2.status, 202, JSON.stringify(push2.data));
    const fc = await listed(push2.data.approval.id);
    assert.equal(fc.kind, 'forcePush'); assert.equal(fc.label, 'FORCE PUSH');
    userSays('push 3 again');
    r = await approve(fc.id, 'push 3 again');
    assert.equal(r.status, 403); assert.match(r.data.error, /FORCE PUSH/);
    userSays('approve the force push of 3');
    const forced = await tb(['approve', fc.id, '--version', fc.version, '--head', fc.head!, '--user-request', 'approve the force push of 3'], 'controller');
    assert.equal(forced.code, 0, forced.out + output);
    assert.match(forced.out, /FORCE PUSH: Yes/, 'tb approve prints the card text first');
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task/t3').split(/\s/)[0], h3b);

    // ---------- 6. a refused tool call stays user only ----------
    const refused = await post('/api/permits', { reason: 'push', steps: [{ command: 'git push origin master --force' }] }, as('t1'));
    assert.equal(refused.status, 400);
    userSays(`approve ${refused.data.refusal}`);
    r = await approve(refused.data.refusal, `approve ${refused.data.refusal}`);
    assert.equal(r.status, 403); assert.match(r.data.error, /refused tool call/);

    // ---------- 7. a scope request ----------
    const scope = await post('/api/scope/request', { kind: 'read', path: join(root, 'reference'), reason: 'Read the reference' }, as('plain'));
    assert.equal(scope.status, 202, JSON.stringify(scope.data));
    userSays('approve the scope request of 4');
    r = await approve(scope.data.approval.id, 'approve the scope request of 4');
    assert.equal(r.status, 200, JSON.stringify(r.data) + output);
    const plain = (await (await fetch(base + '/api/tasks')).json()).find((t: { id: string }) => t.id === 'plain');
    assert.equal(plain.scopes?.[0]?.kind, 'read');

    // ---------- 8. release and restart: the word, and only one in flight ----------
    const rel = (await post('/api/release/request', {}, as('t1'))).data.approval;
    userSays(`approve ${rel.id}`);
    r = await approve(rel.id, `approve ${rel.id}`);
    assert.equal(r.status, 403); assert.match(r.data.error, /word release/);
    userSays('release 1');
    r = await approve(rel.id, 'release 1');
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.said, /may run pnpm release once within two minutes/);
    assert.ok(existsSync(join(tbdir, 'release-permits', 't1.json')));
    const rel2 = (await post('/api/release/request', {}, as('t2'))).data.approval;
    userSays('release 2');
    r = await approve(rel2.id, 'release 2');
    assert.equal(r.status, 409); assert.match(r.data.error, /may run its approved release until/);
    const restartCard = (await post('/api/restart/request', {}, controller)).data.approval;
    assert.ok(restartCard?.id, output);
    userSays(`approve ${restartCard.id}`);
    r = await approve(restartCard.id, `approve ${restartCard.id}`);
    assert.equal(r.status, 403); assert.match(r.data.error, /word restart/);
    userSays(`restart ${restartCard.id}`);
    r = await approve(restartCard.id, `restart ${restartCard.id}`);
    assert.equal(r.status, 409, 'the approved release is still in flight'); assert.match(r.data.error, /approved release/);
    assert.equal((await card(restartCard.id)).state, 'pending');
    await post(`/api/approvals/${restartCard.id}/deny`, {}, user);
    await post(`/api/approvals/${rel2.id}/deny`, {}, user);

    // ---------- 9. the dashboard history and an expired card ----------
    const all = await (await fetch(base + '/api/approvals')).json();
    assert.ok(all.some((a: { id: string; decidedBy?: { by: string; userRequest?: string } }) => a.id === m1b.id && a.decidedBy?.by === 'controller' && a.decidedBy.userRequest === 'Approve 1 - merge it'));
    commit(w2, 'two-more.txt', 'more\n');
    git(w2, 'rebase', '-q', 'master');
    const m3 = (await post('/api/git/merge-request', {}, as('t2'))).data.approval;
    const l3 = await listed(m3.id);
    // a restart of the test server: the pending card expires (approvals.ts), and tb approve says so
    await stopServer(child);
    child = await startServer();
    userSays(`merge ${m3.id}`);
    const late = await tb(['approve', m3.id, '--version', l3.version, '--head', l3.head!, '--user-request', `merge ${m3.id}`], 'controller');
    assert.equal(late.code, 4, late.out); assert.match(late.out, /expired.*Nothing ran/s);
    assert.ok(!readdirSync(join(tbdir)).includes('restart.log'), 'no restart ran');
  } finally {
    await stopServer(child).catch(() => {});
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
