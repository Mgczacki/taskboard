// The memory of a process group (a task browser or a task process), as the dashboard shows it.
// On macOS this is the footprint from /usr/bin/footprint: the memory that the processes wrote to, plus their
// compressed and swapped part. Activity Monitor shows the same number. The sum of RSS from ps is the fallback (other
// systems, or footprint failed). RSS counts a shared page once in each process that maps it, so for Chrome it is
// about 3 times the footprint: 1,390 MB of RSS against 444 to 459 MB of footprint for one headless Chrome with one page.
// footprint takes about 0.3 s for the 11 processes of one Chrome, so it runs with execFile (it does not block the
// server) and each result is kept for CACHE_MS. Two calls for the same group at the same time share one footprint run.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const FOOTPRINT = '/usr/bin/footprint';
const CACHE_MS = 15000;
const useFootprint = process.platform === 'darwin';

export interface Proc { pid: number; pgid: number; rssKb: number }
export async function processes(): Promise<Proc[]> {
  try { return parsePs((await exec('ps', ['-axo', 'pid=,pgid=,rss='], { maxBuffer: 16 * 1024 * 1024 })).stdout); } catch { return []; }
}
export function parsePs(out: string): Proc[] {
  const list: Proc[] = [];
  for (const line of out.split('\n')) {
    const [p, g, r] = line.trim().split(/\s+/).map(Number);
    if (p > 0 && g > 0 && r >= 0) list.push({ pid: p, pgid: g, rssKb: r });
  }
  return list;
}

const cache = new Map<number, { at: number; mb: number }>();
const running = new Map<number, Promise<number | null>>();
let seq = 0;

// The total footprint of these processes in MB, or null when footprint is not there or fails.
async function footprintMb(pids: number[]): Promise<number | null> {
  const file = join(tmpdir(), `taskboard-footprint-${process.pid}-${++seq}.json`);
  try {
    await exec(FOOTPRINT, ['-j', file, ...pids.map(String)], { timeout: 10000 });
    const total = JSON.parse(readFileSync(file, 'utf8'))['total footprint'];
    return typeof total === 'number' ? Math.round(total / 1048576) : null;
  } catch { return null; } finally { rmSync(file, { force: true }); }
}

// MB for each process group in pgids that has processes. One ps call for all groups, then footprint for each group.
export async function byGroup(pgids: number[], procs?: Proc[]): Promise<Map<number, number>> {
  const list = procs || await processes();
  const out = new Map<number, number>();
  await Promise.all([...new Set(pgids)].map(async g => {
    const members = list.filter(p => p.pgid === g);
    if (!members.length) return;
    const rssMb = Math.round(members.reduce((n, p) => n + p.rssKb, 0) / 1024);
    if (!useFootprint) { out.set(g, rssMb); return; }
    const hit = cache.get(g);
    if (hit && Date.now() - hit.at < CACHE_MS) { out.set(g, hit.mb); return; }
    let run = running.get(g);
    if (!run) { run = footprintMb(members.map(p => p.pid)).finally(() => running.delete(g)); running.set(g, run); }
    const mb = await run;
    if (mb === null) { out.set(g, rssMb); return; }
    cache.set(g, { at: Date.now(), mb });
    out.set(g, mb);
  }));
  for (const g of cache.keys()) if (!list.some(p => p.pgid === g)) cache.delete(g);
  return out;
}
export async function groupMb(pgid?: number): Promise<number | null> {
  if (!pgid) return null;
  return (await byGroup([pgid])).get(pgid) ?? null;
}

// The memory of the computer that is free for a new program. On macOS, kern.memorystatus_level is the percent of
// memory available (memory_pressure prints the same number as "System-wide memory free percentage"). Swap use is not
// a good sign of low memory: macOS keeps swap in use for a long time after the memory was free again. On Linux, the
// numbers come from MemAvailable and MemTotal in /proc/meminfo. low: a new browser (about 450 MB, see above) can make
// every program slower. The result is kept for 5 s.
export interface SystemMemory { totalMb: number; availableMb: number; availablePct: number; low: boolean }
export const LOW_MEMORY_PCT = 20, LOW_MEMORY_MB = 2048;
let systemCache: { at: number; value: SystemMemory | null } | null = null;
export async function systemMemory(): Promise<SystemMemory | null> {
  if (systemCache && Date.now() - systemCache.at < 5000) return systemCache.value;
  let value: SystemMemory | null = null;
  try {
    let totalMb = 0, availableMb = 0;
    if (process.platform === 'darwin') {
      const [level, size] = (await exec('sysctl', ['-n', 'kern.memorystatus_level', 'hw.memsize'], { timeout: 3000 })).stdout.trim().split('\n').map(Number);
      totalMb = Math.round(size / 1048576); availableMb = Math.round(totalMb * level / 100);
    } else {
      const info = readFileSync('/proc/meminfo', 'utf8'), kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] || 0);
      totalMb = Math.round(kb('MemTotal') / 1024); availableMb = Math.round(kb('MemAvailable') / 1024);
    }
    if (totalMb > 0) value = systemMemoryOf(totalMb, availableMb);
  } catch { /* not known */ }
  systemCache = { at: Date.now(), value };
  return value;
}
export function systemMemoryOf(totalMb: number, availableMb: number): SystemMemory {
  const availablePct = Math.round(availableMb / totalMb * 100);
  return { totalMb, availableMb, availablePct, low: availablePct < LOW_MEMORY_PCT || availableMb < LOW_MEMORY_MB };
}
