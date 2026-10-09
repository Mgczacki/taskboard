// tb git pr-request: a task asks the user to open one GitHub pull request from its own worktree branch.
// The general guard still refuses `gh pr` in permits (permits.ts hardRule). This module is the only path that runs
// `gh pr create` for a task, and only after the user approves the card on the dashboard (action github-pr).
// The card shows every value that the command uses. Before gh runs, inspectPullRequest runs again, and the run stops
// when the local head, the remote head of the branch, the base commit or the remote URL changed.
// Records are saved to TB_DIR/pull-requests.json.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './store.ts';
import * as machine from './machine.ts';
import { mergeStateForSource, scopeHint } from './task-git.ts';
import { isProtectedBranch, repoName } from './push.ts';
import { TB_DIR } from './config.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const safe = (s: string) => s.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@')
  .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|glpat-)[A-Za-z0-9_-]{12,}\b/g, '[redacted token]');

export const TITLE_MAX = 256;
// GitHub refuses a pull request body over 65536 characters.
export const BODY_MAX = 65536;
const branchName = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+(?<![./])$/;

export interface PullRequestState {
  taskId: string; repository: string; remote: string; remoteUrl: string;
  base: string; baseCommit: string; head: string; headCommit: string;
  title: string; body: string; draft: boolean;
}
export interface PullRequestRecord extends PullRequestState {
  id: string; at: string; doneAt?: string; approvalId?: string;
  state: 'pending' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown'; url?: string; result?: string;
}

async function remoteHead(cwd: string, remote: string, branch: string) {
  const line = await git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`);
  return line ? line.split(/\s/)[0] : null;
}

// Reads every value of the pull request from the task worktree and the remote. It throws the reason when Taskboard
// cannot offer the request. It reads only. It changes no ref.
export async function inspectPullRequest(task: Task, input: { title?: unknown; body?: unknown; base?: unknown; remote?: unknown; draft?: unknown }): Promise<PullRequestState> {
  if (!task.worktree || !task.branch || task.role === 'controller') throw new Error(`A task must use its own Git worktree. ${scopeHint}`);
  await mergeStateForSource(task);
  const head = task.branch;
  if (await git(task.cwd, 'branch', '--show-current') !== head) throw new Error('The task branch changed.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > TITLE_MAX || /[\r\n]/.test(title)) throw new Error(`Give a title of one line under ${TITLE_MAX} characters with --title.`);
  if (input.body !== undefined && typeof input.body !== 'string') throw new Error('Give the body as text.');
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > BODY_MAX) throw new Error(`The body has ${body.length} characters. GitHub accepts at most ${BODY_MAX}.`);
  if (input.draft !== undefined && typeof input.draft !== 'boolean') throw new Error('Give draft as true or false.');
  const remote = input.remote === undefined ? 'origin' : input.remote;
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('Give a configured remote name with --remote.');
  // The configured URL, without url.<base>.insteadOf rewrites, names the GitHub repository.
  const configured = await git(task.cwd, 'config', '--get', `remote.${remote}.url`).catch(() => '');
  if (!configured) throw new Error(`The remote ${remote} is not configured in this worktree.`);
  const remoteUrl = safe(configured);
  const repository = repoName(configured);
  if (!repository) throw new Error(`The remote ${remote} (${remoteUrl}) is not a github.com repository.`);
  const remoteDefault = await git(task.cwd, 'ls-remote', '--symref', remote, 'HEAD').catch(() => '');
  const defaultBranch = remoteDefault.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m)?.[1];
  if (isProtectedBranch(head, defaultBranch, machine.get().pushes.protectedBranches))
    throw new Error(`${head} is a protected branch (master, main, prod, release/*, the remote default branch, or a protected branch in the settings). A pull request must come from a task branch.`);
  const base = input.base === undefined ? defaultBranch : input.base;
  if (typeof base !== 'string' || !base) throw new Error(`Taskboard cannot read the default branch of ${remote}. Give the base branch with --base.`);
  if (!branchName.test(base)) throw new Error('Give the base as a branch name on the remote, for example main.');
  if (base === head) throw new Error('The base and the head are the same branch.');
  const baseCommit = await remoteHead(task.cwd, remote, base);
  if (!baseCommit) throw new Error(`The base branch ${base} does not exist on ${remote}.`);
  const headCommit = await git(task.cwd, 'rev-parse', 'HEAD');
  const pushed = await remoteHead(task.cwd, remote, head);
  if (pushed !== headCommit)
    throw new Error(`${remote}/${head} is at ${pushed || '(no branch)'}, and the task branch is at ${headCommit}. Push the exact head first with tb git push-request, then run tb git pr-request again.`);
  return { taskId: task.id, repository, remote, remoteUrl, base, baseCommit, head, headCommit, title, body, draft: input.draft === true };
}

// The text of the approval card. It shows each value that gh pr create receives.
export function cardDetail(s: PullRequestState, taskNum: number): string {
  return [`Task: #${taskNum}`, `Repository: ${s.repository}`, `Remote: ${s.remote} (${s.remoteUrl})`,
    `Base: ${s.base} at ${s.baseCommit}`, `Head: ${s.head} at ${s.headCommit}`, `Draft: ${s.draft ? 'Yes' : 'No'}`,
    `Title: ${s.title}`, 'Body:', s.body || '(empty)', '',
    'Approve runs gh pr create once. Before it runs, Taskboard checks the head and the base again.'].join('\n');
}

// The reason why the card no longer matches the branch and the remote, or undefined.
export async function changed(task: Task, expected: PullRequestState): Promise<string | undefined> {
  let now: PullRequestState;
  try { now = await inspectPullRequest(task, expected); } catch (e) { return `${e instanceof Error ? e.message : String(e)} Ask the task to run tb git pr-request again.`; }
  const diff = (['repository', 'remoteUrl', 'baseCommit', 'headCommit'] as const).filter(k => now[k] !== expected[k]);
  return diff.length ? `These values changed after the card was made: ${diff.map(k => `${k} ${expected[k]} -> ${now[k]}`).join(', ')}. Ask the task to run tb git pr-request again.` : undefined;
}

export function ghPath() {
  return process.env.TASKBOARD_GH || ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
}
// gh uses the user's own sign-in in GH_CONFIG_DIR (default ~/.config/gh). A token in the server environment is not used.
function ghEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  env.GH_CONFIG_DIR ||= join(homedir(), '.config', 'gh');
  return env;
}
function gh(args: string[], cwd: string, input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghPath(), args, { cwd, env: ghEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const keep = (text: string, d: Buffer) => text.length < 65536 ? text + d.toString('utf8').slice(0, 65536 - text.length) : text;
    child.stdout.on('data', d => { out = keep(out, d); });
    child.stderr.on('data', d => { err = keep(err, d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

// Checks the values again and runs gh pr create once. It returns the URL of the new pull request.
export async function createPullRequest(task: Task, expected: PullRequestState): Promise<{ url: string; output: string }> {
  const reason = await changed(task, expected);
  if (reason) throw new Error(reason);
  const args = ['pr', 'create', '--repo', expected.repository, '--base', expected.base, '--head', expected.head,
    '--title', expected.title, '--body-file', '-', ...(expected.draft ? ['--draft'] : [])];
  const result = await gh(args, task.cwd, expected.body).catch(e => { throw new Error(safe(`gh could not start: ${e instanceof Error ? e.message : String(e)}`)); });
  const output = safe(`${result.out}\n${result.err}`.trim());
  if (result.code !== 0) throw new Error(`gh pr create failed with exit code ${result.code}: ${output}`);
  const url = result.out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
  if (!url) throw new Error(`gh pr create ended without a pull request URL: ${output}`);
  // gh pr create does not take a commit. Read the head commit of the new pull request back and report a difference.
  const view = await gh(['pr', 'view', url, '--json', 'headRefOid,baseRefName,isDraft'], task.cwd).catch(() => null);
  let facts = 'Taskboard could not read the new pull request back with gh pr view.';
  if (view?.code === 0) {
    try {
      const v = JSON.parse(view.out) as { headRefOid?: string; baseRefName?: string; isDraft?: boolean };
      const wrong = [v.headRefOid !== expected.headCommit && `head ${v.headRefOid}`, v.baseRefName !== expected.base && `base ${v.baseRefName}`,
        !!v.isDraft !== expected.draft && `draft ${v.isDraft}`].filter(Boolean);
      facts = wrong.length ? `WARNING: The pull request differs from the card: ${wrong.join(', ')}.` : `GitHub reports head ${v.headRefOid}, base ${v.baseRefName}, draft ${v.isDraft ? 'yes' : 'no'}.`;
    } catch { /* keep the message above */ }
  }
  return { url, output: `${url}\n${facts}` };
}

const recordFile = join(TB_DIR, 'pull-requests.json');
const records: PullRequestRecord[] = (() => { try { return JSON.parse(readFileSync(recordFile, 'utf8')); } catch { return []; } })();
const save = () => writeFileSync(recordFile, JSON.stringify(records.slice(-500), null, 2), { mode: 0o600 });
export const all = () => records.slice().reverse();
export const get = (id: string) => records.find(r => r.id === id);
export function record(state: PullRequestState, id: string, approvalId: string): PullRequestRecord {
  const r: PullRequestRecord = { ...state, id, at: new Date().toISOString(), approvalId, state: 'pending' };
  records.push(r); save(); return r;
}
export function finish(r: PullRequestRecord, state: PullRequestRecord['state'], result: string, url?: string) {
  r.state = state; r.result = safe(result); r.doneAt = new Date().toISOString(); if (url) r.url = url; save();
}
export function reopen(r: PullRequestRecord) {
  if (r.state !== 'denied') return false;
  r.state = 'pending'; r.result = undefined; r.doneAt = undefined; save(); return true;
}
