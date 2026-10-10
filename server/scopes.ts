// Scope requests: a task asks for access that it did not get at its start, and the user approves each request on the
// dashboard (server/index.ts makes the approval card). There are two kinds:
// - worktree: the server creates a new branch and a linked worktree in a repository and attaches the worktree to the
//   task. The tb git commands then work in it with --worktree <name>.
// - read: the agent may read one more folder.
// The server runs git itself, outside the agent shell, and checks the request twice: when the task asks, and again
// just before it creates the worktree. Nothing here gives the agent a general permission bypass.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { HOME, TASKS_DIR, TB_DIR, VAULT } from './config.ts';
import * as accounts from './accounts.ts';
import * as machine from './machine.ts';
import { isProtectedBranch } from './push.ts';
import * as store from './store.ts';
import * as urgent from './urgent.ts';
import type { Scope, Task } from './store.ts';
import { rebasing, recordBase, resolveBase, scopeHint } from './task-git.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const inside = (path: string, root: string) => path === root || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
// Counts attached read folders and worktrees. The task's initial folder does not count.
function checkScopeLimit(t: Task): void {
  const limit = machine.get().scopeLimit;
  const count = (t.scopes || []).length;
  if (limit.enabled && count >= limit.max && !urgent.active(t.id)) // urgent mode (server/urgent.ts) has no scope limit
    throw new Error(`This task holds ${count} attached scopes. The configured maximum is ${limit.max}. Remove a scope or change Settings > Approvals > Scope requests.`);
}

export interface WorktreeInput { repo: string; base: string; branch: string; name?: string; reason: string }
export interface ReadInput { path: string; reason: string }
// What the approval card shows and what the server creates after the approval.
export interface WorktreePlan {
  kind: 'worktree'; taskId: string; repo: string; base: string; baseKind: 'remote branch' | 'commit'; baseCommit: string;
  branch: string; name: string; path: string; reason: string; mainHead: string; mainBranch: string; checks: string[];
}
export interface ReadPlan { kind: 'read'; taskId: string; path: string; name: string; reason: string; checks: string[] }
export type Plan = WorktreePlan | ReadPlan;

// Every worktree that a task holds: its own worktree (when it has one) and its attached worktrees.
export function taskWorktrees(tasks = store.all()): { task: Task; path: string; label: string }[] {
  const list: { task: Task; path: string; label: string }[] = [];
  for (const t of tasks) {
    if (t.role === 'controller') continue;
    if (t.worktree && t.cwd) list.push({ task: t, path: real(t.cwd), label: `the worktree of task #${t.num}` });
    for (const s of t.scopes || []) if (s.kind === 'worktree') list.push({ task: t, path: real(s.path), label: `the attached worktree ${s.name} of task #${t.num}` });
  }
  return list;
}
// The folders that the agent of a task may write in because of its scopes, and the folders that it may read.
export const worktreeScopes = (t: Task) => (t.scopes || []).filter(s => s.kind === 'worktree' && existsSync(s.path));
export const readScopes = (t: Task) => (t.scopes || []).filter(s => s.kind === 'read' && existsSync(s.path));

// The copy of a task that the tb git functions use for one attached worktree. cwd is the attached worktree, folder is
// the main checkout of its repository, and scopeKey keeps its backups, base and merge files apart from the task's own.
export function gitView(t: Task, s: Scope): Task {
  return { ...t, cwd: s.path, folder: s.repo!, branch: s.branch, worktree: true, scopeKey: s.name };
}

// The worktree that a tb git command works on:
// - --worktree <name or path>: that attached worktree, or the task's own worktree when the name is "main" or its path,
// - no --worktree: the task's own worktree, else the only attached worktree.
export function gitTarget(t: Task, ref?: string): Task {
  const attached = (t.scopes || []).filter(s => s.kind === 'worktree');
  const names = attached.map(s => s.name).join(', ');
  if (ref) {
    if (typeof ref !== 'string' || ref.length > 4096) throw new Error('Give --worktree a name or a path.');
    const path = ref.startsWith('/') || ref.startsWith('~') ? real(ref.replace(/^~(?=\/|$)/, HOME)) : '';
    if (t.worktree && (ref === 'main' || (path && path === real(t.cwd)))) return t;
    const s = attached.find(x => x.name === ref || (path && real(x.path) === path));
    if (!s) throw new Error(`This task has no attached worktree ${ref}. ${attached.length ? `Its attached worktrees: ${names}.` : 'It has no attached worktree.'}${t.worktree ? ' Use --worktree main for its own worktree.' : ''}`);
    if (!existsSync(s.path)) throw new Error(`The attached worktree ${s.name} (${s.path}) does not exist any more.`);
    return gitView(t, s);
  }
  if (t.worktree && t.branch) return t;
  if (attached.length === 1) {
    if (!existsSync(attached[0].path)) throw new Error(`The attached worktree ${attached[0].name} (${attached[0].path}) does not exist any more.`);
    return gitView(t, attached[0]);
  }
  if (attached.length > 1) throw new Error(`This task has ${attached.length} attached worktrees: ${names}. Give one with --worktree <name>.`);
  throw new Error(`This task has no worktree. ${scopeHint}`);
}

// The main checkout of the repository that holds path. A linked worktree gives the main checkout of its repository.
async function mainCheckout(path: string): Promise<string> {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`The repository ${path} is not an existing folder. Give an absolute path.`);
  const bare = await git(path, 'rev-parse', '--is-bare-repository').catch(() => '');
  if (bare === '') throw new Error(`${path} is not a Git repository.`);
  if (bare === 'true') throw new Error(`${path} is a bare repository. Give the main checkout of the repository.`);
  const list = await git(path, 'worktree', 'list', '--porcelain');
  const main = list.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
  if (!main || !existsSync(main)) throw new Error(`Taskboard cannot find the main checkout of ${path}.`);
  return realpathSync(main);
}

const protectedRoots = () => [TB_DIR, TASKS_DIR].filter(existsSync).map(p => realpathSync(p));

export async function planWorktree(t: Task, input: WorktreeInput): Promise<WorktreePlan> {
  if (t.role === 'controller') throw new Error('The controller cannot attach a worktree to itself.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 1000) throw new Error('Give --reason with a reason under 1000 characters.');
  if (typeof input.repo !== 'string' || typeof input.base !== 'string' || typeof input.branch !== 'string' || !input.repo || !input.base || !input.branch)
    throw new Error('Give --repo, --base and --branch.');
  checkScopeLimit(t);
  const repo = await mainCheckout(input.repo.replace(/^~(?=\/|$)/, HOME));
  if (protectedRoots().some(p => overlap(repo, p))) throw new Error('The repository contains protected Taskboard files.');
  const pseudo = { ...t, cwd: repo, folder: repo } as Task;

  // the base: a branch of a configured remote (git fetch updates only its remote-tracking ref) or a commit
  const base = input.base.trim();
  let baseKind: WorktreePlan['baseKind'], baseCommit: string;
  if (/^[0-9a-f]{7,64}$/i.test(base)) {
    baseCommit = await git(repo, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`).catch(() => '');
    if (!baseCommit) throw new Error(`${base} is not a commit in ${repo}.`);
    baseKind = 'commit';
  } else {
    let ref: string;
    try { ref = (await resolveBase(pseudo, base)).ref; } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(base === 'master' ? 'The base must be a remote branch such as origin/master, or a commit hash. Local branches are not allowed as a base.' : why);
    }
    if (!ref.startsWith('refs/remotes/')) throw new Error('The base must be a remote branch such as origin/master, or a commit hash.');
    baseCommit = await git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
    baseKind = 'remote branch';
  }

  // the branch: a valid name that the repository does not have yet, and not a protected branch
  const branch = input.branch.trim();
  if (branch.length > 100 || branch.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error(`${branch} is not an allowed branch name. Use letters, digits, ".", "_", "-" and "/".`);
  try { await exec('git', ['check-ref-format', '--branch', branch], { cwd: repo }); } catch { throw new Error(`${branch} is not a valid Git branch name.`); }
  if (isProtectedBranch(branch, undefined, machine.get().pushes.protectedBranches)) throw new Error(`${branch} is a protected branch name. Give a new task branch, for example task/<topic>.`);
  if (await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => '')) throw new Error(`The branch ${branch} already exists in ${repo}. Give a new branch name.`);

  // the name that --worktree uses, and the folder: <repository>-wt/<task id>--<name>, next to the task worktrees
  const own = (t.scopes || []).map(s => s.name);
  let name = input.name ? String(input.name) : slug(basename(repo)) || 'repo';
  if (input.name) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || name === 'main') throw new Error('Give --name 1 to 40 lowercase letters, digits or "-", and not "main".');
    if (own.includes(name)) throw new Error(`This task already has a scope named ${name}.`);
  } else {
    if (name === 'main') name = 'main-repo';
    if (own.includes(name)) name = `${name}-${slug(branch)}`.slice(0, 40).replace(/-$/, '');
    for (let n = 2; own.includes(name); n++) name = `${name.slice(0, 36)}-${n}`;
  }
  const path = join(dirname(repo), `${basename(repo)}-wt`, `${t.id}--${name}`);
  if (existsSync(path)) throw new Error(`The folder ${path} already exists. Give another --name.`);
  if (inside(path, repo)) throw new Error('The worktree folder is inside the main checkout.');
  if (protectedRoots().some(p => overlap(path, p))) throw new Error('The worktree folder overlaps protected Taskboard files.');
  for (const w of taskWorktrees()) if (overlap(path, w.path)) throw new Error(`The worktree folder ${path} overlaps ${w.label} (${w.path}).`);
  const listed = (await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).map(l => real(l.slice(9)));
  for (const w of listed.slice(1)) if (overlap(path, w)) throw new Error(`The worktree folder ${path} overlaps the existing worktree ${w}.`);

  const mainHead = await git(repo, 'rev-parse', 'HEAD').catch(() => '');
  const mainBranch = await git(repo, 'branch', '--show-current').catch(() => '');
  const checks = [
    `The main checkout ${repo} is not changed: its branch ${mainBranch || '(detached HEAD)'} and its files stay as they are. Git adds the branch ${branch} and the worktree record to the shared repository.`,
    `The base ${base} is a ${baseKind} of this repository at ${baseCommit}.${baseKind === 'remote branch' ? ' Taskboard ran git fetch for it. The new branch starts at this commit, even if the remote branch moves later.' : ''}`,
    `The branch ${branch} does not exist yet, and it is not a protected branch.`,
    `The folder ${path} does not exist, and it does not overlap the main checkout or the worktree of another task.`,
  ];
  return { kind: 'worktree', taskId: t.id, repo, base, baseKind, baseCommit, branch, name, path, reason, mainHead, mainBranch, checks };
}

// Runs after the approval. It checks the plan again, creates the branch and the worktree, and attaches the worktree.
export async function createWorktree(t: Task, plan: WorktreePlan): Promise<Scope> {
  if (plan.taskId !== t.id) throw new Error('The request belongs to another task.');
  const again = await planWorktree(t, { repo: plan.repo, base: plan.baseKind === 'commit' ? plan.baseCommit : plan.base, branch: plan.branch, name: plan.name, reason: plan.reason });
  if (again.path !== plan.path || again.repo !== plan.repo) throw new Error('The worktree folder changed after the request. Ask again.');
  if (again.mainHead !== plan.mainHead || again.mainBranch !== plan.mainBranch) throw new Error('The main checkout changed after the request. Ask again.');
  if (!await git(plan.repo, 'cat-file', '-e', `${plan.baseCommit}^{commit}`).then(() => true, () => false)) throw new Error(`The base commit ${plan.baseCommit} is missing. Ask again.`);
  // git worktree add -b writes the new branch and the worktree record; it does not change the main checkout
  await exec('git', ['-C', plan.repo, 'worktree', 'add', '--no-track', '-b', plan.branch, plan.path, plan.baseCommit], { timeout: 120000 });
  const undo = async () => {
    await exec('git', ['-C', plan.repo, 'worktree', 'remove', '--force', plan.path]).catch(() => {});
    await exec('git', ['-C', plan.repo, 'branch', '-D', plan.branch]).catch(() => {});
  };
  try {
    if (await git(plan.repo, 'rev-parse', 'HEAD').catch(() => '') !== plan.mainHead || await git(plan.repo, 'branch', '--show-current').catch(() => '') !== plan.mainBranch)
      throw new Error('The main checkout changed while Taskboard created the worktree.');
    if (await git(plan.path, 'branch', '--show-current') !== plan.branch) throw new Error('The new worktree is not on the new branch.');
  } catch (e) { await undo(); throw e; }
  const scope: Scope = { id: randomUUID().slice(0, 8), kind: 'worktree', name: plan.name, path: realpathSync(plan.path), repo: plan.repo, branch: plan.branch,
    base: plan.base, baseCommit: plan.baseCommit, at: new Date().toISOString(), reason: plan.reason };
  const current = store.get(t.id)!;
  // Another approval can finish while Git creates this worktree.
  try { checkScopeLimit(current); } catch (e) { await undo(); throw e; }
  store.update(t.id, { scopes: [...(current.scopes || []), scope] });
  // tb git rebase, check and push-request then use the remote branch that the worktree started from as its base
  if (plan.baseKind === 'remote branch') recordBase(gitView(current, scope), plan.base);
  // the worktree shares node_modules of the main checkout, as a task worktree does. Taskboard runs no package install
  // here: the tb command waits for this result, and the agent can run the install itself.
  const modules = join(plan.repo, 'node_modules');
  if (existsSync(modules) && !existsSync(join(scope.path, 'node_modules'))) { try { symlinkSync(modules, join(scope.path, 'node_modules'), 'dir'); } catch (e) { console.error('could not link node_modules', e); } }
  return scope;
}

// Folders that a read scope must not include, because they hold credentials or Taskboard state.
function secretRoots(): string[] {
  const names = ['.ssh', '.aws', '.config', '.gnupg', '.claude', '.codex', '.gemini', '.docker', '.kube', '.netrc', 'Library/Keychains'].map(n => join(HOME, n));
  return [...names, TB_DIR, ...accounts.all().map(a => a.dir)].filter(existsSync).map(p => realpathSync(p));
}

export function planRead(t: Task, input: ReadInput): ReadPlan {
  if (t.role === 'controller') throw new Error('The controller cannot ask for a scope.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 1000) throw new Error('Give --reason with a reason under 1000 characters.');
  if (t.agent === 'antigravity') throw new Error('Antigravity has no setting for read-only access to one folder. Ask the user to start a task in that folder.');
  checkScopeLimit(t);
  const given = typeof input.path === 'string' ? input.path.replace(/^~(?=\/|$)/, HOME) : '';
  if (!isAbsolute(given) || !existsSync(given) || !statSync(given).isDirectory()) throw new Error('Give --path an absolute path of an existing folder.');
  const path = realpathSync(given);
  const home = realpathSync(HOME);
  if (path === '/' || inside(home, path)) throw new Error('The folder is too broad: it contains the home folder. Give a project folder.');
  if (dirname(path) === '/' || path.split(sep).length <= 3 && !inside(path, home)) throw new Error('The folder is too broad. Give a project folder.');
  for (const p of secretRoots()) if (overlap(path, p)) throw new Error(`The folder overlaps ${p}, which holds credentials or Taskboard files.`);
  if (inside(path, realpathSync(VAULT))) throw new Error('The agent can already read the Taskboard vault.');
  if (inside(path, real(t.cwd))) throw new Error('The folder is already inside the task folder.');
  for (const s of t.scopes || []) if (inside(path, real(s.path))) throw new Error(`The folder is already inside the scope ${s.name}.`);
  let entries = 0; try { entries = readdirSync(path).length; } catch { throw new Error('Taskboard cannot list the folder.'); }
  const own = (t.scopes || []).map(s => s.name);
  let name = `read-${slug(basename(path)) || 'folder'}`.slice(0, 40);
  for (let n = 2; own.includes(name); n++) name = `${name.slice(0, 36)}-${n}`;
  const effect = t.agent === 'claude'
    ? 'Claude Code gets a Read rule for this folder only. It cannot edit or write files there. Taskboard restarts the session after its current turn, with the same conversation.'
    : 'The Codex sandbox already lets the agent read this folder. Taskboard adds the folder to the instructions of the task. Codex gets no write access to it.';
  const checks = [
    `The folder exists and holds ${entries} entries.`,
    'It does not contain the home folder, and it does not overlap the credential folders, the account folders or the Taskboard folder.',
    effect,
  ];
  return { kind: 'read', taskId: t.id, path, name, reason, checks };
}

export function addRead(t: Task, plan: ReadPlan): Scope {
  if (plan.taskId !== t.id) throw new Error('The request belongs to another task.');
  const current = store.get(t.id)!;
  const again = planRead(current, { path: plan.path, reason: plan.reason });
  const scope: Scope = { id: randomUUID().slice(0, 8), kind: 'read', name: again.name, path: again.path, at: new Date().toISOString(), reason: plan.reason };
  store.update(t.id, { scopes: [...(store.get(t.id)!.scopes || []), scope] });
  return scope;
}

// The approval card text. It names every value that the user approves and every check.
export function cardDetail(t: Task, plan: Plan): string {
  const limit = machine.get().scopeLimit;
  const head = [`Task: #${t.num} ${t.title}`, `Attached scopes: ${(t.scopes || []).length}. Count maximum: ${limit.enabled ? limit.max : 'off (no maximum)'}.`];
  if (plan.kind === 'read') return [...head, 'Scope: read access to one more folder', `Folder: ${plan.path}`, `Reason: ${plan.reason}`, 'Checks:', ...plan.checks.map(c => `- ${c}`)].join('\n');
  return [...head, 'Scope: a new worktree attached to this task', `Repository: ${plan.repo}`, `Base: ${plan.base} at ${plan.baseCommit}`, `New branch: ${plan.branch}`,
    `Worktree folder: ${plan.path}`, `Name for tb git --worktree: ${plan.name}`, `Reason: ${plan.reason}`, 'Checks:', ...plan.checks.map(c => `- ${c}`),
    `Effect on the agent: ${restartEffect(t)}`].join('\n');
}

// What the approval does to the running agent session.
export function restartEffect(t: Task): string {
  const agent = t.agent === 'claude' ? 'Claude Code' : t.agent === 'codex' ? 'Codex' : 'Antigravity';
  return `${agent} gets the folder through --add-dir at its next start. Taskboard restarts the session after its current turn ends and resumes the same conversation. ` +
    'Background shells that the agent started in its own session stop. Processes from tb run keep running.';
}
// A read scope changes the command line of Claude Code only. Codex can already read the folder.
export const needsRestart = (t: Task, kind: Scope['kind']) => kind === 'worktree' || t.agent === 'claude';

// What tb scope request prints after the approval when the session must restart first (index.ts applyScope). The
// agent cannot know when the restart comes, so the text says it, and says that the controller has no part in it.
export function restartText(s: Scope): string {
  const access = s.kind === 'worktree' ? `You have no write access to ${s.path} until this session restarts.` : `You cannot read ${s.path} until this session restarts.`;
  return [access, 'Taskboard restarts this session after this turn ends, and resumes the same conversation.',
    'End your turn now and wait. Do not try to work around it: do not use another folder, and do not ask for a permit.',
    'Do not wait for the controller, and do not send it a message for this. Taskboard restarts the session by itself.',
    'After the restart, Taskboard puts a note in your inbox. Background shells that you started stop. Processes from tb run keep running.'].join('\n');
}

export function noticeText(t: Task, s: Scope): string {
  if (s.kind === 'read') return [`# Scope ${s.id}: read access`, '', `The user approved read access to ${s.path} for task #${t.num}.`,
    t.agent === 'claude' ? 'Claude Code may now read files in that folder. It may not write there.' : 'Read files there with your shell tools. Do not write there.'].join('\n') + '\n';
  return [`# Scope ${s.id}: worktree ${s.name}`, '', `The user approved a worktree for task #${t.num}.`, '',
    `- Repository: ${s.repo}`, `- Branch: ${s.branch}`, `- Base: ${s.base} at ${s.baseCommit}`, `- Worktree folder: ${s.path}`, '',
    `This session has write access to ${s.path}. Work there. Do not change the main checkout ${s.repo}.`,
    `Run the tb git commands with --worktree ${s.name}, for example: tb git commit --worktree ${s.name} "<message>".`,
    `tb git rebase --worktree ${s.name} uses ${s.base} as the base when you give no base.`].join('\n') + '\n';
}

// Removes one scope of a task. A worktree with uncommitted changes is never removed. Ignored files (for example .env
// or build output) are listed first, and the removal goes on only when the user confirms that list. The branch stays.
export async function removeScope(t: Task, name: string, confirmIgnored = false): Promise<{ result: string; ignored?: string[] }> {
  const s = (t.scopes || []).find(x => x.name === name || x.id === name);
  if (!s) throw new Error(`This task has no scope ${name}.`);
  const keep = () => store.update(t.id, { scopes: (store.get(t.id)!.scopes || []).filter(x => x.id !== s.id) });
  if (s.kind === 'read' || !existsSync(s.path)) { keep(); return { result: s.kind === 'read' ? `Removed read access to ${s.path}.` : `Removed the record of ${s.name}. Its folder did not exist.` }; }
  if (await rebasing(s.path)) throw new Error(`The worktree ${s.name} has an unfinished rebase. Taskboard did not remove it.`);
  const changes = (await git(s.path, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(Boolean);
  if (changes.length) throw new Error(`The worktree ${s.name} has ${changes.length} uncommitted change(s), so Taskboard did not remove it: ${changes.slice(0, 20).join('; ')}${changes.length > 20 ? '; and more' : ''}. Commit them with tb git commit --worktree ${s.name}, or remove them yourself.`);
  const ignored = (await git(s.path, 'status', '--porcelain', '--ignored', '--untracked-files=all')).split('\n').filter(l => l.startsWith('!! ')).map(l => l.slice(3))
    .filter(f => f !== 'node_modules' && f !== 'node_modules/');
  if (ignored.length && !confirmIgnored) return { result: `The worktree ${s.name} holds ${ignored.length} ignored file(s). Removing the worktree deletes them. Confirm to remove it.`, ignored: ignored.slice(0, 50) };
  await exec('git', ['-C', s.repo!, 'worktree', 'remove', ...(ignored.length ? ['--force'] : []), s.path], { timeout: 60000 });
  keep();
  return { result: `Removed the worktree ${s.path}. The branch ${s.branch} stays in ${s.repo}.` };
}
