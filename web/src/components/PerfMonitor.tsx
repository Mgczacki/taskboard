// A small box at the bottom left with the work of the dashboard, the server and the machine (perfStats.ts, server/perf.ts).
// Off by default: Settings > This app or browser > Performance, or localStorage 'tb-perf' = 'on'.
// It shows, each second:
// - page: the long tasks of the main thread in the last minute (the count and the longest), and the messages and bytes
//   per second of the page's sockets over the last 5 s
// - server: the delay of its event loop (99th percentile and longest, last full minute), its CPU and memory
// - machine: the 1-minute load for the number of cores, the swap and the free memory, and one line of warning when the
//   machine is overloaded, with the three processes that use the most CPU and the most memory
import { useEffect, useState } from 'react';
import { lastMinute, onPerfChange, perfOn, readMessages, setPerfOn, startCounting, stopCounting } from '../perfStats';

interface Proc { pid: number; name: string; cpu: number; memMb: number }
interface Perf {
  server: { cpuPct: number; rssMb: number; eventLoop: { lastMinute: { p50: number; p99: number; max: number } | null; now: { p50: number; p99: number; max: number } } };
  machine: { cores: number; load: number[]; memory: { totalMb: number; freeMb: number }; swap: { usedMb: number; totalMb: number } | null; overloaded: boolean; topCpu: Proc[]; topMemory: Proc[] };
}
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const memText = (mb: number) => mb >= 1024 ? gb(mb) : `${mb} MB`;

export function PerfMonitor() {
  const [on, setOn] = useState(perfOn);
  useEffect(() => onPerfChange(() => setOn(perfOn())), []);
  if (!on) return null;
  return <PerfBox />;
}

function PerfBox() {
  const [page, setPage] = useState({ count: 0, longest: 0, msgs: 0, kb: 0 });
  const [perf, setPerf] = useState<Perf | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    startCounting();
    const samples: { at: number; messages: number; bytes: number }[] = [];
    const tick = () => {
      const now = { at: Date.now(), ...readMessages() };
      samples.push(now);
      while (samples.length > 6) samples.shift();
      const first = samples[0], secs = Math.max(1, (now.at - first.at) / 1000);
      setPage({ ...lastMinute(), msgs: Math.round((now.messages - first.messages) / secs), kb: Math.round((now.bytes - first.bytes) / 1024 / secs) });
    };
    const load = () => fetch('/api/perf').then(r => r.ok ? r.json() : Promise.reject(new Error(`server answered ${r.status}`))).then(p => { setPerf(p); setErr(''); }, e => setErr(String(e.message || e)));
    tick(); void load();
    const t1 = setInterval(tick, 1000), t2 = setInterval(load, 5000);
    return () => { clearInterval(t1); clearInterval(t2); stopCounting(); };
  }, []);
  const loop = perf?.server.eventLoop.lastMinute || perf?.server.eventLoop.now;
  const m = perf?.machine;
  const swapPct = m?.swap && m.swap.totalMb ? Math.round(m.swap.usedMb / m.swap.totalMb * 100) : null;
  return (
    <div className="perfmon" role="status">
      <button className="perfmon-x" title="Turn the performance monitor off (Settings can turn it on again)" onClick={() => setPerfOn(false)}>✕</button>
      <div><b>Page</b> {page.count} long task{page.count === 1 ? '' : 's'} in 1 min{page.count ? ` · longest ${page.longest} ms` : ''} · sockets {page.msgs} msg/s, {page.kb} KB/s</div>
      {perf && loop && <div><b>Server</b> event loop delay p99 {loop.p99} ms, longest {loop.max} ms{perf.server.eventLoop.lastMinute ? ' (last minute)' : ''} · CPU {perf.server.cpuPct}% · {memText(perf.server.rssMb)}</div>}
      {m && <div><b>Machine</b> load {m.load[0]} on {m.cores} cores{m.swap ? ` · swap ${gb(m.swap.usedMb)} of ${gb(m.swap.totalMb)}` : ''} · free memory {memText(m.memory.freeMb)}</div>}
      {m?.overloaded && <div className="perfmon-warn">The machine is overloaded ({m.load[0] > 2 * m.cores ? `load ${m.load[0]} is above twice the ${m.cores} cores` : `${swapPct}% of the swap is used`}), so Taskboard can be slow for causes outside it. Most CPU: {m.topCpu.map(p => `${p.name} ${Math.round(p.cpu)}%`).join(', ')}. Most memory: {m.topMemory.map(p => `${p.name} ${memText(p.memMb)}`).join(', ')}.</div>}
      {err && <div className="perfmon-warn">Could not read the server numbers: {err}</div>}
    </div>
  );
}
