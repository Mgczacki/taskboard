import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as browser from './task-browser.ts';

export interface ProcessIdentity { pid: number; uid: number; start: string; name: string }

// ps reads only the process identity. It never reads arguments or environment values.
export function identity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim();
    const line = execFileSync('ps', ['-p', String(pid), '-o', 'uid=,ucomm='], { encoding: 'utf8', timeout: 3000 }).trim();
    const match = line.match(/^(\d+)\s+(.+)$/);
    return start && match ? { pid, uid: Number(match[1]), start, name: match[2] } : null;
  } catch { return null; }
}

export function matchesBrowser(recorded: { pid?: number; pidStart?: string; window?: unknown }, current: ProcessIdentity | null, lock: number | null, uid: number): boolean {
  return !recorded.window && sameProcess(recorded, current, uid) && lock === current?.pid;
}
export function sameProcess(recorded: { pid?: number; pidStart?: string }, current: ProcessIdentity | null, uid: number): boolean {
  return !!current && current.pid === recorded.pid && current.uid === uid
    && current.start === recorded.pidStart && /Chrome|Chromium/.test(current.name);
}

export function profileLockPid(id: string): number | null {
  try {
    const link = readlinkSync(join(browser.profileDir(id), 'SingletonLock'));
    const pid = Number(link.slice(link.lastIndexOf('-') + 1));
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

export function candidate(id: string): { pid: number; reason: string } | null {
  const m = browser.readMeta(id);
  if (!m.pid) return null;
  const current = identity(m.pid);
  if (!current) return null;
  const verified = matchesBrowser(m, current, profileLockPid(id), process.getuid?.() ?? -1);
  return { pid: m.pid, reason: verified ? 'Recorded browser identity matches.' : 'Browser identity is incomplete or changed. Review only.' };
}

// Only archived task browsers with a recorded process start can be ended after a server restart.
export interface RecoveryIO {
  meta: (id: string) => { pid?: number; pidStart?: string; window?: unknown };
  identity: (pid: number) => ProcessIdentity | null;
  lock: (id: string) => number | null;
  uid: number;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  wait: () => Promise<void>;
  ended: (id: string) => void;
}
export async function recoverArchived(tasks: { id: string; status: string }[], io: RecoveryIO = {
  meta: browser.readMeta, identity, lock: profileLockPid, uid: process.getuid?.() ?? -1,
  signal: (pid, signal) => process.kill(pid, signal),
  wait: () => new Promise(resolve => setTimeout(resolve, 1000)),
  ended: id => browser.updateMeta(id, { pid: undefined, port: undefined, stoppedAt: new Date().toISOString() }),
}): Promise<string[]> {
  const ended: string[] = [];
  for (const task of tasks) {
    if (task.status !== 'archived') continue;
    const m = io.meta(task.id);
    const expected = io.identity(m.pid || 0);
    if (!matchesBrowser(m, expected, io.lock(task.id), io.uid)) continue;
    if (!matchesBrowser(m, io.identity(m.pid!), io.lock(task.id), io.uid)) continue;
    try { io.signal(m.pid!, 'SIGTERM'); } catch { continue; }
    await io.wait();
    if (sameProcess(m, io.identity(m.pid!), io.uid)) {
      try { io.signal(m.pid!, 'SIGKILL'); } catch { /* process ended */ }
    }
    if (sameProcess(m, io.identity(m.pid!), io.uid)) continue;
    io.ended(task.id);
    ended.push(task.id);
  }
  return ended;
}
