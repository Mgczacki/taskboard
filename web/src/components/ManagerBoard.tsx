import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, useStore, useStoreValue } from '../api';
import { CONFIRM_MS, cardTime, needsConfirm } from '../clickGuard';
import { badgeTitle, boardOf, loadBoards, boardSummary, fmtAge, loadScope, managerGroupsOf, managerMenu, managersVersion, needAction, refreshManagerDetails, rowOf, scopeOf, setManager, subscribeManagers, waitLabel, watchBoards, type Audit, type BoardRow, type FindCard, type ManagerChoice, type ManagerMenu, type PresetKey, type Scope } from '../managerBoard';
import { PopMenu } from './PopMenu';

type TaskRef = { id: string; num: number; title: string };
type RoleTask = TaskRef & { status: string; role?: string };

const useManagers = () => useSyncExternalStore(subscribeManagers, managersVersion);
// The shared manager scope of a group (managerBoard.ts scopeOf), read again when the view opens
function useScope(group: string) {
  useManagers();
  useEffect(() => { void loadScope(group); }, [group]);
  return scopeOf(group);
}
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
          {act.kind === 'push' && <><button className="btn primary" onClick={() => void api.decidePush(act.pushId, true, '', { from: 'manager-board', target: 'approve' }).then(() => loadBoards(), fail)}>Approve</button><DenyButton card={r.waitingOn?.card} run={() => api.decidePush(act.pushId, false, '', { from: 'manager-board', target: 'deny' }).then(() => loadBoards(), fail)} /></>}
          {act.kind === 'decide' && <><button className="btn primary" onClick={() => void api.decide(act.id, true, { from: 'manager-board', target: 'approve' }).then(() => loadBoards(), fail)}>Approve</button><DenyButton card={act.id} run={() => api.decide(act.id, false, { from: 'manager-board', target: 'deny' }).then(() => loadBoards(), fail)} /></>}
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

// Who manages the group, its preset, what the preset allows and the group manager rule (tasks 242 and 273), in the group menu.
// It reads and changes the same manager scope as the manager item of a task menu (ManagerRoleButton).
export function ManagerScope({ group, tasks }: { group: string; tasks: TaskRef[] }) {
  const scope = useScope(group);
  const [error, setError] = useState('');
  const change = (body: { task: string | null; preset?: PresetKey }) => { setError(''); setManager(group, body).catch(e => setError(String((e as Error).message || e))); };
  if (!scope) return <div className="manager-scope sub">Loading the manager…</div>;
  const manager = scope.group.manager || '';
  const key = scope.preset || scope.defaultPreset;
  const preset = scope.presets?.[key];
  return <div className="manager-scope">
    <label style={{ color: 'var(--dim)', margin: '8px 0 2px' }}>◆ Manager <select value={manager} onChange={e => change({ task: e.target.value || null })}>
      <option value="">None</option>{tasks.filter(t => scope.group.tasks.includes(t.id)).map(t => <option key={t.id} value={t.id}>#{t.num} {t.title}</option>)}
    </select></label>
    {preset && <>
      <label style={{ color: 'var(--dim)' }}>Preset <select value={key} disabled={!manager} title={manager ? 'What the manager may do without a card' : 'Choose a manager first. A new manager gets this default preset.'}
        onChange={e => change({ task: manager, preset: e.target.value as PresetKey })}>
        {Object.entries(scope.presets).map(([k, p]) => <option key={k} value={k}>{p.name}{k === scope.defaultPreset ? ' (default)' : ''}</option>)}
      </select></label>
      <PresetText scope={scope} preset={key} />
    </>}
    {error && <div className="sel-warn">{error}</div>}
    <div className="sub">Limits: {Object.entries(scope.caps).map(([key, value]) => `${key} ${value}`).join(' · ')}</div>
  </div>;
}

// What a preset allows, with the group manager rule. The group menu and the confirm panel of a task menu show the same text.
function PresetText({ scope, preset, who = 'the manager', rule = true }: { scope: Scope; preset: PresetKey; who?: string; rule?: boolean }) {
  const p = scope.presets[preset];
  if (!p) return null;
  return <div className="sub manager-preset" aria-label="What the preset allows">
    <b>Without a card, {who} may:</b>
    <ul>{p.may.map(x => <li key={x}>{x}</li>)}</ul>
    {p.not.length > 0 && <><b>Only with your card:</b><ul>{p.not.map(x => <li key={x}>{x}</li>)}</ul></>}
    {rule ? <><b>Never:</b><ul>{scope.never.map(x => <li key={x}>{x}</li>)}</ul><div>{scope.rule} {scope.ruleLimits}</div></>
      : <div><b>Never:</b> {scope.never.map(x => x + '.').join(' ')}</div>}
  </div>;
}

// The manager item of a task menu (task 276): a ◆ button in a canvas window header, an item of the ⋯ menu of a narrow
// window, and a button of the task panel. All three open ManagerRoleView. The controller gets no item.
export function ManagerRoleButton({ t, variant, toast }: { t: RoleTask; variant: 'head' | 'menu' | 'button'; toast: (text: string) => void }) {
  useManagers();
  const groups = useStoreValue(s => s.groups);
  const tasks = useStoreValue(s => s.tasks);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menu = managerMenu(t, groups, tasks);
  if (menu.hidden) return null;
  const manages = menu.choices.some(c => c.kind === 'stop');
  const off = !menu.choices.some(c => !c.disabled);
  const title = menu.hint || (off ? menu.choices.find(c => c.disabled)?.disabled : undefined) || `${menu.label}: the group manager role of #${t.num}`;
  const panel = <ManagerRole t={t} menu={menu} close={() => setOpen(false)} toast={toast} />;
  // In the ⋯ menu of a narrow window the entries are items of that menu, and the confirm panel opens in their place.
  // Canvas.tsx closes that menu when the toast comes, so close() has nothing to do here.
  if (variant === 'menu') return <div className="mgr-role inline"><ManagerRole t={t} menu={menu} close={() => {}} toast={toast} listFirst /></div>;
  return <>
    <button ref={btn} className={variant === 'head' ? `b mgr-btn ${manages ? 'on' : ''} ${off ? 'off' : ''}` : `btn ${off ? 'off' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={menu.label} title={title} onPointerDown={e => e.stopPropagation()} onClick={() => setOpen(o => !o)}>{variant === 'head' ? '◆' : `◆ ${menu.label}`}</button>
    {open && <PopMenu anchor={btn.current} close={() => setOpen(false)} className="mgr-role" align={variant === 'button' ? 'left' : 'right'} label={`Manager role of #${t.num}`}>{panel}</PopMenu>}
  </>;
}

// The state of one open manager item: the chosen entry, the preset, the server call and its toast
function ManagerRole({ t, menu, close, toast, listFirst }: { t: RoleTask; menu: Exclude<ManagerMenu, { hidden: true }>; close: () => void; toast: (text: string) => void; listFirst?: boolean }) {
  const only = !listFirst && menu.choices.length === 1 && !menu.choices[0].disabled ? menu.choices[0] : null;
  const [step, setStep] = useState<ManagerChoice | null>(only);
  const [picked, setPicked] = useState<PresetKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const group = step?.group.id || menu.choices[0]?.group.id || '';
  useManagers();
  useEffect(() => { if (group) void loadScope(group); }, [group]);
  const scope = group ? scopeOf(group) : undefined;
  const preset = picked || (step?.kind === 'preset' ? scope?.preset : scope?.defaultPreset) || 'direct';
  const confirm = async () => {
    if (!step) return;
    setBusy(true); setError('');
    try {
      await setManager(step.group.id, step.kind === 'stop' ? { task: null } : { task: t.id, preset });
      toast(doneText(t, step, scope?.presets[preset]?.name || preset));
      close();
    } catch (e) { setError(String((e as Error).message || e)); setBusy(false); }
  };
  return <ManagerRoleView t={t} menu={menu} step={step} scope={scope} preset={preset} busy={busy} error={error}
    pick={c => { setStep(c); setPicked(null); setError(''); }} setPreset={setPicked} confirm={() => void confirm()} cancel={() => { if (step && !only) { setStep(null); setError(''); } else close(); }} />;
}

export function doneText(t: TaskRef, c: ManagerChoice, presetName: string) {
  if (c.kind === 'stop') return `#${t.num} no longer manages ${c.group.name}.`;
  if (c.kind === 'preset') return `#${t.num} manages ${c.group.name} with the preset ${presetName} now.`;
  if (c.kind === 'replace') return `#${t.num} now manages ${c.group.name} in place of ${c.current?.num ? `#${c.current.num}` : c.current?.id}, with the preset ${presetName}.`;
  return `#${t.num} now manages ${c.group.name} with the preset ${presetName}.`;
}

// The list of entries, or the confirm panel of one entry. It has no hooks, so the tests call it with each state.
// Keys: PopMenu moves the focus with Up and Down and closes on Escape. The buttons are native buttons, so Enter and
// Space click them. The confirm panel puts the focus on the Preset drop-down, or on Cancel when it removes the role.
export interface RoleViewProps {
  t: TaskRef; menu: Exclude<ManagerMenu, { hidden: true }>; step: ManagerChoice | null; scope?: Scope; preset: PresetKey; busy: boolean; error: string;
  pick: (c: ManagerChoice) => void; setPreset: (p: PresetKey) => void; confirm: () => void; cancel: () => void;
}
export function ManagerRoleView({ t, menu, step, scope, preset, busy, error, pick, setPreset, confirm, cancel }: RoleViewProps) {
  if (!step) return <div className="mgr-list">
    {menu.hint && <>
      <button className="mi off" aria-disabled="true" title={menu.hint}><span className="mi-ico">◆</span>Make manager</button>
      <div className="mgr-hint">{menu.hint}</div>
    </>}
    {menu.choices.map(c => <div key={c.kind + c.group.id}>
      <button className={`mi ${c.disabled ? 'off' : ''}`} aria-disabled={c.disabled ? 'true' : undefined} title={c.disabled || c.label}
        onClick={() => { if (!c.disabled) pick(c); }}><span className="mi-ico">◆</span>{c.label}</button>
      {c.disabled && <div className="mgr-hint">{c.disabled}</div>}
    </div>)}
  </div>;
  const g = step.group.name;
  const cur = step.current?.num ? `#${step.current.num}` : step.current?.id;
  const head = step.kind === 'stop' ? `Stop managing ${g}?` : step.kind === 'preset' ? `Change the preset of #${t.num} in ${g}`
    : step.kind === 'replace' ? `Replace ${cur} as manager of ${g}?` : `Make #${t.num} manager of ${g}?`;
  const action = step.kind === 'stop' ? 'Stop managing' : step.kind === 'preset' ? 'Change preset' : step.kind === 'replace' ? 'Replace manager' : 'Make manager';
  const same = step.kind === 'preset' && scope?.preset === preset;
  const needsScope = step.kind !== 'stop';
  return <div className="mgr-confirm" role="dialog" aria-label={head}>
    <b className="mgr-head">◆ {head}</b>
    {step.kind === 'stop' && <div>The tasks of {g} no longer message #{t.num} without a card. Their messages get a card again. #{t.num} keeps running.</div>}
    {step.kind === 'replace' && <div>{cur}{step.current?.title ? ` (${step.current.title})` : ''} stops managing {g}. #{t.num} takes the role. A group has one manager.</div>}
    {needsScope && !scope && <div className="sub">Loading the presets…</div>}
    {needsScope && scope && <>
      <label className="mgr-preset">Preset <select autoFocus value={preset} onChange={e => setPreset(e.target.value as PresetKey)}>
        {Object.entries(scope.presets).map(([k, p]) => <option key={k} value={k}>{p.name}{k === scope.defaultPreset ? ' (default)' : ''}</option>)}
      </select></label>
      <PresetText scope={scope} preset={preset} who={`#${t.num}`} rule={false} />
    </>}
    {error && <div className="sel-warn" role="alert">{error}</div>}
    <div className="row">
      <button className="btn" autoFocus={step.kind === 'stop'} disabled={busy} onClick={cancel}>Cancel</button>
      <button className={`btn ${step.kind === 'stop' ? 'danger' : 'primary'}`} disabled={busy || same || (needsScope && !scope)} onClick={confirm}>{busy ? 'Saving…' : action}</button>
    </div>
  </div>;
}

// Deny in a "Need you" row: a card that appeared less than NEW_CARD_MS ago needs a second click (clickGuard.ts)
function DenyButton({ card, run }: { card?: string; run: () => Promise<unknown> }) {
  const { approvals } = useStore();
  const [ask, setAsk] = useState(false);
  useEffect(() => { if (!ask) return; const t = setTimeout(() => setAsk(false), CONFIRM_MS); return () => clearTimeout(t); }, [ask]);
  const a = approvals.find(x => x.id === card);
  return <button className={`btn${ask ? ' confirm' : ''}`} onClick={() => { if (!ask && a && needsConfirm(cardTime(a))) { setAsk(true); return; } setAsk(false); void run(); }}>{ask ? 'Confirm deny' : 'Deny'}</button>;
}
