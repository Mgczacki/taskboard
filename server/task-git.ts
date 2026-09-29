import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './store.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

export interface MergeState { source: string; target: string; branch: string }

export async function mergeState(t: Task): Promise<MergeState> {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error('This task has no branch in its own worktree.');
  if (realpathSync(t.cwd) === realpathSync(t.folder)) throw new Error('The task must use a separate worktree.');
  const [sourceRoot, targetRoot, sourceCommon, targetCommon, sourceBranch, targetBranch, sourceStatus, targetStatus, source, target] = await Promise.all([
    git(t.cwd, 'rev-parse', '--show-toplevel'), git(t.folder, 'rev-parse', '--show-toplevel'),
    git(t.cwd, 'rev-parse', '--git-common-dir'), git(t.folder, 'rev-parse', '--git-common-dir'),
    git(t.cwd, 'branch', '--show-current'), git(t.folder, 'branch', '--show-current'),
    git(t.cwd, 'status', '--porcelain'), git(t.folder, 'status', '--porcelain'),
    git(t.cwd, 'rev-parse', 'HEAD'), git(t.folder, 'rev-parse', 'HEAD'),
  ]);
  if (realpathSync(sourceRoot) !== realpathSync(t.cwd) || realpathSync(targetRoot) !== realpathSync(t.folder)) throw new Error('A worktree path changed.');
  if (realpathSync(resolve(t.cwd, sourceCommon)) !== realpathSync(resolve(t.folder, targetCommon))) throw new Error('The worktrees belong to different repositories.');
  if (sourceBranch !== t.branch || targetBranch !== 'master') throw new Error('The task branch or target branch changed.');
  if (sourceStatus || targetStatus) throw new Error('Both worktrees must have no local changes.');
  const owner = await git(t.cwd, 'worktree', 'list', '--porcelain');
  const entry = owner.split(/\n\n/).find(x => x.split('\n')[0] === `worktree ${realpathSync(t.cwd)}`);
  if (!entry || !entry.split('\n').includes(`branch refs/heads/${t.branch}`)) throw new Error('The task branch is not in its worktree.');
  return { source, target, branch: t.branch };
}

export async function commitTask(t: Task, message: string): Promise<string> {
  if (!message.trim() || message.length > 200 || /[\r\n]/.test(message)) throw new Error('Give a one-line commit message under 200 characters.');
  await mergeStateForSource(t);
  await exec('git', ['add', '-A'], { cwd: t.cwd });
  await exec('git', ['commit', '-m', message], { cwd: t.cwd });
  return `Committed ${await git(t.cwd, 'rev-parse', '--short', 'HEAD')} on ${t.branch}.`;
}

async function mergeStateForSource(t: Task) {
  if (!t.worktree || !t.branch || t.role === 'controller') throw new Error('This task has no branch in its own worktree.');
  if (realpathSync(await git(t.cwd, 'rev-parse', '--show-toplevel')) !== realpathSync(t.cwd)) throw new Error('The task worktree changed.');
  if (await git(t.cwd, 'branch', '--show-current') !== t.branch) throw new Error('The task branch changed.');
  const sourceCommon = await git(t.cwd, 'rev-parse', '--git-common-dir');
  const targetCommon = await git(t.folder, 'rev-parse', '--git-common-dir');
  if (realpathSync(resolve(t.cwd, sourceCommon)) !== realpathSync(resolve(t.folder, targetCommon))) throw new Error('The worktrees belong to different repositories.');
  const owner = await git(t.cwd, 'worktree', 'list', '--porcelain');
  const entry = owner.split(/\n\n/).find(x => x.split('\n')[0] === `worktree ${realpathSync(t.cwd)}`);
  if (!entry || !entry.split('\n').includes(`branch refs/heads/${t.branch}`)) throw new Error('The task branch is not in its worktree.');
}

export async function rebaseTask(t: Task): Promise<string> {
  await mergeStateForSource(t);
  if (await git(t.cwd, 'status', '--porcelain')) throw new Error('Commit or discard local changes before rebasing.');
  await exec('git', ['rebase', 'master'], { cwd: t.cwd });
  return `Rebased ${t.branch} onto local master.`;
}

export async function mergeTask(t: Task, expected: MergeState): Promise<string> {
  const current = await mergeState(t);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The branch or checkout changed after approval. Request a new merge.');
  await exec('git', ['merge', '--no-ff', '--no-edit', expected.branch], { cwd: t.folder });
  return `Merged ${expected.branch} into local master at ${await git(t.folder, 'rev-parse', '--short', 'HEAD')}.`;
}
