import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Every test makes its own temporary repository with a bare remote. No test touches a real project.
const top = mkdtempSync(join(tmpdir(), 'tb-repair-'));
process.env.TASKBOARD_DIR = join(top, 'tbdir');
process.env.TASKBOARD_VAULT = join(top, 'vault');
mkdirSync(join(top, 'tbdir'), { recursive: true });
const { squashTask, dropCommit, restoreBackup, listBackups, checkTask } = await import('../server/task-repair.ts');
const { rebaseTask } = await import('../server/task-git.ts');
const { historyReport, riskyPath } = await import('../server/task-history.ts');
const push = await import('../server/push.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(top, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
let n = 0;
function setup() {
  const root = join(top, `repo-${++n}`);
  const main = join(root, 'main'), work = join(root, 'task'), bare = join(root, 'remote.git');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-b', 'master');
  git(main, 'config', 'user.email', 'repair-test@example.invalid');
  git(main, 'config', 'user.name', 'Repair Test');
  writeFileSync(join(main, 'base.txt'), 'base\n');
  git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
  git(root, 'init', '--bare', '-b', 'master', bare);
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', 'origin', 'master');
  git(main, 'push', 'origin', 'master:prod');
  git(main, 'branch', 'prod');
  git(main, 'worktree', 'add', '-b', 'task/example', work);
  const task = { id: `repair-${n}`, num: n, title: 'Repair', agent: 'codex', cwd: work, folder: main, branch: 'task/example', worktree: true, role: 'task' } as Task;
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [name, body] of Object.entries(files)) {
      if (body === null) rmSync(join(work, name), { recursive: true, force: true });
      else { mkdirSync(join(work, name, '..'), { recursive: true }); writeFileSync(join(work, name), body); }
    }
    git(work, 'add', '-A'); git(work, 'commit', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  const refs = () => git(main, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes');
  return { root, main, work, bare, task, commit, refs };
}
const backupsOf = (cwd: string, t: Task) => git(cwd, 'for-each-ref', '--format=%(refname)', `refs/taskboard-backup/${t.id}/`).split('\n').filter(Boolean);

test('squash makes one commit over the base, keeps the files, and keeps a backup that restores the old head', async () => {
  const { main, work, task, commit } = setup();
  commit({ 'src/app.ts': 'export {}\n', '.pnpm-store/v3/files/00/big': 'store\n' }, 'Add code and a temporary package store');
  const oldHead = commit({ '.pnpm-store/v3/files/00/big': null }, 'Delete the package store');
  const masterHead = git(main, 'rev-parse', 'master');
  const before = await checkTask(task);
  assert.match(before, /Warning: The history holds 1 path of type \.pnpm-store: \.pnpm-store\/v3\/files\/00\/big/);
  const out = await squashTask(task, 'master', 'Add the app code');
  const head = git(work, 'rev-parse', 'HEAD');
  assert.equal(git(work, 'rev-parse', 'HEAD^'), masterHead);
  assert.equal(git(work, 'rev-list', '--count', 'master..HEAD'), '1');
  assert.equal(git(work, 'log', '-1', '--format=%s'), 'Add the app code');
  assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), git(work, 'rev-parse', `${oldHead}^{tree}`));
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(git(main, 'rev-parse', 'master'), masterHead);
  const [backup] = backupsOf(work, task);
  assert.equal(git(work, 'rev-parse', backup), oldHead);
  assert.match(out, new RegExp(`Backup: ${backup}`));
  assert.match(out, /Undo: tb git repair --restore/);
  assert.match(out, /Files changed: 1\n  A src\/app\.ts/);
  assert.match(out, /Largest added file: src\/app\.ts \(10 B\)/);
  assert.match(out, /History check: the 1 commit after master hold no file larger than 5\.0 MiB/);
  assert.doesNotMatch(out, /Warning/);
  assert.match(await listBackups(task), new RegExp(backup));
  const restored = await restoreBackup(task, backup.split('/').pop()!);
  assert.equal(git(work, 'rev-parse', 'HEAD'), oldHead);
  assert.match(restored, /Restored task\/example/);
  assert.equal(backupsOf(work, task).length, 2);
  assert.ok(backupsOf(work, task).some(b => git(work, 'rev-parse', b) === head));
});

test('squash and drop refuse local changes, a missing base, a wrong base, and leave every ref unchanged', async () => {
  const { main, work, task, commit, refs } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  const before = refs();
  writeFileSync(join(work, 'untracked.txt'), 'local\n');
  await assert.rejects(squashTask(task, 'master', 'One'), /uncommitted changes.*tb git commit/);
  await assert.rejects(dropCommit(task, git(work, 'rev-parse', 'HEAD')), /uncommitted changes/);
  await assert.rejects(restoreBackup(task, 'x'), /uncommitted changes/);
  rmSync(join(work, 'untracked.txt'));
  await assert.rejects(squashTask(task, '', 'One'), /--base/);
  await assert.rejects(squashTask(task, 'master', ''), /one-line message/);
  await assert.rejects(squashTask(task, 'master', 'two\nlines'), /one-line message/);
  await assert.rejects(squashTask(task, 'prod', 'One'), /not a remote branch/);
  await assert.rejects(squashTask(task, 'upstream/master', 'One'), /not a remote branch/);
  await assert.rejects(squashTask(task, 'origin/missing', 'One'), /not a remote branch/);
  await assert.rejects(squashTask(task, 'origin/../master', 'One'), /not a remote branch/);
  await assert.rejects(squashTask(task, 'origin/HEAD', 'One'), /not a remote branch/);
  writeFileSync(join(main, 'm.txt'), 'm\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'master moves on');
  const moved = refs();
  await assert.rejects(squashTask(task, 'master', 'One'), /does not contain master; run tb git rebase master first/);
  assert.equal(refs(), moved);
  assert.notEqual(before, moved);
  assert.deepEqual(backupsOf(work, task), []);
});

test('repair refuses the main checkout, a protected branch name, another task branch, and the controller', async () => {
  const { main, work, task, commit, refs } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  git(main, 'branch', 'task/other', 'master');
  const before = refs();
  await assert.rejects(squashTask({ ...task, cwd: main }, 'master', 'One'), /main checkout/);
  await assert.rejects(squashTask({ ...task, branch: 'prod' }, 'master', 'One'), /does not change prod/);
  await assert.rejects(squashTask({ ...task, branch: 'master' }, 'master', 'One'), /does not change master/);
  await assert.rejects(squashTask({ ...task, branch: 'task/other' }, 'master', 'One'), /branch changed/);
  await assert.rejects(squashTask({ ...task, role: 'controller' }, 'master', 'One'), /no worktree branch/);
  await assert.rejects(squashTask({ ...task, worktree: false }, 'master', 'One'), /no worktree branch/);
  await assert.rejects(dropCommit({ ...task, branch: 'task/other' }, git(work, 'rev-parse', 'HEAD')), /branch changed/);
  assert.equal(refs(), before);
});

test('drop removes one commit that only the task branch holds and replays the later commits', async () => {
  const { work, task, commit } = setup();
  const store = commit({ '.pnpm-store/pkg': 'store\n' }, 'Add a temporary package store');
  commit({ 'src/app.ts': 'export {}\n' }, 'Add code');
  const oldHead = commit({ '.pnpm-store/pkg': null }, 'Delete the package store');
  const out = await dropCommit(task, store.slice(0, 10));
  assert.equal(git(work, 'log', '--format=%s', 'master..HEAD'), 'Add code');
  assert.equal(existsSync(join(work, 'src/app.ts')), true);
  assert.equal(git(work, 'ls-files', '.pnpm-store'), '');
  assert.match(out, new RegExp(`Removed ${store.slice(0, 12)}`));
  assert.doesNotMatch(out, /Warning/);
  assert.equal(git(work, 'rev-parse', backupsOf(work, task)[0]), oldHead);
});

test('drop refuses a commit in the base, on another branch, a merge, a bad hash, and a commit that later commits need', async () => {
  const { main, work, task, commit, refs } = setup();
  const base = git(main, 'rev-parse', 'master');
  const first = commit({ 'f.txt': 'one\n' }, 'Add f');
  const second = commit({ 'f.txt': 'two\n' }, 'Change f');
  await assert.rejects(dropCommit(task, base), /already in master/);
  await assert.rejects(dropCommit(task, 'HEAD~1'), /commit hash/);
  await assert.rejects(dropCommit(task, 'deadbeefdeadbeef'), /not a commit/);
  const before = refs();
  await assert.rejects(dropCommit(task, first), /depends on .*branch is unchanged/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), second);
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(work, '.git')) && !existsSync(join(main, '.git', 'worktrees', 'task', 'rebase-merge')), true);
  assert.deepEqual(backupsOf(work, task), []);
  assert.equal(refs(), before);
  git(main, 'branch', 'task/other', first);
  await assert.rejects(dropCommit(task, first), /also on refs\/heads\/task\/other/);
  git(main, 'branch', '-D', 'task/other');
  writeFileSync(join(main, 'm.txt'), 'm\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'master moves on');
  git(work, 'merge', '--no-ff', '-m', 'merge master', 'master');
  await assert.rejects(dropCommit(task, first), /Merge commits follow/);
});

test('rebase onto a remote branch fetches it first and refuses names that are not remote branches', async () => {
  const { root, main, work, bare, task, commit } = setup();
  commit({ 'task.txt': 'task\n' }, 'Task change');
  const other = join(root, 'other');
  git(root, 'clone', '--branch', 'prod', bare, other);
  git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'user.name', 'Other');
  writeFileSync(join(other, 'prod.txt'), 'prod\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'prod fix'); git(other, 'push', 'origin', 'prod');
  const remoteProd = git(other, 'rev-parse', 'HEAD');
  const localMaster = git(main, 'rev-parse', 'master'), localProd = git(main, 'rev-parse', 'prod');
  for (const bad of ['prod', 'origin', 'origin/', 'upstream/prod', 'origin/missing', '--exec=true', 'origin/a..b'])
    await assert.rejects(rebaseTask(task, 'start', undefined, bad), /not a remote branch/, bad);
  const out = await rebaseTask(task, 'start', undefined, 'origin/prod');
  assert.equal(git(main, 'rev-parse', 'refs/remotes/origin/prod'), remoteProd);
  assert.equal(git(work, 'rev-parse', 'HEAD^'), remoteProd);
  assert.match(out, /Rebased task\/example onto origin\/prod\./);
  assert.match(out, /Check of task\/example against origin\/prod:\nFiles changed: 1\n  A task\.txt/);
  assert.equal(git(main, 'rev-parse', 'master'), localMaster);
  assert.equal(git(main, 'rev-parse', 'prod'), localProd);
  // a later rebase onto local master keeps the prod commit, because local master does not hold it
  assert.match(await rebaseTask(task), /onto local master/);
  assert.equal(git(work, 'log', '-1', '--format=%s', 'HEAD^'), 'prod fix');
  assert.equal(git(work, 'rev-parse', 'HEAD~2'), localMaster);
  writeFileSync(join(work, 'dirty.txt'), 'x\n');
  await assert.rejects(rebaseTask(task, 'start', undefined, 'origin/prod'), /local changes/);
});

test('the check reports files over the size limit and unsafe paths in any commit', async () => {
  const { work, commit } = setup();
  commit({ 'big.bin': 'x'.repeat(64), 'node_modules/left/index.js': '1\n', 'config/.env': 'A=1\n', 'deploy/credentials/key.json': '{}\n' }, 'Add files');
  commit({ 'big.bin': null, 'node_modules': null, 'config/.env': null, 'deploy/credentials': null }, 'Delete them');
  const out = await historyReport(work, 'refs/heads/master', 'master', 'HEAD', 32);
  assert.match(out, /Files changed: 0/);
  assert.match(out, /Largest added file: none/);
  assert.match(out, /Warning: The history holds 1 file larger than 32 B: big\.bin \(64 B\)/);
  assert.match(out, /type node_modules: node_modules\/left\/index\.js/);
  assert.match(out, /type \.env file: config\/\.env/);
  assert.match(out, /type credentials folder: deploy\/credentials\/key\.json/);
  assert.equal(riskyPath('src/credentials.ts'), '');
  assert.equal(riskyPath('.env.example'), '');
  assert.equal(riskyPath('.env.local'), '.env file');
  assert.equal(riskyPath('.aws/credentials'), 'credentials folder');
  assert.equal(riskyPath('home/.config/gh/hosts.yml'), 'credentials folder');
  assert.equal(riskyPath('a/b/.pnpm-store/x'), '.pnpm-store');
});

test('after a repair a push needs a force push card that replaces only the old head of this task', async () => {
  const { root, main, work, bare, task, commit } = setup();
  commit({ 'a.txt': 'a\n', '.pnpm-store/pkg': 'store\n' }, 'A with store');
  commit({ '.pnpm-store/pkg': null }, 'Remove store');
  const first = await push.inspectPush(task, 'First push');
  assert.equal(first.fastForward, true);
  assert.equal(first.forcePush, false);
  assert.ok(first.warnings.some(w => /\.pnpm-store/.test(w)));
  await push.runPush(task, first);
  const pushed = git(main, 'ls-remote', 'origin', 'refs/heads/task/example').split(/\s/)[0];
  await squashTask(task, 'master', 'A');
  const forced = await push.inspectPush(task, 'Push the repaired branch');
  assert.equal(forced.fastForward, false);
  assert.equal(forced.forcePush, true);
  assert.equal(forced.needsCard, true);
  assert.equal(forced.oldHead, pushed);
  assert.deepEqual(forced.replaced!.map(c => c.subject), ['Remove store', 'A with store']);
  assert.ok(!forced.warnings.some(w => /\.pnpm-store/.test(w)));
  assert.match(await push.runPush(task, forced), /forced update|\+/);
  assert.equal(git(main, 'ls-remote', 'origin', 'refs/heads/task/example').split(/\s/)[0], git(work, 'rev-parse', 'HEAD'));

  // the remote branch moved after the card was made: the approved push stops
  commit({ 'b.txt': 'b\n' }, 'B');
  await squashTask(task, 'master', 'A and B');
  const stale = await push.inspectPush(task, 'Push again');
  assert.equal(stale.forcePush, true);
  const other = join(root, 'other');
  git(root, 'clone', '--branch', 'task/example', bare, other);
  git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'user.name', 'Other Person');
  writeFileSync(join(other, 'theirs.txt'), 'theirs\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'their commit'); git(other, 'push', 'origin', 'task/example');
  await assert.rejects(push.runPush(task, stale), /The branch changed/);
  // their commit is in no backup of this task, so no force push is offered
  const refused = await push.inspectPush(task, 'Push again');
  assert.equal(refused.fastForward, false);
  assert.equal(refused.forcePush, false);
  await assert.rejects(push.runPush(task, refused), /fast-forward/);
  assert.equal(git(other, 'ls-remote', 'origin', 'refs/heads/task/example').split(/\s/)[0], git(other, 'rev-parse', 'HEAD'));
  assert.equal(push.isProtectedBranch('prod', 'master', []), true);
  assert.equal(push.isProtectedBranch('task/example', 'master', ['task/example']), true);
  assert.equal(readFileSync(join(main, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/master');
});

test('a task branch that equals master after its merge can push master only when the request names master', async () => {
  const { main, work, task, commit } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  git(main, 'merge', '--ff-only', 'task/example');
  assert.equal(git(work, 'rev-parse', 'HEAD'), git(main, 'rev-parse', 'master'));
  const named = await push.inspectPush(task, 'Push merged master', { branch: 'master' });
  assert.equal(named.branch, 'master');
  assert.equal(named.newHead, git(main, 'rev-parse', 'master'));
  assert.equal((await push.inspectPush(task, 'Push the task branch')).branch, 'task/example');
  await assert.rejects(push.inspectPush(task, 'Push prod', { branch: 'prod' }), /only this task branch or merged local master/);
});
