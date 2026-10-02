// Why this server started, why it stopped, and which uncaught errors it survives.
// - The process-level handler for uncaught errors (installLife, called by lock.ts once the port is bound). An error
//   with a known recoverable code (a write to a closed socket, pipe or pseudo-terminal, a failed spawn) is written to
//   the log with its stack, and the server keeps running. The server exits only for an out-of-memory error, or for a
//   second uncaught error of an unknown kind within 10 seconds. The log line says which.
// - The start history in <TB_DIR>/server-starts.json: the last 50 starts, each with its process id, start time, the
//   release, and how it ended (a signal, a crash with the first error line, a release, a restart from the dashboard,
//   or unknown when the process ended without writing it: SIGKILL, out of memory or a power loss).
// - <TB_DIR>/restart-intent.json: scripts/restart.mjs, release.mjs and rollback.mjs write it just before they stop the
//   server, so the SIGTERM that follows is recorded as a release, a rollback or a restart and not as an unknown signal.
// GET /api/server returns this data (index.ts); the dashboard shows it in Settings → Taskboard server.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type EndKind = 'crash' | 'signal' | 'release' | 'rollback' | 'manual' | 'exit' | 'unknown';
export interface StartEnd { kind: EndKind; at?: string; detail?: string }
export interface StartRecord { pid: number; startedAt: string; release: string; end?: StartEnd }
export interface Intent { reason: 'release' | 'rollback' | 'manual'; at: string; detail?: string }

const HISTORY = 50;
const startsFile = (dir: string) => join(dir, 'server-starts.json');
const intentFile = (dir: string) => join(dir, 'restart-intent.json');
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return d; } };
const writeJson = (f: string, v: unknown) => { const tmp = `${f}.${process.pid}`; writeFileSync(tmp, JSON.stringify(v, null, 2)); renameSync(tmp, f); };

// Error codes of a write or read on a socket, pipe or pseudo-terminal whose other end closed, and of a spawn that
// could not start (no free descriptor, process slot or pseudo-terminal). Each ends one connection or one child process,
// not the server.
export const RECOVERABLE = new Set(['EPIPE', 'EIO', 'EBADF', 'ECONNRESET', 'ECONNABORTED', 'ENOTCONN', 'ETIMEDOUT', 'EAGAIN',
  'EMFILE', 'ENFILE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE']);
const OUT_OF_MEMORY = /out of memory|allocation failed|Invalid (string|array buffer) length|Array buffer allocation/i;

export function classify(e: unknown): 'recoverable' | 'fatal' | 'unknown' {
  const err = e as { code?: unknown; message?: unknown } | null;
  const message = String(err?.message ?? e ?? '');
  if (OUT_OF_MEMORY.test(message) || err?.code === 'ERR_OUT_OF_MEMORY') return 'fatal';
  if (typeof err?.code === 'string' && RECOVERABLE.has(err.code)) return 'recoverable';
  // node-pty throws these without a code when it cannot open a pseudo-terminal or start the child (see server/pty.ts):
  // 1.1.0 says "posix_spawnp failed.", 1.2.0 names the step, for example "open slave pty failed: Too many open files"
  if (/posix_spawnp? failed|(posix_openpt|grantpt|unlockpt|open slave pty|tcsetattr|posix_spawnattr_\w+) failed|(openpty|forkpty)\(3\) failed/.test(message)) return 'recoverable';
  return 'unknown';
}

export const firstLine = (e: unknown) => {
  const err = e as { code?: unknown; message?: unknown } | null;
  const text = err && typeof err === 'object' && 'message' in err ? `${(e as Error).name || 'Error'}: ${err.message}` : String(e);
  return text.split('\n')[0].slice(0, 300);
};

// The decision for one uncaught error. `recent` holds the times of earlier unknown errors; it is changed in place.
export function decide(e: unknown, now: number, recent: number[], windowMs = 10_000): { exit: boolean; line: string } {
  const kind = classify(e);
  const code = (e as { code?: unknown })?.code;
  const label = typeof code === 'string' ? `code ${code}` : 'no error code';
  if (kind === 'fatal') return { exit: true, line: `crashed: stopping because the error shows that memory is exhausted (${label})` };
  if (kind === 'recoverable') return { exit: false, line: `recovered: an uncaught error with a recoverable ${label} ended one operation; the server keeps running` };
  while (recent.length && now - recent[0] > windowMs) recent.shift();
  recent.push(now);
  if (recent.length > 1) return { exit: true, line: `crashed: stopping because this is the second uncaught error within ${windowMs / 1000} s (${label})` };
  return { exit: false, line: `recovered: an uncaught error of an unknown kind (${label}); the server keeps running and stops if another follows within ${windowMs / 1000} s` };
}

// ---------- start history ----------
export function readStarts(dir: string): StartRecord[] { return readJson<StartRecord[]>(startsFile(dir), []).filter(s => s && typeof s.pid === 'number'); }

// A fresh intent (written less than 2 minutes ago) explains the next SIGTERM.
export function readIntent(dir: string, now = Date.now()): Intent | null {
  const i = readJson<Intent | null>(intentFile(dir), null);
  return i && now - Date.parse(i.at) < 120_000 ? i : null;
}

// Record this start. The previous start that has no end ended without writing one.
export function recordStart(dir: string, pid: number, root: string, now = new Date()): StartRecord[] {
  const list = readStarts(dir);
  const last = list[list.length - 1];
  if (last && !last.end) last.end = { kind: 'unknown', detail: 'the process ended without a log entry (SIGKILL, out of memory, or power loss)' };
  list.push({ pid, startedAt: now.toISOString(), release: basename(root) });
  const kept = list.slice(-HISTORY);
  try { writeJson(startsFile(dir), kept); } catch { /* the folder is read-only: no history */ }
  return kept;
}

// Record how this process ends. Runs in the 'exit' handler, so it must be synchronous.
export function recordEnd(dir: string, pid: number, end: StartEnd) {
  const list = readStarts(dir);
  const me = [...list].reverse().find(s => s.pid === pid);
  if (!me || me.end) return;
  me.end = { at: new Date().toISOString(), ...end };
  try { writeJson(startsFile(dir), list); } catch { /* read-only */ }
}

// The end of a SIGTERM: a release, rollback or restart if one was announced, otherwise a plain signal.
export function signalEnd(dir: string, signal: string, now = Date.now()): StartEnd {
  const i = readIntent(dir, now);
  return i ? { kind: i.reason, detail: i.detail || `${signal} from ${i.reason === 'manual' ? 'a restart' : `a ${i.reason}`}` } : { kind: 'signal', detail: `${signal} (no restart, release or rollback was announced)` };
}

export function writeIntent(dir: string, reason: Intent['reason'], detail?: string) {
  try { writeJson(intentFile(dir), { reason, at: new Date().toISOString(), detail }); } catch { /* no folder */ }
}

export interface Health {
  pid: number; startedAt: string; uptimeSec: number; release: string;
  previous: StartEnd | null;          // how the start before this one ended
  starts: StartRecord[];              // the last 10, newest first
  counts: Record<EndKind, number>;    // ends in the whole history (up to 50 starts)
  planned: number;                    // release + rollback + manual
  recovered: { count: number; last?: { at: string; line: string } };
}

let recovered: Health['recovered'] = { count: 0 };
let current: { dir: string; startedAt: string; release: string } | null = null;

export function health(): Health | null {
  if (!current) return null;
  const list = readStarts(current.dir);
  const counts = { crash: 0, signal: 0, release: 0, rollback: 0, manual: 0, exit: 0, unknown: 0 } as Record<EndKind, number>;
  for (const s of list) if (s.end) counts[s.end.kind] = (counts[s.end.kind] || 0) + 1;
  const prev = list.length > 1 ? list[list.length - 2].end ?? null : null;
  return { pid: process.pid, startedAt: current.startedAt, uptimeSec: Math.round(process.uptime()), release: current.release, previous: prev,
    starts: list.slice(-10).reverse(), counts, planned: counts.release + counts.rollback + counts.manual, recovered };
}

// Things to do before a SIGTERM or SIGINT exit (index.ts tells the dashboards that the server stops).
const beforeStop: ((end: StartEnd) => void)[] = [];
export const onStopping = (f: (end: StartEnd) => void) => { beforeStop.push(f); };

export function installLife(dir: string, root: string, log = (s: string) => console.error(s), exit = (code: number) => process.exit(code)) {
  const list = recordStart(dir, process.pid, root);
  current = { dir, startedAt: list[list.length - 1].startedAt, release: basename(root) };
  const prev = list.length > 1 ? list[list.length - 2].end : undefined;
  if (prev) log(`${new Date().toISOString()} started: process ${process.pid}, release ${current.release}; the previous server ended: ${prev.kind}${prev.detail ? ` (${prev.detail})` : ''}`);
  let ending: StartEnd | null = null;
  process.on('exit', code => recordEnd(dir, process.pid, ending || { kind: code ? 'crash' : 'exit', detail: `exit code ${code}` }));
  const recent: number[] = [];
  process.on('uncaughtException', e => {
    const d = decide(e, Date.now(), recent);
    log(`${new Date().toISOString()} ${d.line}:`);
    console.error(e);
    if (d.exit) { ending = { kind: 'crash', detail: firstLine(e) }; exit(1); return; }
    recovered = { count: recovered.count + 1, last: { at: new Date().toISOString(), line: firstLine(e) } };
  });
  process.on('unhandledRejection', e => console.error(`${new Date().toISOString()} unhandled promise rejection:`, e));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
    if (ending) return;
    ending = signalEnd(dir, sig);
    log(`${new Date().toISOString()} stopping: received ${sig} (process ${process.pid}); reason: ${ending.kind}${ending.detail ? ` (${ending.detail})` : ''}`);
    for (const f of beforeStop) { try { f(ending); } catch { /* the stop goes on */ } }
    // a short wait lets the dashboards receive the message; launchd waits 20 s before it sends SIGKILL
    setTimeout(() => exit(0), beforeStop.length ? 150 : 0).unref();
  });
}
