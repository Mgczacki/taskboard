// Processes that belong to a task (dev servers, databases), started with `tb run` or from the dashboard. A group owns
// none: the group view lists the processes of its tasks (runtime-summary.ts).
// Each process runs in its own window of the tmux session proc-<num> on Taskboard's tmux server. tmux keeps them
// running when the Taskboard server restarts, like the agents.
// The list is a registry file: <task folder>/procs.json. Output goes to
// a log file next to it (tmux pipe-pane). Each process gets TB_PROC_OWNER and TB_PROC_NAME in its environment, so a
// child that leaves the process group of its tmux pane (setsid) can still be found with `ps` and stopped.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync, rmSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as store from './store.ts';
import { ensureConfigured, tmux, quote } from './tmux.ts';

const exec = promisify(execFile);

export type ProcState = 'starting' | 'running' | 'exited' | 'stopped' | 'suspended';
export interface Proc {
  name: string; command: string; cwd: string; stop?: string; port?: number; portFromLog?: boolean;
  startedBy: 'agent' | 'user'; state: ProcState; exitCode?: number; started?: string; ended?: string;
  window?: string; pid?: number; stopNote?: string;
  path?: string; // the PATH of the shell that ran tb run, so the command finds the same programs as the agent
  permitId?: string; // an approved run starts once and cannot restart after it ends
}
export interface Owner { kind: 'task'; id: string; session: string; dir: string; env: Record<string, string> }

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
export const checkName = (name: unknown) => { if (typeof name !== 'string' || !NAME.test(name)) throw new Error('A process name has 1 to 40 letters, digits, dots, dashes or underscores, and starts with a letter or digit.'); return name; };

export function taskOwner(t: store.Task, env: Record<string, string>): Owner {
  return { kind: 'task', id: t.id, session: `proc-${t.num}`, dir: store.taskDir(t.id), env };
}
// the value of TB_PROC_OWNER: the task id
const ownerTag = (o: Owner) => o.id;
const registry = (o: Owner) => join(o.dir, 'procs.json');
export const logFile = (o: Owner, name: string) => join(o.dir, 'procs', `${name}.log`);

export function load(o: Owner): Proc[] {
  try { const list = JSON.parse(readFileSync(registry(o), 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
}
function save(o: Owner, list: Proc[]) {
  mkdirSync(o.dir, { recursive: true });
  writeFileSync(registry(o), JSON.stringify(list, null, 2));
}
const listeners = new Set<(o: Owner) => void>();
export const onChange = (fn: (o: Owner) => void) => { listeners.add(fn); };
const changed = (o: Owner) => { for (const fn of listeners) try { fn(o); } catch { /* listener failed */ } };

// One change at a time for each owner: a start and a stop for the same list must not overwrite each other.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(o: Owner, fn: () => Promise<T>): Promise<T> {
  const key = ownerTag(o);
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  const queued = next.finally(() => { if (queues.get(key) === queued) queues.delete(key); }).catch(() => {});
  queues.set(key, queued);
  return next;
}

const SEP = '|~|';
interface Pane { window: string; pid: number; dead: boolean; status: number | null }
async function panes(session: string): Promise<Map<string, Pane> | null> {
  let out: string;
  try { out = await tmux('list-panes', '-s', '-t', '=' + session, '-F', ['#{window_id}', '#{pane_pid}', '#{pane_dead}', '#{pane_dead_status}'].join(SEP)); }
  catch (e) {
    const text = `${(e as { stderr?: string }).stderr || ''} ${(e as Error).message}`;
    return /can't find (session|window)|no server running|error connecting to|No such file/i.test(text) ? new Map() : null;
  }
  const map = new Map<string, Pane>();
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [window, pid, dead, status] = line.split(SEP);
    map.set(window, { window, pid: Number(pid), dead: dead === '1', status: status === '' ? null : Number(status) });
  }
  return map;
}

// The port a dev server prints when it starts ("http://localhost:5173/", "listening on port 3000"). Read from the
// first 64 KB of the log, because servers print it once at the start.
export function portFromText(text: string): number | undefined {
  const m = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/) || text.match(/\bport[ :=]+(\d{2,5})\b/i);
  const port = m ? Number(m[1]) : NaN;
  return port > 0 && port < 65536 ? port : undefined;
}
function readHead(file: string, bytes: number) {
  try { const fd = openSync(file, 'r'); const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); closeSync(fd); return buf.subarray(0, n).toString('utf8'); } catch { return ''; }
}
export function readTail(file: string, bytes = 64 * 1024) {
  try {
    const fd = openSync(file, 'r'); const size = fstatSync(fd).size; const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); closeSync(fd);
    // eslint-disable-next-line no-control-regex
    return buf.toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g, '');
  } catch { return ''; }
}

// Read the state of each process from tmux. A window that is gone was ended outside Taskboard (or the Mac restarted).
export async function refresh(o: Owner): Promise<Proc[]> {
  return serial(o, async () => refreshNow(o));
}
async function refreshNow(o: Owner): Promise<Proc[]> {
  const list = load(o);
  if (!list.length) return list;
  const map = await panes(o.session);
  if (!map) return list; // tmux did not answer: do not guess
  let dirty = false;
  for (const p of list) {
    if (p.state !== 'running' && p.state !== 'starting') continue;
    if (p.state === 'starting' && !p.window && p.permitId && p.started && Date.now() - Date.parse(p.started) < 10_000) continue;
    const pane = p.window ? map.get(p.window) : undefined;
    if (!pane) { Object.assign(p, { state: 'stopped', ended: new Date().toISOString(), stopNote: 'Its tmux window is gone (Taskboard or the Mac restarted, or it was closed outside Taskboard).' }); dirty = true; continue; }
    if (pane.dead) { Object.assign(p, { state: 'exited', exitCode: pane.status ?? undefined, ended: new Date().toISOString() }); dirty = true; continue; }
    if (p.state === 'starting') { p.state = 'running'; dirty = true; }
    if (!p.port || p.portFromLog) {
      const port = portFromText(readHead(logFile(o, p.name), 65536));
      if (port && port !== p.port) { p.port = port; p.portFromLog = true; dirty = true; }
    }
  }
  if (dirty) { save(o, list); changed(o); }
  return list;
}

export interface StartInput { name: string; command: string; cwd: string; stop?: string; port?: number; startedBy: 'agent' | 'user'; path?: string; permitId?: string }
export function start(o: Owner, input: StartInput): Promise<Proc> {
  checkName(input.name);
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4000) throw new Error('Give the command to run (up to 4000 characters).');
  if (input.stop !== undefined && (typeof input.stop !== 'string' || input.stop.length > 4000)) throw new Error('The stop command has up to 4000 characters.');
  if (input.port !== undefined && !(Number.isInteger(input.port) && input.port > 0 && input.port < 65536)) throw new Error('The port is a whole number from 1 to 65535.');
  if (!input.cwd || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error(`The folder ${input.cwd} does not exist.`);
  return serial(o, async () => {
    const list = await refreshNow(o);
    const old = list.find(p => p.name === input.name);
    if (old?.permitId || (input.permitId && list.some(p => p.permitId === input.permitId))) throw new Error('An approved run can start only once.');
    if (old && (old.state === 'running' || old.state === 'starting')) throw new Error(`A process named ${input.name} is already running. Stop it first, or use another name.`);
    if (old?.window) await tmux('kill-window', '-t', old.window).catch(() => {});
    const p: Proc = { name: input.name, command: input.command.trim(), cwd: input.cwd, stop: input.stop?.trim() || undefined, port: input.port, startedBy: input.startedBy, state: 'starting', started: new Date().toISOString(), path: typeof input.path === 'string' && input.path.length < 8000 ? input.path : undefined, permitId: input.permitId };
    const next = [...list.filter(x => x.name !== p.name), p];
    if (p.permitId) save(o, next); // reserve this approval before tmux can start the command
    try { await launch(o, p); }
    catch (e) {
      if (p.window) await tmux('kill-window', '-t', p.window).catch(() => {});
      if (p.permitId) { p.state = 'stopped'; p.ended = new Date().toISOString(); p.stopNote = `Start failed: ${(e as Error).message}`; save(o, next); }
      throw e;
    }
    save(o, next);
    changed(o);
    return p;
  });
}

// The window waits for a ready file before it runs the command, so the log has the first line of output too:
// pipe-pane can only start once the window exists.
async function launch(o: Owner, p: Proc) {
  const log = logFile(o, p.name);
  mkdirSync(join(o.dir, 'procs'), { recursive: true });
  writeFileSync(log, `--- ${new Date().toISOString()} ${p.command} (in ${p.cwd})\n`, { flag: 'a' });
  const ready = join(o.dir, 'procs', `.${p.name}.ready`);
  rmSync(ready, { force: true });
  // The environment goes into a script, not into tmux -e arguments: the first tmux command on a socket becomes the
  // tmux server, and its command line would then carry TB_PROC_OWNER, so the search for marked processes below would
  // find the tmux server itself.
  const env = { ...o.env, ...(p.path ? { PATH: p.path } : {}), TB_PROC_OWNER: ownerTag(o), TB_PROC_NAME: p.name };
  const run = join(o.dir, 'procs', `.${p.name}.sh`);
  writeFileSync(run, [
    // tmux ignores -c when its own working directory was deleted (see inFolder in tmux.ts), so the script changes folder
    `cd ${quote(resolve(p.cwd))} || exit 1`,
    ...Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${quote(v)}`),
    `i=0; while [ ! -e ${quote(ready)} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${quote(ready)} ] || exit 1; rm -f ${quote(ready)}`,
    `exec /bin/sh -c ${quote(p.command)}`, '',
  ].join('\n'), { mode: 0o600 });
  const exists = (await panes(o.session))?.size ? true : false;
  const fmt = ['#{window_id}', '#{pane_pid}'].join(SEP);
  const out = exists
    ? await tmux('new-window', '-d', '-P', '-F', fmt, '-t', '=' + o.session + ':', '-n', p.name, '-c', p.cwd, '/bin/sh', run)
    : await tmux('new-session', '-d', '-P', '-F', fmt, '-s', o.session, '-n', p.name, '-c', p.cwd, '-x', '200', '-y', '50', '/bin/sh', run);
  const [window, pid] = out.trim().split(SEP);
  p.window = window; p.pid = Number(pid);
  // new-session may have started the tmux server: give it the Taskboard settings like an agent session does
  if (!exists) await ensureConfigured().catch(() => {});
  // keep the window after the command exits, so its exit code can be read (the global setting also does this, but
  // a user or a program can change the global setting)
  await tmux('set-option', '-w', '-t', window, 'remain-on-exit', 'on').catch(() => {});
  await tmux('pipe-pane', '-o', '-t', window, `cat >> ${quote(log)}`).catch(() => {});
  writeFileSync(ready, '');
}

// Send a signal to the process group of the pane (tmux makes each pane a session leader, so its pid is the group id).
const signalGroup = (pid: number, sig: NodeJS.Signals) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

// Processes that carry TB_PROC_OWNER=<owner> (and TB_PROC_NAME=<name>) in their environment, found with ps.
// On macOS `ps -E` prints the environment after the command; on Linux `ps e` does.
// macOS does not show the environment of some system programs (observed for /bin/sleep), so this search is a second
// step after the signal to the process group, not a replacement for it.
export async function marked(owner: string, name?: string): Promise<number[]> {
  let out = '';
  try { out = (await exec('ps', process.platform === 'darwin' ? ['-E', '-ww', '-ax', '-o', 'pid=,command='] : ['eww', '-ax', '-o', 'pid=,args='], { maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { return []; }
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s(.*)$/); if (!m) continue;
    const words = m[2].split(/\s+/);
    if (!words.includes(`TB_PROC_OWNER=${owner}`)) continue;
    if (name && !words.includes(`TB_PROC_NAME=${name}`)) continue;
    // never the tmux server or a tmux client (their arguments can name the environment of a session) or Taskboard
    if (/(^|\/)tmux(\s|$)/.test(words[0]) || words[0].endsWith('/tmux')) continue;
    const pid = Number(m[1]); if (pid !== process.pid) pids.push(pid);
  }
  return pids;
}

async function stopOne(o: Owner, p: Proc, state: 'stopped' | 'suspended', note?: string) {
  const notes: string[] = [];
  if (p.stop && (p.state === 'running' || p.state === 'starting')) {
    try {
      await exec('/bin/sh', ['-c', p.stop], { cwd: p.cwd, env: { ...process.env, ...o.env, ...(p.path ? { PATH: p.path } : {}), TB_PROC_OWNER: ownerTag(o), TB_PROC_NAME: `${p.name}-stop` }, timeout: 30000 });
      notes.push('Stop command finished.');
    } catch (e) { notes.push(`Stop command failed: ${(e as Error).message.split('\n')[0]}`); }
  }
  if (p.pid) {
    signalGroup(p.pid, p.permitId ? 'SIGINT' : 'SIGTERM');
    const grace = p.permitId ? 1200 : 50;
    for (let i = 0; i < grace && alive(p.pid); i++) await new Promise(r => setTimeout(r, 100));
    if (alive(p.pid) && p.permitId) {
      signalGroup(p.pid, 'SIGTERM');
      for (let i = 0; i < 50 && alive(p.pid); i++) await new Promise(r => setTimeout(r, 100));
    }
    if (alive(p.pid)) { signalGroup(p.pid, 'SIGKILL'); notes.push(p.permitId ? 'Force-stopped after 125 s. Check cleanup.' : 'Force-stopped after 5 s.'); }
  }
  // children that left the pane's process group
  const left = await marked(ownerTag(o), p.name);
  for (const pid of left) { try { process.kill(pid, 'SIGTERM'); } catch { /* ended */ } }
  if (left.length) {
    await new Promise(r => setTimeout(r, 1000));
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
    notes.push(`Stopped ${left.length} process(es) that had left the group.`);
  }
  if (p.window) await tmux('kill-window', '-t', p.window).catch(() => {});
  writeFileSync(logFile(o, p.name), `--- ${new Date().toISOString()} ${state === 'suspended' ? 'stopped because the task was suspended' : 'stopped'}${notes.length ? ': ' + notes.join(' ') : ''}\n`, { flag: 'a' });
  Object.assign(p, { state, ended: new Date().toISOString(), window: undefined, pid: undefined, stopNote: [note, ...notes].filter(Boolean).join(' ') || undefined });
}

export function stop(o: Owner, name: string, remove = false): Promise<Proc[]> {
  return serial(o, async () => {
    const list = await refreshNow(o);
    const p = list.find(x => x.name === name);
    if (!p) throw new Error(`No process named ${name}.`);
    if (remove && p.permitId) throw new Error('An approved run record cannot be removed.');
    if (p.state === 'running' || p.state === 'starting' || p.window) await stopOne(o, p, 'stopped');
    const next = remove ? list.filter(x => x !== p) : list;
    save(o, next); changed(o);
    return next;
  });
}

export function restart(o: Owner, name: string): Promise<Proc> {
  return serial(o, async () => {
    const list = await refreshNow(o);
    const p = list.find(x => x.name === name);
    if (!p) throw new Error(`No process named ${name}.`);
    if (p.permitId) throw new Error('An approved run cannot restart. Request a new approval.');
    if (p.state === 'running' || p.state === 'starting' || p.window) await stopOne(o, p, 'stopped');
    if (!existsSync(p.cwd)) throw new Error(`The folder ${p.cwd} does not exist any more.`);
    Object.assign(p, { state: 'starting', started: new Date().toISOString(), ended: undefined, exitCode: undefined, stopNote: undefined });
    if (p.portFromLog) { p.port = undefined; p.portFromLog = undefined; }
    await launch(o, p);
    save(o, list); changed(o);
    return p;
  });
}

// Archive (state "stopped") and idle suspend (state "suspended", started again on resume) stop every running process.
export function stopAll(o: Owner, state: 'stopped' | 'suspended'): Promise<number> {
  return serial(o, async () => {
    const list = await refreshNow(o);
    let n = 0;
    for (const p of list) {
      if (state === 'suspended' && p.permitId) continue;
      if (p.state === 'running' || p.state === 'starting') { await stopOne(o, p, state); n++; }
      // an exited process keeps its state and exit code: a resume must not start it again
      else if (p.window) { await tmux('kill-window', '-t', p.window).catch(() => {}); p.window = undefined; p.pid = undefined; }
    }
    // A suspended task does not end an approved run. Its finally block must have time to complete.
    const keep = state === 'suspended' && list.some(p => p.permitId && (p.state === 'running' || p.state === 'starting'));
    if (!keep) {
      const left = await marked(ownerTag(o));
      for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
      await tmux('kill-session', '-t', '=' + o.session).catch(() => {});
    }
    if (n || list.length) { save(o, list); changed(o); }
    return n;
  });
}

// Resume after an idle suspend: start each process that the suspend stopped. Processes stopped by hand stay stopped.
export function resumeSuspended(o: Owner): Promise<number> {
  return serial(o, async () => {
    const list = await refreshNow(o);
    let n = 0;
    for (const p of list) {
      if (p.state !== 'suspended') continue;
      if (p.permitId) { p.state = 'stopped'; p.stopNote = 'An approved run cannot restart after suspension.'; continue; }
      if (!existsSync(p.cwd)) { p.state = 'stopped'; p.stopNote = `The folder ${p.cwd} does not exist any more.`; continue; }
      Object.assign(p, { state: 'starting', started: new Date().toISOString(), ended: undefined, exitCode: undefined, stopNote: undefined });
      if (p.portFromLog) { p.port = undefined; p.portFromLog = undefined; }
      try { await launch(o, p); n++; } catch (e) { Object.assign(p, { state: 'stopped', stopNote: `Could not start again: ${(e as Error).message}` }); }
    }
    save(o, list); changed(o);
    return n;
  });
}
