import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Task } from './store.ts';
import { backupPrefix, findBase, scopeHint, mergeStateForSource, rebasing, recordBase, resolveBase, saveBackup } from './task-git.ts';
import { historyReport } from './task-history.ts';

// tb git repair rewrites only the task's own branch in its own worktree. Before each change it saves the old head
// in refs/taskboard-backup/<task id>/<time>, so tb git repair --restore can undo the change. tb git rebase saves
// the same kind of backup, so --list and --restore also show and use the backups of a rebase.
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const isAncestor = (cwd: string, a: string, b: string) => exec('git', ['merge-base', '--is-ancestor', a, b], { cwd }).then(() => true, () => false);
const protectedBranch = (branch: string) => /^(master|main|prod)$/i.test(branch) || /^release\//i.test(branch);
export { backupPrefix };

async function preflight(t: Task): Promise<string> {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error(`This task has no worktree branch; tb git repair works only on a task branch in its own worktree. ${scopeHint}`);
  if (realpathSync(t.cwd) === realpathSync(t.folder)) throw new Error('This task uses the main checkout; tb git repair works only in a separate task worktree.');
  if (protectedBranch(t.branch)) throw new Error(`tb git repair does not change ${t.branch}.`);
  if (await rebasing(t.cwd)) throw new Error('The task has an unfinished rebase; run tb git rebase --continue or tb git rebase --abort first.');
  await mergeStateForSource(t);
  if (await git(t.cwd, 'status', '--porcelain')) throw new Error('The task worktree has uncommitted changes; run tb git commit first. tb git repair changed nothing.');
  return git(t.cwd, 'rev-parse', 'HEAD');
}

const backup = (t: Task, head: string) => saveBackup(t, head, 'tb git repair');

const result = (done: string, name: string, report: string) =>
  `${done}\nBackup: ${name}\nUndo: tb git repair --restore ${name}\n\n${report}`;

// One commit with the tree of the current head and the base as its parent. The worktree files do not change.
export async function squashTask(t: Task, baseName: string, message: string): Promise<string> {
  if (!message.trim() || message.length > 200 || /[\r\n]/.test(message)) throw new Error('Give tb git repair --squash a one-line message under 200 characters with -m.');
  if (!baseName) throw new Error('Give tb git repair --squash a base with --base, for example --base origin/master or --base master.');
  const head = await preflight(t);
  const base = await resolveBase(t, baseName);
  recordBase(t, base.name);
  const baseHead = await git(t.cwd, 'rev-parse', '--verify', `${base.ref}^{commit}`);
  if (baseHead === head) throw new Error(`The branch has no commits after ${base.name}; nothing to squash.`);
  if (!await isAncestor(t.cwd, baseHead, head)) throw new Error(`The branch does not contain ${base.name}; run tb git rebase ${base.name} first, then tb git repair --squash.`);
  const count = await git(t.cwd, 'rev-list', '--count', `${baseHead}..${head}`);
  const commit = await git(t.cwd, 'commit-tree', `${head}^{tree}`, '-p', baseHead, '-m', message.trim());
  const name = await backup(t, head);
  await exec('git', ['update-ref', '-m', `taskboard: squash onto ${base.name}`, `refs/heads/${t.branch}`, commit, head], { cwd: t.cwd });
  return result(`Squashed ${count} commit${count === '1' ? '' : 's'} of ${t.branch} into ${commit.slice(0, 12)} over ${base.name}.`, name, await historyReport(t.cwd, base.ref, base.name));
}

// Removes one commit that only this task branch holds, and replays the later commits.
// Without a base, it uses local master, or the base that findBase gives when the repository has no master.
export async function dropCommit(t: Task, commitArg: string, baseName?: string): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/i.test(commitArg)) throw new Error('Give tb git repair --drop a commit hash of 7 to 64 hex characters.');
  const head = await preflight(t);
  const commit = await git(t.cwd, 'rev-parse', '--verify', '--quiet', `${commitArg}^{commit}`).catch(() => '');
  if (!commit) throw new Error(`${commitArg} is not a commit in this repository.`);
  if (!await isAncestor(t.cwd, commit, head)) throw new Error(`${commitArg} is not on ${t.branch}.`);
  const base = baseName ? await resolveBase(t, baseName) : await findBase(t, { localFirst: true });
  if (baseName) recordBase(t, base.name);
  if (await isAncestor(t.cwd, commit, base.ref)) throw new Error(`${commitArg} is already in ${base.name}; tb git repair removes only commits after the base.`);
  const remotes = (await git(t.cwd, 'remote')).split('\n').filter(Boolean);
  const own = new Set([`refs/heads/${t.branch}`, ...remotes.map(r => `refs/remotes/${r}/${t.branch}`)]);
  const others = (await git(t.cwd, 'for-each-ref', '--format=%(refname)', '--contains', commit, 'refs/heads', 'refs/remotes')).split('\n').filter(r => r && !own.has(r));
  if (others.length) throw new Error(`${commitArg} is also on ${others.slice(0, 5).join(', ')}; tb git repair removes only commits that are only on ${t.branch}.`);
  const parents = (await git(t.cwd, 'rev-list', '--parents', '-n', '1', commit)).split(' ').length - 1;
  if (parents !== 1) throw new Error(`${commitArg} is a merge or a first commit; use tb git repair --squash instead.`);
  if (await git(t.cwd, 'rev-list', '--merges', `${commit}..${head}`)) throw new Error(`Merge commits follow ${commitArg}; use tb git repair --squash instead.`);
  const name = await backup(t, head);
  try { await exec('git', ['-c', 'core.editor=true', 'rebase', '--onto', `${commit}^`, commit], { cwd: t.cwd }); }
  catch {
    if (await rebasing(t.cwd)) await exec('git', ['rebase', '--abort'], { cwd: t.cwd });
    if (await git(t.cwd, 'rev-parse', 'HEAD') === head) await exec('git', ['update-ref', '-d', name, head], { cwd: t.cwd });
    throw new Error(`A later commit depends on ${commitArg}, so the replay stopped and was undone. The branch is unchanged. Use tb git repair --squash instead.`);
  }
  return result(`Removed ${commit.slice(0, 12)} from ${t.branch}. The new head is ${(await git(t.cwd, 'rev-parse', 'HEAD')).slice(0, 12)}.`, name, await historyReport(t.cwd, base.ref, base.name));
}

export async function listBackups(t: Task): Promise<string> {
  if (!t.worktree || !t.branch) throw new Error(`This task has no worktree branch. ${scopeHint}`);
  const refs = await git(t.cwd, 'for-each-ref', '--sort=-refname', '--format=%(refname) %(objectname:short) %(subject)', backupPrefix(t));
  return refs || 'This task has no backups from tb git repair or tb git rebase.';
}

// Moves the task branch back to one of this task's backups. It first saves the current head as a new backup.
export async function restoreBackup(t: Task, backupName: string): Promise<string> {
  const head = await preflight(t);
  const full = backupName.startsWith('refs/') ? backupName : backupPrefix(t) + backupName;
  const tail = full.slice(backupPrefix(t).length);
  if (!full.startsWith(backupPrefix(t)) || !/^[0-9A-Za-z-]+$/.test(tail)) throw new Error('Give a backup of this task; run tb git repair --list to see them.');
  const target = await git(t.cwd, 'rev-parse', '--verify', '--quiet', `${full}^{commit}`).catch(() => '');
  if (!target) throw new Error(`${full} does not exist; run tb git repair --list to see the backups.`);
  const name = await backup(t, head);
  await exec('git', ['reset', '--keep', target], { cwd: t.cwd });
  const base = await findBase(t, { localFirst: true }).catch(() => null);
  const report = base ? await historyReport(t.cwd, base.ref, base.name) : 'No report: Taskboard cannot find the base of this branch. Run tb git check --base BASE.';
  return result(`Restored ${t.branch} to ${target.slice(0, 12)} from ${full}.`, name, report);
}

// Without a base, tb git check uses local master, or the base that findBase gives when the repository has no master.
export async function checkTask(t: Task, baseName?: string): Promise<string> {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error(`This task has no worktree branch. ${scopeHint}`);
  await mergeStateForSource(t);
  const base = baseName ? await resolveBase(t, baseName) : await findBase(t, { localFirst: true });
  return historyReport(t.cwd, base.ref, base.name);
}
