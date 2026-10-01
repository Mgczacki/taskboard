import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TB_DIR } from './config.ts';
import type { Task } from './store.ts';
import { historyReport } from './task-history.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const gitPath = async (cwd: string, name: string) => resolve(cwd, await git(cwd, 'rev-parse', '--git-path', name));
export const rebasing = async (cwd: string) => existsSync(await gitPath(cwd, 'rebase-merge')) || existsSync(await gitPath(cwd, 'rebase-apply'));
const pendingPath = (t: Task, file?: string) => file || join(TB_DIR, 'git-merges', `${encodeURIComponent(t.id)}.json`);
const readPending = (file: string): MergeState | null => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as MergeState; } catch { return null; }
};
const savePending = (file: string, state: MergeState) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(state)); };
const clearPending = (file: string) => rmSync(file, { force: true });
let masterQueue = Promise.resolve();
async function withMasterLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = masterQueue;
  let release!: () => void;
  masterQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await run(); } finally { release(); }
}

export interface MergeState { source: string; target: string; branch: string }

export async function mergeState(t: Task): Promise<MergeState> {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error('This task has no worktree branch; start a task in a worktree before running tb git merge-request.');
  if (realpathSync(t.cwd) === realpathSync(t.folder)) throw new Error('This task uses master; start a task in a separate worktree before running tb git merge-request.');
  if (await rebasing(t.cwd)) throw new Error('The task has an unfinished rebase; run tb git rebase --continue or tb git rebase --abort.');
  const [sourceRoot, targetRoot, sourceCommon, targetCommon, sourceBranch, targetBranch, sourceStatus, targetStatus, source, target] = await Promise.all([
    git(t.cwd, 'rev-parse', '--show-toplevel'), git(t.folder, 'rev-parse', '--show-toplevel'),
    git(t.cwd, 'rev-parse', '--git-common-dir'), git(t.folder, 'rev-parse', '--git-common-dir'),
    git(t.cwd, 'branch', '--show-current'), git(t.folder, 'branch', '--show-current'),
    git(t.cwd, 'status', '--porcelain'), git(t.folder, 'status', '--porcelain'),
    git(t.cwd, 'rev-parse', 'HEAD'), git(t.folder, 'rev-parse', 'HEAD'),
  ]);
  if (realpathSync(sourceRoot) !== realpathSync(t.cwd) || realpathSync(targetRoot) !== realpathSync(t.folder)) throw new Error('A worktree path changed; restore the task worktree before running tb git merge-request.');
  if (realpathSync(resolve(t.cwd, sourceCommon)) !== realpathSync(resolve(t.folder, targetCommon))) throw new Error('The worktrees belong to different repositories; start a task worktree from master before running tb git merge-request.');
  if (sourceBranch !== t.branch || targetBranch !== 'master') throw new Error('The branch changed; run tb git rebase --abort, then tb git merge-request.');
  if (sourceStatus) throw new Error('The task worktree has local changes; run tb git commit before tb git merge-request.');
  if (targetStatus) throw new Error('Master has local changes; finish or remove them in master, then run tb git merge-request.');
  const owner = await git(t.cwd, 'worktree', 'list', '--porcelain');
  const entry = owner.split(/\n\n/).find(x => x.split('\n')[0] === `worktree ${realpathSync(t.cwd)}`);
  if (!entry || !entry.split('\n').includes(`branch refs/heads/${t.branch}`)) throw new Error('The task branch is not in its worktree; restore the task worktree before running tb git merge-request.');
  return { source, target, branch: t.branch };
}

export async function commitTask(t: Task, message: string): Promise<string> {
  if (!message.trim() || message.length > 200 || /[\r\n]/.test(message)) throw new Error('Run tb git commit with a one-line message under 200 characters.');
  await mergeStateForSource(t);
  await exec('git', ['add', '-A'], { cwd: t.cwd });
  await exec('git', ['commit', '--quiet', '-m', message], { cwd: t.cwd });
  return `Committed ${await git(t.cwd, 'rev-parse', '--short', 'HEAD')} on ${t.branch}.`;
}

export async function mergeStateForSource(t: Task, allowRebase = false) {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error('This task has no worktree branch; start a task in a worktree before running tb git rebase.');
  if (realpathSync(await git(t.cwd, 'rev-parse', '--show-toplevel')) !== realpathSync(t.cwd)) throw new Error('The task worktree changed; restore it before running tb git rebase.');
  const active = allowRebase && await rebasing(t.cwd);
  if (active) {
    const dir = existsSync(await gitPath(t.cwd, 'rebase-merge')) ? await gitPath(t.cwd, 'rebase-merge') : await gitPath(t.cwd, 'rebase-apply');
    if (readFileSync(join(dir, 'head-name'), 'utf8').trim() !== `refs/heads/${t.branch}`) throw new Error('The task branch changed; run tb git rebase --abort.');
  } else if (await git(t.cwd, 'branch', '--show-current') !== t.branch) throw new Error('The task branch changed; run tb git rebase --abort.');
  const sourceCommon = await git(t.cwd, 'rev-parse', '--git-common-dir');
  const targetCommon = await git(t.folder, 'rev-parse', '--git-common-dir');
  if (realpathSync(resolve(t.cwd, sourceCommon)) !== realpathSync(resolve(t.folder, targetCommon))) throw new Error('The worktrees belong to different repositories; start a task worktree from master before running tb git rebase.');
  const owner = await git(t.cwd, 'worktree', 'list', '--porcelain');
  const entry = owner.split(/\n\n/).find(x => x.split('\n')[0] === `worktree ${realpathSync(t.cwd)}`);
  if (!entry || (!active && !entry.split('\n').includes(`branch refs/heads/${t.branch}`))) throw new Error('The task branch is not in its worktree; restore it before running tb git rebase.');
}

const redact = (s: string) => s.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@');

// A base is local master or a branch of a configured remote of the task repository, such as origin/prod.
// For a remote base, git fetch updates refs/remotes/<remote>/<branch> first. Only that remote-tracking ref changes.
export async function resolveBase(t: Task, base = 'master'): Promise<{ name: string; ref: string; remote?: string }> {
  if (base === 'master') return { name: 'master', ref: 'refs/heads/master' };
  const refuse = () => new Error(`${base} is not a remote branch of this repository; give master or a remote branch such as origin/master.`);
  const remotes = (await git(t.cwd, 'remote')).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
  const remote = remotes.find(r => base.startsWith(r + '/'));
  const branch = remote ? base.slice(remote.length + 1) : '';
  if (!remote || !branch || branch === 'HEAD' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw refuse();
  try { await exec('git', ['check-ref-format', `refs/heads/${branch}`], { cwd: t.cwd }); } catch { throw refuse(); }
  const ref = `refs/remotes/${remote}/${branch}`;
  try {
    await exec('git', ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:${ref}`],
      { cwd: t.cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (e) {
    const detail = redact(String((e as { stderr?: string }).stderr || (e as Error).message)).trim().split('\n')[0];
    if (/couldn't find remote ref/i.test(detail)) throw refuse();
    throw new Error(`git fetch ${remote} ${branch} failed, so nothing changed: ${detail}`);
  }
  return { name: base, ref, remote };
}

export async function rebaseTask(t: Task, action: 'start' | 'continue' | 'abort' = 'start', file = pendingPath(t), base = 'master'): Promise<string> {
  await mergeStateForSource(t, true);
  const active = await rebasing(t.cwd);
  let target: Awaited<ReturnType<typeof resolveBase>> | undefined;
  if (action === 'abort') {
    if (!active) throw new Error('No rebase is in progress; run tb git rebase to start one.');
    await exec('git', ['rebase', '--abort'], { cwd: t.cwd });
    clearPending(file);
    return `Aborted the rebase of ${t.branch}.`;
  }
  if (action === 'start') {
    if (active) throw new Error('A rebase is in progress; resolve conflicts and run tb git rebase --continue, or run tb git rebase --abort.');
    if (await git(t.cwd, 'status', '--porcelain')) throw new Error('The task worktree has local changes; run tb git commit before tb git rebase.');
    target = await resolveBase(t, base);
    try { await exec('git', ['rebase', target.ref], { cwd: t.cwd }); }
    catch (e) { if (await rebasing(t.cwd)) throw new Error('The rebase has conflicts; resolve them in the task worktree and run tb git rebase --continue.'); throw e; }
  } else {
    if (!active) throw new Error('No rebase is in progress; run tb git rebase to start one.');
    const unmerged = (await git(t.cwd, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
    for (const name of unmerged) {
      try { if (/^(<<<<<<< |=======|>>>>>>> )/m.test(readFileSync(join(t.cwd, name), 'utf8'))) throw new Error(`Resolve conflict markers in ${name}, then run tb git rebase --continue.`); }
      catch (e) { if (e instanceof Error && e.message.startsWith('Resolve conflict markers')) throw e; }
    }
    if (unmerged.length) await exec('git', ['add', '-A', '--', ...unmerged], { cwd: t.cwd });
    try { await exec('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: t.cwd }); }
    catch (e) { if (await rebasing(t.cwd)) throw new Error('The rebase still has conflicts; resolve them in the task worktree and run tb git rebase --continue.'); throw e; }
  }
  const pending = readPending(file);
  if (pending) {
    try { const result = await withMasterLock(() => finishMerge(t, pending)); clearPending(file); return result; }
    catch (e) { clearPending(file); throw e; }
  }
  if (target?.remote) return `Rebased ${t.branch} onto ${target.name}.\n\n${await historyReport(t.cwd, target.ref, target.name)}`;
  return `Rebased ${t.branch} onto local master; run tb git merge-request to request a merge.`;
}

async function restoreMaster(t: Task, head: string) {
  if (await git(t.folder, 'rev-parse', 'HEAD') !== head) throw new Error('Master changed during the merge; inspect master before tb git merge-request.');
  if (existsSync(await gitPath(t.folder, 'MERGE_HEAD'))) {
    try { await exec('git', ['merge', '--abort'], { cwd: t.folder }); } catch { /* reset below restores the recorded head */ }
  }
  if (await git(t.folder, 'status', '--porcelain') || existsSync(await gitPath(t.folder, 'MERGE_HEAD'))) await exec('git', ['reset', '--hard', head], { cwd: t.folder });
}

async function finishMerge(t: Task, expected: MergeState): Promise<string> {
  const current = await mergeState(t);
  if (current.target !== expected.target) throw new Error('Master changed after approval; run tb git merge-request again.');
  try { await exec('git', ['merge', '--no-ff', '--no-edit', current.branch], { cwd: t.folder }); }
  catch (e) { await restoreMaster(t, expected.target); throw new Error('The merge failed and master was restored; run tb git rebase, then tb git merge-request.'); }
  return `Merged ${expected.branch} into local master at ${await git(t.folder, 'rev-parse', '--short', 'HEAD')}.`;
}

export async function mergeTask(t: Task, expected: MergeState, file = pendingPath(t)): Promise<string> {
  return withMasterLock(async () => {
    const current = await mergeState(t);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The branch or checkout changed after approval; run tb git merge-request again.');
    try { await exec('git', ['merge-base', '--is-ancestor', expected.target, expected.branch], { cwd: t.cwd }); }
    catch {
      try { await exec('git', ['rebase', 'master'], { cwd: t.cwd }); }
      catch (e) {
        if (await rebasing(t.cwd)) {
          savePending(file, expected);
          return 'Resolve conflicts in the task worktree and run tb git rebase --continue to finish the approved merge.';
        }
        throw new Error('The rebase failed; run tb git rebase --abort, then tb git merge-request.');
      }
    }
    return finishMerge(t, expected);
  });
}
