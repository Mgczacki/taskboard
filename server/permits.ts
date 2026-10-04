import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TB_DIR, VAULT, TASKS_DIR, GUARD_SCRIPT, PORT } from './config.ts';
import type { Task } from './store.ts';
import * as store from './store.ts';
import * as machine from './machine.ts';
import * as taskGit from './task-git.ts';
import { scopeHint } from './task-git.ts';
import { taskWorktrees, worktreeScopes } from './scopes.ts';

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
  steps: PermitStep[]; approvedBy?: 'user' | 'controller'; approvalRule?: string; riskClass?: 'low' | 'high'; controllerRequestText?: string; statedRisk?: string;
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

function allowedTaskGit(argv: string[]): boolean {
  if (argv[0] !== 'git') return false;
  if (argv.length === 2 && /^(status|diff|log|show)$/.test(argv[1])) return true;
  if (argv.length === 3 && argv[1] === 'add' && argv[2] === '-A') return true;
  if (argv.length === 4 && argv[1] === 'commit' && argv[2] === '-m' && argv[3].length <= 200) return true;
  if (argv.length === 3 && argv[1] === 'rebase' && /^(master|--abort|--continue)$/.test(argv[2])) return true;
  return false;
}
function allowedSharedGit(argv: string[], task: Task): boolean {
  return argv[0] === 'git' && !!task.worktree && !!task.branch && (
    (argv.length === 3 && argv[1] === 'merge' && (argv[2] === '--abort' || argv[2] === task.branch)) ||
    (argv.length === 4 && argv[1] === 'merge' && argv[2] === '--no-ff' && argv[3] === task.branch));
}
function hardRule(argv: string[], task?: Task) {
  const bin = argv[0].split('/').pop() || '';
  const text = argv.join(' ');
  if (/^mcp__[^\s/]+$/.test(argv[0])) throw new Error('An MCP tool call cannot run from a shell permit. Do not retry this command. Use an allowed path or ask the user to do this step.');
  if (/^(sudo|su|ssh|scp|sftp|vi|vim|nano|less|more|top|htop)$/.test(bin) || (/^(bash|sh|zsh|python|python3|node)$/.test(bin) && argv.includes('-i'))) throw new Error('Interactive commands cannot run from a permit.');
  if (bin === 'tb' || bin === 'taskboard') throw new Error('A permit cannot run another Taskboard command.');
  if (bin === 'git' && argv.slice(1).some(x => /^(add|commit|rebase|merge|reset|checkout|switch|push|pull|cherry-pick|revert|worktree|update-ref|stash|branch|tag)$/.test(x)) && !allowedTaskGit(argv) && !(task && allowedSharedGit(argv, task)))
    throw new Error(argv.includes('worktree') || (task && !task.worktree)
      ? `Use the task Git commands for changes to Git refs. A permit cannot create a worktree. ${scopeHint}`
      : 'Use the task Git commands for changes to Git refs.');
  if (/\bgit\s+push\b|\bgh\s+(repo|pr|api)\b/.test(text)) throw new Error('A GitHub write needs a separate user decision.');
  if (/\b(pnpm|npm|yarn)\b.*\b(release|rollback)\b|scripts\/release\.mjs|scripts\/rollback\.mjs/.test(text)) throw new Error('A release or rollback needs its own rule.');
  if (/scripts\/restart\.mjs/.test(text)) throw new Error('A restart of Taskboard needs the user.');
  if (/\b(pkill|killall|launchctl)\b/.test(text)) throw new Error('This process command is outside permit scope.');
  if (/\.taskboard|server\.pid|server\/index\.ts|taskboard\s+kill-server/.test(text)) throw new Error('A permit cannot change the running Taskboard server.');
  if (argv.some(a => /(^|\/)\.env(?:\.|$)|\.(?:pem|key|p8|p12|pfx)$/.test(a))) throw new Error('A suggestion cannot display a credential file.');
  if (bin === 'env' && argv.some(a => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))) throw new Error('Do not place environment values in the command card.');
  if (bin === 'security' && argv.includes('-p')) throw new Error('Do not place a keychain password in the command card.');
  if (/(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/i.test(text) || /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/.test(text)) throw new Error('The command contains a secret value. Use a file or a credential store instead.');
}
export function redactOutput(value: string): string {
  let safe = value;
  for (const [name, secret] of Object.entries(process.env)) if (/(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(name) && secret && secret.length >= 6)
    safe = safe.split(secret).join('[redacted]');
  return safe.replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:ghp_|gho_|github_pat_|glpat-|sk-)[A-Za-z0-9_-]{12,}\b/g, '[redacted token]');
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
  const roots = [task.cwd, join(VAULT, 'tasks', task.id), ...worktreeScopes(task).map(s => s.path), ...machine.get().permitFolders].filter(existsSync).map(p => realpathSync(p));
  if (unsafeRoot(realpathSync(task.cwd))) throw new Error('The task folder contains protected Taskboard files.');
  if (machine.get().permitFolders.some(p => !existsSync(p) || unsafeRoot(realpathSync(p)))) throw new Error('An extra folder contains protected Taskboard files.');
  const otherWorktrees = taskWorktrees().filter(w => w.task.id !== task.id && existsSync(w.path)).map(w => w.path);
  if (roots.some(root => otherWorktrees.some(other => inside(root, other) || inside(other, root)))) throw new Error('The allowed folders overlap another task worktree.');
  const steps = inputs.map(input => {
    if (input.continueOnFailure) throw new Error('Steps must stop after a failure.');
    const argv = parseCommand(input.command); hardRule(argv, task);
    const requested = input.cwd || task.cwd;
    if (!isAbsolute(requested)) throw new Error('A working directory must be absolute.');
    const cwd = realpathSync(requested);
    if (unsafeRoot(cwd)) throw new Error('The working directory contains protected Taskboard files.');
    if (otherWorktrees.some(other => inside(other, cwd))) throw new Error('The working directory is another task worktree.');
    if (argv[0] === 'git' && allowedTaskGit(argv) && (!task.worktree || !task.branch || cwd !== realpathSync(task.cwd))) throw new Error('Git commands need this task’s own worktree branch.');
    if (argv[0] === 'git' && allowedSharedGit(argv, task) && cwd !== realpathSync(task.folder)) throw new Error('The merge command needs the task’s shared checkout.');
    const timeoutSeconds = input.timeoutSeconds ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error('A step timeout must be 1 through 120 seconds.');
    return { command: input.command, argv, cwd, timeoutSeconds, network: input.network === true, scriptHash: scriptHash(argv, cwd, [...roots, cwd]), state: 'pending' as const };
  });
  if (steps.reduce((sum, s) => sum + s.timeoutSeconds, 0) > 300) throw new Error('The sequence exceeds five minutes.');
  return { steps, riskFlags: [...new Set(steps.flatMap(s => risk(s.argv, s.cwd, task, s.network)))] };
}
export function canPermitRefusal(task: Task, refusal: { command: string; cwd?: string; toolName?: string }): boolean {
  if (refusal.toolName && refusal.toolName !== 'Bash') return false;
  try { validate(task, [{ command: refusal.command, cwd: refusal.cwd || task.cwd }]); return true; }
  catch { return false; }
}
export function request(task: Task, reason: string, inputs: StepInput[], refusalId?: string, statedRisk = ''): Permit {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('Give a reason under 1000 characters.');
  if (typeof statedRisk !== 'string' || statedRisk.length > 500) throw new Error('Keep the risk under 500 characters.');
  const recent = all().filter(p => p.taskId === task.id);
  if (recent.some(p => ['pending', 'running'].includes(p.state))) throw new Error('This task already has a pending permit.');
  if (recent.filter(p => Date.parse(p.createdAt) > Date.now() - 600000).length >= 3 || recent.filter(p => Date.parse(p.createdAt) > Date.now() - 86400000).length >= 10) throw new Error('This task has reached its permit request limit.');
  const { steps, riskFlags } = validate(task, inputs);
  const id = randomUUID();
  const stepHash = createHash('sha256').update(JSON.stringify({ taskId: task.id, steps: steps.map(s => [s.command, s.cwd, s.timeoutSeconds, s.network, s.scriptHash]) })).digest('hex');
  const p: Permit = { id, taskId: task.id, taskNum: task.num, agent: task.agent, reason: redactOutput(reason.trim()), refusalId,
    createdAt: now(), expiresAt: '', state: 'pending', stepHash, riskFlags, steps, statedRisk: redactOutput(statedRisk.trim()), riskClass: classify(steps, task) };
  records.set(id, p); save(p); return p;
}
export function expire(p: Permit) {
  return false;
}
// End a pending permit without a decision, for example because its task was archived. Nothing runs.
export function cancel(p: Permit, reason: string) {
  if (expire(p) || p.state !== 'pending') return false;
  p.state = 'expired'; p.error = reason; p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return true;
}
export function deny(p: Permit, comment: string) {
  if (expire(p) || p.state !== 'pending') return p;
  p.state = 'denied'; p.decidedAt = now(); p.decisionComment = redactOutput(comment.slice(0, 2000));
  p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return p;
}
export function controllerRule(p: Permit, task: Task, readOnly: boolean): string | undefined {
  if (!readOnly || p.taskId !== task.id || p.state !== 'pending' || expire(p)) return;
  if (p.riskClass !== 'low' || classify(p.steps, task) !== 'low') return;
  return 'low-risk commands';
}
export const controllerAllowed = (p: Permit, task: Task, enabled: boolean) => !!controllerRule(p, task, enabled);
export function explicitControllerRequest(transcript: string | undefined, agent: string, words: string, p: Permit): boolean {
  if (!transcript || !words.trim() || words.length > 2000 || !/\b(approve|run)\b/i.test(words)) return false;
  if (!p.steps.every(s => words.includes(s.command) || words.includes(p.id))) return false;
  return userWrote(transcript, agent, words);
}
// True when one user message in the controller transcript is exactly these words. Text that a tool returned, a task
// log or a mail is not a user message, so it does not count.
export const userWrote = (transcript: string | undefined, agent: string, words: string): boolean => userWroteCount(transcript, agent, words) > 0;
// How many user messages in the controller transcript are exactly these words.
export function userWroteCount(transcript: string | undefined, agent: string, words: string): number {
  if (!transcript || !words.trim() || words.length > 2000) return 0;
  let content = '';
  let count = 0;
  try { content = readFileSync(transcript, 'utf8').slice(-4 * 1024 * 1024); } catch { return 0; }
  for (const line of content.split('\n')) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    let message = '';
    if (agent === 'claude' && row.type === 'user' && !row.isMeta && !row.isSidechain) {
      const c = row.message?.content;
      message = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '';
    } else if (agent === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
      message = (row.payload.content || []).filter((x: any) => x.type === 'input_text').map((x: any) => x.text).join('\n');
    } else if (agent === 'antigravity' && row.type === 'USER_INPUT') {
      message = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? row.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') : '';
    }
    if (message.trim() === words.trim()) count++;
  }
  return count;
}
export function notice(p: Permit): string {
  const comment = p.decisionComment ? ` User comment: ${p.decisionComment}.` : '';
  const result = p.steps.map((s, i) => `Step ${i + 1}: ${s.state}, exit ${s.exitCode ?? 'none'}.`).join(' ');
  return `Suggestion ${p.id} ${p.state}.${comment} ${result} Read the last 200 output lines in your inbox.`;
}
export function classify(steps: PermitStep[], task: Task): 'low' | 'high' {
  const read = /^(pwd|rg|ls|cat|head|tail|wc|stat|echo|true|false|test)$/;
  if (steps.some(s => /(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)|keychain|credential|secret|password/i.test(s.command + ' ' + s.cwd) || s.argv.some(a => /^--(?:pre|pre-glob|exec|pager|ext-diff)/.test(a)))) return 'high';
  if (steps.some(s => !inside(realpathSync(task.cwd), s.cwd))) return 'high';
  if (steps.every(s => !s.network && read.test(s.argv[0].split('/').pop() || ''))) return 'low';
  if (task.worktree && task.branch && steps.every(s => s.cwd === realpathSync(task.cwd) && allowedTaskGit(s.argv) && !s.network)) return 'low';
  return 'high';
}

async function guard(task: Task, step: PermitStep) {
  hardRule(step.argv, task);
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], { input: JSON.stringify({ tool_input: { command: step.command } }), encoding: 'utf8',
    env: { ...process.env, TASK_ID: task.id, TASK_WORKTREE: task.worktree ? task.cwd : '', TASKBOARD_DIR: TB_DIR, TASKBOARD_PORT: String(PORT) } });
  if (result.status !== 0) throw new Error(result.stderr || 'The Taskboard guard failed.');
  if (result.stdout.trim()) {
    let reason = result.stdout;
    try { reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason || reason; } catch { /* keep the guard output */ }
    if (!(step.argv[0] === 'git' && (allowedTaskGit(step.argv) || allowedSharedGit(step.argv, task)) && reason.includes('run `tb git'))) throw new Error(reason);
  }
}
export async function run(p: Permit, task: Task, by: 'user' | 'controller', comment = '', controllerRequestText = '', executor: typeof execute = execute) {
  if (expire(p) || p.state !== 'pending') return p;
  if (p.taskId !== task.id) throw new Error('The task changed.');
  try {
    const { steps } = validate(task, p.steps);
    const hash = createHash('sha256').update(JSON.stringify({ taskId: task.id, steps: steps.map(s => [s.command, s.cwd, s.timeoutSeconds, s.network, s.scriptHash]) })).digest('hex');
    if (hash !== p.stepHash) throw new Error('The approved steps changed.');
  } catch (e) {
    p.state = 'failed'; p.error = e instanceof Error ? e.message : String(e);
    p.steps.forEach(s => s.state = 'cancelled'); p.finishedAt = now(); save(p); return p;
  }
  p.state = 'running'; p.approvedBy = by; p.decidedAt = now(); p.decisionComment = redactOutput(comment.slice(0, 2000));
  p.approvalRule = by === 'user' ? 'dashboard Run' : p.riskClass === 'low' ? 'low-risk command' : 'explicit user request';
  if (by === 'controller') p.controllerRequestText = redactOutput(controllerRequestText.slice(0, 2000));
  p.startedAt = now(); save(p);
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i];
    try {
      const checked = validate(task, [step]).steps[0];
      if (checked.cwd !== step.cwd || checked.scriptHash !== step.scriptHash) throw new Error('The working directory or script changed after approval.');
      if (step.argv[0] === 'git' && allowedTaskGit(step.argv)) await taskGit.mergeStateForSource(task, true);
      if (allowedSharedGit(step.argv, task)) {
        const branch = spawnSync('git', ['branch', '--show-current'], { cwd: step.cwd, encoding: 'utf8' });
        if (branch.status !== 0 || branch.stdout.trim() !== 'master') throw new Error('The shared checkout is no longer on master.');
      }
      await guard(task, step);
      step.state = 'running'; step.startedAt = now(); save(p);
      const result = await executor(task, step);
      step.exitCode = result.code; step.signal = result.signal; step.outputTail = redactOutput(result.output.split('\n').slice(-200).join('\n').slice(-65536));
      step.state = result.code === 0 ? 'succeeded' : 'failed';
      if (result.error) step.error = result.error;
    } catch (e) { step.state = 'failed'; step.error = e instanceof Error ? e.message : String(e); }
    step.finishedAt = now(); save(p);
    if (step.state === 'failed') {
      p.state = 'failed'; p.error = `Step ${i + 1} failed: ${step.error || (step.signal ? `signal ${step.signal}` : `exit ${step.exitCode}`)}`;
      p.steps.slice(i + 1).forEach(s => s.state = 'cancelled'); break;
    }
  }
  if (p.state === 'running') p.state = 'succeeded';
  p.finishedAt = now(); save(p); return p;
}

async function execute(task: Task, step: PermitStep): Promise<{ code: number | null; signal: string | null; output: string; error?: string }> {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise(resolveResult => {
    const child = spawn(shell, ['-lc', step.command],
      { cwd: step.cwd, env: { ...process.env, TASK_ID: task.id }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', done = false, timedOut = false;
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (done) return; done = true; clearTimeout(timer);
      resolveResult({ code, signal, output: output.slice(-65536), error: timedOut ? 'Step timed out.' : error });
    };
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-65536); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', e => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal));
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } }, step.timeoutSeconds * 1000);
  });
}
