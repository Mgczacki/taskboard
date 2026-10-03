// Scope requests on a test Taskboard server with its own port, folders and tmux socket, temporary repositories and
// stand-in agent programs. Nothing here uses the real Taskboard or a real repository.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-scope-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), bin = join(root, 'bin'), workspace = join(root, 'workspace');
for (const d of [tbdir, join(vault, 'tasks'), bin, workspace, join(root, 'code'), join(root, 'remotes')]) mkdirSync(d, { recursive: true });
const socket = `tb-scope-${process.pid}`;
// this test can run inside a Taskboard task: drop the variables of that task and of the real server
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k))) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
// stand-ins for the agents: each records its arguments and keeps running
for (const name of ['claude', 'codex', 'agy']) { writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(root, `args-${name}`)}\nexec sleep 600\n`); chmodSync(join(bin, name), 0o755); }

function repo(name: string): string {
  const main = join(root, 'code', name), bare = join(root, 'remotes', `${name}.git`);
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master'); git(main, 'config', 'user.email', 'scope-test@example.invalid'); git(main, 'config', 'user.name', 'Scope Test');
  writeFileSync(join(main, 'readme.txt'), `${name}\n`); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', `start ${name}`);
  git(root, 'init', '-q', '--bare', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', '-q', 'origin', 'master');
  return realpathSync(main);
}
const alpha = repo('alpha'), beta = repo('beta'), gamma = repo('gamma');
// task #2 holds a worktree of beta at <beta>-wt, so a new worktree of beta for task #1 would be inside it
git(beta, 'worktree', 'add', '-q', '-b', 'task/other', `${beta}-wt`);
const taskNote = (f: Record<string, string | number | boolean>) => writeFileSync(join(vault, 'tasks', `${f.id}.md`),
  `---\n${Object.entries({ created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', statusAt: '2026-01-01T00:00:00.000Z', ...f }).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n# ${f.title}\n`);
// accounts in the test folder, not marked as default: Taskboard writes the folder trust of a default account into the
// real ~/.claude.json and ~/.codex/config.toml (workspace-trust.ts)
const testAccounts = ['claude', 'codex'].map(agent => ({ id: `${agent}-test`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: false, maxParallel: 8, created: new Date().toISOString() }));
for (const a of testAccounts) mkdirSync(a.dir, { recursive: true });
writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify(testAccounts));
taskNote({ id: 'plain-task', num: 1, title: 'Research without a worktree', agent: 'claude', account: 'claude-test', status: 'working', cwd: workspace, folder: workspace, session: 'task-1', sessionId: '11111111-2222-3333-4444-555555555555' });
taskNote({ id: 'other-task', num: 2, title: 'Other task', agent: 'codex', account: 'codex-test', status: 'idle', cwd: `${beta}-wt`, folder: beta, branch: 'task/other', worktree: true, session: 'task-2' });
const transcript = join(root, 'controller.jsonl');
writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'What does task 1 wait for?' } }) + '\n');
taskNote({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', role: 'controller', status: 'idle', cwd: workspace, folder: workspace, session: 'controller', transcript });
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'scope-test', controller: { autostart: false, remoteControl: false } }));
// a live session for task #1, so the approval must restart it after its turn
tmux('new-session', '-d', '-s', 'task-1', 'sleep 600');

test('a task without a worktree asks for scopes, and only the user approves them', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'scope-test' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`test server exited ${child.exitCode}: ${output}`);
      return (await fetch(base + '/api/info')).ok;
    }, { description: 'the scope test server to answer /api/info', timeoutMs: 60_000,
      state: () => `expected HTTP 200 at ${base}; server output:\n${output.slice(-3000)}` });
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const as = (actor: string) => ({ 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': actor });
    const user = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string> = as('plain-task')) => {
      const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const getTask = async (id: string) => (await (await fetch(base + '/api/tasks')).json()).find((t: { id: string }) => t.id === id);
    const tb = (args: string[], actor = 'plain-task') => spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...clean, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: actor }, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = (args: string[], actor = 'plain-task') => new Promise<{ code: number | null; out: string }>(resolve => {
      const p = tb(args, actor); let out = '';
      p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { out += b; }); p.on('close', code => resolve({ code, out }));
    });

    // 1. the refusals name tb scope request
    const commit = await post('/api/git/commit', { message: 'x' });
    assert.equal(commit.status, 400);
    assert.match(commit.data.error, /tb scope request worktree --repo/);
    const permit = await post('/api/permits', { reason: 'worktree', steps: [{ command: `git -C ${alpha} worktree add /tmp/x -b y` }] });
    assert.equal(permit.status, 400);
    assert.match(permit.data.error, /tb scope request worktree/);
    const guard = spawnSync(process.execPath, ['server/hooks/guard.mjs'], { input: JSON.stringify({ tool_input: { command: `git -C ${alpha} worktree add ../x` } }), encoding: 'utf8', env: { ...clean, TASKBOARD_DIR: tbdir, TASK_ID: 'plain-task' } });
    assert.match(guard.stdout, /no worktree.*tb scope request worktree --repo/);

    // 2. a request with tb: the card shows every value and check; the task and the controller cannot approve it
    const cli = tb(['scope', 'request', 'worktree', '--repo', alpha, '--base', 'origin/master', '--branch', 'task/alpha-change', '--reason', 'Change alpha']);
    let cliOut = ''; cli.stdout.on('data', b => { cliOut += b; }); cli.stderr.on('data', b => { cliOut += b; });
    const cliDone = new Promise(resolve => cli.on('close', resolve));
    const card = await waitFor(async (): Promise<{ id: string; detail: string; state: string } | undefined> =>
      (await (await fetch(base + '/api/approvals')).json()).find((a: { action: string; state: string }) => a.action === 'scope' && a.state === 'pending'),
    { description: 'the scope approval card', timeoutMs: 60_000,
      state: () => `expected a pending scope card; CLI:\n${cliOut}; server:\n${output.slice(-3000)}` });
    const alphaHead = git(alpha, 'rev-parse', 'HEAD');
    const path1 = join(`${alpha}-wt`, 'plain-task--alpha');
    for (const line of ['Task: #1 Research without a worktree', `Repository: ${alpha}`, `Base: origin/master at ${alphaHead}`, 'New branch: task/alpha-change', `Worktree folder: ${path1}`, 'Reason: Change alpha', 'is not changed', 'does not exist yet', 'does not overlap'])
      assert.ok(card.detail.includes(line), `${line}\n${card.detail}`);
    assert.equal((await post(`/api/approvals/${card.id}/approve`, {})).status, 403, 'a task without the dashboard origin');
    assert.equal((await post(`/api/approvals/${card.id}/approve`, {}, { ...as('plain-task'), origin: base })).status, 403, 'a task that sends an origin');
    assert.equal((await run(['scope', 'approve', card.id, '--user-request', `approve ${card.id}`])).code, 1, 'tb scope approve in a task');
    const ctl = await post(`/api/scope/${card.id}/controller-approve`, { userRequest: `approve ${card.id}` }, as('controller'));
    assert.equal(ctl.status, 403, 'the controller without the controller token and the user chat message');
    assert.equal((await (await fetch(`${base}/api/approvals/${card.id}`)).json()).state, 'pending');
    assert.ok(!existsSync(path1));

    // 3. the user approves: the server creates the branch and the worktree, and the main checkout stays as it was
    const approved = await post(`/api/approvals/${card.id}/approve`, {}, user);
    assert.equal(approved.data.state, 'approved', JSON.stringify(approved.data) + output);
    await cliDone;
    assert.match(cliOut, /Attached the worktree alpha/);
    assert.match(cliOut, /restarts this session after this turn ends/);
    assert.equal(git(path1, 'branch', '--show-current'), 'task/alpha-change');
    assert.equal(git(alpha, 'rev-parse', 'HEAD'), alphaHead);
    assert.equal(git(alpha, 'branch', '--show-current'), 'master');
    assert.equal(git(alpha, 'status', '--porcelain'), '');
    let plain = await getTask('plain-task');
    assert.equal(plain.scopes.length, 1);
    assert.deepEqual({ name: plain.scopes[0].name, branch: plain.scopes[0].branch, repo: plain.scopes[0].repo, path: plain.scopes[0].path }, { name: 'alpha', branch: 'task/alpha-change', repo: alpha, path: path1 });
    assert.equal(plain.restartWhenDone, true);

    // 4. the restart after the turn: the stand-in agent starts with --add-dir for the new worktree, and the note arrives
    await post('/api/hooks/claude', { taskId: 'plain-task', input: { hook_event_name: 'Stop' } }, { 'content-type': 'application/json', 'x-taskboard-token': token });
    const args = () => existsSync(join(root, 'args-claude')) ? readFileSync(join(root, 'args-claude'), 'utf8') : '';
    await waitFor(() => args().split('\n').join(' ').includes(`--add-dir ${path1}`), {
      description: 'the restarted agent to receive the attached worktree', timeoutMs: 90_000,
      state: () => `expected --add-dir ${path1}; args:\n${args()}; server:\n${output.slice(-3000)}`,
    });
    assert.match(args(), /Attached worktree alpha: branch task\/alpha-change/);
    // the same conversation id (--resume when a transcript exists, --session-id when the stand-in wrote none)
    assert.match(args(), /--(resume|session-id)\n11111111-2222-3333-4444-555555555555/);
    const inbox = join(vault, 'tasks', 'plain-task', 'inbox');
    const note = await waitFor(() => existsSync(inbox) && readdirSync(inbox).find(f => f.startsWith('scope-')), {
      description: 'the restarted task to receive its scope note', timeoutMs: 60_000,
      state: () => `expected a scope note in ${inbox}; args:\n${args()}; server:\n${output.slice(-3000)}`,
    });
    assert.ok(note);
    assert.match(readFileSync(join(vault, 'tasks', 'plain-task', 'inbox', note!), 'utf8'), /tb git commit --worktree alpha/);
    assert.equal((await getTask('plain-task')).restartWhenDone, undefined);
    // from here on the session is not live, so the next approvals add the scope without a restart
    tmux('kill-session', '-t', 'task-1');

    // 5. tb git uses the only attached worktree; rebase, check and push-request use the base that it started from
    writeFileSync(join(path1, 'change.txt'), 'alpha change\n');
    const c1 = await run(['git', 'commit', 'Add the alpha change']);
    assert.equal(c1.code, 0, c1.out);
    assert.match(c1.out, /on task\/alpha-change/);
    assert.equal(git(path1, 'log', '-1', '--format=%s'), 'Add the alpha change');
    writeFileSync(join(alpha, 'local-only.txt'), 'x\n'); git(alpha, 'add', '-A'); git(alpha, 'commit', '-q', '-m', 'local master only');
    const r1 = await run(['git', 'rebase']);
    assert.equal(r1.code, 0, r1.out);
    assert.match(r1.out, /onto origin\/master/);
    assert.ok(!existsSync(join(path1, 'local-only.txt')), 'the rebase did not use local master');
    const check = await run(['git', 'check']);
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /change\.txt/);
    const pushReq = await post('/api/git/push-request', { reason: 'Publish the alpha change' });
    assert.equal(pushReq.status, 202, JSON.stringify(pushReq.data));
    assert.match(pushReq.data.approval.detail, /Branch: task\/alpha-change/);
    assert.match(pushReq.data.approval.detail, /Base: origin\/master \(from the base this task last gave/);
    const pushed = await post(`/api/git/pushes/${pushReq.data.push.id}/decide`, { approve: true }, user);
    assert.equal(pushed.data.state, 'succeeded', JSON.stringify(pushed.data));
    assert.equal(git(alpha, 'ls-remote', 'origin', 'refs/heads/task/alpha-change').split(/\s/)[0], git(path1, 'rev-parse', 'HEAD'));
    assert.equal((await post('/api/git/push-request', { reason: 'x', branch: 'master' })).status, 400, 'the protected branch master');
    const merge = await post('/api/git/merge-request', {});
    assert.equal(merge.status, 202, JSON.stringify(merge.data));
    assert.match(merge.data.approval.detail, /Attached worktree: alpha/);
    assert.equal((await post(`/api/approvals/${merge.data.approval.id}/deny`, {}, user)).data.state, 'denied');

    // 6. a rejection: nothing changes
    const reject = await post('/api/scope/request', { kind: 'worktree', repo: gamma, base: 'origin/master', branch: 'task/rejected', reason: 'Try gamma' });
    assert.equal(reject.status, 202, JSON.stringify(reject.data));
    assert.equal((await post(`/api/approvals/${reject.data.approval.id}/deny`, {}, user)).data.state, 'denied');
    assert.equal(git(gamma, 'branch', '--list', 'task/rejected'), '');
    assert.equal((await getTask('plain-task')).scopes.length, 1);

    // 7. refusals: a folder inside the worktree of another task, a branch that exists, a local branch as the base
    const overlap = await post('/api/scope/request', { kind: 'worktree', repo: beta, base: 'origin/master', branch: 'task/beta-change', reason: 'Change beta' });
    assert.equal(overlap.status, 400);
    assert.match(overlap.data.error, /overlaps the worktree of task #2/);
    assert.match((await post('/api/scope/request', { kind: 'worktree', repo: gamma, base: 'origin/master', branch: 'master', reason: 'x' })).data.error, /protected/);
    assert.match((await post('/api/scope/request', { kind: 'worktree', repo: alpha, base: 'origin/master', branch: 'task/alpha-change', reason: 'x', name: 'again' })).data.error, /already exists/);
    assert.match((await post('/api/scope/request', { kind: 'worktree', repo: gamma, base: 'master', branch: 'task/g', reason: 'x' })).data.error, /remote branch/);
    assert.match((await post('/api/scope/request', { kind: 'read', path: join(root, '..'), reason: 'x' })).data.error, /too broad|overlaps/);

    // 8. a second worktree in a second repository, from a commit; tb git then needs --worktree
    const gammaHead = git(gamma, 'rev-parse', 'HEAD');
    const second = await post('/api/scope/request', { kind: 'worktree', repo: gamma, base: gammaHead.slice(0, 10), branch: 'task/gamma-change', reason: 'Change gamma' });
    assert.equal(second.status, 202, JSON.stringify(second.data));
    assert.match(second.data.approval.detail, new RegExp(`is a commit of this repository at ${gammaHead}`));
    assert.equal((await post(`/api/approvals/${second.data.approval.id}/approve`, {}, user)).data.state, 'approved');
    const path2 = join(`${gamma}-wt`, 'plain-task--gamma');
    assert.equal(git(path2, 'branch', '--show-current'), 'task/gamma-change');
    const both = await run(['git', 'commit', 'Which one']);
    assert.equal(both.code, 1);
    assert.match(both.out, /2 attached worktrees: alpha, gamma/);
    writeFileSync(join(path2, 'gamma.txt'), 'gamma\n');
    const c2 = await run(['git', 'commit', '--worktree', 'gamma', 'Add the gamma change']);
    assert.equal(c2.code, 0, c2.out);
    assert.equal(git(path2, 'log', '-1', '--format=%s'), 'Add the gamma change');
    writeFileSync(join(path1, 'second.txt'), 'second\n');
    const c3 = await run(['git', 'commit', '--worktree', path1, 'Second alpha change']);
    assert.equal(c3.code, 0, c3.out);
    assert.equal(git(path1, 'log', '-1', '--format=%s'), 'Second alpha change');
    assert.match((await run(['git', 'check', '--worktree', 'gamma', '--base', 'origin/master'])).out, /gamma\.txt/);
    assert.match((await run(['git', 'rebase', '--worktree', 'nothing'])).out, /no attached worktree nothing/);
    // the other task cannot use the worktrees of task #1
    assert.match((await post('/api/git/commit', { message: 'x', worktree: 'gamma' }, as('other-task'))).data.error, /no attached worktree gamma/);
    const list = await run(['scope', 'list']);
    assert.match(list.out, /alpha .*task\/alpha-change/);
    assert.match(list.out, /gamma .*task\/gamma-change/);

    // 9. read access to one more folder
    const docsDir = join(root, 'reference'); mkdirSync(docsDir); writeFileSync(join(docsDir, 'spec.md'), '# Spec\n');
    const read = await post('/api/scope/request', { kind: 'read', path: docsDir, reason: 'Read the spec' });
    assert.equal(read.status, 202, JSON.stringify(read.data));
    assert.match(read.data.approval.detail, /Read rule for this folder only/);
    assert.equal((await post(`/api/approvals/${read.data.approval.id}/approve`, {}, user)).data.state, 'approved');
    plain = await getTask('plain-task');
    assert.deepEqual(plain.scopes.map((s: { kind: string; name: string }) => `${s.kind}:${s.name}`), ['worktree:alpha', 'worktree:gamma', 'read:read-reference']);
    const settings = JSON.parse(readFileSync(join(tbdir, 'task-settings', 'plain-task.json'), 'utf8'));
    assert.equal(settings.permissions.allow.includes(`Read(/${docsDir}/**)`), false, 'the settings file is written at the next start');

    // 10. the controller approves only with the user's exact chat message that names the request
    const other = join(root, 'reference-2'); mkdirSync(other);
    const asked = await post('/api/scope/request', { kind: 'read', path: other, reason: 'Read more' });
    assert.equal(asked.status, 202, JSON.stringify(asked.data));
    const controller = { ...as('controller'), 'x-tb-mail-controller': readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim() };
    const words = `Yes, approve scope request ${asked.data.approval.id}`;
    const early = await post(`/api/scope/${asked.data.approval.id}/controller-approve`, { userRequest: words }, controller);
    assert.equal(early.status, 403, 'the user did not write these words');
    assert.match(early.data.error, /exact chat message/);
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: words } }) + '\n', { flag: 'a' });
    assert.equal((await post(`/api/scope/${asked.data.approval.id}/controller-approve`, { userRequest: 'approve it' }, controller)).status, 403, 'the words must name the request');
    const late = await post(`/api/scope/${asked.data.approval.id}/controller-approve`, { userRequest: words }, controller);
    assert.equal(late.status, 200, JSON.stringify(late.data));
    assert.equal(late.data.state, 'approved');

    // 11. archive keeps the attached worktrees; a removal keeps uncommitted work and the branch
    const archived = await post('/api/tasks/plain-task/kill', {}, user);
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    await waitFor(async () => (await getTask('plain-task'))?.status === 'archived', {
      description: 'the task archive request to reach archived status', timeoutMs: 60_000,
      state: async () => `expected archived; task: ${JSON.stringify(await getTask('plain-task'))}; server:\n${output.slice(-3000)}`,
    });
    assert.equal((await getTask('plain-task')).status, 'archived');
    assert.ok(existsSync(path1) && existsSync(path2));
    writeFileSync(join(path2, 'unsaved.txt'), 'work in progress\n');
    const dirty = await post('/api/tasks/plain-task/scopes/gamma/remove', {}, user);
    assert.equal(dirty.status, 400);
    assert.match(dirty.data.error, /uncommitted change.*unsaved\.txt/);
    assert.ok(existsSync(join(path2, 'unsaved.txt')));
    assert.equal((await post('/api/tasks/plain-task/scopes/alpha/remove', {}, as('plain-task'))).status, 403, 'a task cannot remove a scope');
    writeFileSync(join(path1, '.gitignore'), 'build/\n'); await run(['git', 'commit', '--worktree', 'alpha', 'Ignore build']);
    mkdirSync(join(path1, 'build')); writeFileSync(join(path1, 'build', 'out.js'), 'x\n');
    const ignored = await post('/api/tasks/plain-task/scopes/alpha/remove', {}, user);
    assert.equal(ignored.status, 409);
    assert.ok(ignored.data.ignored.some((f: string) => f.startsWith('build')), JSON.stringify(ignored.data));
    assert.ok(existsSync(path1));
    const removed = await post('/api/tasks/plain-task/scopes/alpha/remove', { confirm: true }, user);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.ok(!existsSync(path1));
    assert.equal(git(alpha, 'branch', '--list', 'task/alpha-change').trim().replace(/^[*+ ]+/, ''), 'task/alpha-change');
    assert.deepEqual((await getTask('plain-task')).scopes.map((s: { name: string }) => s.name), ['gamma', 'read-reference', 'read-reference-2']);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no tmux server */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
