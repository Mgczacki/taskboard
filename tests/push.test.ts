import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-push-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(join(root, 'tbdir'), { recursive: true });
const push = await import('../server/push.ts');
type Task = import('../server/store.ts').Task;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const main = join(root, 'main'), work = join(root, 'work'), bare = join(root, 'remote.git');
mkdirSync(main);
git(main, 'init', '-b', 'master');
git(main, 'config', 'user.email', 'push-test@example.invalid');
git(main, 'config', 'user.name', 'Push Test');
writeFileSync(join(main, 'base.txt'), 'base\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
git(root, 'init', '--bare', bare);
git(main, 'remote', 'add', 'origin', bare);
git(main, 'push', 'origin', 'master');
git(main, 'worktree', 'add', '-b', 'task-push', work);
const task = { id: 'push-test', num: 1, title: 'Push test', agent: 'codex', cwd: work, folder: main, branch: 'task-push', worktree: true } as Task;
const commit = (name: string, body: string) => { writeFileSync(join(work, name), body); git(work, 'add', '-A'); git(work, 'commit', '-m', name); };

test('the card lists commits and files and warns about secrets', async () => {
  commit('.env', 'api_key=example-secret-value-12345\n');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.remoteUrl, bare);
  assert.equal(state.branch, 'task-push');
  assert.equal(state.fastForward, true);
  assert.equal(state.needsCard, true);
  assert.ok(state.commits.some(c => c.subject === '.env' && c.author.includes('Push Test')));
  assert.ok(state.topFiles.includes('.env'));
  assert.ok(state.warnings.some(w => w.includes('look like secrets')));
  assert.ok(state.warnings.some(w => w.includes('quick diff scan found a line')));
});

test('a changed local head or remote head stops the approved push', async () => {
  const state = await push.inspectPush(task, 'Publish the task branch');
  commit('next.txt', 'next\n');
  await assert.rejects(push.runPush(task, state), /The branch changed/);
  const newer = await push.inspectPush(task, 'Publish the task branch');
  git(work, 'push', 'origin', 'task-push');
  await assert.rejects(push.runPush(task, newer), /The branch changed/);
});

test('a remote commit that is not an ancestor blocks the push', async () => {
  const other = join(root, 'other');
  git(root, 'clone', '--branch', 'task-push', bare, other);
  git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'user.name', 'Other Person');
  writeFileSync(join(other, 'remote.txt'), 'remote\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'remote'); git(other, 'push', 'origin', 'task-push');
  commit('local.txt', 'local\n');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.fastForward, false);
  await assert.rejects(push.runPush(task, state), /fast-forward/);
});

test('only an own unprotected task branch on origin can run without a card', () => {
  const settings = { taskBranches: 'run' as const, ownRepositories: [] as string[], protectedBranches: [] as string[] };
  const needs = (branch: string, remote: string, url: string, login = 'owner', policy = settings) =>
    push.pushNeedsCard('task-push', branch, remote, url, 'master', login, policy);
  assert.equal(needs('task-push', 'origin', 'git@github.com:owner/repo.git'), false);
  assert.equal(needs('task-push', 'origin', 'git@github.com:company/repo.git'), true);
  assert.equal(needs('master', 'origin', 'git@github.com:owner/repo.git'), true);
  assert.equal(needs('task-push', 'backup', 'git@github.com:owner/repo.git'), true);
  assert.equal(needs('task-push', 'origin', 'git@github.com:company/repo.git', 'owner', { ...settings, ownRepositories: ['company/repo'] }), false);
  assert.equal(needs('task-push', 'origin', 'git@github.com:owner/repo.git', 'owner', { ...settings, protectedBranches: ['task-push'] }), true);
  assert.equal(needs('task-push', 'origin', 'git@github.com:owner/repo.git', 'owner', { ...settings, taskBranches: 'ask' as const }), true);
  assert.throws(() => needs('task-push', 'origin', 'git@github.com:owner/repo.git', 'owner', { ...settings, taskBranches: 'never' as const }), /Settings block/);
});

test('a push card expires after ten minutes', () => {
  const created = '2026-01-01T00:00:00.000Z';
  assert.equal(push.pushExpired(created, Date.parse(created) + 599999), false);
  assert.equal(push.pushExpired(created, Date.parse(created) + 600000), true);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
