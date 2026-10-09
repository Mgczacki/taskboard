import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// tb git merge-from (server/task-merge-base.ts). Each test makes its own temporary repository with a bare remote whose
// default branch is main, like a repository without local master. No test touches a real project.
const top = mkdtempSync(join(tmpdir(), 'tb-merge-from-'));
process.env.TASKBOARD_DIR = join(top, 'tbdir');
process.env.TASKBOARD_VAULT = join(top, 'vault');
mkdirSync(join(top, 'tbdir'), { recursive: true });
const { mergeBaseTask } = await import('../server/task-merge-base.ts');
const { commitTask } = await import('../server/task-git.ts');
const { gitTarget } = await import('../server/scopes.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(top, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
let n = 0;
// A main checkout cloned from a bare remote on main, a task worktree whose branch is pushed, and a second clone
// (`other`) that pushes new commits to origin/main.
function setup(branch = `task/merge-${n + 1}`) {
  const root = join(top, `repo-${++n}`);
  const seed = join(root, 'seed'), main = join(root, 'main'), work = join(root, 'task'), bare = join(root, 'remote.git'), other = join(root, 'other');
  mkdirSync(seed, { recursive: true });
  const identity = (cwd: string) => { git(cwd, 'config', 'user.email', 'merge-test@example.invalid'); git(cwd, 'config', 'user.name', 'Merge Test'); };
  git(seed, 'init', '-b', 'main'); identity(seed);
  writeFileSync(join(seed, 'shared.txt'), 'base\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'base');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', 'origin', 'main');
  git(root, 'clone', bare, main); identity(main);
  git(root, 'clone', bare, other); identity(other);
  git(main, 'worktree', 'add', '-b', branch, work, 'origin/main');
  const task = { id: `merge-${n}`, num: n, title: 'Merge', agent: 'claude', cwd: work, folder: main, branch, worktree: true, role: 'task' } as Task;
  const commitOther = (file: string, body: string, message: string) => {
    git(other, 'pull', '-q', 'origin', 'main'); writeFileSync(join(other, file), body);
    git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', message); git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { root, main, work, bare, task, branch, commitOther };
}
const parents = (cwd: string, ref = 'HEAD') => git(cwd, 'rev-list', '--parents', '-n', '1', ref).split(' ').slice(1);
const isAncestor = (cwd: string, a: string, b: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;

test('a clean merge of origin/main keeps the pushed task commits and needs no force push', async () => {
  const { work, task, branch, commitOther } = setup();
  writeFileSync(join(work, 'task.txt'), 'task\n');
  await commitTask(task, 'Task change');
  git(work, 'push', '-q', 'origin', branch);
  const pushed = git(work, 'rev-parse', 'HEAD');
  const upstream = commitOther('upstream.txt', 'upstream\n', 'Upstream change');

  const result = await mergeBaseTask(task, 'start', 'origin/main');
  assert.match(result, /Merged origin\/main into task\/merge-1 at [0-9a-f]+/);
  assert.match(result, /Undo: tb git repair --restore refs\/taskboard-backup\/merge-1\//);
  assert.deepEqual(parents(work), [pushed, upstream], 'one merge commit: first parent is the old head, second is origin/main');
  assert.equal(git(work, 'log', '-1', '--format=%s'), `Merge origin/main into ${branch}`);
  assert.equal(git(work, 'branch', '--show-current'), branch);
  assert.ok(isAncestor(work, `refs/remotes/origin/${branch}`, 'HEAD'), 'the pushed head is an ancestor, so a normal push is a fast-forward');
  assert.equal(readFileSync(join(work, 'upstream.txt'), 'utf8'), 'upstream\n');
  assert.equal(git(work, 'status', '--porcelain'), '');
  git(work, 'push', '-q', 'origin', branch); // a push without --force succeeds
  assert.match(await mergeBaseTask(task, 'start', 'origin/main'), /already contains origin\/main; nothing to merge/);
});

test('a merge with a conflict stages only the named files and finishes with --continue', async () => {
  const { work, task, commitOther } = setup();
  writeFileSync(join(work, 'shared.txt'), 'task\n');
  await commitTask(task, 'Task change');
  const head = git(work, 'rev-parse', 'HEAD');
  const upstream = commitOther('shared.txt', 'upstream\n', 'Upstream change');

  await assert.rejects(mergeBaseTask(task, 'start', 'origin/main'), (e: Error) =>
    /The merge has conflicts in these files:\n- shared\.txt\n/.test(e.message) && /tb git merge-from --continue/.test(e.message));
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'the branch head does not move on a conflict');
  await assert.rejects(commitTask(task, 'Would commit conflict markers'), /A merge is in progress/);
  await assert.rejects(mergeBaseTask(task, 'start', 'origin/main'), /A merge is in progress/);
  await assert.rejects(mergeBaseTask(task, 'continue'), /still unmerged:\n- shared\.txt/);
  await assert.rejects(mergeBaseTask(task, 'continue', undefined, ['shared.txt']), /Resolve conflict markers in shared\.txt/);
  for (const bad of ['../shared.txt', '/etc/hosts', 'missing.txt', ''])
    await assert.rejects(mergeBaseTask(task, 'continue', undefined, [bad]), /Give --stage one file path/, bad);

  writeFileSync(join(work, 'shared.txt'), 'task and upstream\n');
  writeFileSync(join(work, 'scratch.txt'), 'not named\n'); // a file that is not named stays out of the merge commit
  const result = await mergeBaseTask(task, 'continue', undefined, ['shared.txt']);
  assert.match(result, /Finished the merge into task\/merge-2 at [0-9a-f]+/);
  assert.match(result, /not named with --stage; they are not in the merge commit/);
  assert.deepEqual(parents(work), [head, upstream]);
  assert.equal(git(work, 'show', 'HEAD:shared.txt'), 'task and upstream');
  assert.equal(spawnSync('git', ['cat-file', '-e', 'HEAD:scratch.txt'], { cwd: work }).status === 0, false);
  assert.equal(git(work, 'status', '--porcelain'), '?? scratch.txt');
  assert.equal(existsSync(join(task.folder, '.git', 'worktrees', 'task', 'MERGE_HEAD')), false);
});

test('tb git merge-from --abort restores the branch as before the merge', async () => {
  const { work, task, commitOther } = setup();
  writeFileSync(join(work, 'shared.txt'), 'task\n');
  await commitTask(task, 'Task change');
  const head = git(work, 'rev-parse', 'HEAD');
  commitOther('shared.txt', 'upstream\n', 'Upstream change');
  await assert.rejects(mergeBaseTask(task, 'abort'), /No merge is in progress/);
  await assert.rejects(mergeBaseTask(task, 'start', 'origin/main'), /conflicts/);
  assert.match(await mergeBaseTask(task, 'abort'), /Aborted the merge into task\/merge-3/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(work, 'shared.txt'), 'utf8'), 'task\n');
  assert.equal(git(work, 'for-each-ref', 'refs/taskboard-backup/merge-3/'), '', 'an aborted merge saves no backup');
  await assert.rejects(mergeBaseTask(task, 'continue'), /No merge is in progress/);
});

test('a task cannot merge into a foreign worktree, a protected branch, or with local changes', async () => {
  const { main, work, task } = setup();
  // a second task's worktree in the same repository
  const foreign = join(task.folder, '..', 'foreign');
  git(main, 'worktree', 'add', '-b', 'task/foreign', foreign, 'origin/main');
  const foreignHead = git(foreign, 'rev-parse', 'HEAD');
  // scopes.gitTarget (used by POST /api/git/merge-from) accepts only the task's own and attached worktrees
  assert.throws(() => gitTarget(task, foreign), /This task has no attached worktree/);
  assert.throws(() => gitTarget(task, 'foreign'), /This task has no attached worktree/);
  // a task copy that points at the foreign worktree is refused because that worktree does not hold the task branch
  await assert.rejects(mergeBaseTask({ ...task, cwd: foreign }, 'start', 'origin/main'), /task branch changed/);
  assert.equal(git(foreign, 'rev-parse', 'HEAD'), foreignHead);
  // the main checkout is not a task worktree
  await assert.rejects(mergeBaseTask({ ...task, cwd: main, branch: 'main' }, 'start', 'origin/main'), /main checkout/);
  // a protected branch (release/*) in a worktree is refused before any Git change
  const release = join(task.folder, '..', 'release');
  git(main, 'worktree', 'add', '-b', 'release/1', release, 'origin/main');
  await assert.rejects(mergeBaseTask({ ...task, cwd: release, branch: 'release/1' }, 'start', 'origin/main'), /release\/1 is a protected branch/);
  // a base that is not master or a remote branch, and uncommitted changes
  await assert.rejects(mergeBaseTask(task, 'start', 'task/foreign'), /not a remote branch/);
  writeFileSync(join(work, 'dirty.txt'), 'dirty\n');
  await assert.rejects(mergeBaseTask(task, 'start', 'origin/main'), /local changes; run tb git commit/);
});
