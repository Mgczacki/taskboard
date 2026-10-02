// Numbers for the performance monitor of the dashboard (web/src/components/PerfMonitor.tsx, off by default):
// - the delay of this server's event loop (perf_hooks.monitorEventLoopDelay), for the last full minute and the current one
// - the CPU and memory of this server process
// - the load of the machine (os.loadavg) and its swap use (macOS: sysctl vm.swapusage; Linux: /proc/meminfo)
// - when the machine is overloaded, the three processes that use the most CPU and the three that use the most memory (ps)
// Only GET /api/perf reads the machine values, and each read is kept for 5 s. Nothing here stops or changes a process.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { basename } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ms = (ns: number) => Math.round(ns / 1e5) / 10;

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
type Delay = { p50: number; p99: number; max: number };
let lastMinute: Delay | null = null;
const read = (): Delay => ({ p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) });
setInterval(() => { lastMinute = read(); loop.reset(); }, 60000).unref();

let cpuAt = { t: Date.now(), usage: process.cpuUsage() };
function serverCpu() {
  const now = Date.now(), usage = process.cpuUsage(), dt = now - cpuAt.t;
  const pct = dt > 0 ? Math.round(((usage.user - cpuAt.usage.user) + (usage.system - cpuAt.usage.system)) / 10 / dt) : 0;
  if (dt > 2000) cpuAt = { t: now, usage };
  return pct;
}

export interface Swap { usedMb: number; totalMb: number }
async function swap(): Promise<Swap | null> {
  try {
    if (platform() === 'darwin') {
      // "total = 13312.00M  used = 11900.25M  free = 1411.75M  (encrypted)"
      const out = (await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 })).stdout;
      const num = (k: string) => { const m = out.match(new RegExp(`${k} = ([\\d.]+)([KMG])`)); return m ? Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 } as Record<string, number>)[m[2]] : 0; };
      return { usedMb: Math.round(num('used')), totalMb: Math.round(num('total')) };
    }
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0);
    return { usedMb: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024), totalMb: Math.round(kb('SwapTotal') / 1024) };
  } catch { return null; }
}

export interface Proc { pid: number; name: string; cpu: number; memMb: number }
async function processes(): Promise<Proc[]> {
  try {
    const out = (await run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm='], { timeout: 5000, maxBuffer: 8 << 20 })).stdout;
    return out.split('\n').map(l => l.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)).filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ pid: Number(m[1]), cpu: Number(m[2]), memMb: Math.round(Number(m[3]) / 1024), name: basename(m[4]) }));
  } catch { return []; }
}

// The machine counts as overloaded when its 1-minute load is above twice the number of cores, or when more than 80 %
// of the swap is in use (at least 1 GB of swap).
export const overloaded = (load1: number, cores: number, s: Swap | null) =>
  load1 > 2 * cores || (!!s && s.totalMb >= 1024 && s.usedMb / s.totalMb > 0.8);

let machine: { at: number; value: Promise<unknown> } | null = null;
async function readMachine() {
  const cores = cpus().length, load = loadavg().map(x => Math.round(x * 10) / 10), s = await swap();
  const over = overloaded(load[0], cores, s);
  const procs = over ? await processes() : [];
  const top = (k: 'cpu' | 'memMb') => [...procs].sort((a, b) => b[k] - a[k]).slice(0, 3);
  return { cores, load, memory: { totalMb: Math.round(totalmem() / 1048576), freeMb: Math.round(freemem() / 1048576) }, swap: s, overloaded: over, topCpu: top('cpu'), topMemory: top('memMb') };
}

export async function snapshot() {
  if (!machine || Date.now() - machine.at > 5000) machine = { at: Date.now(), value: readMachine() };
  return {
    at: new Date().toISOString(),
    server: { pid: process.pid, cpuPct: serverCpu(), rssMb: Math.round(process.memoryUsage().rss / 1048576), eventLoop: { lastMinute, now: read() } },
    machine: await machine.value,
  };
}
