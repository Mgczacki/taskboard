import { useEffect, useState } from 'react';

type Row = { id: string; num: number; title: string; ageMinutes: number; source: string; waitingOn?: { on: string; needs: string; reason: string; unblocks: string[] } };
type Board = { group: { name: string }; heartbeat?: { pending: number; lastTurn: string | null; notResponding: boolean }; columns: Record<string, Row[]> };
type Scope = { group: { manager?: string; tasks: string[] }; caps: Record<string, number>; actions: { at: string; action: string; target: string; result: string; userRequest?: string }[] };
const labels: Record<string, string> = { needsYou: 'Needs you', waitingOther: 'Waiting on other', running: 'Running', free: 'Free', blocked: 'Blocked' };

export function ManagerBoard({ group, tasks, openTask }: { group: string; tasks: { id: string; num: number; title: string }[]; openTask: (id: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [showScope, setShowScope] = useState(false);
  const loadScope = () => void fetch(`/api/manager/${encodeURIComponent(group)}`).then(r => r.json()).then(setScope).catch(() => {});
  const setManager = async (task: string) => {
    await fetch(`/api/manager/${encodeURIComponent(group)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: task || null }) });
    loadScope();
  };
  useEffect(() => {
    let live = true;
    const load = () => void fetch(`/api/board?group=${encodeURIComponent(group)}`).then(r => r.json()).then(x => { if (live) setBoard(x); }).catch(() => {});
    load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [group]);
  if (!board?.columns) return null;
  return <section className="manager-board" aria-label={`${board.group.name} manager board`}>
    <h2>Manager · {board.group.name} <button className="btn" onClick={() => { setShowScope(x => !x); loadScope(); }}>Scope</button></h2>
    {board.heartbeat && <p className="sub">Manager last update: {board.heartbeat.lastTurn ? new Date(board.heartbeat.lastTurn).toLocaleString() : 'none'} · {board.heartbeat.pending} events pending{board.heartbeat.notResponding ? ' · manager not responding' : ''}</p>}
    {showScope && scope && <div className="manager-scope">
      <label>Manager of this group <select value={scope.group.manager || ''} onChange={e => void setManager(e.target.value)}>
        <option value="">None</option>{tasks.filter(t => scope.group.tasks.includes(t.id)).map(t => <option key={t.id} value={t.id}>#{t.num} {t.title}</option>)}
      </select></label>
      <p>Limits: {Object.entries(scope.caps).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>
      <ul>{scope.actions.slice(0, 10).map((a, i) => <li key={i}>{new Date(a.at).toLocaleString()} · {a.action} · {a.target} · {a.result}{a.userRequest ? ` · user message: ${a.userRequest}` : ''}</li>)}</ul>
    </div>}
    <div className="manager-columns">{Object.entries(labels).map(([key, label]) => <div className="manager-column" key={key}>
      <h3>{label} <span>{board.columns[key]?.length || 0}</span></h3>
      {(board.columns[key] || []).map(row => <button key={row.id} onClick={() => openTask(row.id)}>
        <strong>#{row.num} {row.title}</strong>
        <small>{row.waitingOn?.needs || row.waitingOn?.reason || label} · {row.ageMinutes} min · {row.source}</small>
        {!!row.waitingOn?.unblocks.length && <small>Unblocks {row.waitingOn.unblocks.join(', ')}</small>}
      </button>)}
    </div>)}</div>
  </section>;
}
