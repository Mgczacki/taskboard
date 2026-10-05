import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from './store.ts';
import * as store from './store.ts';
import * as machine from './machine.ts';
import { findBase, mergeStateForSource, scopeHint } from './task-git.ts';
import { backupPrefix } from './task-repair.ts';
import { scanHistory } from './task-history.ts';
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

// The push card lists at most this many commits and files. A count gives the rest.
export const CARD_COMMITS = 50;
export const CARD_FILES = 20;
// The quick secret scan reads at most this many bytes of the diff.
const DIFF_SCAN_BYTES = 64 * 1024 * 1024;

type Commit = { hash: string; subject: string; author: string };
export interface PushState {
  taskId: string; branch: string; remote: string; remoteUrl: string; oldHead: string | null; newHead: string;
  base: string; baseSource: string;
  fastForward: boolean; forcePush?: boolean; forceBasis?: string; forceRefusal?: string; replaced?: Commit[]; replacedCount?: number; commitCount: number; commits: Commit[];
  fileCount: number; topFiles: string[]; warnings: string[]; reason: string; thenRelease: boolean;
  needsCard: boolean;
}

// Runs git and gives each line of its output to `each`, without keeping the output. `each` returns false to stop git.
// Git also stops after maxBytes of output. The result says whether git stopped early.
function gitEach(cwd: string, args: string[], each: (line: string) => boolean | void, maxBytes = Infinity): Promise<{ stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '', err = '', bytes = 0, stopped = false;
    const stop = () => { if (!stopped) { stopped = true; child.kill(); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() || '';
      for (const line of lines) if (each(line) === false) { stop(); return; }
      if (bytes >= maxBytes) stop();
      else if (rest.length > 1024 * 1024) rest = rest.slice(0, 1024 * 1024);
    });
    child.stderr.on('data', d => { if (err.length < 4096) err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (stopped) return resolve({ stopped: true });
      if (rest && each(rest) === false) return resolve({ stopped: true });
      if (code) return reject(new Error(`git ${args[0]} failed: ${err.trim()}`));
      resolve({ stopped: false });
    });
  });
}
const parseCommit = (line: string): Commit => { const [hash, subject, author] = line.split('\0'); return { hash, subject, author }; };
// The first `limit` commits that `revs` selects, and the count of all of them.
async function listCommits(cwd: string, revs: string[], limit = CARD_COMMITS) {
  const count = Number(await git(cwd, 'rev-list', '--count', ...revs));
  const commits = count ? (await git(cwd, 'log', `--max-count=${limit}`, '--format=%H%x00%s%x00%an <%ae>', ...revs)).split('\n').filter(Boolean).map(parseCommit) : [];
  return { count, commits };
}
const more = (n: number, word: string) => n > 0 ? [`and ${n} more ${word}`] : [];

// The text of the approval card for a push.
export function pushCardDetail(state: PushState): string {
  const line = (c: Commit) => `${c.hash} ${c.subject} — ${c.author}`;
  const replacedCount = state.replacedCount ?? state.replaced?.length ?? 0;
  const force = state.forcePush ? [
    'FORCE PUSH: Yes. This task rewrote its branch with tb git rebase or tb git repair after an earlier push.',
    `Approving replaces ${state.oldHead} on ${state.remote}/${state.branch}.`,
    `Why Taskboard offers a force push: ${state.forceBasis || `${state.oldHead} is in a backup of this task.`}`,
    `Taskboard pushes with --force-with-lease=refs/heads/${state.branch}:${state.oldHead}. The lease is pinned to the remote head that Taskboard observed, so the push fails if the remote branch moved.`,
    `Commits that leave the remote branch: ${replacedCount}`,
    ...(state.replaced || []).map(line), ...more(replacedCount - (state.replaced?.length || 0), 'commits'), '', ''].join('\n') : '';
  return force + [
    `Remote: ${state.remoteUrl}`, `Branch: ${state.branch}`, `Base: ${state.base} (from ${state.baseSource})`,
    `Range: ${state.oldHead || `(new branch; commits and files are counted from ${state.base})`} -> ${state.newHead}`,
    `Commits: ${state.commitCount}`, ...state.commits.map(line), ...more(state.commitCount - state.commits.length, 'commits'),
    `Files changed: ${state.fileCount}`, ...state.topFiles, ...more(state.fileCount - state.topFiles.length, 'files'),
    `Fast-forward now: ${state.fastForward ? 'Yes' : 'No'}`, 'Warnings:', ...state.warnings].join('\n');
}
export interface PushRecord { id: string; at: string; doneAt?: string; taskId: string; branch: string; remote: string; remoteUrl: string; oldHead: string | null; newHead: string; state: 'pending' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown'; result?: string; approvalId?: string }
const recordFile = join(TB_DIR, 'pushes.json');
const records: PushRecord[] = (() => { try { return JSON.parse(readFileSync(recordFile, 'utf8')); } catch { return []; } })();
export const allPushes = () => records.slice().reverse();
export const pushExpired = (_created: string, _now = Date.now()) => false;
export function recordPush(state: PushState, id: string, approvalId?: string): PushRecord {
  const record: PushRecord = { id, at: new Date().toISOString(), taskId: state.taskId, branch: state.branch, remote: state.remote,
    remoteUrl: state.remoteUrl, oldHead: state.oldHead, newHead: state.newHead, state: 'pending', approvalId };
  records.push(record); save(); return record;
}
export function finishPush(record: PushRecord, state: PushRecord['state'], result: string) { record.state = state; record.result = safe(result); record.doneAt = new Date().toISOString(); save(); }
// The user undid the denial on the card (approvals.undo): the push waits again. Nothing was pushed.
export function reopenPush(record: PushRecord) {
  if (record.state !== 'denied') return false;
  record.state = 'pending'; record.result = undefined; record.doneAt = undefined; save(); return true;
}
// The heads that Taskboard pushed for a task to one branch of one remote, from pushes.json. Each succeeded push
// record holds the task, the remote URL, the branch, the pushed head and the time.
export const pushedHeads = (taskId: string, remoteUrl: string, branch: string) =>
  records.filter(r => r.state === 'succeeded' && r.taskId === taskId && r.remoteUrl === remoteUrl && r.branch === branch);
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
export const isProtectedBranch = (branch: string, defaultBranch: string | undefined, protectedBranches: string[]) =>
  /^(master|main|prod)$/i.test(branch) || /^release\//i.test(branch) || branch === defaultBranch || protectedBranches.includes(branch);
export function pushNeedsCard(taskBranch: string, branch: string, remote: string, remoteUrl: string, defaultBranch: string | undefined,
  login: string, settings: { taskBranches: 'run' | 'ask' | 'never'; ownRepositories: string[]; protectedBranches: string[] }) {
  const repository = repoName(remoteUrl);
  const owner = repository?.split('/')[0];
  const ownRepository = !!repository && (owner?.toLowerCase() === login.toLowerCase() || settings.ownRepositories.some(r => r.toLowerCase() === repository.toLowerCase()));
  const protectedBranch = isProtectedBranch(branch, defaultBranch, settings.protectedBranches);
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

// A force push replaces commits on the remote branch, so Taskboard offers it only when all of these are true:
// - the push goes to this task's own branch,
// - the branch is not protected (master, main, prod, release/*, the remote default branch, or a protected branch in the settings),
// - no other task uses the same branch in the same repository,
// - the remote head is a head that Taskboard pushed for this task (pushes.json), or it is in a backup that
//   tb git rebase or tb git repair made for this task (refs/taskboard-backup/<task id>/).
// It always needs the user's approval on the push card. The result gives the reason for the card or the refusal.
async function checkForcePush(task: Task, cwd: string, o: { branch: string; taskBranch: string; remote: string; remoteUrl: string; oldHead: string; oldAvailable: boolean; defaultBranch?: string }):
  Promise<{ basis: string } | { refusal: string }> {
  if (o.branch !== o.taskBranch) return { refusal: `the push goes to ${o.branch}, and Taskboard force pushes only the task's own branch ${o.taskBranch}.` };
  if (isProtectedBranch(o.branch, o.defaultBranch, machine.get().pushes.protectedBranches))
    return { refusal: `${o.branch} is a protected branch (master, main, prod, release/*, the remote default branch, or a protected branch in the settings).` };
  const sameRepo = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
  // the main branch of each other task, and the branches of the worktrees that other tasks and this task attached
  const owner = store.all().find(t => t.role !== 'controller' && (
    (t.id !== task.id && t.branch === o.branch && sameRepo(t.folder, task.folder)) ||
    (t.scopes || []).some(s => s.kind === 'worktree' && s.branch === o.branch && !!s.repo && sameRepo(s.repo, task.folder) && !(t.id === task.id && s.name === task.scopeKey))));
  if (owner) return { refusal: `task #${owner.num} (${owner.title}) also uses the branch ${o.branch}.` };
  if (!o.oldAvailable) return { refusal: `the remote head ${o.oldHead} is not in the local repository, so Taskboard cannot check it. Someone else may have pushed to the branch.` };
  const pushed = pushedHeads(task.id, o.remoteUrl, o.branch).filter(r => r.newHead === o.oldHead).pop();
  if (pushed) return { basis: `Taskboard pushed ${o.oldHead} for this task at ${pushed.doneAt || pushed.at} (push ${pushed.id}).` };
  const backups = (await git(cwd, 'for-each-ref', '--format=%(objectname) %(refname)', backupPrefix(task))).split('\n').filter(Boolean);
  for (const line of backups) {
    const [commit, name] = line.split(' ');
    if (await isAncestor(cwd, o.oldHead, commit)) return { basis: `${o.oldHead} is in the backup ${name} that tb git rebase or tb git repair made for this task.` };
  }
  return { refusal: `both checks failed. Check 1: ${o.oldHead} is not a head that Taskboard pushed for this task to ${o.remote}/${o.branch}. ` +
    `Check 2: ${o.oldHead} is not in a backup of this task (tb git repair --list shows the backups).` };
}

export async function inspectPush(task: Task, reason: string, options: { branch?: string; remote?: string; base?: string; thenRelease?: boolean } = {}): Promise<PushState> {
  if (!task.worktree || !task.branch || task.role === 'controller') throw new Error(`A task must use its own Git worktree. ${scopeHint}`);
  await mergeStateForSource(task);
  if (realpathSync(await git(task.folder, 'rev-parse', '--show-toplevel')) !== realpathSync(task.folder)) throw new Error('The main checkout changed.');
  const taskBranch = task.branch;
  if (!reason.trim() || reason.length > 1000) throw new Error('Give a reason under 1000 characters.');
  const ownBranch = await git(task.cwd, 'branch', '--show-current');
  if (ownBranch !== taskBranch) throw new Error('The task branch changed.');
  const ownHead = await git(task.cwd, 'rev-parse', 'HEAD');
  // A repository without a local master branch can push only the task branch.
  const masterHead = await git(task.folder, 'rev-parse', '--verify', '--quiet', 'refs/heads/master^{commit}').catch(() => '');
  // A task branch equal to master (for example after tb git rebase following its merge) can push master only when
  // the request names master. Without --branch, such a branch still pushes itself.
  const merged = !!masterHead && await isAncestor(task.cwd, ownHead, masterHead) && (ownHead !== masterHead || options.branch === 'master');
  const branch = options.branch || (merged ? 'master' : taskBranch);
  if (branch !== taskBranch && (branch !== 'master' || !merged)) throw new Error('The request can name only this task branch or merged local master.');
  const cwd = branch === 'master' ? task.folder : task.cwd;
  if (await git(cwd, 'branch', '--show-current') !== branch) throw new Error('The branch changed.');
  const remote = options.remote || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('Give a configured remote name.');
  const remoteUrl = safe(await git(cwd, 'remote', 'get-url', '--push', remote));
  const base = await findBase(task, { named: options.base, remote });
  const oldHead = await remoteHead(cwd, remote, branch);
  const newHead = await git(cwd, 'rev-parse', 'HEAD');
  const oldAvailable = oldHead ? await git(cwd, 'cat-file', '-e', `${oldHead}^{commit}`).then(() => true).catch(() => false) : false;
  const fastForward = !oldHead || (oldAvailable && await isAncestor(cwd, oldHead, newHead));
  // The card counts commits and files from the remote head. For a new remote branch, or a remote head that is not in
  // the local repository, it counts them from the base. It never reads the full history of the repository.
  const revs = oldHead && oldAvailable ? [newHead, '--not', oldHead] : [newHead, '--not', base.ref];
  const diffRange = oldHead && oldAvailable ? [oldHead, newHead] : [`${base.ref}...${newHead}`];
  const { count: commitCount, commits } = await listCommits(cwd, revs);
  const warnings: string[] = [];
  const taskAuthor = await git(task.cwd, 'log', '-1', '--format=%an <%ae>', taskBranch);
  let otherCommits = false;
  await gitEach(cwd, ['log', '--format=%H%x00%s%x00%an <%ae>', ...revs], line => {
    const c = parseCommit(line);
    if (c.author !== taskAuthor || (/Merge branch ['"]?([^'" ]+)/.test(c.subject) && !c.subject.includes(taskBranch))) { otherCommits = true; return false; }
  });
  if (!otherCommits && branch === 'master') await gitEach(cwd, ['log', '--format=%s', ...revs, '--not', taskBranch], subject => {
    if (!subject.includes(taskBranch)) { otherCommits = true; return false; }
  });
  if (otherCommits) warnings.push('The range contains commits from other tasks or people.');
  const topFiles: string[] = [], flaggedFiles: string[] = [];
  let fileCount = 0, flaggedCount = 0;
  await gitEach(cwd, ['diff', '--name-only', ...diffRange], path => {
    if (!path) return;
    fileCount++;
    if (topFiles.length < CARD_FILES) topFiles.push(path);
    if (secretFile.test(path)) { flaggedCount++; if (flaggedFiles.length < 10) flaggedFiles.push(path); }
  });
  if (flaggedCount) warnings.push(`Files that look like secrets: ${flaggedFiles.join(', ')}${flaggedCount > flaggedFiles.length ? `, and ${flaggedCount - flaggedFiles.length} more` : ''}`);
  let secretFound = false;
  const scan = await gitEach(cwd, ['diff', '--no-ext-diff', '--unified=0', ...diffRange], line => {
    if (secretLine.test(line)) { secretFound = true; return false; }
  }, DIFF_SCAN_BYTES);
  warnings.push(secretFound ? 'The quick diff scan found a line that looks like a secret.'
    : scan.stopped ? `The quick diff scan read only the first ${DIFF_SCAN_BYTES / 1024 / 1024} MiB of the diff and found no secret pattern there.`
    : 'The quick diff scan found no secret pattern.');
  const remoteDefault = await git(cwd, 'ls-remote', '--symref', remote, 'HEAD').catch(() => '');
  const defaultBranch = remoteDefault.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m)?.[1];
  let forcePush = false, forceBasis: string | undefined, forceRefusal: string | undefined;
  let replaced: PushState['replaced'] = [];
  let replacedCount = 0;
  if (!fastForward && oldHead) {
    const check = await checkForcePush(task, cwd, { branch, taskBranch, remote, remoteUrl, oldHead, oldAvailable, defaultBranch });
    if ('basis' in check) { forcePush = true; forceBasis = check.basis; }
    else forceRefusal = `The remote branch ${remote}/${branch} is at ${oldHead}, and the local branch does not contain that commit, so a normal push is not a fast-forward. ` +
      `Taskboard cannot offer a force push: ${check.refusal} Do not try another way to push. Ask the user what to do.`;
    if (forcePush) ({ count: replacedCount, commits: replaced } = await listCommits(cwd, [oldHead, '--not', newHead]));
  }
  const history = await scanHistory(cwd, oldHead && oldAvailable ? [newHead, '--not', oldHead] : [newHead, '--not', `--remotes=${remote}`]).catch(() => null);
  if (history) warnings.push(...history.warnings);
  const needsCard = forcePush || pushNeedsCard(taskBranch, branch, remote, remoteUrl, defaultBranch, signedInLogin(), machine.get().pushes);
  return { taskId: task.id, branch, remote, remoteUrl, oldHead, newHead, base: base.name, baseSource: base.source, fastForward, forcePush, forceBasis, forceRefusal, replaced, replacedCount,
    commitCount, commits, fileCount, topFiles, warnings, reason: reason.trim(), thenRelease: !!options.thenRelease, needsCard };
}

export async function runPush(task: Task, expected: PushState): Promise<string> {
  if (!expected.fastForward && !expected.forcePush) throw new Error(expected.forceRefusal || 'The push is not a fast-forward, and Taskboard cannot offer a force push. Ask the user what to do.');
  const current = await inspectPush(task, expected.reason, { branch: expected.branch, remote: expected.remote, base: expected.base, thenRelease: expected.thenRelease });
  if (current.newHead !== expected.newHead || current.oldHead !== expected.oldHead || current.remoteUrl !== expected.remoteUrl || current.remote !== expected.remote)
    throw new Error('The branch changed. Ask for a new push request.');
  if (!current.fastForward && !(current.forcePush && expected.forcePush)) throw new Error('The branch changed. Ask for a new push request.');
  if (!!current.forcePush !== !!expected.forcePush) throw new Error('The branch changed. Ask for a new push request.');
  const cwd = expected.branch === 'master' ? task.folder : task.cwd;
  // --force-with-lease replaces the remote branch only while it still points to the head that the card showed
  const lease = expected.forcePush && expected.oldHead ? [`--force-with-lease=refs/heads/${expected.branch}:${expected.oldHead}`] : [];
  // git push can print long messages from the remote. Taskboard keeps the first 64 KiB of each stream, so a long
  // message cannot turn a finished push into a failed one.
  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn('git', ['push', '--porcelain', ...lease, expected.remote, `${expected.newHead}:refs/heads/${expected.branch}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const keep = (text: string, d: Buffer) => text.length < 65536 ? text + d.toString('utf8').slice(0, 65536 - text.length) : text;
    child.stdout.on('data', d => { out = keep(out, d); });
    child.stderr.on('data', d => { err = keep(err, d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  }).catch(e => { throw new Error(safe(String(e))); });
  const text = safe(`${result.out}\n${result.err}`.trim());
  if (result.code !== 0) throw new Error(`git push failed: ${text}`);
  return text;
}
