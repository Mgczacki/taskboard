import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as machine from './machine.ts';
import { isProtectedBranch } from './push.ts';
import type { Task } from './store.ts';
import { mergeStateForSource, rebasing, recordBase, resolveBase, saveBackup } from './task-git.ts';
import { historyReport } from './task-history.ts';

// tb git merge-from merges a base (local master or a fetched remote branch such as origin/main) into the task branch
// with one merge commit. It does not rewrite the commits of the branch, so a branch that is already pushed needs no
// force push after it. It works only in the task's own worktree or in one of its attached worktrees (scopes.gitTarget
// picks the worktree). It does not change the base, master or any other branch.
//
// Order of one run:
// - tb git merge-from BASE: git fetch updates the remote-tracking ref of BASE, then git merge --no-ff makes the merge
//   commit. On a conflict, Git keeps MERGE_HEAD and the branch head does not move.
// - tb git merge-from --continue --stage PATH ...: stages only the named files, then makes the merge commit. It
//   refuses while a file still has conflict markers or while an unmerged file is not named.
// - tb git merge-from --abort: git merge --abort restores the branch head and the files from before the merge.
// After the merge commit, the old head is saved in refs/taskboard-backup/<task id>/<time>. tb git repair --restore
// can undo the merge with it.
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const gitPath = async (cwd: string, name: string) => resolve(cwd, await git(cwd, 'rev-parse', '--git-path', name));
export const merging = async (cwd: string) => existsSync(await gitPath(cwd, 'MERGE_HEAD'));
const isAncestor = (cwd: string, a: string, b: string) => exec('git', ['merge-base', '--is-ancestor', a, b], { cwd }).then(() => true, () => false);
const redact = (s: string) => s.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@');
const unmergedFiles = async (cwd: string) => (await git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
const backupText = (name: string) => `Backup of the old head: ${name}\nUndo: tb git repair --restore ${name}`;
const conflictText = (files: string[]) =>
  `The merge has conflicts in these files:\n${files.map(f => `- ${f}`).join('\n')}\n` +
  'Resolve each file in the task worktree. Then run tb git merge-from --continue with one --stage PATH for each resolved file, ' +
  'or run tb git merge-from --abort.';

// The default branch of a remote, from refs/remotes/<remote>/HEAD, for the protected-branch rule of push.ts.
async function defaultBranch(cwd: string, remote = 'origin'): Promise<string | undefined> {
  const head = await git(cwd, 'symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`).catch(() => '');
  return head.startsWith(`refs/remotes/${remote}/`) ? head.slice(`refs/remotes/${remote}/`.length) : undefined;
}

async function preflight(t: Task) {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error('This task has no worktree branch; tb git merge-from works only on a task branch in its own or an attached worktree.');
  if (realpathSync(t.cwd) === realpathSync(t.folder)) throw new Error('This task uses the main checkout; tb git merge-from works only in a separate task worktree.');
  // The same protected-branch rule as tb git push-request: master, main, prod, release/*, the remote default branch,
  // and the protected branches in the settings.
  if (isProtectedBranch(t.branch, await defaultBranch(t.cwd), machine.get().pushes.protectedBranches))
    throw new Error(`${t.branch} is a protected branch; tb git merge-from changes only a task branch.`);
  if (await rebasing(t.cwd)) throw new Error('The task has an unfinished rebase; run tb git rebase --continue or tb git rebase --abort first.');
  // mergeStateForSource checks that the worktree holds the task branch and belongs to the repository of t.folder.
  await mergeStateForSource(t);
}

// Each --stage value must be one path relative to the worktree that Git knows (tracked, or untracked and not ignored).
async function checkStagePath(t: Task, path: string) {
  if (!path || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\\') || path.includes('\0'))
    throw new Error(`Give --stage one file path relative to the task worktree, not ${JSON.stringify(path)}.`);
  const names = (await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', `:(literal)${path}`], { cwd: t.cwd })).stdout.split('\0').filter(Boolean);
  if (!names.length || names.some(name => name !== path)) throw new Error(`Give --stage one file path, not a directory or a path that Git does not know: ${path}.`);
  if (existsSync(join(t.cwd, path)) && /^(<<<<<<< |=======\r?$|>>>>>>> )/m.test(readFileSync(join(t.cwd, path), 'utf8')))
    throw new Error(`Resolve conflict markers in ${path}, then run tb git merge-from --continue again.`);
}

export async function mergeBaseTask(t: Task, action: 'start' | 'continue' | 'abort', base?: string, stage: string[] = []): Promise<string> {
  await preflight(t);
  const active = await merging(t.cwd);
  if (stage.length && action !== 'continue') throw new Error('Give --stage only with tb git merge-from --continue.');
  if (action === 'abort') {
    if (!active) throw new Error('No merge is in progress; run tb git merge-from BASE to start one.');
    await exec('git', ['merge', '--abort'], { cwd: t.cwd });
    return `Aborted the merge into ${t.branch}. The branch head is ${await git(t.cwd, 'rev-parse', '--short', 'HEAD')}, as before the merge.`;
  }
  if (action === 'continue') {
    if (!active) throw new Error('No merge is in progress; run tb git merge-from BASE to start one.');
    for (const path of stage) await checkStagePath(t, path);
    // -A stages a named file that the resolution deleted. Only the named files are staged.
    if (stage.length) await exec('git', ['add', '-A', '--', ...stage.map(p => `:(literal)${p}`)], { cwd: t.cwd });
    const left = await unmergedFiles(t.cwd);
    if (left.length) throw new Error(`These files are still unmerged:\n${left.map(f => `- ${f}`).join('\n')}\nResolve them, then run tb git merge-from --continue with --stage PATH for each one.`);
    const head = await git(t.cwd, 'rev-parse', 'HEAD');
    try { await exec('git', ['-c', 'core.editor=true', 'commit', '--no-edit', '--quiet'], { cwd: t.cwd }); }
    catch (e) {
      const detail = redact(String((e as { stderr?: string }).stderr || (e as Error).message)).trim();
      throw new Error(`Git could not make the merge commit: ${detail || 'Git gave no error text.'}`);
    }
    const name = await saveBackup(t, head, 'tb git merge-from');
    const unstaged = await git(t.cwd, 'status', '--porcelain');
    return `Finished the merge into ${t.branch} at ${await git(t.cwd, 'rev-parse', '--short', 'HEAD')}.\n${backupText(name)}` +
      (unstaged ? '\nThe worktree still has changes that were not named with --stage; they are not in the merge commit.' : '');
  }
  if (active) throw new Error('A merge is in progress; resolve conflicts and run tb git merge-from --continue --stage PATH, or run tb git merge-from --abort.');
  if (!base) throw new Error('Give a base, for example tb git merge-from origin/main.');
  if (await git(t.cwd, 'status', '--porcelain')) throw new Error('The task worktree has local changes; run tb git commit before tb git merge-from.');
  const target = await resolveBase(t, base);
  recordBase(t, target.name);
  const head = await git(t.cwd, 'rev-parse', 'HEAD');
  if (await isAncestor(t.cwd, target.ref, head)) return `${t.branch} already contains ${target.name}; nothing to merge.`;
  try { await exec('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge ${target.name} into ${t.branch}`, target.ref], { cwd: t.cwd }); }
  catch (e) {
    if (await merging(t.cwd)) throw new Error(conflictText(await unmergedFiles(t.cwd)));
    const detail = redact(String((e as { stderr?: string }).stderr || (e as Error).message)).trim();
    throw new Error(`git merge failed, and the branch head did not change: ${detail || 'Git gave no error text.'}`);
  }
  const name = await saveBackup(t, head, 'tb git merge-from');
  const report = target.remote ? `\n\n${await historyReport(t.cwd, target.ref, target.name)}` : '';
  return `Merged ${target.name} into ${t.branch} at ${await git(t.cwd, 'rev-parse', '--short', 'HEAD')}. The commits of the branch did not change, so a push needs no force.\n${backupText(name)}${report}`;
}
