import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, useStoreValue } from '../api';
import { badgeTitle, boardOf, loadBoards, boardSummary, fmtAge, managerGroupsOf, managersVersion, needAction, refreshManagerDetails, rowOf, subscribeManagers, waitLabel, watchBoards, type BoardRow, type FindCard } from '../managerBoard';
import { PopMenu } from './PopMenu';

type TaskRef = { id: string; num: number; title: string };
type Audit = { at: string; actor: string; action: string; target: string; result: string; userRequest?: string };
type Preset = { name: string; may: string[]; not: string[] };
type Scope = { group: { manager?: string; tasks: string[] }; caps: Record<string, number>; actions: Audit[];
  preset: string | null; defaultPreset: string; presets: Record<string, Preset>; never: string[]; rule: string; ruleLimits: string };

const useManagers = () => useSyncExternalStore(subscribeManagers, managersVersion);
// Read the boards of all groups while the calling view is shown
export function useBoards() { useEffect(() => watchBoards(), []); return useManagers(); }
// Find a card of the store by the card id of a wait
function useFindCard(): FindCard {
  const approvals = useStoreValue(s => s.approvals);
  const pending = useStoreValue(s => s.pending);
  return id => {
    const a = approvals.find(x => x.id === id);
    if (a) return { kind: 'approval', action: a.action, pushId: a.payload?.pushId, permitId: a.payload?.permitId };
    if (pending.some(x => x.id === id)) return { kind: 'question' };
  };
}

// "Manager" on a manager task, wherever the task shows. The tooltip names the group, the caps and what the manager may do now.
export function ManagerBadge({ id }: { id: string | undefined }) {
  useManagers();
  const groups = managerGroupsOf(id);
  useEffect(() => { if (groups.length) void refreshManagerDetails(); }, [groups.length]);
  if (!groups.length) return null;
  return <span className="chip mgr-badge" title={badgeTitle(groups)} onMouseEnter={() => void refreshManagerDetails()}>◆ Manager</span>;
}

// The ◆ on a group tab whose group has a manager. The tooltip names the manager task. A click opens it.
export function ManagerMark({ manager, tasks, open }: { manager?: string; tasks: TaskRef[]; open: (id: string) => void }) {
  const t = manager ? tasks.find(x => x.id === manager) : undefined;
  if (!t) return null;
  return <button className="mgr-mark" aria-label={`Manager: #${t.num} ${t.title}`} title={`Manager: #${t.num} ${t.title}. Click to open the manager task.`}
    onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); open(t.id); }}>◆</button>;
}

// The wait of a task in place of the status word of its canvas window, for example "Waits on #302" or "Approve push".
// It shows the status word (children) when the task does not wait or no board holds it.
export function WaitLabel({ taskId, group, children }: { taskId: string; group?: string; children: ReactNode }) {
  useManagers();
  const find = useFindCard();
  const at = rowOf(taskId, group);
  const text = at && waitLabel(at.row, at.column, find);
  if (!text) return <>{children}</>;
  const w = at.row.waitingOn;
  return <span className={`st st-label wait-label ${at.column === 'needsYou' ? 'needs-you' : at.column === 'blocked' ? 'stopped' : ''}`} title={`${w?.needs || w?.reason || text} · ${fmtAge(at.row.ageMinutes)}`}>{text}</span>;
}

// "3 need you" on a group tab of a group with a manager. A click opens a drop-down with two tabs:
// Need you (the rows that wait for the user, with Approve and Deny when one click decides the card) and
// Manager did (the actions of the manager, server/manager-role.ts actions()).
export function GroupNeeds({ group, open, toast }: { group: string; open: (id: string) => void; toast: (text: string) => void }) {
  useManagers();
  const b = boardOf(group);
  const btn = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  if (!b?.group.manager) return null;
  const n = boardSummary(b).counts.needsYou;
  return <>
    <button ref={btn} className={`need-chip ${n ? 'hot' : ''} ${shown ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={shown}
      title={n ? `${n} ${n === 1 ? 'task needs' : 'tasks need'} you in this group. Click for the list and for what the manager did.` : 'Nothing in this group needs you. Click for what the manager did.'}
      onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setShown(x => !x); }}>{n ? `${n} need you` : '0 need you'}</button>
    {shown && <PopMenu anchor={btn.current} close={() => setShown(false)} className="need-pop" align="left" label={`${b.group.name}: need you`}>
      <NeedsPanel group={group} rows={b.columns.needsYou || []} manager={b.group.manager} open={id => { setShown(false); open(id); }} toast={toast} />
    </PopMenu>}
  </>;
}

function NeedsPanel({ group, rows, manager, open, toast }: { group: string; rows: BoardRow[]; manager: string; open: (id: string) => void; toast: (text: string) => void }) {
  const [tab, setTab] = useState<'need' | 'did'>('need');
  const [audit, setAudit] = useState<Audit[] | null>(null);
  const find = useFindCard();
  const tasks = useStoreValue(s => s.tasks);
  useEffect(() => { void fetch(`/api/manager/${encodeURIComponent(group)}`).then(r => r.json()).then((s: Scope) => setAudit(s.actions || [])).catch(() => setAudit([])); }, [group]);
  const num = (id: string) => { const t = tasks.find(x => x.id === id); return t ? `#${t.num}` : id === 'user' ? 'you' : id; };
  const fail = (e: unknown) => toast(String((e as Error).message || e));
  const mgr = tasks.find(t => t.id === manager);
  return <div className="need-panel" onClick={e => e.stopPropagation()}>
    <div className="need-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'need'} className={tab === 'need' ? 'on' : ''} onClick={() => setTab('need')}>Need you <span>{rows.length}</span></button>
      <button role="tab" aria-selected={tab === 'did'} className={tab === 'did' ? 'on' : ''} onClick={() => setTab('did')}>Manager did <span>{audit?.length ?? '…'}</span></button>
    </div>
    {tab === 'need' ? <div className="need-list">
      {!rows.length && <div className="need-empty">Nothing in this group needs you.</div>}
      {rows.map(r => { const act = needAction(r, find); return <div key={r.id} className="need-row">
        <span className="dot needs-you" /><span className="n">#{r.num}</span>
        <div className="need-txt"><b title={r.title}>{r.title}</b><small title={r.waitingOn?.needs}>{r.waitingOn?.needs || r.waitingOn?.reason || 'Needs you'}</small></div>
        <span className="a">{fmtAge(r.ageMinutes)}</span>
        <span className="need-acts">
          {act.kind === 'push' && <><button className="btn primary" onClick={() => void api.decidePush(act.pushId, true, '').then(() => loadBoards(), fail)}>Approve</button><button className="btn" onClick={() => void api.decidePush(act.pushId, false, '').then(() => loadBoards(), fail)}>Deny</button></>}
          {act.kind === 'decide' && <><button className="btn primary" onClick={() => void api.decide(act.id, true).then(() => loadBoards(), fail)}>Approve</button><button className="btn" onClick={() => void api.decide(act.id, false).then(() => loadBoards(), fail)}>Deny</button></>}
          {act.kind === 'review' && <button className="btn" onClick={() => { location.hash = 'inbox:documents'; }}>Open review</button>}
          {act.kind === 'open' && <button className="btn" onClick={() => open(r.id)}>Open task</button>}
        </span>
      </div>; })}
    </div> : <div className="need-list">
      {audit && !audit.length && <div className="need-empty">The manager did nothing yet.</div>}
      {audit?.map((a, i) => <div key={i} className="need-row did" title={a.userRequest ? `User message: ${a.userRequest}` : undefined}>
        <span className="a">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="chip">{a.action}</span>
        <div className="need-txt"><span>{num(a.actor)} · {a.target ? num(a.target) : '—'}</span></div>
        <span className="a">{a.result}</span>
      </div>)}
    </div>}
    <div className="need-foot">◆ {mgr ? <button className="btn ghost" onClick={() => open(mgr.id)}>#{mgr.num} {mgr.title}</button> : manager} manages this group. The group menu (⋯) sets the manager.</div>
  </div>;
}

// Who manages the group, its preset, what the preset allows and the group manager rule (tasks 242 and 273), in the group menu
export function ManagerScope({ group, tasks }: { group: string; tasks: TaskRef[] }) {
  const [scope, setScope] = useState<Scope | null>(null);
  const load = () => void fetch(`/api/manager/${encodeURIComponent(group)}`).then(r => r.json()).then(setScope).catch(() => {});
  useEffect(load, [group]);
  const setManager = async (body: { task: string | null; preset?: string }) => {
    await fetch(`/api/manager/${encodeURIComponent(group)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    load();
  };
  if (!scope) return <div className="manager-scope sub">Loading the manager…</div>;
  const manager = scope.group.manager || '';
  const key = scope.preset || scope.defaultPreset;
  const preset = scope.presets?.[key];
  return <div className="manager-scope">
    <label style={{ color: 'var(--dim)', margin: '8px 0 2px' }}>◆ Manager <select value={manager} onChange={e => void setManager({ task: e.target.value || null })}>
      <option value="">None</option>{tasks.filter(t => scope.group.tasks.includes(t.id)).map(t => <option key={t.id} value={t.id}>#{t.num} {t.title}</option>)}
    </select></label>
    {preset && <>
      <label style={{ color: 'var(--dim)' }}>Preset <select value={key} disabled={!manager} title={manager ? 'What the manager may do without a card' : 'Choose a manager first. A new manager gets this default preset.'}
        onChange={e => void setManager({ task: manager, preset: e.target.value })}>
        {Object.entries(scope.presets).map(([k, p]) => <option key={k} value={k}>{p.name}{k === scope.defaultPreset ? ' (default)' : ''}</option>)}
      </select></label>
      <div className="sub manager-preset" aria-label="What the preset allows">
        <b>Without a card, the manager may:</b>
        <ul>{preset.may.map(x => <li key={x}>{x}</li>)}</ul>
        {preset.not.length > 0 && <><b>Only with your card:</b><ul>{preset.not.map(x => <li key={x}>{x}</li>)}</ul></>}
        <b>Never:</b>
        <ul>{scope.never.map(x => <li key={x}>{x}</li>)}</ul>
        <div>{scope.rule} {scope.ruleLimits}</div>
      </div>
    </>}
    <div className="sub">Limits: {Object.entries(scope.caps).map(([key, value]) => `${key} ${value}`).join(' · ')}</div>
  </div>;
}
