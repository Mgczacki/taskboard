import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// A sandbox Taskboard server with its own port, folders and tmux socket, and a temporary repository with a bare remote.
const root = mkdtempSync(join(tmpdir(), 'tb-repair-route-'));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, 'main'), work = join(root, 'work'), bare = join(root, 'remote.git');
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault');
mkdirSync(main); mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
git(main, 'init', '-b', 'master'); git(main, 'config', 'user.email', 'repair-test@example.invalid'); git(main, 'config', 'user.name', 'Repair Test');
writeFileSync(join(main, 'base.txt'), 'base\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
git(root, 'init', '--bare', '-b', 'master', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', 'origin', 'master');
git(main, 'worktree', 'add', '-b', 'task-repair', work);
mkdirSync(join(work, '.pnpm-store')); writeFileSync(join(work, '.pnpm-store', 'pkg'), 'store\n'); writeFileSync(join(work, 'app.txt'), 'app\n');
git(work, 'add', '-A'); git(work, 'commit', '-m', 'add app and a package store');
git(work, 'rm', '-r', '-q', '.pnpm-store'); git(work, 'commit', '-m', 'remove the package store');
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
writeFileSync(join(vault, 'tasks', 'repair-task.md'), `---\nid: repair-task\nnum: 1\ntitle: Repair test\nagent: codex\nstatus: idle\ncwd: ${work}\nfolder: ${main}\nbranch: task-repair\nworktree: true\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Repair test\n`);
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });

test('the routes repair the branch, and the next push needs a force push card that the user approves', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault,
      TASKBOARD_TMUX_SOCKET: `tb-repair-route-${port}`, TASKBOARD_MACHINE_NAME: 'repair-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const taskHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'repair-task' };
    const userHeaders = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string> = taskHeaders) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };

    const controller = await post('/api/git/repair', { mode: 'squash', base: 'master', message: 'x' }, { ...taskHeaders, 'x-tb-actor': 'controller' });
    assert.equal(controller.status, 403);
    assert.equal((await post('/api/git/repair', { mode: 'reset' })).status, 400);
    assert.equal((await post('/api/git/rebase', { action: 'continue', base: 'origin/master' })).status, 400);
    assert.equal((await post('/api/git/push-request', { reason: 'test', force: true })).status, 400);
    for (const command of ['git reset --soft master', 'git rebase origin/prod', 'git update-ref refs/heads/task-repair HEAD~1', 'git push --force origin task-repair']) {
      const refused = await post('/api/permits', { reason: 'repair', steps: [{ command }] });
      assert.equal(refused.status, 400, command);
      assert.match(refused.data.error, /tb git/, command);
    }

    const check = await post('/api/git/check', {});
    assert.equal(check.status, 200);
    assert.match(check.data.result, /Warning: The history holds 1 path of type \.pnpm-store/);

    const first = await post('/api/git/push-request', { reason: 'first push' });
    assert.equal(first.status, 202, JSON.stringify(first.data));
    assert.doesNotMatch(first.data.approval.detail, /FORCE PUSH/);
    assert.match(first.data.approval.detail, /\.pnpm-store/);
    assert.equal((await post(`/api/git/pushes/${first.data.push.id}/decide`, { approve: true }, userHeaders)).data.state, 'succeeded');
    const oldRemote = git(main, 'ls-remote', 'origin', 'refs/heads/task-repair').split(/\s/)[0];

    const squash = await post('/api/git/repair', { mode: 'squash', base: 'master', message: 'Add the app' });
    assert.equal(squash.status, 200, JSON.stringify(squash.data));
    assert.match(squash.data.result, /Backup: refs\/taskboard-backup\/repair-task\//);
    assert.doesNotMatch(squash.data.result, /Warning/);
    const listed = await post('/api/git/repair', { mode: 'list' });
    assert.match(listed.data.result, /refs\/taskboard-backup\/repair-task\//);

    const forced = await post('/api/git/push-request', { reason: 'push the repaired branch' });
    assert.equal(forced.status, 202, JSON.stringify(forced.data));
    assert.equal(forced.data.approval.summary, 'force push task-repair to origin');
    assert.match(forced.data.approval.detail, new RegExp(`^FORCE PUSH: Yes\\. .*\\nApproving replaces ${oldRemote} on origin/task-repair`));
    assert.match(forced.data.approval.detail, /Commits that leave the remote branch: 2\n.*remove the package store/);
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task-repair').split(/\s/)[0], oldRemote);
    const agent = await post(`/api/git/pushes/${forced.data.push.id}/decide`, { approve: true });
    assert.equal(agent.status, 403);
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task-repair').split(/\s/)[0], oldRemote);
    const approved = await post(`/api/git/pushes/${forced.data.push.id}/decide`, { approve: true }, userHeaders);
    assert.equal(approved.data.state, 'succeeded', JSON.stringify(approved.data));
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task-repair').split(/\s/)[0], git(work, 'rev-parse', 'HEAD'));
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], git(main, 'rev-parse', 'master'));
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  }
});

test('the tb command sends the base and repair options and refuses force flags before any request', async () => {
  const seen: { path: string; body: unknown }[] = [];
  const server = createHttpServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { seen.push({ path: req.url || '', body: body ? JSON.parse(body) : null }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: 'ok' })); });
  });
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const tb = fileURLToPath(new URL('../bin/tb', import.meta.url));
  const run = (...args: string[]) => new Promise<{ code: number | null; err: string }>(resolve => {
    const c = spawn(process.execPath, [tb, ...args], { env: { ...process.env, TB_URL: `http://127.0.0.1:${port}`, TB_TOKEN_FILE: join(root, 'no-token'), TASK_ID: 'repair-task' } });
    let err = ''; c.stderr.on('data', d => { err += d; }); c.on('close', code => resolve({ code, err }));
  });
  try {
    assert.equal((await run('git', 'rebase', 'origin/prod')).code, 0);
    assert.equal((await run('git', 'rebase')).code, 0);
    assert.equal((await run('git', 'rebase', '--continue')).code, 0);
    assert.equal((await run('git', 'repair', '--squash', '--base', 'origin/master', '-m', 'One commit')).code, 0);
    assert.equal((await run('git', 'repair', '--drop', 'abc1234', '--base', 'origin/prod')).code, 0);
    assert.equal((await run('git', 'repair', '--restore', '20261001T000000Z')).code, 0);
    assert.equal((await run('git', 'repair', '--list')).code, 0);
    assert.equal((await run('git', 'check', '--base', 'origin/master')).code, 0);
    assert.deepEqual(seen, [
      { path: '/api/git/rebase', body: { action: 'start', base: 'origin/prod' } },
      { path: '/api/git/rebase', body: { action: 'start' } },
      { path: '/api/git/rebase', body: { action: 'continue' } },
      { path: '/api/git/repair', body: { mode: 'squash', base: 'origin/master', message: 'One commit' } },
      { path: '/api/git/repair', body: { mode: 'drop', base: 'origin/prod', commit: 'abc1234' } },
      { path: '/api/git/repair', body: { mode: 'restore', backup: '20261001T000000Z' } },
      { path: '/api/git/repair', body: { mode: 'list' } },
      { path: '/api/git/check', body: { base: 'origin/master' } },
    ]);
    seen.length = 0;
    for (const args of [['git', 'repair'], ['git', 'repair', '--squash', '--drop', 'abc1234'], ['git', 'rebase', '--onto', 'x'], ['git', 'rebase', 'a', 'b'],
      ['git', 'push-request', '--reason', 'x', '--force'], ['git', 'push-request', '--reason', 'x', '--force-with-lease']])
      assert.equal((await run(...args)).code, 1, args.join(' '));
    assert.deepEqual(seen, []);
  } finally { server.close(); }
});
