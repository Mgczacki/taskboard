// The restart after an approved worktree scope, on a test Taskboard server with its own port, folders and tmux socket.
// Stand-in Claude and Codex programs record their arguments. Nothing here uses the real Taskboard or a real repository.
// Each case is one task: the request, the end of the turn and the approval come in a different order or status.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-scope-restart-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), bin = join(root, 'bin'), workspace = join(root, 'workspace');
for (const d of [tbdir, join(vault, 'tasks'), bin, workspace, join(root, 'code'), join(root, 'remotes'), join(root, 'args')]) mkdirSync(d, { recursive: true });
const socket = `tb-scope-restart-${process.pid}`;
// this test can run inside a Taskboard task: drop the variables of that task and of the real server
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
// stand-ins for the agents: each start records its arguments in args/<task id> and keeps running. The Codex stand-in
// also answers the hook list that Taskboard reads before it starts Codex (agents.ts codexHookTrust).
const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
} else {
  if (process.argv.includes('status')) { console.log('Logged in'); process.exit(0); }
  fs.appendFileSync(path.join(${JSON.stringify(join(root, 'args'))}, process.env.TASK_ID), process.argv.slice(2).join('\\n') + '\\n');
  setInterval(() => {}, 1000);
}
`;
for (const name of ['claude', 'codex']) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
// accounts in the test folder, not marked as default: Taskboard writes the folder trust of a default account into the
// real ~/.claude.json and ~/.codex/config.toml (workspace-trust.ts)
const testAccounts = ['claude', 'codex'].map(agent => ({ id: `${agent}-test`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: false, maxParallel: 20, created: new Date().toISOString() }));
for (const a of testAccounts) mkdirSync(a.dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(testAccounts));

const main = join(root, 'code', 'app'), bare = join(root, 'remotes', 'app.git');
mkdirSync(main);
git(main, 'init', '-q', '-b', 'master'); git(main, 'config', 'user.email', 'scope-test@example.invalid'); git(main, 'config', 'user.name', 'Scope Test');
writeFileSync(join(main, 'readme.txt'), 'app\n'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'start');
git(root, 'init', '-q', '--bare', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', '-q', 'origin', 'master');
const repo = realpathSync(main);

// the cases: one task each, with a live tmux session (a screen file that the pane shows, so a test can show a dialog)
type Case = { id: string; num: number; agent: 'claude' | 'codex'; extra?: string };
const cases: Case[] = [
  { id: 'claude-ended', num: 1, agent: 'claude' },
  { id: 'codex-ended', num: 2, agent: 'codex' },
  { id: 'claude-quiet', num: 3, agent: 'claude' },
  { id: 'claude-review', num: 4, agent: 'claude' },
  { id: 'codex-review', num: 5, agent: 'codex' },
  { id: 'claude-long-turn', num: 6, agent: 'claude' },
  { id: 'claude-dialog', num: 7, agent: 'claude' },
  { id: 'codex-question', num: 8, agent: 'codex' },
  { id: 'claude-fails', num: 9, agent: 'claude', extra: 'transfer: {"direction":"source","state":"started","peerIdentity":"x","task":"y"}\n' },
  { id: 'codex-resumed', num: 10, agent: 'codex' },
];
const sessionId = (n: number) => `0000000${n}-2222-3333-4444-555555555555`;
for (const c of cases) {
  writeFileSync(join(vault, 'tasks', `${c.id}.md`), `---\nid: ${c.id}\nnum: ${c.num}\ntitle: "Case ${c.id}"\nagent: ${c.agent}\nstatus: working\n` +
    `cwd: ${JSON.stringify(workspace)}\nfolder: ${JSON.stringify(workspace)}\nsession: task-${c.num}\nsessionId: "${sessionId(c.num)}"\naccount: ${c.agent}-test\n` +
    `created: '2026-01-01T00:00:00.000Z'\nupdated: '2026-01-01T00:00:00.000Z'\nstatusAt: '2026-01-01T00:00:00.000Z'\n${c.extra || ''}---\n# Case ${c.id}\n`);
  mkdirSync(join(vault, 'tasks', c.id), { recursive: true });
  writeFileSync(join(root, `screen-${c.num}`), 'working\n');
  tmux('new-session', '-d', '-x', '120', '-y', '30', '-s', `task-${c.num}`, `while :; do clear; cat ${join(root, `screen-${c.num}`)}; sleep 1; done`);
}
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'scope-restart-test', controller: { autostart: false, remoteControl: false },
  permissions: { controllerNeedsApproval: true, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const args = (id: string) => existsSync(join(root, 'args', id)) ? readFileSync(join(root, 'args', id), 'utf8') : '';

test('an approved worktree restarts the session once the agent waits, for every status and order', { timeout: 240000 }, async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket,
    TASKBOARD_MACHINE_NAME: 'scope-restart-test', TASKBOARD_RESTART_WAIT_MS: '20000' };
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/info')).ok) break; } catch { /* the server starts */ }
      await sleep(100);
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const hookHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token };
    const post = async (path: string, body: unknown, headers: Record<string, string>) => {
      const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const asTask = (id: string) => ({ ...hookHeaders, 'x-tb-actor': id });
    const user = { 'content-type': 'application/json', origin: base };
    const getTask = async (id: string) => (await (await fetch(base + '/api/tasks')).json()).find((t: { id: string }) => t.id === id);
    const worktree = (c: Case) => join(`${repo}-wt`, `${c.id}--app`);
    const request = async (c: Case) => {
      const r = await post('/api/scope/request', { kind: 'worktree', repo, base: 'origin/master', branch: `task/${c.id}`, reason: `Case ${c.id}` }, asTask(c.id));
      assert.equal(r.status, 202, JSON.stringify(r.data) + output);
      assert.equal((await getTask(c.id)).status, 'needs-you');
      return r.data.approval.id as string;
    };
    const approve = async (id: string) => { const r = await post(`/api/approvals/${id}/approve`, {}, user); assert.equal(r.data.state, 'approved', JSON.stringify(r.data) + output); return r.data.result as string; };
    const endTurn = async (c: Case, text = 'Done.') => c.agent === 'claude'
      ? post('/api/hooks/claude', { taskId: c.id, input: { hook_event_name: 'Stop', session_id: sessionId(c.num), last_assistant_message: text } }, hookHeaders)
      : post('/api/hooks/codex', { taskId: c.id, payload: { type: 'agent-turn-complete', 'thread-id': sessionId(c.num), 'last-assistant-message': text } }, hookHeaders);
    // the restart started the agent again with --add-dir for the new worktree, in the same conversation
    const restarted = (c: Case) => args(c.id).includes(worktree(c));
    const waitFor = async (ok: () => boolean | Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await sleep(250); } return false; };
    const by = (id: string) => cases.find(c => c.id === id)!;

    // 1. Claude: the turn ended right after the request, and the user approves at once
    const c1 = by('claude-ended'); const a1 = await request(c1); await endTurn(c1);
    const result1 = await approve(a1);
    // the agent reads plainly that it has no write access until the restart, and that it must not wait for the controller
    assert.match(result1, /no write access to .* until this session restarts/);
    assert.match(result1, /End your turn now and wait/);
    assert.match(result1, /Do not try to work around it/);
    assert.match(result1, /Do not wait for the controller/);
    // 2. Codex: the same order (the case of task 171 without a review)
    const c2 = by('codex-ended'); const a2 = await request(c2); await endTurn(c2); await approve(a2);
    // 3. Claude: the turn ended long before the approval
    const c3 = by('claude-quiet'); const a3 = await request(c3); await endTurn(c3);
    // 4 and 5. A document waits for review, so the end of the turn sets 'review' (the case of task 171)
    for (const id of ['claude-review', 'codex-review']) {
      const doc = join(vault, 'tasks', id, 'outbox', 'report.md'); mkdirSync(join(vault, 'tasks', id, 'outbox'), { recursive: true }); writeFileSync(doc, '# Report\n');
      const r = await post('/api/review/request', { path: doc, task: id }, asTask(id)); assert.ok(r.status < 300, JSON.stringify(r.data));
    }
    const c4 = by('claude-review'), c5 = by('codex-review');
    const a4 = await request(c4), a5 = await request(c5);
    // the approval comes while the agent still waits in tb scope request (its turn runs), then the turn ends
    await approve(a4); await approve(a5);
    assert.equal((await getTask(c4.id)).status, 'working');
    await endTurn(c4); await endTurn(c5);
    assert.equal((await getTask(c4.id)).status, 'review');
    assert.equal((await getTask(c5.id)).status, 'review');
    // 6. a turn that does not end
    const c6 = by('claude-long-turn'); await approve(await request(c6));
    // 7. the turn ended, but a dialog shows on the screen
    const c7 = by('claude-dialog'); const a7 = await request(c7); await endTurn(c7);
    writeFileSync(join(root, 'screen-7'), 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n');
    await approve(a7);
    // 8. Codex ends its turn with a question for the user
    const c8 = by('codex-question'); const a8 = await request(c8); await approve(a8); await endTurn(c8, 'Which branch should I use?');
    assert.equal((await getTask(c8.id)).status, 'needs-you');
    // 9. the restart fails: the reason shows on the task and in its log
    const c9 = by('claude-fails'); const a9 = await request(c9); await endTurn(c9); await approve(a9);
    // 10. the session ends while the restart waits, and the user resumes it (task 171: tb park and tb resume)
    const c10 = by('codex-resumed'); await approve(await request(c10));
    tmux('kill-session', '-t', 'task-10');
    assert.ok(await waitFor(async () => (await getTask(c10.id)).status === 'suspended', 10000));
    assert.equal((await post(`/api/tasks/${c10.id}/resume`, {}, user)).status, 200);

    // the waiting tasks show that a restart is pending and why
    const list = spawnSync(process.execPath, ['bin/tb', 'scope', 'list'], { cwd: process.cwd(), encoding: 'utf8', env: { ...clean, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: c6.id } });
    assert.match(list.stdout, /Restart pending: Waiting for the end of the turn to give access to the new worktree app\. Until the restart/, list.stdout + list.stderr);
    const pending = await getTask(c6.id);
    assert.equal(pending.restartWhenDone, true);
    assert.match(pending.restartWait || '', /Waiting for the end of the turn to give access to the new worktree/);

    await sleep(16000);
    await approve(a3);

    for (const c of [c1, c2, c3, c4, c5]) assert.ok(await waitFor(() => restarted(c), 30000), `${c.id} did not restart: ${JSON.stringify(await getTask(c.id))}\n${args(c.id)}\n${output}`);
    for (const c of [c1, c2, c3, c4, c5]) {
      const t = await getTask(c.id);
      assert.equal(t.restartWhenDone, undefined, c.id);
      // the same conversation
      assert.match(args(c.id), new RegExp(sessionId(c.num)), c.id);
      assert.match(readFileSync(join(vault, 'tasks', c.id, 'log.md'), 'utf8'), /Restarted the session .* new worktree app/, c.id);
    }
    // the document still waits for review, so the restarted task stays in 'review'
    for (const c of [c4, c5]) assert.equal((await getTask(c.id)).status, 'review', c.id);

    // 7. the dialog keeps the restart waiting; once it is gone, the restart runs
    assert.ok(!restarted(c7), 'restarted while a dialog showed');
    assert.match((await getTask(c7.id)).restartWait || '', /question or a dialog/);
    writeFileSync(join(root, 'screen-7'), 'done\n');
    assert.ok(await waitFor(() => restarted(c7), 30000), `${c7.id}: ${JSON.stringify(await getTask(c7.id))}`);

    // 8. the open question keeps it waiting; the answer starts a turn, and its end restarts the session
    assert.ok(!restarted(c8), 'restarted while a question was open');
    assert.match((await getTask(c8.id)).restartWait || '', /question/);
    await endTurn(c8, 'Done with main.');
    assert.ok(await waitFor(() => restarted(c8), 30000), `${c8.id}: ${JSON.stringify(await getTask(c8.id))}`);

    // 9. the failed restart is visible with its reason
    assert.ok(await waitFor(async () => !!(await getTask(c9.id)).restartFailed, 30000), JSON.stringify(await getTask(c9.id)));
    const failed = await getTask(c9.id);
    assert.match(failed.restartFailed, /Check the target transfer/);
    assert.match(readFileSync(join(vault, 'tasks', c9.id, 'log.md'), 'utf8'), /The restart .* failed: Check the target transfer/);

    // 10. the resumed session has the new folder; Taskboard clears the wait and does not restart it a second time
    assert.ok(await waitFor(async () => (await getTask(c10.id)).restartWhenDone === undefined, 10000), JSON.stringify(await getTask(c10.id)));
    assert.equal(args(c10.id).split('\n').filter(l => l === worktree(c10)).length, 1, args(c10.id));
    assert.match(readFileSync(join(vault, 'tasks', c10.id, 'log.md'), 'utf8'), /did not restart it again/);

    // 6. after the set time the task offers Restart now and says why; Restart now restarts it
    assert.ok(!restarted(c6));
    assert.ok(await waitFor(async () => !!(await getTask(c6.id)).restartOverdue, 30000), JSON.stringify(await getTask(c6.id)));
    assert.match((await getTask(c6.id)).restartWait, /did not end/);
    const now = await post(`/api/tasks/${c6.id}/restart`, { when: 'now' }, user);
    assert.equal(now.status, 200, JSON.stringify(now.data));
    assert.ok(await waitFor(() => restarted(c6), 10000), args(c6.id));
    assert.equal((await getTask(c6.id)).restartOverdue, undefined);
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    tmux('kill-server');
    rmSync(root, { recursive: true, force: true });
  }
});
