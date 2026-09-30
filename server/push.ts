import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from './store.ts';
import * as machine from './machine.ts';
import { mergeStateForSource } from './task-git.ts';
import { TB_DIR } from './config.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const safe = (s: string) => s.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@').replace(/(token|password|secret)=([^\s&]+)/gi, '$1=[redacted]')
  .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_|glpat-)[A-Za-z0-9_-]{12,}\b/g, '[redacted token]');
const secretFile = /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|[^/]*\.(?:pem|key|p8|p12|pfx)$|[^/]*(?:secret|token|credential)[^/]*)/i;
const secretLine = /^\+(?!\+\+).*(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*["']?\S{8,}|AKIA[A-Z0-9]{16}|(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,})/im;

export interface PushState {
  taskId: string; branch: string; remote: string; remoteUrl: string; oldHead: string | null; newHead: string;
  fastForward: boolean; commitCount: number; commits: { hash: string; subject: string; author: string }[];
  fileCount: number; topFiles: string[]; warnings: string[]; reason: string; thenRelease: boolean;
  needsCard: boolean;
}
export interface PushRecord { id: string; at: string; taskId: string; branch: string; remote: string; remoteUrl: string; oldHead: string | null; newHead: string; state: 'pending' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown'; result?: string; approvalId?: string }
const recordFile = join(TB_DIR, 'pushes.json');
const records: PushRecord[] = (() => { try { return JSON.parse(readFileSync(recordFile, 'utf8')); } catch { return []; } })();
export const allPushes = () => records.slice().reverse();
export const pushExpired = (created: string, now = Date.now()) => now - Date.parse(created) >= 600000;
export function recordPush(state: PushState, id: string, approvalId?: string): PushRecord {
  const record: PushRecord = { id, at: new Date().toISOString(), taskId: state.taskId, branch: state.branch, remote: state.remote,
    remoteUrl: state.remoteUrl, oldHead: state.oldHead, newHead: state.newHead, state: 'pending', approvalId };
  records.push(record); save(); return record;
}
export function finishPush(record: PushRecord, state: PushRecord['state'], result: string) { record.state = state; record.result = safe(result); save(); }
const save = () => writeFileSync(recordFile, JSON.stringify(records, null, 2), { mode: 0o600 });
function repoName(url: string): string | null {
  const m = url.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
function signedInLogin(): string {
  const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';
  try { return execFileSync(gh, ['auth', 'status', '--json', 'hosts', '--jq', '.hosts."github.com"[] | select(.active) | .login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
export function pushNeedsCard(taskBranch: string, branch: string, remote: string, remoteUrl: string, defaultBranch: string | undefined,
  login: string, settings: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] }) {
  const repository = repoName(remoteUrl);
  const owner = repository?.split('/')[0];
  const ownRepository = !!repository && (owner?.toLowerCase() === login.toLowerCase() || settings.ownRepositories.some(r => r.toLowerCase() === repository.toLowerCase()));
  const protectedBranch = /^(master|main|prod)$/i.test(branch) || /^release\//i.test(branch) || branch === defaultBranch || settings.protectedBranches.includes(branch);
  if (branch === taskBranch && !protectedBranch && ownRepository && remote === 'origin' && settings.taskBranches === 'never')
    throw new Error('Settings block pushes of task branches to your own repositories.');
  return true;
}

async function remoteHead(cwd: string, remote: string, branch: string) {
  const line = await git(cwd, 'ls-remote', '--heads', remote, `refs/heads/${branch}`);
  return line ? line.split(/\s/)[0] : null;
}

async function isAncestor(cwd: string, oldHead: string, newHead: string) {
  try { await git(cwd, 'merge-base', '--is-ancestor', oldHead, newHead); return true; } catch { return false; }
}

export async function inspectPush(task: Task, reason: string, options: { branch?: string; remote?: string; thenRelease?: boolean } = {}): Promise<PushState> {
  if (!task.worktree || !task.branch || task.role === 'controller') throw new Error('A task must use its own Git worktree.');
  await mergeStateForSource(task);
  if (realpathSync(await git(task.folder, 'rev-parse', '--show-toplevel')) !== realpathSync(task.folder)) throw new Error('The main checkout changed.');
  const taskBranch = task.branch;
  if (!reason.trim() || reason.length > 1000) throw new Error('Give a reason under 1000 characters.');
  const ownBranch = await git(task.cwd, 'branch', '--show-current');
  if (ownBranch !== taskBranch) throw new Error('The task branch changed.');
  const ownHead = await git(task.cwd, 'rev-parse', 'HEAD');
  const masterHead = await git(task.folder, 'rev-parse', 'refs/heads/master');
  const merged = await isAncestor(task.cwd, ownHead, masterHead) && ownHead !== masterHead;
  const branch = options.branch || (merged ? 'master' : taskBranch);
  if (branch !== taskBranch && (branch !== 'master' || !merged)) throw new Error('The request can name only this task branch or merged local master.');
  const cwd = branch === 'master' ? task.folder : task.cwd;
  if (await git(cwd, 'branch', '--show-current') !== branch) throw new Error('The branch changed.');
  const remote = options.remote || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('Give a configured remote name.');
  const remoteUrl = safe(await git(cwd, 'remote', 'get-url', '--push', remote));
  const oldHead = await remoteHead(cwd, remote, branch);
  const newHead = await git(cwd, 'rev-parse', 'HEAD');
  const oldAvailable = oldHead ? await git(cwd, 'cat-file', '-e', `${oldHead}^{commit}`).then(() => true).catch(() => false) : false;
  const fastForward = !oldHead || (oldAvailable && await isAncestor(cwd, oldHead, newHead));
  const range = oldHead && oldAvailable ? `${oldHead}..${newHead}` : newHead;
  const raw = await git(cwd, 'log', '--format=%H%x00%s%x00%an <%ae>', range);
  const commits = raw ? raw.split('\n').map(line => { const [hash, subject, author] = line.split('\0'); return { hash, subject, author }; }) : [];
  const paths = (oldHead && oldAvailable ? await git(cwd, 'diff', '--name-only', oldHead, newHead) : await git(cwd, 'log', '--format=', '--name-only', newHead)).split('\n').filter(Boolean);
  const files = [...new Set(paths)];
  const warnings: string[] = [];
  const taskAuthor = await git(task.cwd, 'log', '-1', '--format=%an <%ae>', taskBranch);
  const outsideTask = branch === 'master' ? new Set((await git(cwd, 'rev-list', range, '--not', taskBranch)).split('\n').filter(Boolean)) : new Set<string>();
  if (commits.some(c => c.author !== taskAuthor ||
      (/Merge branch ['"]?([^'" ]+)/.test(c.subject) && !c.subject.includes(taskBranch)) ||
      (outsideTask.has(c.hash) && !c.subject.includes(taskBranch)))) warnings.push('The range contains commits from other tasks or people.');
  const flaggedFiles = files.filter(f => secretFile.test(f));
  if (flaggedFiles.length) warnings.push(`Files that look like secrets: ${flaggedFiles.slice(0, 10).join(', ')}`);
  const diff = oldHead && oldAvailable ? await git(cwd, 'diff', '--no-ext-diff', '--unified=0', oldHead, newHead) : await git(cwd, 'log', '-p', '--format=', newHead);
  warnings.push(secretLine.test(diff) ? 'The quick diff scan found a line that looks like a secret.' : 'The quick diff scan found no secret pattern.');
  const remoteDefault = await git(cwd, 'ls-remote', '--symref', remote, 'HEAD').catch(() => '');
  const defaultBranch = remoteDefault.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m)?.[1];
  const needsCard = pushNeedsCard(taskBranch, branch, remote, remoteUrl, defaultBranch, signedInLogin(), machine.get().pushes);
  return { taskId: task.id, branch, remote, remoteUrl, oldHead, newHead, fastForward, commitCount: commits.length, commits,
    fileCount: files.length, topFiles: files.slice(0, 20), warnings, reason: reason.trim(), thenRelease: !!options.thenRelease, needsCard };
}

export async function runPush(task: Task, expected: PushState): Promise<string> {
  if (!expected.fastForward) throw new Error('The remote branch does not allow a fast-forward push.');
  const current = await inspectPush(task, expected.reason, { branch: expected.branch, remote: expected.remote, thenRelease: expected.thenRelease });
  if (current.newHead !== expected.newHead || current.oldHead !== expected.oldHead || current.remoteUrl !== expected.remoteUrl || current.remote !== expected.remote)
    throw new Error('The branch changed. Ask for a new push request.');
  if (!current.fastForward) throw new Error('The branch changed. Ask for a new push request.');
  const cwd = expected.branch === 'master' ? task.folder : task.cwd;
  try {
    const result = await exec('git', ['push', '--porcelain', expected.remote, `${expected.newHead}:refs/heads/${expected.branch}`],
      { cwd, maxBuffer: 1024 * 1024 });
    return safe(`${result.stdout}\n${result.stderr}`.trim());
  } catch (e) { throw new Error(safe(String(e))); }
}
