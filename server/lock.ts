// One Taskboard server per machine: ~/.taskboard/server.pid records the running server. A second server started with
// the same ~/.taskboard sees a live process there and exits. Test servers use their own TASKBOARD_DIR.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { TB_DIR, URL_BASE } from './config.ts';

const FILE = join(TB_DIR, 'server.pid');
interface Lock { pid: number; url: string; started: string }

export function alreadyRunning(): Lock | null {
  if (!existsSync(FILE)) return null;
  try {
    const l: Lock = JSON.parse(readFileSync(FILE, 'utf8'));
    if (l.pid === process.pid) return null;
    process.kill(l.pid, 0); // throws when the process is gone
    // the pid may have been reused by another program after a crash: check that it is a Taskboard server
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(l.pid)], { encoding: 'utf8' });
    return /server\/index\.ts/.test(cmd) ? l : null;
  } catch { return null; }
}

export function holdLock() {
  writeFileSync(FILE, JSON.stringify({ pid: process.pid, url: URL_BASE, started: new Date().toISOString() }));
  const release = () => { try { if (JSON.parse(readFileSync(FILE, 'utf8')).pid === process.pid) unlinkSync(FILE); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(0));
}
