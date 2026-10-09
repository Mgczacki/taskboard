import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// POST /api/git/merge-from on a sandbox Taskboard server with its own port, folders and tmux socket. Two tasks hold one
// worktree each in a temporary repository with a bare remote. Nothing here uses the real Taskboard or a real repository.
const root = mkdtempSync(join(tmpdir(), 'tb-merge-from-route-'));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, 'main'), workA = join(root, 'work-a'), workB = join(root, 'work-b'), other = join(root, 'other'), bare = join(root, 'remote.git');
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault');
mkdirSync(main); mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
const identity = (cwd: string) => { git(cwd, 'config', 'user.email', 'merge-route@example.invalid'); git(cwd, 'config', 'user.name', 'Merge Route'); };
git(main, 'init', '-b', 'main'); identity(main);
writeFileSync(join(main, 'shared.txt'), 'base\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
git(root, 'init', '--bare', '-b', 'main', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', '-u', 'origin', 'main');
git(main, 'fetch', 'origin'); git(main, 'remote', 'set-head', 'origin', 'main');
git(main, 'worktree', 'add', '-b', 'task/a', workA, 'origin/main');
git(main, 'worktree', 'add', '-b', 'task/b', workB, 'origin/main');
writeFileSync(join(workA, 'shared.txt'), 'task a\n'); git(workA, 'commit', '-qam', 'Task A change'); git(workA, 'push', '-q', 'origin', 'task/a');
git(root, 'clone', '-q', bare, other); identity(other);
writeFileSync(join(other, 'shared.txt'), 'upstream\n'); writeFileSync(join(other, 'new.txt'), 'new\n');
git(other, 'add', '-A'); git(other, 'commit', '-qm', 'Upstream change'); git(other, 'push', '-q', 'origin', 'main');
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
const note = (id: string, num: number, cwd: string, branch: string) => writeFileSync(join(vault, 'tasks', `${id}.md`),
  `---\nid: ${id}\nnum: ${num}\ntitle: Merge ${id}\nagent: codex\nstatus: idle\ncwd: ${cwd}\nfolder: ${main}\nbranch: ${branch}\nworktree: true\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Merge ${id}\n`);
note('task-a', 1, workA, 'task/a');
note('task-b', 2, workB, 'task/b');
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });

test('the route merges only into the actor task worktree and supports conflict, continue and abort', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault,
      TASKBOARD_TMUX_SOCKET: `tb-merge-from-route-${port}`, TASKBOARD_MACHINE_NAME: 'merge-from-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    // the server writes a token for each task at start (server/task-token.ts). A task must send its own token.
    const taskToken = (actor: string) => { try { return readFileSync(join(tbdir, 'task-tokens', actor), 'utf8').trim(); } catch { return ''; } };
    const as = (actor: string) => ({ 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': actor, 'x-tb-task-token': taskToken(actor) });
    const post = async (body: unknown, actor = 'task-a') => {
      const response = await fetch(base + '/api/git/merge-from', { method: 'POST', headers: as(actor), body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as { result?: string; error?: string } };
    };
    const headA = git(workA, 'rev-parse', 'HEAD'), headB = git(workB, 'rev-parse', 'HEAD');

    // the controller, a bad action, and a base or --stage in the wrong action are refused before any Git command
    assert.equal((await post({ action: 'start', base: 'origin/main' }, 'controller')).status, 403);
    assert.equal((await post({ action: 'reset' })).status, 400);
    assert.equal((await post({ action: 'continue', base: 'origin/main' })).status, 400);
    assert.equal((await post({ action: 'start', base: 'origin/main', stage: ['shared.txt'] })).status, 400);
    // task A cannot name the worktree of task B, by path or by name
    for (const worktree of [workB, 'work-b', 'task/b']) {
      const foreign = await post({ action: 'start', base: 'origin/main', worktree });
      assert.equal(foreign.status, 400, worktree);
      assert.match(foreign.data.error || '', /This task has no attached worktree/, worktree);
    }
    assert.equal(git(workB, 'rev-parse', 'HEAD'), headB);
    assert.equal(git(workB, 'status', '--porcelain'), '');

    // a conflict, an abort, the conflict again, and a continue that stages only the named file
    const conflict = await post({ action: 'start', base: 'origin/main' });
    assert.equal(conflict.status, 400);
    assert.match(conflict.data.error || '', /conflicts in these files:\n- shared\.txt/);
    assert.match((await post({ action: 'abort' })).data.result || '', /Aborted the merge into task\/a/);
    assert.equal(git(workA, 'rev-parse', 'HEAD'), headA);
    assert.equal(git(workA, 'status', '--porcelain'), '');
    assert.equal((await post({ action: 'start', base: 'origin/main' })).status, 400);
    writeFileSync(join(workA, 'shared.txt'), 'task a and upstream\n');
    const done = await post({ action: 'continue', stage: ['shared.txt'] });
    assert.equal(done.status, 200, done.data.error);
    assert.match(done.data.result || '', /Finished the merge into task\/a/);
    assert.deepEqual(git(workA, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1), [headA, git(main, 'rev-parse', 'origin/main')]);
    assert.equal(git(workA, 'show', 'HEAD:new.txt'), 'new');
    git(workA, 'push', '-q', 'origin', 'task/a'); // a fast-forward push: no force
    // task B and local main did not change
    assert.equal(git(workB, 'rev-parse', 'HEAD'), headB);
    assert.equal(git(main, 'branch', '--show-current'), 'main');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  }
});

test('the tb command sends the merge-from options and refuses other forms before any request', async () => {
  const seen: { path: string; body: unknown }[] = [];
  const server = createHttpServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { seen.push({ path: req.url || '', body: body ? JSON.parse(body) : null }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: 'ok' })); });
  });
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const tb = fileURLToPath(new URL('../bin/tb', import.meta.url));
  const run = (...args: string[]) => new Promise<{ code: number | null; err: string }>(resolve => {
    const c = spawn(process.execPath, [tb, ...args], { env: { ...process.env, TB_URL: `http://127.0.0.1:${port}`, TB_TOKEN_FILE: join(root, 'no-token'), TB_TASK_TOKEN: 'test', TASK_ID: 'task-a' } });
    let err = ''; c.stderr.on('data', d => { err += d; }); c.on('close', code => resolve({ code, err }));
  });
  try {
    assert.equal((await run('git', 'merge-from', 'origin/main')).code, 0);
    assert.equal((await run('git', 'merge-from', '--continue', '--stage', 'a.txt', '--stage', 'dir/b.txt')).code, 0);
    assert.equal((await run('git', 'merge-from', '--continue')).code, 0);
    assert.equal((await run('git', 'merge-from', '--abort', '--worktree', 'python')).code, 0);
    assert.deepEqual(seen, [
      { path: '/api/git/merge-from', body: { action: 'start', base: 'origin/main' } },
      { path: '/api/git/merge-from', body: { action: 'continue', stage: ['a.txt', 'dir/b.txt'] } },
      { path: '/api/git/merge-from', body: { action: 'continue' } },
      { path: '/api/git/merge-from', body: { action: 'abort', worktree: 'python' } },
    ]);
    seen.length = 0;
    for (const args of [['git', 'merge-from'], ['git', 'merge-from', 'a', 'b'], ['git', 'merge-from', '--abort', 'x'], ['git', 'merge-from', '--squash'],
      ['git', 'merge-from', '--continue', '--stage'], ['git', 'merge-from', '--continue', 'a.txt'], ['git', 'merge-from', '--continue', '--stage', '--abort']])
      assert.equal((await run(...args)).code, 1, args.join(' '));
    assert.deepEqual(seen, []);
  } finally { server.close(); }
});
