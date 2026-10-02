// The lock file <TB_DIR>/server.pid records which process serves this TB_DIR. Exclusivity itself comes from the
// port, which index.ts binds before calling acquire(): only one process can hold a port, and the kernel frees it when
// that process dies, so there is no stale state to clean up. The file is written atomically (temporary file + rename),
// so a reader never sees it half written. It still refuses a second server on the same TB_DIR with another port.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, TB_DIR, URL_BASE } from './config.ts';
import { installLife } from './server-life.ts';

const FILE = join(TB_DIR, 'server.pid');
export interface Lock { pid: number; url: string; started: string }

// the process recorded in the file, if it is a live Taskboard server other than this one
function liveHolder(): Lock | null {
  try {
    const l: Lock = JSON.parse(readFileSync(FILE, 'utf8'));
    if (l.pid === process.pid) return null;
    process.kill(l.pid, 0); // throws when the process is gone
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(l.pid)], { encoding: 'utf8' });
    return /server\/index\.ts/.test(cmd) ? l : null;
  } catch { return null; }
}

// Call only after the port is bound. Returns the other server if one serves this TB_DIR on a different port.
export function acquire(): Lock | null {
  const holder = liveHolder();
  if (holder && holder.url !== URL_BASE) return holder;
  const tmp = `${FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, url: URL_BASE, started: new Date().toISOString() }));
  renameSync(tmp, FILE);
  installRelease();
  return null;
}

function installRelease() {
  const release = () => { try { if (JSON.parse(readFileSync(FILE, 'utf8')).pid === process.pid) unlinkSync(FILE); } catch { /* gone */ } };
  process.on('exit', release);
  // a closed terminal must not stop a server started with nohup
  process.on('SIGHUP', () => console.log(`${new Date().toISOString()} ignored SIGHUP`));
  // SIGTERM, SIGINT, uncaught errors and the start history (server-life.ts)
  installLife(TB_DIR, ROOT);
}
