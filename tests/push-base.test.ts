import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Each test makes its own temporary repository with a bare remote. No test touches a real project.
const top = mkdtempSync(join(tmpdir(), 'tb-push-base-'));
process.env.TASKBOARD_DIR = join(top, 'tbdir');
process.env.TASKBOARD_VAULT = join(top, 'vault');
mkdirSync(join(top, 'tbdir'), { recursive: true });
// The large test makes thousands of loose objects. A background git gc must not change them while the test runs.
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0' });
const push = await import('../server/push.ts');
const taskGit = await import('../server/task-git.ts');
const { checkTask, dropCommit, squashTask } = await import('../server/task-repair.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(top, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
let n = 0;
// A main checkout on `mainBranch`, a bare remote whose HEAD is `mainBranch`, and a task worktree.
// With clone = false, the main checkout has no refs/remotes/origin/HEAD.
function setup(mainBranch: string, { clone = true } = {}) {
  const root = join(top, `repo-${++n}`);
  const seed = join(root, 'seed'), main = join(root, 'main'), work = join(root, 'task'), bare = join(root, 'remote.git');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-b', mainBranch);
  git(seed, 'config', 'user.email', 'base-test@example.invalid'); git(seed, 'config', 'user.name', 'Base Test');
  writeFileSync(join(seed, 'base.txt'), 'base\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'base');
  git(root, 'init', '--bare', '-b', mainBranch, bare);
  git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', 'origin', mainBranch);
  git(root, 'clone', bare, main);
  // Git 2.48 and later also create refs/remotes/origin/HEAD on fetch, so the test deletes it.
  if (!clone) git(main, 'remote', 'set-head', 'origin', '--delete');
  git(main, 'config', 'user.email', 'base-test@example.invalid'); git(main, 'config', 'user.name', 'Base Test');
  const branch = `task/base-${n}`;
  git(main, 'worktree', 'add', '-b', branch, work);
  const task = { id: `base-${n}`, num: n, title: 'Base', agent: 'codex', cwd: work, folder: main, branch, worktree: true } as Task;
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, body] of Object.entries(files)) { mkdirSync(join(work, name, '..'), { recursive: true }); writeFileSync(join(work, name), body); }
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  return { root, seed, main, work, bare, task, branch, commit };
}

test('a repository with no master branch uses origin/prod from refs/remotes/origin/HEAD', async () => {
  const { main, task, commit } = setup('prod');
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/master'], { cwd: main }).status, 0, 'the test repository has no master');
  commit({ 'src/a.ts': 'export const a = 1;\n' }, 'Add a');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.base, 'origin/prod');
  assert.match(state.baseSource, /refs\/remotes\/origin\/HEAD/);
  assert.equal(state.branch, task.branch);
  assert.equal(state.commitCount, 1);
  assert.deepEqual(state.topFiles, ['src/a.ts']);
  // tb git check and tb git repair use the same base when the task gives none.
  assert.match(await checkTask(task), /against origin\/prod:/);
  const drop = commit({ 'src/b.ts': 'export const b = 1;\n' }, 'Add b');
  assert.match(await dropCommit(task, drop), /Removed/);
  // tb git merge-request merges only into local master and says so.
  await assert.rejects(taskGit.mergeState(task), /no local master branch/);
});

test('an explicit base wins, is shown on the card, and an unknown base is refused', async () => {
  const { task, commit } = setup('prod');
  commit({ 'src/a.ts': 'a\n' }, 'Add a');
  const state = await push.inspectPush(task, 'Publish the task branch', { base: 'origin/prod' });
  assert.equal(state.base, 'origin/prod');
  assert.match(state.baseSource, /--base/);
  await assert.rejects(push.inspectPush(task, 'Publish the task branch', { base: 'origin/nothing' }), /not a branch/);
});

test('a base that tb git rebase or tb git repair used is recorded and used next', async () => {
  const { seed, task, commit } = setup('prod');
  git(seed, 'push', 'origin', 'prod:staging');
  commit({ 'src/a.ts': 'a\n' }, 'Add a');
  await taskGit.rebaseTask(task, 'start', undefined, 'origin/staging');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.base, 'origin/staging');
  assert.match(state.baseSource, /tb git rebase or tb git repair/);
  await squashTask(task, 'origin/prod', 'One commit');
  assert.equal((await push.inspectPush(task, 'Publish the task branch')).base, 'origin/prod');
});

test('an unclear base is refused with a message that names --base', async () => {
  const { main, task, commit } = setup('prod', { clone: false });
  commit({ 'src/a.ts': 'a\n' }, 'Add a');
  await assert.rejects(push.inspectPush(task, 'Publish the task branch'), /--base/);
  await assert.rejects(checkTask(task), /--base/);
  // A configured value in the repository settles it.
  git(main, 'config', 'taskboard.base', 'origin/prod');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.base, 'origin/prod');
  assert.match(state.baseSource, /taskboard\.base/);
});

test('a repository that uses master keeps its behavior', async () => {
  const { main, task, branch, commit } = setup('master');
  commit({ 'a.txt': 'a\n' }, 'Add a');
  const state = await push.inspectPush(task, 'Publish the task branch');
  assert.equal(state.base, 'origin/master');
  assert.equal(state.branch, branch);
  assert.equal(state.commitCount, 1);
  assert.match(await checkTask(task), /against master:/);
  assert.match(await taskGit.rebaseTask(task), /onto local master/);
  // After the merge into local master, the request that names master pushes master.
  git(main, 'merge', '--ff-only', branch);
  const merged = await push.inspectPush(task, 'Publish master', { branch: 'master' });
  assert.equal(merged.branch, 'master');
  assert.equal(merged.commitCount, 1);
});

test('a large branch with a long history produces a normal card with limited lists', async () => {
  const { seed, task, commit } = setup('master');
  // The base history holds more than 16 MB of patches. The old code read all of it for a new remote branch.
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(seed, 'blob.txt'), `${i}\n`.repeat(200000) + 'x'.repeat(1024 * 1024));
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', `history ${i}`);
  }
  git(seed, 'push', '-q', 'origin', 'master');
  git(task.cwd, 'fetch', '-q', 'origin');
  git(task.cwd, 'reset', '-q', '--hard', 'origin/master');
  // The branch itself changes 3000 files in 120 commits.
  for (let c = 0; c < 120; c++) {
    const files: Record<string, string> = {};
    for (let f = 0; f < 25; f++) files[`many/${c}/${f}.txt`] = `${c} ${f}\n`;
    commit(files, `Change ${c}`);
  }
  const state = await push.inspectPush(task, 'Publish the large branch');
  assert.equal(state.commitCount, 120);
  assert.equal(state.commits.length, push.CARD_COMMITS);
  assert.equal(state.fileCount, 3000);
  assert.equal(state.topFiles.length, push.CARD_FILES);
  const card = push.pushCardDetail(state);
  assert.match(card, /and 70 more commits/);
  assert.match(card, /and 2980 more files/);
  assert.match(card, /^Base: origin\/master/m);
  assert.ok(card.length < 20000, `the card has ${card.length} characters`);
});
