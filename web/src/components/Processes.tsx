// Settings → Taskboard server → Processes: every process of Taskboard grouped by task, with CPU, memory, energy impact
// and age (GET /api/processes, server/processes.ts; `tb top` prints the same table). It reloads every 5 s while it is
// shown. Energy impact needs a 2 s sample of top, so it is measured only when the box is ticked.
import { useEffect, useState } from 'react';
import { api, type ProcTable } from '../api';
import { SettingItem } from './SettingsLayout';

const age = (s: number | null) => s == null ? '' : s >= 86400 ? `${Math.floor(s / 86400)} d` : s >= 3600 ? `${Math.floor(s / 3600)} h` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`;
const mem = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

export function Processes() {
  const [t, setT] = useState<ProcTable | null>(null);
  const [power, setPower] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const r = await api.processes(power); if (!stop) { setT(r); setErr(''); } } catch (e) { if (!stop) setErr((e as Error).message); }
      if (!stop) timer = setTimeout(load, 5000);
    };
    void load();
    return () => { stop = true; clearTimeout(timer); };
  }, [power]);
  return <SettingItem id="processes">
    <div className="ctl-box set-card">
      <div><b>Processes</b></div>
      <div className="sub">Every process that belongs to Taskboard, grouped by task: the server, tmux, the agents, their MCP servers and shells, the task browsers and test servers. In a process list, search for <code>tb#</code> to find the agents: each one starts as <code>tb#&lt;task number&gt; &lt;agent&gt;</code>. In the command line tool, <code>tb top</code> prints this table.</div>
      <label className="opt"><input type="checkbox" checked={power} onChange={e => setPower(e.target.checked)} /> Measure energy impact (each update takes 2 s)</label>
      {err && <div className="sub">{err}</div>}
      {!t ? <div className="sub">Loading…</div> : <>
        <p>Taskboard in total: CPU {t.totals.cpu}%, memory {mem(t.totals.memMb)}{t.totals.power != null ? `, energy impact ${t.totals.power}` : ''}, {t.totals.count} processes.</p>
        <table className="starts procs"><thead><tr><th>Process</th><th>Kind</th><th>CPU %</th><th>Memory</th>{t.power && <th>Energy</th>}<th>Age</th><th>Command</th></tr></thead>
          {t.groups.map(g => <tbody key={g.key}>
            <tr className="proc-group"><td colSpan={2}><b>{g.label}</b></td><td>{g.totals.cpu}</td><td>{mem(g.totals.memMb)}</td>{t.power && <td>{g.totals.power}</td>}<td></td><td className="sub">{g.totals.count} processes</td></tr>
            {g.procs.map(p => <tr key={p.pid}><td>{p.pid} {p.name}</td><td>{p.kind}</td><td>{p.cpu.toFixed(1)}</td><td>{mem(p.memMb)}</td>{t.power && <td>{p.power?.toFixed(1)}</td>}<td>{age(p.ageSec)}</td><td className="sub" title={p.command}>{p.command.slice(0, 80)}</td></tr>)}
          </tbody>)}
        </table>
      </>}
    </div>
  </SettingItem>;
}
