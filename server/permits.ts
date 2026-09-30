import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TB_DIR, VAULT, TASKS_DIR, GUARD_SCRIPT, PORT } from './config.ts';
import type { Task } from './store.ts';
import * as store from './store.ts';
import * as machine from './machine.ts';

export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type PermitState = 'pending' | 'running' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown';
export interface PermitStep {
  command: string; argv: string[]; cwd: string; timeoutSeconds: number; network: boolean;
  scriptHash?: string;
  state: StepState; startedAt?: string; finishedAt?: string; exitCode?: number | null; signal?: string | null;
  outputTail?: string; error?: string;
}
export interface Permit {
  id: string; taskId: string; taskNum: number; agent: string; reason: string; refusalId?: string;
  approvalId?: string;
  createdAt: string; expiresAt: string; state: PermitState; stepHash: string; riskFlags: string[];
  steps: PermitStep[]; approvedBy?: 'user' | 'controller'; controllerRequestText?: string;
  decidedAt?: string; decisionComment?: string; startedAt?: string; finishedAt?: string; error?: string;
}
export interface StepInput { command: string; cwd?: string; timeoutSeconds?: number; network?: boolean; continueOnFailure?: boolean }
const DIR = join(TB_DIR, 'permits');
const records = new Map<string, Permit>();
const listeners = new Set<(p: Permit) => void>();
const now = () => new Date().toISOString();
const inside = (root: string, path: string) => path === root || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const unsafeRoot = (root: string) => [TB_DIR, TASKS_DIR].some(protectedPath => inside(root, realpathSync(protectedPath)) || inside(realpathSync(protectedPath), root));
const file = (id: string) => join(DIR, id + '.json');
const save = (p: Permit) => {
  mkdirSync(DIR, { recursive: true });
  const tmp = join(DIR, `.${p.id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(p, null, 2), { mode: 0o600 });
  renameSync(tmp, file(p.id));
  for (const fn of listeners) fn(p);
};
export const onChange = (fn: (p: Permit) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export function load() {
  mkdirSync(DIR, { recursive: true });
  for (const name of readdirSync(DIR)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    try {
      const p = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Permit;
      if (p.state === 'running') { p.state = 'unknown'; p.error = 'Taskboard restarted during execution. Check effects before asking again.'; p.finishedAt = now(); save(p); }
      if (p.state === 'pending' && Date.parse(p.expiresAt) <= Date.now()) { p.state = 'expired'; p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); }
      records.set(p.id, p);
    } catch { /* skip a damaged record */ }
  }
}
export const get = (id: string) => records.get(id);
export const all = () => [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export function attachApproval(p: Permit, approvalId: string) { p.approvalId = approvalId; save(p); }

// A command is one executable and its arguments. A shell never interprets it.
export function parseCommand(command: string): string[] {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\r\n\0]/.test(command)) throw new Error('Give one command line under 2000 characters.');
  const args: string[] = []; let value = '', quote = '', active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (c === '\\' && quote === '"' && i + 1 < command.length) { value += command[++i]; continue; }
      value += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (/\s/.test(c)) { if (active) { args.push(value); value = ''; active = false; } continue; }
    if (/[;&|`$<>(){}\[\]*?!#\\]/.test(c)) throw new Error('Shell syntax is not allowed in a permit command.');
    value += c; active = true;
  }
  if (quote) throw new Error('Close the quoted argument.');
  if (active) args.push(value);
  if (!args.length || args.length > 64) throw new Error('Give one executable and at most 63 arguments.');
  if (args[0].includes('/') && !isAbsolute(args[0])) throw new Error('Use an absolute executable path or a name on PATH.');
  return args;
}

function hardRule(argv: string[]) {
  const bin = argv[0].split('/').pop() || '';
  const text = argv.join(' ');
  if (/^(sudo|su|ssh|scp|sftp|vi|vim|nano|less|more|top|htop)$/.test(bin) || (/^(bash|sh|zsh|python|python3|node)$/.test(bin) && argv.includes('-i'))) throw new Error('Interactive commands cannot run from a permit.');
  if (bin === 'tb' || bin === 'taskboard') throw new Error('A permit cannot run another Taskboard command.');
  if (bin === 'git' && argv.slice(1).some(x => /^(add|commit|rebase|merge|reset|checkout|switch|push|pull|cherry-pick|revert|worktree|update-ref|stash|branch|tag)$/.test(x))) throw new Error('Use the task Git commands for changes to Git refs.');
  if (/\bgit\s+push\b|\bgh\s+(repo|pr|api)\b/.test(text)) throw new Error('A GitHub write needs a separate user decision.');
  if (/\b(pnpm|npm|yarn)\b.*\b(release|rollback)\b|scripts\/release\.mjs|scripts\/rollback\.mjs/.test(text)) throw new Error('A release or rollback needs its own rule.');
  if (/\b(pkill|killall|launchctl)\b/.test(text)) throw new Error('This process command is outside permit scope.');
  if (/\.taskboard|server\.pid|server\/index\.ts|taskboard\s+kill-server/.test(text)) throw new Error('A permit cannot change the running Taskboard server.');
}
function risk(argv: string[], cwd: string, task: Task, network: boolean): string[] {
  const flags: string[] = [];
  const bin = argv[0].split('/').pop() || '';
  if (network) flags.push('Uses network');
  if (/^(rm|rmdir|unlink|find)$/.test(bin)) flags.push('Deletes files');
  if (/^(git|hg)$/.test(bin) && /^(rebase|reset|commit|merge)$/.test(argv[1] || '')) flags.push('Changes Git history');
  if (!inside(realpathSync(task.cwd), cwd) && !inside(realpathSync(join(VAULT, 'tasks', task.id)), cwd)) flags.push('Touches a user allowed folder');
  if (!/^(pwd|rg|ls|cat|head|tail|wc|echo|true|false|test|stat|find)$/.test(bin)) flags.push('Unknown effect');
  if (!/^(pwd|rg|ls|cat|head|tail|wc|echo|true|false|test|stat)$/.test(bin)) flags.push('Writes in task paths');
  return flags;
}
function scriptHash(argv: string[], cwd: string, roots: string[]): string | undefined {
  const bin = argv[0].split('/').pop() || '';
  const name = /^(bash|sh|zsh|python|python3|node)$/.test(bin) ? argv[1] : /\.(sh|py|js|mjs)$/.test(argv[0]) ? argv[0] : undefined;
  if (!name || name.startsWith('-')) return;
  const target = isAbsolute(name) ? name : join(cwd, name);
  try {
    const real = realpathSync(target);
    if (!roots.some(root => inside(root, real))) throw new Error('The script file is outside this task.');
    const content = readFileSync(real);
    if (/\bgit\s+push\b|\bgh\s+(repo|pr|api)\b/.test(content.toString('utf8'))) throw new Error('A GitHub write needs a separate user decision.');
    return createHash('sha256').update(content).digest('hex');
  }
  catch (e) { if (e instanceof Error && /outside this task|GitHub write/.test(e.message)) throw e; throw new Error('The script file must exist when you request the permit.'); }
}
export function validate(task: Task, inputs: StepInput[]): { steps: PermitStep[]; riskFlags: string[] } {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 8) throw new Error('Give one through eight steps.');
  if (task.role === 'controller') throw new Error('The controller cannot request a permit for itself.');
  const roots = [task.cwd, join(VAULT, 'tasks', task.id), ...machine.get().permitFolders].filter(existsSync).map(p => realpathSync(p));
  if (unsafeRoot(realpathSync(task.cwd))) throw new Error('The task folder contains protected Taskboard files.');
  if (machine.get().permitFolders.some(p => !existsSync(p) || unsafeRoot(realpathSync(p)))) throw new Error('An extra folder contains protected Taskboard files.');
  const otherWorktrees = store.all().filter(t => t.id !== task.id && t.worktree && existsSync(t.cwd)).map(t => realpathSync(t.cwd));
  if (roots.some(root => otherWorktrees.some(other => inside(root, other) || inside(other, root)))) throw new Error('The allowed folders overlap another task worktree.');
  const steps = inputs.map(input => {
    if (input.continueOnFailure) throw new Error('Steps must stop after a failure.');
    const argv = parseCommand(input.command); hardRule(argv);
    const requested = input.cwd || task.cwd;
    if (!isAbsolute(requested)) throw new Error('A working directory must be absolute.');
    const cwd = realpathSync(requested);
    if (!roots.some(root => inside(root, cwd))) throw new Error('The working directory is outside this task.');
    const timeoutSeconds = input.timeoutSeconds ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error('A step timeout must be 1 through 120 seconds.');
    return { command: input.command, argv, cwd, timeoutSeconds, network: input.network === true, scriptHash: scriptHash(argv, cwd, roots), state: 'pending' as const };
  });
  if (steps.reduce((sum, s) => sum + s.timeoutSeconds, 0) > 300) throw new Error('The sequence exceeds five minutes.');
  return { steps, riskFlags: [...new Set(steps.flatMap(s => risk(s.argv, s.cwd, task, s.network)))] };
}
export function request(task: Task, reason: string, inputs: StepInput[], refusalId?: string): Permit {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('Give a reason under 1000 characters.');
  const recent = all().filter(p => p.taskId === task.id);
  if (recent.some(p => ['pending', 'running'].includes(p.state))) throw new Error('This task already has a pending permit.');
  if (recent.filter(p => Date.parse(p.createdAt) > Date.now() - 600000).length >= 3 || recent.filter(p => Date.parse(p.createdAt) > Date.now() - 86400000).length >= 10) throw new Error('This task has reached its permit request limit.');
  const { steps, riskFlags } = validate(task, inputs);
  const id = randomUUID();
  const stepHash = createHash('sha256').update(JSON.stringify({ taskId: task.id, steps: steps.map(s => [s.argv, s.cwd, s.timeoutSeconds, s.network, s.scriptHash]) })).digest('hex');
  const p: Permit = { id, taskId: task.id, taskNum: task.num, agent: task.agent, reason: reason.trim(), refusalId,
    createdAt: now(), expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'pending', stepHash, riskFlags, steps };
  records.set(id, p); save(p); return p;
}
export function expire(p: Permit) {
  if (p.state !== 'pending' || Date.parse(p.expiresAt) > Date.now()) return false;
  p.state = 'expired'; p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return true;
}
export function deny(p: Permit, comment: string) {
  if (expire(p) || p.state !== 'pending') return p;
  p.state = 'denied'; p.decidedAt = now(); p.decisionComment = comment.slice(0, 2000);
  p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return p;
}
export function controllerAllowed(p: Permit, task: Task, enabled: boolean) {
  if (!enabled || p.taskId !== task.id || p.state !== 'pending' || expire(p)) return false;
  if (p.riskFlags.some(f => f !== 'Writes in task paths')) return false;
  return p.steps.every(s => !s.network);
}

const path = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
function sandboxProfile(task: Task, step: PermitStep): string {
  const q = (s: string) => JSON.stringify(s);
  const roots = [task.cwd, join(VAULT, 'tasks', task.id), ...machine.get().permitFolders].filter(existsSync).map(p => realpathSync(p));
  const reads = ['/usr', '/bin', '/sbin', '/System', '/Library', '/opt/homebrew', '/usr/local', '/private/tmp', ...roots];
  return `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow sysctl-read)
    (allow file-read* ${reads.map(s => `(subpath ${q(s)})`).join(' ')} (literal "/dev/null") (literal "/dev/urandom"))
    (allow file-write* ${roots.map(s => `(subpath ${q(s)})`).join(' ')})
    ${step.network ? '(allow network*)' : ''}`;
}
async function guard(task: Task, step: PermitStep) {
  hardRule(step.argv);
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], { input: JSON.stringify({ tool_input: { command: step.command } }), encoding: 'utf8',
    env: { PATH: path, HOME: process.env.HOME || '', TASK_ID: task.id, TASK_WORKTREE: task.worktree ? task.cwd : '', TASKBOARD_DIR: TB_DIR, TASKBOARD_PORT: String(PORT) } });
  if (result.status !== 0) throw new Error(result.stderr || 'The Taskboard guard failed.');
  if (result.stdout.trim()) {
    let reason = result.stdout;
    try { reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason || reason; } catch { /* keep the guard output */ }
    throw new Error(reason);
  }
}
export async function run(p: Permit, task: Task, by: 'user' | 'controller', comment = '', controllerRequestText = '', executor: typeof execute = execute) {
  if (expire(p) || p.state !== 'pending') return p;
  if (p.taskId !== task.id) throw new Error('The task changed.');
  try {
    const { steps } = validate(task, p.steps);
    const hash = createHash('sha256').update(JSON.stringify({ taskId: task.id, steps: steps.map(s => [s.argv, s.cwd, s.timeoutSeconds, s.network, s.scriptHash]) })).digest('hex');
    if (hash !== p.stepHash) throw new Error('The approved steps changed.');
  } catch (e) {
    p.state = 'failed'; p.error = e instanceof Error ? e.message : String(e);
    p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return p;
  }
  p.state = 'running'; p.approvedBy = by; p.decidedAt = now(); p.decisionComment = comment.slice(0, 2000);
  if (by === 'controller') p.controllerRequestText = controllerRequestText.slice(0, 2000);
  p.startedAt = now(); save(p);
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i];
    try {
      const checked = validate(task, [step]).steps[0];
      if (checked.cwd !== step.cwd || checked.scriptHash !== step.scriptHash) throw new Error('The working directory or script changed after approval.');
      await guard(task, step);
      step.state = 'running'; step.startedAt = now(); save(p);
      const result = await executor(task, step);
      step.exitCode = result.code; step.signal = result.signal; step.outputTail = result.output.slice(-8192);
      step.state = result.code === 0 ? 'succeeded' : 'failed';
      if (result.error) step.error = result.error;
    } catch (e) { step.state = 'failed'; step.error = e instanceof Error ? e.message : String(e); }
    step.finishedAt = now(); save(p);
    if (step.state === 'failed') {
      p.state = 'failed'; p.error = `Step ${i + 1} failed: ${step.error || `exit ${step.exitCode}`}`;
      p.steps.slice(i + 1).forEach(s => s.state = 'cancelled'); break;
    }
  }
  if (p.state === 'running') p.state = 'succeeded';
  p.finishedAt = now(); save(p); return p;
}

async function execute(task: Task, step: PermitStep): Promise<{ code: number | null; signal: string | null; output: string; error?: string }> {
  // These four commands have no file or network effects. They also work when the operating system sandbox is unavailable.
  if (!step.network && step.argv[0] === 'pwd' && step.argv.length === 1) return { code: 0, signal: null, output: step.cwd + '\n' };
  if (!step.network && step.argv[0] === 'echo' && step.argv.slice(1).every(s => !s.startsWith('-') && !s.includes('\\'))) return { code: 0, signal: null, output: step.argv.slice(1).join(' ') + '\n' };
  if (!step.network && step.argv[0] === 'true' && step.argv.length === 1) return { code: 0, signal: null, output: '' };
  if (!step.network && step.argv[0] === 'false' && step.argv.length === 1) return { code: 1, signal: null, output: '' };
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('The command sandbox is unavailable. Nothing ran.');
  const env = { PATH: path, HOME: process.env.HOME || '' };
  const profile = sandboxProfile(task, step);
  return new Promise(resolveResult => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, step.argv[0], ...step.argv.slice(1)],
      { cwd: step.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', done = false, timedOut = false;
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (done) return; done = true; clearTimeout(timer);
      resolveResult({ code, signal, output: output.slice(-8192), error: timedOut ? 'Step timed out.' : error });
    };
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-131072); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', e => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal));
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, step.timeoutSeconds * 1000);
  });
}
