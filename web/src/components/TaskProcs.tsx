// The processes of a task (server/task-procs.ts): state, port, memory, start / stop / restart, and the output log.
import { useEffect, useState } from 'react';
import type { Proc, ProcScope } from '../api';
import { api } from '../api';

const STATE_DOT: Record<Proc['state'], string> = { running: 'unread', starting: 'working', exited: 'stopped', stopped: 'idle', suspended: 'suspended' };

export function ProcList({ scope, id, cwd, compact = false }: { scope: ProcScope; id: string; cwd?: string; compact?: boolean }) {
  const [list, setList] = useState<Proc[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [logName, setLogName] = useState('');
  const [log, setLog] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', command: '', port: '', stop: '', cwd: cwd || '' });

  const load = () => api.procs(scope, id).then(l => { setList(l); setErr(''); }).catch(e => setErr(String(e.message || e)));
  useEffect(() => { setList(null); void load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, [scope, id]);
  useEffect(() => {
    if (!logName) return;
    const read = () => api.procLog(scope, id, logName).then(t => setLog(String(t))).catch(() => {});
    void read(); const t = setInterval(read, 2000); return () => clearInterval(t);
  }, [scope, id, logName]);

  const act = async (name: string, action: 'stop' | 'restart' | 'remove') => {
    setBusy(name); try { await api.procAction(scope, id, name, action); if (action === 'remove' && logName === name) setLogName(''); await load(); } catch (e) { setErr(String((e as Error).message || e)); } setBusy('');
  };
  const add = async () => {
    setBusy('+');
    try {
      await api.startProc(scope, id, { name: form.name.trim(), command: form.command.trim(), cwd: form.cwd.trim() || undefined, stop: form.stop.trim() || undefined, port: form.port ? Number(form.port) : undefined });
      setAdding(false); setForm({ name: '', command: '', port: '', stop: '', cwd: cwd || '' }); await load();
    } catch (e) { setErr(String((e as Error).message || e)); }
    setBusy('');
  };

  return (
    <div className={`procs ${compact ? 'compact' : ''}`}>
      <div className="procs-head">
        <b>Processes</b>
        <span className="sub">Taskboard ends them when the task is archived or suspended.</span>
        <span className="sp" />
        <button className="btn" onClick={() => setAdding(a => !a)}>＋ Add process</button>
      </div>
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      {adding && <div className="procs-add">
        <input placeholder="Name, for example web" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <input className="pcmd" placeholder="Command, for example pnpm dev" value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} />
        <input placeholder="Port (optional)" value={form.port} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} />
        <input className="pcmd" placeholder="Stop command (optional), for example docker compose down" value={form.stop} onChange={e => setForm({ ...form, stop: e.target.value })} />
        <input className="pcmd" placeholder="Folder" value={form.cwd} onChange={e => setForm({ ...form, cwd: e.target.value })} />
        <div><button className="btn primary" disabled={busy === '+' || !form.name.trim() || !form.command.trim()} onClick={add}>Start</button> <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button></div>
      </div>}
      {list && !list.length && !adding && <div className="sub procs-none">No processes. An agent starts one with <code>tb run &lt;name&gt; -- &lt;command&gt;</code>. You can add one here.</div>}
      {!!list?.length && <table className="procs-table">
        <thead><tr><th>Name</th><th>State</th>{!compact && <th>Command</th>}<th>Port</th><th title="Resident memory (RSS) of the process group, read with ps while this tab is open. Shared pages count in each process.">Memory</th>{!compact && <th>Started by</th>}<th /></tr></thead>
        <tbody>{list.map(p => {
          const on = p.state === 'running' || p.state === 'starting';
          return (
            <tr key={p.name} className={logName === p.name ? 'sel' : ''}>
              <td><b>{p.name}</b></td>
              <td title={p.stopNote || (p.started ? `Started ${new Date(p.started).toLocaleString()}` : '')}><span className={`dot ${STATE_DOT[p.state]}`} /> {p.state}{p.state === 'exited' && p.exitCode !== undefined ? ` (${p.exitCode})` : ''}</td>
              {!compact && <td className="pcmd" title={`${p.command}\nin ${p.cwd}${p.stop ? `\nstop command: ${p.stop}` : ''}`}>{p.command}</td>}
              <td>{p.port ? <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer" title="Open in your own browser">{p.port}</a> : '—'}</td>
              <td className="pmem">{on && typeof p.memMb === 'number' ? `${p.memMb} MB` : '—'}</td>
              {!compact && <td>{p.startedBy === 'agent' ? 'agent' : 'you'}</td>}
              <td className="act">
                {on ? <><button className="btn" disabled={busy === p.name} onClick={() => act(p.name, 'stop')}>Stop</button><button className="btn" disabled={busy === p.name} onClick={() => act(p.name, 'restart')}>Restart</button></>
                  : <><button className="btn" disabled={busy === p.name} onClick={() => act(p.name, 'restart')}>Start</button><button className="btn ghost" disabled={busy === p.name} onClick={() => act(p.name, 'remove')} title="Remove it from the list">Remove</button></>}
                <button className={`btn ${logName === p.name ? 'on' : ''}`} onClick={() => setLogName(n => n === p.name ? '' : p.name)}>Log</button>
              </td>
            </tr>
          );
        })}</tbody>
      </table>}
      {logName && <pre className="logtext procs-log">{log || 'No output yet.'}</pre>}
    </div>
  );
}
