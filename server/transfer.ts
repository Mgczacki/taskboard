// A checked handoff between two Taskboard servers. No account or server credential enters the package.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { HOME, TASKS_DIR, TB_DIR, TOKEN } from './config.ts';
import * as accounts from './accounts.ts';
import * as agents from './agents.ts';
import * as groups from './groups.ts';
import * as machines from './machines.ts';
import * as store from './store.ts';
import * as tmux from './tmux.ts';

const exec = promisify(execFile);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 24 * 1024 * 1024;
const secretName = /(^|\/)(\.env(?:\.|$)|\.git(?:\/|$)|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.config(?:\/|$)|\.claude(?:\/|$)|\.codex(?:\/|$)|[^/]*\.(?:pem|key|p8|p12|pfx)$|[^/]*(?:secret|token|credential)[^/]*)/i;
const secretText = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*["']?\S{8,}|(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/i;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
async function bundle(cwd: string, base: string): Promise<{ size: number; hash: string; commits: number; data: Buffer }> {
  if (!base || !await git(cwd, 'cat-file', '-e', `${base}^{commit}`).then(() => true).catch(() => false)) throw new Error('The target commit is missing on the source.');
  if (!await git(cwd, 'merge-base', '--is-ancestor', base, 'HEAD').then(() => true).catch(() => false)) throw new Error('The target commit is not an ancestor of the source.');
  const names = await git(cwd, 'log', '--format=', '--name-only', `${base}..HEAD`);
  if (names.split('\n').some(name => name && secretName.test(name))) throw new Error('The commits include a file that may hold a secret.');
  const patch = (await exec('git', ['log', '-p', '--format=', `${base}..HEAD`], { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  if (secretText.test(patch)) throw new Error('The commits include text that may hold a secret.');
  const commits = Number(await git(cwd, 'rev-list', '--count', `${base}..HEAD`));
  const directory = join(tmpdir(), `tb-transfer-${randomUUID()}`), file = join(directory, 'commits.bundle');
  mkdirSync(directory, { mode: 0o700 });
  try {
    await exec('git', ['bundle', 'create', file, 'HEAD', `^${base}`], { cwd, timeout: 30000, maxBuffer: 1024 * 1024 });
    const data = readFileSync(file);
    if (data.length > MAX_TOTAL) throw new Error('The Git bundle exceeds 24 MiB. Push and pull the branch instead.');
    return { size: data.length, hash: sha(data), commits, data };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const safeRemote = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    return parsed.toString().replace(/\.git$/, '').replace(/\/$/, '');
  }
  return url.replace(/\.git$/, '').replace(/\/$/, '');
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
function safeFolder(path: string) {
  const full = realpathSync(path);
  const protectedPaths = [TB_DIR, TASKS_DIR, join(HOME, '.ssh'), join(HOME, '.aws'), join(HOME, '.config'),
    ...accounts.all().map(a => a.dir)].filter(existsSync).map(p => realpathSync(p));
  if (protectedPaths.some(p => inside(full, p) || inside(p, full))) throw new Error('The folder contains Taskboard or account files. Choose a project folder.');
  return full;
}

interface GitState { root: string; main: string; remote: string; branch: string; head: string; changes: string[]; ignored: string[] }
async function gitState(folder: string): Promise<GitState> {
  const root = realpathSync(await git(folder, 'rev-parse', '--show-toplevel').catch(() => folder));
  const inGit = await git(folder, 'rev-parse', '--is-inside-work-tree').then(x => x === 'true').catch(() => false);
  if (!inGit) return { root, main: root, remote: '', branch: '', head: '', changes: [], ignored: [] };
  const [remote, branch, head, status, ignored, worktrees] = await Promise.all([
    git(folder, 'remote', 'get-url', 'origin').then(safeRemote).catch(() => ''),
    git(folder, 'branch', '--show-current'), git(folder, 'rev-parse', 'HEAD'),
    git(folder, 'status', '--porcelain=v1', '--untracked-files=all'),
    git(folder, 'ls-files', '--others', '--ignored', '--exclude-standard').catch(() => ''),
    git(folder, 'worktree', 'list', '--porcelain'),
  ]);
  const main = worktrees.split('\n').find(line => line.startsWith('worktree '))?.slice(9) || root;
  return { root, main, remote, branch, head, changes: status ? status.split('\n').slice(0, 200) : [], ignored: ignored ? ignored.split('\n').slice(0, 200) : [] };
}

export interface TransferFile { path: string; size: number; hash: string; data?: string }
interface FileList { files: TransferFile[]; omitted: string[] }
export async function workspaceFiles(t: store.Task): Promise<FileList> {
  const root = realpathSync(t.cwd);
  if (!await git(root, 'rev-parse', '--is-inside-work-tree').then(x => x === 'true').catch(() => false)) return { files: [], omitted: ['The source folder is not a Git checkout.'] };
  const changed = await exec('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', 'HEAD'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const deleted = await git(root, 'diff', '--name-only', '--diff-filter=D', 'HEAD');
  const files: TransferFile[] = [], omitted: string[] = deleted ? [`Deleted files need a commit: ${deleted}`] : [];
  let total = 0;
  for (const name of new Set((changed.stdout + untracked.stdout).split('\0').filter(Boolean))) {
    const path = resolve(root, name);
    if (!inside(path, root) || secretName.test(name) || !existsSync(path)) { omitted.push(`${name}: blocked path`); continue; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) { omitted.push(`${name}: blocked type or size`); continue; }
    const bytes = readFileSync(path);
    if (secretText.test(bytes.toString('utf8'))) { omitted.push(`${name}: possible secret`); continue; }
    total += bytes.length;
    files.push({ path: name, size: bytes.length, hash: sha(bytes) });
  }
  return { files, omitted };
}
export function taskFiles(t: store.Task): FileList {
  const base = store.taskDir(t.id), files: TransferFile[] = [], omitted: string[] = [];
  let total = 0;
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth > 5) return;
    if (lstatSync(dir).isSymbolicLink()) { omitted.push(`${relative(base, dir)}: symbolic link`); return; }
    if (lstatSync(dir).isFile()) {
      const rel = relative(base, dir), bytes = readFileSync(dir);
      if (secretName.test(rel) || bytes.length > MAX_FILE || total + bytes.length > MAX_TOTAL || secretText.test(bytes.toString('utf8'))) omitted.push(`${rel}: blocked name, size, or content`);
      else { total += bytes.length; files.push({ path: rel, size: bytes.length, hash: sha(bytes) }); }
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = relative(base, path), stat = lstatSync(path);
      if (stat.isSymbolicLink()) { omitted.push(`${rel}: symbolic link`); continue; }
      if (stat.isDirectory()) { walk(path, depth + 1); continue; }
      if (!stat.isFile()) { omitted.push(`${rel}: not a file`); continue; }
      if (secretName.test(rel) || stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) { omitted.push(`${rel}: blocked name or size`); continue; }
      const bytes = readFileSync(path);
      if (secretText.test(bytes.toString('utf8'))) { omitted.push(`${rel}: possible secret`); continue; }
      total += bytes.length;
      files.push({ path: rel, size: bytes.length, hash: sha(bytes) });
    }
  };
  for (const entry of ['log.md', 'handoffs', 'inbox', 'outbox', 'attachments']) walk(join(base, entry), 0);
  return { files, omitted };
}
function packageFiles(t: store.Task, list: FileList): TransferFile[] {
  return list.files.map(f => {
    const path = join(store.taskDir(t.id), f.path), bytes = readFileSync(path);
    if (bytes.length !== f.size || sha(bytes) !== f.hash) throw new Error(`Task file changed: ${f.path}. Run the check again.`);
    return { ...f, data: bytes.toString('base64') };
  });
}
export function verifyFile(f: TransferFile, base: string): string {
  if (!f || typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..') || secretName.test(f.path)) throw new Error('Unsafe transfer file path.');
  const path = resolve(base, f.path);
  if (!inside(path, base)) throw new Error('Transfer file escapes the task folder.');
  let parent = resolve(path, '..');
  while (inside(parent, base) && parent !== base) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Transfer file follows a symbolic link.');
    parent = resolve(parent, '..');
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Transfer file replaces a symbolic link.');
  const bytes = Buffer.from(f.data || '', 'base64');
  if (bytes.length !== f.size || bytes.length > MAX_FILE || sha(bytes) !== f.hash || secretText.test(bytes.toString('utf8'))) throw new Error(`Transfer file failed verification: ${f.path}.`);
  return path;
}

function signature(path: string, body: unknown, token: string) { return createHmac('sha256', token).update(path + '\n' + JSON.stringify(body)).digest('hex'); }
export function signedRequest(path: string, body: object) {
  const payload = { ...body, at: Date.now() };
  return { payload, headers: { 'x-taskboard-peer-signature': signature(path, payload, TOKEN) } };
}
export function peer(req: Request): machines.Machine {
  if (req.get('origin') || req.get('x-taskboard-token') !== TOKEN) throw new Error('Transfer requires server authentication.');
  const value = req.get('x-taskboard-peer-signature') || '';
  if (!/^[a-f0-9]{64}$/.test(value) || Math.abs(Date.now() - Number(req.body?.at)) > 120000) throw new Error('Transfer signature expired or missing.');
  const found = machines.all().filter(m => {
    const expected = signature(req.originalUrl, req.body, m.token);
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
  if (found.length !== 1) throw new Error('The source machine is not paired with this machine.');
  return found[0];
}
async function callPeer(m: machines.Machine, path: string, body: object) {
  const url = new URL(m.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    throw new Error('Transfer requires an HTTPS or local machine address.');
  const request = signedRequest(path, body);
  const r = await machines.call(m, 'POST', path, request.payload, request.headers, path.endsWith('/stage') ? 120000 : 30000);
  if (r.status !== 200) throw new Error(typeof r.data?.error === 'string' ? r.data.error : `${m.name} returned ${r.status}.`);
  if (!/^[a-f0-9-]{36}$/i.test(r.data?.machineId || '')) throw new Error('The target did not prove its machine identity. Update Taskboard on that machine.');
  machines.rememberIdentity(m.id, r.data.machineId);
  return r.data;
}

export async function check(t: store.Task, machineId: string, folder: string) {
  if (t.role === 'controller') throw new Error('The controller cannot move to another machine.');
  if (t.transfer?.state === 'started') throw new Error('This task already moved.');
  safeFolder(t.cwd);
  const machine = machines.get(machineId);
  if (!machine || !machines.stateOf(machineId)?.online) throw new Error('Choose a connected target machine.');
  if (!folder || !folder.startsWith('/')) throw new Error('Choose an absolute folder on the target machine.');
  const source = await gitState(t.cwd);
  const target = await callPeer(machine, '/api/transfer/check', { folder });
  const files = taskFiles(t);
  const workspace = await workspaceFiles(t);
  let bundleInfo: { available: boolean; size?: number; hash?: string; commits?: number; reason?: string } | null = null;
  if (source.head && target.git.head && source.head !== target.git.head && source.remote && source.remote === target.git.remote) {
    try { const b = await bundle(t.cwd, target.git.head); bundleInfo = { available: true, size: b.size, hash: b.hash, commits: b.commits }; }
    catch (e) { bundleInfo = { available: false, reason: e instanceof Error ? e.message : String(e) }; }
  }
  let transcript: { path: string; size: number; hash: string; available: boolean; reason?: string } | null = null;
  if (t.transcript && existsSync(t.transcript)) {
    const stat = lstatSync(t.transcript);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE) {
      const bytes = readFileSync(t.transcript);
      transcript = { path: 'history/source-transcript.jsonl', size: bytes.length, hash: sha(bytes), available: !secretText.test(bytes.toString('utf8')) };
      if (!transcript.available) transcript.reason = 'The transcript may contain a secret.';
    } else transcript = { path: 'history/source-transcript.jsonl', size: stat.size, hash: '', available: false, reason: 'The transcript is a link or exceeds the size limit.' };
  }
  const issues: string[] = [];
  if (!source.remote || !target.git.remote || source.remote !== target.git.remote) issues.push('Git remotes differ or are missing.');
  if (source.branch !== target.git.branch) issues.push('Git branches differ.');
  if (source.head !== target.git.head) issues.push('Commits differ. Push and pull, or prepare a matching target worktree.');
  if (target.git.changes.length) issues.push('The target folder has uncommitted files. Choose a worktree without local changes.');
  if (source.ignored.length) issues.push('Ignored source files stay on the source machine.');
  if (files.omitted.length) issues.push('Some task files cannot be sent.');
  if (workspace.omitted.length) issues.push('Some changed project files cannot be sent.');
  // attached worktrees and read folders (server/scopes.ts) stay on this machine; the target task would not have them
  if (t.scopes?.length) issues.push(`This task has ${t.scopes.length} attached worktree(s) or folder(s): ${t.scopes.map(s => s.path).join(', ')}. A transfer does not move them. Push their branches and remove them on the task page first.`);
  const report = { machine: machineId, folder: target.git.root, source, target: target.git as GitState,
    accounts: target.accounts as { id: string; name: string; agent: string; signedIn: boolean; unavailable?: string }[], files, workspace, transcript, bundle: bundleInfo, issues };
  return { ...report, fingerprint: sha(JSON.stringify(report)), ready: issues.filter(x => !x.startsWith('Ignored') && !x.startsWith('Some task') && !x.startsWith('Some changed')).length === 0 };
}

export async function targetCheck(folder: string) {
  if (typeof folder !== 'string' || !folder.startsWith('/') || !existsSync(folder)) throw new Error('Target folder does not exist.');
  safeFolder(folder);
  const git = await gitState(folder);
  const list = await Promise.all(accounts.all().map(async a => ({ id: a.id, name: a.name, agent: a.agent,
    signedIn: (await accounts.status(a, true)).signedIn, unavailable: accounts.unavailable(a, agents.runningOn(a.id)) })));
  return { git, accounts: list };
}

interface StageInput { transferId: string; folder: string; handoffOnly: boolean; source: { id: string; num: number; title: string; desc: string; goal?: string; now?: string; ask?: string; agent: store.Agent; branch?: string; head: string; remote: string }; account: string; files: TransferFile[]; workspace: TransferFile[]; transcript?: TransferFile; bundle?: { size: number; hash: string; base: string; data: string }; groups: string[] }
async function removeCreatedWorktree(t: store.Task) {
  if (!t.transfer?.worktreeCreated || !t.branch) return;
  await exec('git', ['worktree', 'remove', t.cwd], { cwd: t.folder, timeout: 30000 });
  await exec('git', ['branch', '-D', t.branch], { cwd: t.folder, timeout: 10000 });
}
export async function stage(input: StageInput, sourceMachine: machines.Machine) {
  const existing = store.all().find(t => t.transfer?.id === input.transferId && t.transfer.direction === 'target');
  if (existing) {
    if (existing.transfer?.machine !== sourceMachine.id || existing.transfer.task !== input.source?.id) throw new Error('Transfer ID belongs to another task.');
    return { id: existing.id, num: existing.num, state: existing.transfer.state };
  }
  if (!/^[a-f0-9-]{36}$/.test(input.transferId) || !input.source || !Array.isArray(input.files) || !Array.isArray(input.workspace) || !Array.isArray(input.groups)) throw new Error('Invalid transfer package.');
  if (secretText.test([input.source.title, input.source.desc, input.source.goal, input.source.now, input.source.ask].join('\n'))) throw new Error('Task text may contain a secret. Edit the task text before transfer.');
  const target = await targetCheck(input.folder), acct = accounts.get(input.account);
  if (!acct || acct.agent !== input.source.agent || !(await accounts.status(acct, true)).signedIn || accounts.unavailable(acct, agents.runningOn(acct.id))) throw new Error('Choose an available signed-in target account.');
  if (input.bundle && input.handoffOnly) throw new Error('A handoff-only transfer cannot use a Git bundle.');
  if (!input.handoffOnly && (!target.git.remote || target.git.remote !== input.source.remote || target.git.changes.length || (input.bundle ? target.git.head !== input.bundle.base : target.git.branch !== input.source.branch || target.git.head !== input.source.head))) throw new Error('Target Git state changed. Run the check again.');
  if (input.handoffOnly && input.workspace.length) throw new Error('A handoff-only transfer cannot copy project files.');
  if ([...input.files, ...input.workspace, ...(input.transcript ? [input.transcript] : [])].reduce((sum, f) => sum + Number(f.size || 0), 0) + (input.bundle?.size || 0) > MAX_TOTAL) throw new Error('Transfer files exceed the size limit.');
  const num = store.nextNum(), id = `transfer-${input.transferId}-${num}`, dir = join(TASKS_DIR, id);
  for (const f of input.files) verifyFile(f, dir);
  if (input.transcript && input.transcript.path !== 'history/source-transcript.jsonl') throw new Error('Invalid transcript path.');
  if (input.transcript) verifyFile(input.transcript, dir);
  let cwd = target.git.root, branch = target.git.branch, worktreeCreated = false;
  if (input.bundle) {
    const bytes = Buffer.from(input.bundle.data || '', 'base64');
    if (bytes.length !== input.bundle.size || bytes.length > MAX_TOTAL || sha(bytes) !== input.bundle.hash || !/^[a-f0-9]{40,64}$/.test(input.source.head)) throw new Error('The Git bundle failed verification.');
    const directory = join(TB_DIR, 'transfers'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${input.transferId}.bundle`), ref = `refs/taskboard-transfer/${input.transferId}`;
    branch = `task/transfer-${input.transferId}`;
    cwd = join(target.git.main + '-wt', id);
    writeFileSync(file, bytes, { mode: 0o600 });
    try {
      await exec('git', ['bundle', 'verify', file], { cwd: target.git.main, timeout: 30000 });
      await exec('git', ['fetch', file, `HEAD:${ref}`], { cwd: target.git.main, timeout: 60000 });
      if (await git(target.git.main, 'rev-parse', ref) !== input.source.head) throw new Error('The bundle commit differs from the source commit.');
      await exec('git', ['worktree', 'add', '-b', branch, cwd, ref], { cwd: target.git.main, timeout: 30000 });
      worktreeCreated = true;
    } catch (e) {
      await exec('git', ['worktree', 'remove', '--force', cwd], { cwd: target.git.main }).catch(() => {});
      await exec('git', ['branch', '-D', branch], { cwd: target.git.main }).catch(() => {});
      throw e;
    } finally {
      await exec('git', ['update-ref', '-d', ref], { cwd: target.git.main }).catch(() => {});
      rmSync(file, { force: true });
    }
  }
  let task: store.Task;
  try {
    for (const f of input.workspace) verifyFile(f, cwd);
    task = store.create({ id, num, title: input.source.title, desc: input.source.desc, goal: input.source.goal, now: input.source.now,
    ask: input.source.ask, agent: acct.agent, account: acct.id, status: 'suspended', statusSource: `Staged from ${sourceMachine.name}.`,
    cwd, folder: target.git.main, branch, worktree: cwd !== target.git.main, session: `task-${num}`,
      transfer: { id: input.transferId, machine: sourceMachine.id, task: input.source.id, direction: 'target', state: 'staged', worktreeCreated, ...(sourceMachine.identity ? { peerIdentity: sourceMachine.identity } : {}) } });
  } catch (e) {
    if (worktreeCreated) {
      await exec('git', ['worktree', 'remove', cwd], { cwd: target.git.main }).catch(() => {});
      await exec('git', ['branch', '-D', branch], { cwd: target.git.main }).catch(() => {});
    }
    throw e;
  }
  try {
    for (const f of input.files) {
      const path = verifyFile(f, dir); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, Buffer.from(f.data!, 'base64'), { mode: 0o600 });
    }
    if (input.transcript) {
      const path = verifyFile(input.transcript, dir); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, Buffer.from(input.transcript.data!, 'base64'), { mode: 0o600 });
      store.update(id, { transcript: path });
    }
    writeFileSync(join(dir, 'workspace-stage.json'), JSON.stringify(input.workspace), { mode: 0o600 });
    const handoffDir = join(dir, 'handoffs'); mkdirSync(handoffDir, { recursive: true });
    const handoff = join(handoffDir, `transfer-${input.transferId}.md`);
    writeFileSync(handoff, [
      `Continue task: ${input.source.title}`,
      `The source task was #${input.source.num} on ${sourceMachine.name}.`,
      `Source task ID: ${input.source.id}.`,
      input.bundle ? `The source branch was ${input.source.branch || 'unnamed'}. This worktree uses ${branch}.` : '',
      `Original request: ${input.source.desc}`,
      `Goal: ${input.source.goal || input.source.title}`,
      `Last known work: ${input.source.now || 'Unknown.'}`,
      `Waiting for: ${input.source.ask || 'Nothing.'}`,
      `Read the task log and files in ${dir} before editing.`,
      input.transcript ? `The earlier transcript is in ${join(dir, 'history', 'source-transcript.jsonl')}.` : 'The earlier transcript was not copied.',
      'Check this worktree before continuing. The conversation starts here with this handoff.',
    ].join('\n\n'), { mode: 0o600 });
    store.update(id, { handoff });
    for (const name of input.groups.filter(x => typeof x === 'string' && x.length <= 80)) {
      const group = groups.all().find(g => g.name === name) || groups.create(name);
      groups.update(group.id, { tasks: [...group.tasks, id] });
    }
    return { id, num, state: 'staged' };
  } catch (e) {
    for (const g of groups.groupsOf(id)) groups.update(g.id, { tasks: g.tasks.filter(taskId => taskId !== id) });
    await removeCreatedWorktree(task);
    store.discardStagedTransfer(id);
    throw e;
  }
}

export async function start(transferId: string) {
  const t = store.all().find(x => x.transfer?.id === transferId && x.transfer.direction === 'target');
  if (!t) throw new Error('Target task not found.');
  if (t.transfer!.state === 'started') return { id: t.id, num: t.num, state: 'started' };
  if (t.transfer!.state === 'starting') return { id: t.id, num: t.num, state: 'starting' };
  if (!['staged', 'failed'].includes(t.transfer!.state)) throw new Error('Target task is not staged.');
  const acct = accounts.get(t.account);
  if (!acct || !(await accounts.status(acct, true)).signedIn || accounts.unavailable(acct, agents.runningOn(acct.id))) throw new Error('Target account is unavailable.');
  const current = await gitState(t.cwd);
  if (current.branch !== (t.branch || '')) throw new Error('The target branch changed after staging.');
  const staged = JSON.parse(readFileSync(join(store.taskDir(t.id), 'workspace-stage.json'), 'utf8')) as TransferFile[];
  for (const f of staged) verifyFile(f, current.root);
  if (current.changes.length) {
    const changed = current.changes.map(line => line.slice(3));
    if (changed.some(path => {
      const file = staged.find(f => f.path === path);
      return !file || !existsSync(resolve(current.root, path)) || sha(readFileSync(resolve(current.root, path))) !== file.hash;
    }))
      throw new Error('The target worktree changed after staging.');
  }
  for (const f of staged) {
    const path = resolve(current.root, f.path);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from(f.data!, 'base64'));
  }
  store.update(t.id, { transfer: { ...t.transfer!, state: 'starting' } });
  try {
    await agents.resumeTask(t);
    await new Promise(r => setTimeout(r, 250));
    const live = (await tmux.listSessions())?.find(session => session.name === t.session);
    if (!live || live.dead) throw new Error('The target agent stopped during startup.');
  }
  catch (e) {
    await tmux.killSession(t.session);
    store.update(t.id, { transfer: { ...t.transfer!, state: 'failed' }, status: 'suspended', statusSource: `Transfer start failed: ${String(e)}` }); throw e;
  }
  store.update(t.id, { transfer: { ...t.transfer!, state: 'started' }, statusSource: 'Transferred task started on this machine.' });
  return { id: t.id, num: t.num, state: 'started' };
}

export async function state(transferId: string) {
  const t = store.all().find(x => x.transfer?.id === transferId && x.transfer.direction === 'target');
  if (!t) return null;
  if (t.transfer?.state === 'starting' && Date.now() - Date.parse(t.updated) > 120000) {
    const present = await tmux.hasSession(t.session);
    if (present === true) store.update(t.id, { transfer: { ...t.transfer, state: 'started' }, statusSource: 'Recovered a transferred session after the server restarted.' });
    if (present === false) store.update(t.id, { transfer: { ...t.transfer, state: 'failed' }, status: 'suspended', statusSource: 'The transferred session did not start.' });
  }
  return { id: t.id, num: t.num, state: t.transfer!.state };
}
export async function cancel(transferId: string, sourceMachine: machines.Machine) {
  const t = store.all().find(x => x.transfer?.id === transferId && x.transfer.direction === 'target');
  if (!t) return { canceled: true };
  if (t.transfer?.machine !== sourceMachine.id || !['staged', 'failed'].includes(t.transfer.state)) throw new Error('The target task can no longer be canceled.');
  if (t.transfer.state === 'failed') {
    const sessions = await tmux.listSessions();
    if (!sessions || sessions.some(session => session.name === t.session && !session.dead)) throw new Error('The target session status is unknown. Check the target before canceling.');
  }
  for (const g of groups.groupsOf(t.id)) groups.update(g.id, { tasks: g.tasks.filter(id => id !== t.id) });
  await removeCreatedWorktree(t);
  store.discardStagedTransfer(t.id);
  return { canceled: true };
}

export async function move(t: store.Task, input: { machine: string; folder: string; account: string; fingerprint: string; handoffOnly?: boolean; useBundle?: boolean; includeFiles: boolean; includeWorkspace: boolean; includeTranscript?: boolean; stopNow?: boolean }) {
  if (t.role === 'controller' || t.openElsewhere) throw new Error('This session cannot move while it runs in another terminal.');
  const report = await check(t, input.machine, input.folder);
  if (report.fingerprint !== input.fingerprint) throw new Error('The transfer check changed. Review it again.');
  if (!report.ready && !input.handoffOnly && !input.useBundle) throw new Error(report.issues.join(' '));
  if (t.scopes?.length) throw new Error('This task has attached worktrees or folders. A transfer does not move them. Push their branches and remove them on the task page first.');
  if (input.handoffOnly && input.includeWorkspace) throw new Error('A handoff-only transfer cannot copy project files.');
  if (input.useBundle && (!report.bundle?.available || input.handoffOnly || report.source.remote !== report.target.remote || report.target.changes.length)) throw new Error('The Git bundle is not available for this target.');
  if (input.includeWorkspace && report.workspace.omitted.length) throw new Error('Some changed project files cannot be sent. Choose a prepared target worktree or commit the changes.');
  if (input.includeTranscript && !report.transcript?.available) throw new Error('The transcript cannot be sent. Use the handoff without it.');
  const m = machines.get(input.machine)!;
  const acct = report.accounts.find(a => a.id === input.account);
  if (!acct || acct.agent !== t.agent || !acct.signedIn || acct.unavailable) throw new Error('Choose an available target account for this agent.');
  if (!input.stopNow && t.status === 'working') throw new Error('The agent is working. Wait for its turn to finish, or choose Stop now.');
  const transferId = randomUUID();
  const bundleData = input.useBundle ? await bundle(t.cwd, report.target.head) : null;
  if (bundleData && (bundleData.hash !== report.bundle?.hash || bundleData.size !== report.bundle?.size)) throw new Error('The Git bundle changed. Run the check again.');
  const stageBody: StageInput = { transferId, folder: report.folder, handoffOnly: !!input.handoffOnly,
    source: { id: t.id, num: t.num, title: t.title, desc: t.desc, goal: t.goal, now: t.now, ask: t.ask, agent: t.agent,
      branch: report.source.branch, head: report.source.head, remote: report.source.remote }, account: input.account,
    files: input.includeFiles ? packageFiles(t, report.files) : [], workspace: input.includeWorkspace ? report.workspace.files.map(f => {
      const bytes = readFileSync(resolve(t.cwd, f.path));
      if (bytes.length !== f.size || sha(bytes) !== f.hash) throw new Error(`Project file changed: ${f.path}. Run the check again.`);
      return { ...f, data: bytes.toString('base64') };
    }) : [], transcript: input.includeTranscript && report.transcript && t.transcript ? (() => {
      const bytes = readFileSync(t.transcript);
      if (bytes.length !== report.transcript.size || sha(bytes) !== report.transcript.hash) throw new Error('Transcript changed. Run the check again.');
      return { path: report.transcript.path, size: bytes.length, hash: report.transcript.hash, data: bytes.toString('base64') };
    })() : undefined, bundle: bundleData ? { size: bundleData.size, hash: bundleData.hash, base: report.target.head, data: bundleData.data.toString('base64') } : undefined,
    groups: groups.groupsOf(t.id).map(g => g.name) };
  const staged = await callPeer(m, '/api/transfer/stage', stageBody);
  if (staged.state !== 'staged') throw new Error('The target task is not staged.');
  let stopped = false;
  try {
    const latest = await check(t, input.machine, input.folder);
    if (latest.fingerprint !== report.fingerprint) throw new Error('Files or Git state changed during staging. Run the check again.');
    const present = await tmux.hasSession(t.session);
    if (present === null) throw new Error('Cannot check the source session.');
    if (present) await tmux.killSession(t.session);
    stopped = true;
    store.update(t.id, { status: 'suspended', statusSource: `Starting target task on ${m.name}.`,
      transfer: { id: transferId, machine: m.id, task: staged.id, direction: 'source', state: 'staged', peerIdentity: m.identity } });
    const started = await callPeer(m, '/api/transfer/start', { transferId });
    if (started.state !== 'started') throw new Error('The target task is still starting. Check its state before resuming the source.');
    store.update(t.id, { status: 'archived', statusSource: `Moved to #${started.num} on ${m.name}.`,
      transfer: { id: transferId, machine: m.id, task: started.id, direction: 'source', state: 'started', peerIdentity: m.identity } });
    store.appendLog(t.id, { did: `Moved to #${started.num} on ${m.name}.`, next: 'Continue in the linked target task.' });
    return { id: started.id, num: started.num, machine: m.id, machineIdentity: m.identity, transferId };
  } catch (e) {
    if (!stopped) try { await callPeer(m, '/api/transfer/cancel', { transferId }); } catch { /* keep the source running */ }
    if (stopped) {
      let result: { state?: string } | null = null;
      try { result = await callPeer(m, '/api/transfer/state', { transferId }); } catch { /* result remains unknown */ }
      if (result?.state === 'started') {
        store.update(t.id, { status: 'archived', statusSource: `Moved to #${staged.num} on ${m.name}.`, transfer: { id: transferId, machine: m.id, task: staged.id, direction: 'source', state: 'started', peerIdentity: m.identity } });
        return { id: staged.id, num: staged.num, machine: m.id, machineIdentity: m.identity, transferId };
      }
      store.update(t.id, { status: 'suspended', statusSource: result ? 'Transfer failed. Resume the source task or retry the staged target.' : 'Transfer result is unknown. Check both machines before resuming.',
        transfer: { id: transferId, machine: m.id, task: staged.id, direction: 'source', state: 'failed', peerIdentity: m.identity } });
    }
    throw e;
  }
}

export async function recover(t: store.Task, action: 'status' | 'retry-target' | 'resume-source') {
  if (t.transfer?.direction !== 'source') throw new Error('This task is not the source of a transfer.');
  const m = machines.get(t.transfer.machine);
  if (!m) throw new Error('The target machine connection is missing.');
  const result = await callPeer(m, '/api/transfer/state', { transferId: t.transfer.id });
  if (result?.state === 'started') {
    store.update(t.id, { status: 'archived', statusSource: `Moved to #${result.num} on ${m.name}.`, transfer: { ...t.transfer, state: 'started' } });
    return { state: 'started', target: result };
  }
  if (action === 'status' || result?.state === 'starting') return { state: result?.state || 'unknown', target: result };
  if (action === 'retry-target') {
    if (!['staged', 'failed'].includes(result?.state)) throw new Error('The target cannot start in its current state.');
    const started = await callPeer(m, '/api/transfer/start', { transferId: t.transfer.id });
    if (started.state !== 'started') throw new Error('The target is still starting. Check again.');
    store.update(t.id, { status: 'archived', statusSource: `Moved to #${started.num} on ${m.name}.`, transfer: { ...t.transfer, state: 'started' } });
    return { state: 'started', target: started };
  }
  if (!['staged', 'failed'].includes(result?.state)) throw new Error('The target result is unknown. Do not resume the source.');
  await callPeer(m, '/api/transfer/cancel', { transferId: t.transfer.id });
  store.update(t.id, { transfer: undefined, status: 'suspended', statusSource: 'Transfer canceled. Resume the source task.' });
  return { state: 'source-ready' };
}
