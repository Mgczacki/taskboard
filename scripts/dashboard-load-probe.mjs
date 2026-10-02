// Loaded into a test Taskboard server with `node --import` by scripts/dashboard-load.mjs. It records, without changing
// what the server does:
// - the event loop delay (perf_hooks.monitorEventLoopDelay, 10 ms resolution)
// - each child process call (execFile, spawn, exec and their sync forms) by command and first argument, with its time
//   and the time of its synchronous start (the part that blocks the event loop)
// - each synchronous file call (readFileSync, writeFileSync, statSync and others) with its time
// It writes the totals to the file in TB_PROBE_FILE every 2 s. The benchmark reads two samples and subtracts them.
// SIGUSR2 starts the event loop histogram again, so its values cover only the time after the signal.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const OUT = process.env.TB_PROBE_FILE;
const { writeFileSync, renameSync } = fs;
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
const calls = {}; // name -> { n, ms, syncMs }: ms until the call ended; syncMs: the part that blocked the event loop
const add = (name, ms, syncMs = ms) => { const c = calls[name] || (calls[name] = { n: 0, ms: 0, syncMs: 0 }); c.n++; c.ms += ms; c.syncMs += syncMs; };
const label = (cmd, args) => {
  const base = String(cmd).split('/').pop();
  if (base === 'tmux' && Array.isArray(args)) { const a = args[0] === '-L' ? args[2] : args[0]; return `tmux ${a}`; }
  if (base === 'git' && Array.isArray(args)) return `git ${args.find(x => !String(x).startsWith('-') && !String(x).includes('/')) || ''}`;
  return base;
};
for (const k of ['execFile', 'spawn', 'exec']) {
  const orig = cp[k];
  cp[k] = function (cmd, args, ...rest) {
    const t0 = performance.now(), name = `${k} ${label(cmd, args)}`;
    const child = orig.call(this, cmd, args, ...rest), sync = performance.now() - t0;
    child?.once?.('exit', () => add(name, performance.now() - t0, sync));
    return child;
  };
  // promisify(execFile) and promisify(exec) resolve with { stdout, stderr }: keep that form for the wrapper
  if (orig[promisify.custom]) {
    const wrapped = cp[k];
    cp[k][promisify.custom] = (...a) => new Promise((resolve, reject) => {
      wrapped(...a, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }));
    });
  }
}
for (const k of ['execFileSync', 'spawnSync', 'execSync']) {
  const orig = cp[k];
  cp[k] = function (cmd, args, ...rest) {
    const t0 = performance.now();
    try { return orig.call(this, cmd, args, ...rest); } finally { add(`${k} ${label(cmd, args)}`, performance.now() - t0); }
  };
}
// the first frame in the server's own code (file:line), so each count names the code that made the call
const caller = () => {
  const keep = Error.stackTraceLimit; Error.stackTraceLimit = 12;
  const stack = new Error().stack || ''; Error.stackTraceLimit = keep;
  const m = stack.split('\n').slice(2).map(l => l.match(/\/(server\/[^:)]+:\d+)/)).find(Boolean);
  return m ? m[1] : 'other';
};
for (const k of ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'existsSync', 'readdirSync', 'renameSync', 'mkdirSync', 'openSync', 'readSync']) {
  const orig = fs[k];
  fs[k] = function (...a) {
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { add(`fs.${k} ${caller()}`, performance.now() - t0); }
  };
}
syncBuiltinESMExports();

const started = Date.now();
const dump = () => {
  if (!OUT) return;
  const ms = v => +(v / 1e6).toFixed(2);
  const body = JSON.stringify({ at: Date.now(), uptime: Date.now() - started, cpu: process.cpuUsage(), rss: process.memoryUsage().rss,
    eld: { count: h.count, mean: ms(h.mean), p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) }, calls });
  try { writeFileSync(OUT + '.tmp', body); renameSync(OUT + '.tmp', OUT); } catch { /* folder gone */ }
};
setInterval(() => { dump(); }, 2000).unref();
process.on('SIGUSR2', () => { h.reset(); });
