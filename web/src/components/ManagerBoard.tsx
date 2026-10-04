import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { BOARD_COLUMNS, badgeTitle, boardSummary, fmtAge, headerKey, heartbeatState, managerGroupsOf, managersVersion, readAutoOpen, readOpen, refreshManagerDetails, saveOpen, shouldAutoOpen, subscribeManagers, type Board, type BoardRow } from '../managerBoard';

type Scope = { group: { manager?: string; tasks: string[] }; caps: Record<string, number>; actions: { at: string; action: string; target: string; result: string; userRequest?: string }[] };
type TaskRef = { id: string; num: number; title: string };

const useManagers = () => useSyncExternalStore(subscribeManagers, managersVersion);

// "Manager" on a manager task, wherever the task shows. The tooltip names the group, the caps and what the manager may do now.
export function ManagerBadge({ id }: { id: string | undefined }) {
  useManagers();
  const groups = managerGroupsOf(id);
  useEffect(() => { if (groups.length) void refreshManagerDetails(); }, [groups.length]);
  if (!groups.length) return null;
  return <span className="chip mgr-badge" title={badgeTitle(groups)} onMouseEnter={() => void refreshManagerDetails()}>Manager</span>;
}

// The manager chip on a group header: the number of the manager task. A click opens the manager task.
export function ManagerChip({ manager, tasks, open }: { manager?: string; tasks: TaskRef[]; open: (id: string) => void }) {
  const t = manager ? tasks.find(x => x.id === manager) : undefined;
  if (!t) return null;
  return <button className="mgr-chip" title={`Manager: #${t.num} ${t.title}. Click to open the manager task.`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); open(t.id); }}>Manager #{t.num}</button>;
}

// Who manages the group, the caps and the last manager actions (task 242). The change of the manager is saved by the server.
function ManagerScope({ group, tasks, onChanged }: { group: string; tasks: TaskRef[]; onChanged: () => void }) {
  const [scope, setScope] = useState<Scope | null>(null);
  const load = () => void fetch(`/api/manager/${encodeURIComponent(group)}`).then(r => r.json()).then(setScope).catch(() => {});
  useEffect(load, [group]);
  const setManager = async (task: string) => {
    await fetch(`/api/manager/${encodeURIComponent(group)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: task || null }) });
    load(); onChanged();
  };
  if (!scope) return <div className="manager-scope sub">Loading the scope…</div>;
  return <div className="manager-scope">
    <label>Manager of this group <select value={scope.group.manager || ''} onChange={e => void setManager(e.target.value)}>
      <option value="">None</option>{tasks.filter(t => scope.group.tasks.includes(t.id)).map(t => <option key={t.id} value={t.id}>#{t.num} {t.title}</option>)}
    </select></label>
    <p>Limits: {Object.entries(scope.caps).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>
    {scope.actions.length > 0 && <ul>{scope.actions.slice(0, 10).map((a, i) => <li key={i}>{new Date(a.at).toLocaleString()} · {a.action} · {a.target} · {a.result}{a.userRequest ? ` · user message: ${a.userRequest}` : ''}</li>)}</ul>}
  </div>;
}

const rowText = (row: BoardRow, label: string) => row.waitingOn?.needs || row.waitingOn?.reason || row.now || label;

// The board above the canvas windows of a group. Folded, it is one row of at most 36 px with the count of each column.
// Open, it shows the rows below that header, at most 40% of the window high, with its own scroll.
// "Open full board" shows the full cards in a wide drawer. A group without a manager shows one row with "Set a manager".
export function ManagerBoard({ group, tasks, openTask }: { group: string; tasks: TaskRef[]; openTask: (id: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [open, setOpenState] = useState(() => readOpen(group));
  const [full, setFull] = useState(false);
  const [showScope, setShowScope] = useState(false);
  const [setting, setSetting] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const needsBefore = useRef(0);
  const panelId = useId();
  const [reload, setReload] = useState(0);
  useEffect(() => { setOpenState(readOpen(group)); setFull(false); setShowScope(false); setSetting(false); needsBefore.current = 0; }, [group]);
  useEffect(() => {
    let live = true;
    const load = () => void fetch(`/api/board?group=${encodeURIComponent(group)}`).then(r => r.json()).then(x => { if (live) setBoard(x); }).catch(() => {});
    load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [group, reload]);
  const summary = board?.columns && board.group.id === group ? boardSummary(board) : null;
  const needs = summary?.counts.needsYou || 0;
  // Settings > This app or browser: open the board by itself when more rows need you. The opening is not saved.
  useEffect(() => {
    if (!summary) return;
    if (shouldAutoOpen(needsBefore.current, needs, readAutoOpen())) setOpenState(true);
    needsBefore.current = needs;
  }, [needs, !!summary]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!board || !summary) return null;
  const setOpen = (v: boolean) => { setOpenState(v); saveOpen(group, v); };
  const name = board.group.name;

  if (!board.group.manager) return <section className="mboard none" aria-label={`${name} manager`}>
    <div className="mb-head">
      <span className="mb-name dim">No manager</span>
      {setting ? <ManagerScope group={group} tasks={tasks} onChanged={() => { setSetting(false); setReload(n => n + 1); }} />
        : <button className="btn mb-btn" onClick={() => setSetting(true)} title="Choose a task of this group as its manager. The manager tracks the waits of the other tasks.">Set a manager</button>}
    </div>
  </section>;

  const hb = heartbeatState(board.heartbeat);
  const manager = tasks.find(t => t.id === board.group.manager);
  return <section className={`mboard ${open ? 'open' : ''}`} aria-label={`${name} manager board`}
    onKeyDown={e => { if (e.key === 'Escape' && open && !full) { e.stopPropagation(); setOpen(false); toggle.current?.focus(); } }}>
    <div className="mb-head">
      <button ref={toggle} className="mb-toggle" aria-expanded={open} aria-controls={panelId} title={open ? 'Fold the manager board' : 'Open the manager board'}
        onClick={() => setOpen(!open)} onKeyDown={e => { const a = headerKey(e.key, open); if (!a) return; e.preventDefault(); e.stopPropagation(); setOpen(a === 'toggle' ? !open : false); }}>
        <span className="mb-chev" aria-hidden="true">▸</span>
        <span className="mb-name">{name}</span>
        <span className="mb-chips">{BOARD_COLUMNS.map(([k, label, word]) => <span key={k} className={`mb-chip ${k === 'needsYou' && summary.counts[k] ? 'hot' : ''} ${summary.counts[k] ? '' : 'zero'}`} title={`${label}: ${summary.counts[k]}`}>{summary.counts[k]} {word}</span>)}
          {summary.oldestMinutes !== null && <span className="mb-chip age" title="The oldest wait in Needs you, Waiting on other and Blocked">oldest {fmtAge(summary.oldestMinutes)}</span>}</span>
      </button>
      <span className={`mb-beat ${hb.state}`} role="img" aria-label={hb.text} title={hb.text} />
      {manager && <ManagerChip manager={manager.id} tasks={tasks} open={openTask} />}
      <button className="btn mb-btn" onClick={() => setFull(true)} title="Show every column with the full text of each row">Open full board</button>
    </div>
    <div className="mb-body" id={panelId} role="region" aria-label={`${name} board rows`} inert={!open}>
      <div className="mb-inner"><div className="mb-scroll">
        <div className="mb-meta sub"><span>{hb.text}</span><button className="btn ghost mb-btn" onClick={() => setShowScope(x => !x)} aria-expanded={showScope}>Scope</button></div>
        {showScope && <ManagerScope group={group} tasks={tasks} onChanged={() => setReload(n => n + 1)} />}
        <div className="mb-cols">{BOARD_COLUMNS.map(([k, label]) => <div className="mb-col" key={k}>
          <h3>{label}<span>{summary.counts[k]}</span></h3>
          {(board.columns[k] || []).map(row => <button key={row.id} className="mb-row" onClick={() => openTask(row.id)}
            title={`#${row.num} ${row.title}\n${rowText(row, label)} · ${fmtAge(row.ageMinutes)} · ${row.source}${row.waitingOn?.unblocks.length ? `\nUnblocks ${row.waitingOn.unblocks.join(', ')}` : ''}`}>
            <span className="n">#{row.num}</span><span className="t">{row.title}</span><span className="a">{fmtAge(row.ageMinutes)}</span>
          </button>)}
          {!summary.counts[k] && <div className="mb-empty">None</div>}
        </div>)}</div>
      </div></div>
    </div>
    {full && <FullBoard board={board} tasks={tasks} openTask={id => { setFull(false); openTask(id); }} close={() => { setFull(false); toggle.current?.focus(); }} reload={() => setReload(n => n + 1)} />}
  </section>;
}

// The full board in a wide drawer over the page: every column with the full text of each row, and the scope.
function FullBoard({ board, tasks, openTask, close, reload }: { board: Board; tasks: TaskRef[]; openTask: (id: string) => void; close: () => void; reload: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [showScope, setShowScope] = useState(false);
  useEffect(() => {
    closeBtn.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    addEventListener('keydown', key, true); return () => removeEventListener('keydown', key, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hb = heartbeatState(board.heartbeat);
  return <div className="mb-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="mb-drawer" role="dialog" aria-modal="true" aria-label={`${board.group.name} manager board`}>
      <div className="mb-dhead">
        <h2>Manager board · {board.group.name}</h2>
        <span className={`mb-beat ${hb.state}`} role="img" aria-label={hb.text} title={hb.text} />
        <ManagerChip manager={board.group.manager} tasks={tasks} open={openTask} />
        <span className="pc-sp" />
        <button className="btn" onClick={() => setShowScope(x => !x)} aria-expanded={showScope}>Scope</button>
        <button ref={closeBtn} className="btn" onClick={close} title="Close (Escape)">Close</button>
      </div>
      <p className="sub mb-dsub">{hb.text}</p>
      {showScope && <ManagerScope group={board.group.id} tasks={tasks} onChanged={reload} />}
      <div className="manager-columns">{BOARD_COLUMNS.map(([key, label]) => <div className="manager-column" key={key}>
        <h3>{label} <span>{board.columns[key]?.length || 0}</span></h3>
        {(board.columns[key] || []).map(row => <button key={row.id} onClick={() => openTask(row.id)} title={`#${row.num} ${row.title}`}>
          <strong>#{row.num} {row.title}</strong>
          <small>{rowText(row, label)} · {fmtAge(row.ageMinutes)} · {row.source}</small>
          {!!row.waitingOn?.unblocks.length && <small>Unblocks {row.waitingOn.unblocks.join(', ')}</small>}
        </button>)}
      </div>)}</div>
    </div>
  </div>;
}
