import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-push-route-'));
const main = join(root, 'main'), work = join(root, 'work'), bare = join(root, 'remote.git');
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault');
mkdirSync(main); mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
git(main, 'init', '-b', 'master'); git(main, 'config', 'user.email', 'push-test@example.invalid'); git(main, 'config', 'user.name', 'Push Test');
writeFileSync(join(main, 'base.txt'), 'base\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
git(root, 'init', '--bare', bare); git(main, 'remote', 'add', 'origin', bare); git(main, 'push', 'origin', 'master');
git(main, 'worktree', 'add', '-b', 'task-push', work);
writeFileSync(join(work, '.env'), 'api_key=example-secret-value-12345\n'); git(work, 'add', '-A'); git(work, 'commit', '-m', 'add secret fixture');
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
writeFileSync(join(vault, 'tasks', 'push-task.md'), `---\nid: push-task\nnum: 1\ntitle: Push test\nagent: codex\nstatus: idle\ncwd: ${work}\nfolder: ${main}\nbranch: task-push\nworktree: true\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Push test\n`);

test('a sandbox server shows and decides a push to a local bare remote', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const address = s.address(); const port = typeof address === 'object' && address ? address.port : 0; s.close(() => resolve(port)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault,
      TASKBOARD_TMUX_SOCKET: `tb-push-route-${port}`, TASKBOARD_MACHINE_NAME: 'push-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const taskHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'push-task' };
    const post = async (path: string, body: unknown, headers: Record<string, string> = taskHeaders) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const force = await post('/api/git/push-request', { reason: 'test', force: true });
    assert.equal(force.status, 400);
    const request = await post('/api/git/push-request', { reason: 'test the card', thenRelease: true });
    assert.equal(request.status, 202, output);
    const { push, approval } = request.data;
    assert.match(approval.detail, /Remote: .*remote\.git/);
    assert.match(approval.detail, /Branch: task-push/);
    assert.match(approval.detail, /add secret fixture/);
    assert.match(approval.detail, /Files changed:/);
    assert.match(approval.detail, /quick diff scan found a line/);
    if (process.env.PUSH_CARD_PREVIEW) {
      writeFileSync(process.env.PUSH_CARD_PREVIEW, base);
      while (!existsSync(process.env.PUSH_CARD_PREVIEW + '.done')) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const agent = await post(`/api/git/pushes/${push.id}/decide`, { approve: true });
    assert.equal(agent.status, 403);
    const controller = await post(`/api/git/pushes/${push.id}/decide`, { approve: true }, { ...taskHeaders, 'x-tb-actor': 'controller' });
    assert.equal(controller.status, 403);
    const deniedPermit = await post('/api/permits', { reason: 'push', steps: [{ command: 'git push --force origin task-push' }] });
    assert.equal(deniedPermit.status, 400);
    assert.match(deniedPermit.data.error, /tb git push-request/);
    assert.ok(deniedPermit.data.refusal);
    const userHeaders = { 'content-type': 'application/json', origin: base };
    const decided = await post(`/api/git/pushes/${push.id}/decide`, { approve: true }, userHeaders);
    assert.equal(decided.status, 200, output);
    assert.equal(decided.data.state, 'succeeded', JSON.stringify(decided.data));
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task-push').split(/\s/)[0], push.newHead);
    const approvals = await (await fetch(base + '/api/approvals')).json();
    assert.ok(approvals.some((a: { action: string; state: string }) => a.action === 'release' && a.state === 'pending'));
    assert.equal((await post(`/api/git/pushes/${push.id}/decide`, { approve: true }, userHeaders)).data.state, 'succeeded');
    writeFileSync(join(main, 'other.txt'), 'other task\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'Other task change');
    git(main, 'merge', '--no-ff', '--no-edit', 'task-push');
    const permit = await post('/api/permits', { reason: 'Push merged master', steps: [{ command: 'git push origin master', network: true }] });
    assert.equal(permit.status, 202, JSON.stringify(permit.data));
    assert.match(permit.data.message, /tb git push-request/);
    assert.equal(permit.data.approval.action, 'git-push');
    assert.match(permit.data.approval.detail, /commits from other tasks or people/);
    const refused = await post(`/api/git/pushes/${permit.data.push.id}/decide`, { approve: false, comment: 'Check the merged commits.' }, userHeaders);
    assert.equal(refused.data.state, 'denied');
    assert.match(refused.data.result, /Check the merged commits/);
    const expiring = await post('/api/git/push-request', { reason: 'Check restart expiry', branch: 'master' });
    assert.equal(expiring.status, 202);
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    restarted = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(),
      env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault,
        TASKBOARD_TMUX_SOCKET: `tb-push-route-${port}`, TASKBOARD_MACHINE_NAME: 'push-test' }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const expired = await (await fetch(base + `/api/git/pushes/${expiring.data.push.id}`, { headers: taskHeaders })).json();
    assert.equal(expired.state, 'expired');
    assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/master').split(/\s/)[0], git(main, 'rev-parse', 'HEAD~2'));
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (restarted && restarted.exitCode === null) { restarted.kill('SIGTERM'); await new Promise(resolve => restarted!.once('exit', resolve)); }
    rmSync(root, { recursive: true, force: true });
  }
});
