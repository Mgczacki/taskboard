// Links between tasks in the interface: the ports on a Canvas window, the card that explains the links, the markers in
// lists, the Links section of the task panel and the linked work overview. Rules: server/links.ts. Helpers: links.ts.
import { useEffect, useRef, useState } from 'react';
import type { LinkKind, LinkSet, LinkSets, LinkSuggestion, Task } from '../api';
import { STATUS_LABEL, api } from '../api';
import { isReplaced, linkRows, recentlyReady, sections, showLinkedWork } from '../links';
import '../links.css';

type Go = (id: string) => void;
const find = (tasks: Task[], id: string) => tasks.find(t => t.id === id);
const when = (iso?: string) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const who = (by: { actor: string; task?: string }, tasks: Task[]) => by.actor === 'task' ? `#${find(tasks, by.task || '')?.num ?? '?'}` : by.actor === 'user' ? 'You' : by.actor === 'controller' ? 'Controller' : 'Taskboard';
const err = (e: unknown) => e instanceof Error ? e.message : String(e);

// A task number that goes to the task: the host decides (the Canvas moves to the window, other views open the panel).
export function TaskNum({ id, tasks, onGo }: { id: string; tasks: Task[]; onGo: Go }) {
  const t = find(tasks, id);
  return <a href="#" className="lk-num" title={t ? `#${t.num} ${t.title} (${STATUS_LABEL[t.status]})` : id} onClick={e => { e.preventDefault(); e.stopPropagation(); onGo(id); }}>#{t?.num ?? '?'}</a>;
}

// Suggestions from data Taskboard already has (server: GET /api/links/suggestions). One copy for the page, read again
// at most once a minute and after a confirm or dismiss.
let sugCache: { at: number; list: LinkSuggestion[]; wait?: Promise<LinkSuggestion[]> } = { at: 0, list: [] };
const sugListeners = new Set<() => void>();
function loadSuggestions(force = false) {
  if (!force && (sugCache.wait || Date.now() - sugCache.at < 60000)) return;
  sugCache.wait = api.linkSuggestions().then(list => { sugCache = { at: Date.now(), list }; sugListeners.forEach(f => f()); return list; }).catch(() => { sugCache.wait = undefined; return sugCache.list; });
}
export function useSuggestions(id: string) {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick(x => x + 1); sugListeners.add(f); loadSuggestions(); return () => { sugListeners.delete(f); }; }, []);
  return sugCache.list.filter(s => s.from === id || s.to === id);
}

const KIND_TEXT: Record<LinkKind, string> = { dependsOn: 'depends on', replaces: 'replaces', followUpOf: 'is a follow-up of', relatedTo: 'is related to' };

// Every link of a task in both directions, grouped as "Blocked by", "Waited on by" and so on. compact: the hover card.
export function LinkList({ t, tasks, onGo, toast, compact }: { t: Task; tasks: Task[]; onGo: Go; toast?: (s: string) => void; compact?: boolean }) {
  const rows = linkRows(t, tasks);
  const sugs = useSuggestions(t.id);
  const [busy, setBusy] = useState(false);
  const act = async (p: Promise<unknown>, done?: string) => { setBusy(true); try { await p; if (done) toast?.(done); loadSuggestions(true); } catch (e) { toast?.(err(e)); } finally { setBusy(false); } };
  const local = !t.machine;
  return <div className={`lk-list ${compact ? 'compact' : ''}`}>
    {!rows.length && !sugs.length && <div className="lk-none">No links.</div>}
    {sections(rows).map(([label, list]) => <div key={label} className="lk-sec">
      <div className="lk-h">{label}</div>
      {list.map(r => { const o = find(tasks, r.other); return <div key={r.link.id + r.dir} className={`lk-row ${r.open ? 'open' : ''}`}>
        <span className={`dot ${o?.status || 'archived'}`} />
        <div className="lk-main">
          <div><TaskNum id={r.other} tasks={tasks} onGo={onGo} /> <span className={o && isReplaced(o) ? 'lk-strike' : ''}>{o?.title || 'Removed task'}</span>{o && <span className="lk-st">{STATUS_LABEL[o.status]}</span>}{r.link.folded && <span className="lk-st">folded</span>}
            {r.dir === 'out' && r.link.kind === 'dependsOn' && r.other !== r.link.to && <span className="lk-st">replaces #{find(tasks, r.link.to)?.num}</span>}
            {r.movedFrom && <span className="lk-st">was on #{find(tasks, r.movedFrom)?.num}</span>}</div>
          <div className="lk-note">{r.link.note && <>“{r.link.note}” · </>}{who(r.link.by, tasks)}, {when(r.link.at)}{r.link.doneAt && <> · marked done by {who(r.link.doneBy || { actor: 'user' }, tasks)}{r.link.doneNote ? `: ${r.link.doneNote}` : ''}</>}</div>
        </div>
        {local && !compact && <span className="lk-acts">
          {r.open && <button className="btn ghost" disabled={busy} onClick={() => act(api.linkDone(r.owner, r.link.id), 'Marked done.')} title="The other task is not archived, but this task no longer waits for it">Mark done</button>}
          <button className="btn ghost" disabled={busy} onClick={() => act(api.removeLink(r.owner, r.link.id), 'Link removed.')} title="Remove this link. A parked task stays parked.">Remove</button>
        </span>}
      </div>; })}
    </div>)}
    {local && sugs.length > 0 && <div className="lk-sec">
      <div className="lk-h">Suggested</div>
      {sugs.map(s => <div key={s.from + s.to + s.kind} className="lk-row sug">
        <span className="dot idle" />
        <div className="lk-main"><div><TaskNum id={s.from} tasks={tasks} onGo={onGo} /> {KIND_TEXT[s.kind]} <TaskNum id={s.to} tasks={tasks} onGo={onGo} />?</div><div className="lk-note">{s.reason}</div></div>
        <span className="lk-acts"><button className="btn ghost" disabled={busy} onClick={() => act(api.addLink(s.from, { kind: s.kind, to: s.to }), 'Link added.')}>Confirm</button><button className="btn ghost" disabled={busy} onClick={() => act(api.dismissSuggestion(s))}>Dismiss</button></span>
      </div>)}
    </div>}
  </div>;
}

// The form that adds a link from this task to another one.
export function AddLink({ t, tasks, toast, close }: { t: Task; tasks: Task[]; toast: (s: string) => void; close: () => void }) {
  const [kind, setKind] = useState<LinkKind>('dependsOn');
  const [to, setTo] = useState(''); const [note, setNote] = useState(''); const [folded, setFolded] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = tasks.find(x => x.role !== 'controller' && !x.machine && (String(x.num) === to.replace(/^#/, '').trim()));
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try { await api.addLink(t.id, { kind, to: target.id, note: note || undefined, folded: kind === 'replaces' && folded }); toast(kind === 'replaces' && !['parked', 'archived'].includes(target.status) ? `Link added. #${target.num} is parked.` : 'Link added.'); close(); }
    catch (e) { toast(err(e)); } finally { setBusy(false); }
  };
  return <div className="lk-add" onKeyDown={e => { if (e.key === 'Escape') close(); }}>
    <span>#{t.num}</span>
    <select value={kind} onChange={e => setKind(e.target.value as LinkKind)} aria-label="Link type">
      <option value="dependsOn">depends on</option><option value="replaces">replaces</option><option value="followUpOf">is a follow-up of</option><option value="relatedTo">is related to</option>
    </select>
    <input autoFocus value={to} onChange={e => setTo(e.target.value)} placeholder="task number" aria-label="Task number" size={8} onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
    {target ? <span className="lk-target">{target.title}</span> : to && <span className="lk-target bad">No task #{to.replace(/^#/, '')}</span>}
    <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (optional)" aria-label="Note" className="lk-noteinput" onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
    {kind === 'replaces' && <label title="The work of the other task went into this task"><input type="checkbox" checked={folded} onChange={e => setFolded(e.target.checked)} /> folded</label>}
    <button className="btn primary" disabled={!target || busy} onClick={() => void submit()}>Add</button>
    <button className="btn ghost" onClick={close}>Cancel</button>
    {kind === 'replaces' && <span className="lk-warn">Taskboard parks the replaced task.</span>}
  </div>;
}

// The state of a task's links as a short badge.
export function LinkState({ t, tasks }: { t: Task; tasks: Task[] }) {
  const l = t.link; if (!l) return null;
  if (l.state === 'superseded') return <span className="lk-badge super">Replaced by #{find(tasks, l.replacedBy || '')?.num ?? '?'}</span>;
  if (l.state === 'blocked') return <span className="lk-badge blocked">Blocked by {(l.blockedBy || []).map(id => '#' + (find(tasks, id)?.num ?? '?')).join(' ')}</span>;
  if (l.state === 'ready' && recentlyReady(t, tasks)) return <span className="lk-badge ready">Ready</span>;
  if (l.waitedOnBy?.length) return <span className="lk-badge waited">{l.waitedOnBy.length} waiting on this</span>;
  return null;
}

// A small marker for lists: blocked, replaced or recently ready.
export function LinkMarker({ t, tasks }: { t: Task; tasks: Task[] }) {
  const l = t.link; if (!l) return null;
  if (l.state === 'blocked') return <span className="lk-mk blocked" title={`Blocked by ${(l.blockedBy || []).map(id => '#' + (find(tasks, id)?.num ?? '?')).join(' ')}`}>⊘</span>;
  if (l.state === 'superseded') return <span className="lk-mk super" title={`Replaced by #${find(tasks, l.replacedBy || '')?.num ?? '?'}`}>⤳</span>;
  if (l.state === 'ready' && recentlyReady(t, tasks)) return <span className="lk-mk ready" title="Ready: no task blocks it now">✓</span>;
  return null;
}

// The Links section of the task panel.
export function LinksSection({ t, tasks, onGo, toast }: { t: Task; tasks: Task[]; onGo: Go; toast: (s: string) => void }) {
  const [adding, setAdding] = useState(false);
  const rows = linkRows(t, tasks), sugs = useSuggestions(t.id);
  const [open, setOpen] = useState(() => localStorage.getItem('tb-links-open') !== '0');
  if (t.machine || t.role === 'controller') return null;
  const toggle = () => { setOpen(o => { try { localStorage.setItem('tb-links-open', o ? '0' : '1'); } catch { /* storage off */ } return !o; }); };
  return <div className="dr-links">
    <div className="lk-head">
      <button className="lk-fold" onClick={toggle} aria-expanded={open}>{open ? '▾' : '▸'} Links</button>
      <span className="lk-count">{rows.length}{sugs.length ? ` · ${sugs.length} suggested` : ''}</span>
      <LinkState t={t} tasks={tasks} />
      <span className="sp" />
      <button className="btn ghost" onClick={() => showLinkedWork({ task: t.id })} title="The state of every task linked to this one">Show linked work</button>
      <button className="btn ghost" onClick={() => { setAdding(a => !a); setOpen(true); }}>＋ Add link</button>
    </div>
    {open && <>{adding && <AddLink t={t} tasks={tasks} toast={toast} close={() => setAdding(false)} />}<LinkList t={t} tasks={tasks} onGo={onGo} toast={toast} /></>}
  </div>;
}

// The two ports on the title bar of a Canvas window. Left: what the task waits for (or "⤳ #n" when another task
// replaced it). Right: how many tasks wait for it. The pointer on a port opens the card with every link of the task.
export function LinkPorts({ t, tasks, onGo, side }: { t: Task; tasks: Task[]; onGo: Go; side: 'left' | 'right' }) {
  // the card is fixed to the screen (a window clips its content), below the port and inside the screen
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const port = useRef<HTMLSpanElement>(null);
  const l = t.link;
  if (!l || t.machine) return null;
  const num = (id?: string) => '#' + (find(tasks, id || '')?.num ?? '?');
  let cls = 'empty', text = '·', title = '';
  if (side === 'left') {
    if (l.state === 'superseded') { cls = 'rep'; text = `⤳${num(l.replacedBy).slice(1)}`; title = `Replaced by ${num(l.replacedBy)}`; }
    else if (l.state === 'blocked') { const b = l.blockedBy || []; cls = 'blocked'; text = num(b[0]).slice(1) + (b.length > 1 ? ` +${b.length - 1}` : ''); title = `Blocked by ${b.map(num).join(' ')}`; }
    else if (l.state === 'ready' && recentlyReady(t, tasks)) { cls = 'ready'; text = '✓'; title = 'Ready: no task blocks it now'; }
    else title = 'No task blocks this task';
  } else {
    const w = l.waitedOnBy || [];
    if (w.length) { cls = 'out'; text = String(w.length); title = `${w.length} task${w.length === 1 ? '' : 's'} wait${w.length === 1 ? 's' : ''} on this: ${w.map(num).join(' ')}`; }
    else title = 'No task waits on this task';
  }
  const enter = () => {
    window.clearTimeout(timer.current);
    const r = port.current?.getBoundingClientRect(); if (!r) return;
    const w = Math.min(360, innerWidth - 16);
    setOpen(o => o || { top: Math.min(r.bottom + 4, innerHeight - 120), left: Math.max(8, Math.min(side === 'left' ? r.left - 4 : r.right - w + 4, innerWidth - w - 8)) });
  };
  const leave = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(null), 200); };
  return <span className={`lk-pw ${side}`} onPointerDown={e => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
    <span ref={port} className={`lk-port ${cls}`} aria-label={title} title={open ? undefined : title} tabIndex={0} onFocus={enter} onBlur={leave}>{text}</span>
    {open && <div className="lk-card" role="dialog" aria-label={`Links of #${t.num}`} style={{ top: open.top, left: open.left, maxHeight: innerHeight - open.top - 12 }}>
      <div className="lk-card-h">#{t.num} {t.title}</div>
      <div className="lk-card-sub">{title}</div>
      <LinkList t={t} tasks={tasks} onGo={id => { setOpen(null); onGo(id); }} compact />
      <div className="lk-card-f">A click on a number goes to its window, or opens its task panel. <a href="#" onClick={e => { e.preventDefault(); setOpen(null); showLinkedWork({ task: t.id }); }}>Show linked work</a></div>
    </div>}
  </span>;
}

// The linked work overview: for a task, its linked set; for a group, every linked set that holds a task of the group.
export function LinkedWork({ q, tasks, close, onGo }: { q: { task?: string; group?: string }; tasks: Task[]; close: () => void; onGo: Go }) {
  const [data, setData] = useState<LinkSets | null>(null);
  const [error, setError] = useState('');
  const version = tasks.map(t => t.updated).join();
  useEffect(() => { api.linkSets(q).then(setData, e => setError(err(e))); }, [q.task, q.group, version]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [close]);
  const start = q.task ? find(tasks, q.task) : undefined;
  const sum = (k: keyof LinkSet['counts']) => (data?.sets || []).reduce((n, s) => n + s.counts[k], 0);
  const sentence = data ? [
    sum('waitsForYou') && `${sum('waitsForYou')} wait${sum('waitsForYou') === 1 ? 's' : ''} for you`,
    sum('blocked') && `${sum('blocked')} ${sum('blocked') === 1 ? 'is' : 'are'} blocked by another task`,
    sum('working') && `${sum('working')} working`,
    sum('replaced') && `${sum('replaced')} replaced or folded`,
  ].filter(Boolean).join('. ') : '';
  return <div className="lw-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="lw-box" role="dialog" aria-label="Linked work">
      <div className="lw-head"><h2>Linked work {start ? `of #${start.num}` : data?.group ? `from ${data.group.name}` : ''}</h2>
        {data && <span className="sub">{data.sets.length} linked set{data.sets.length === 1 ? '' : 's'}{data.unlinked ? ` · ${data.unlinked} task${data.unlinked === 1 ? '' : 's'} of the group without links` : ''}</span>}
        <span className="sp" /><button className="btn ghost icon" onClick={close} aria-label="Close">✕</button></div>
      {error && <div className="banner stopped">{error}</div>}
      {!data && !error && <div className="lw-empty">Loading…</div>}
      {data && <div className="lw-body">
        {sentence && <p className="lw-state">{sentence}.</p>}
        {!data.sets.length && <div className="lw-empty">No task here has links. Add links with tb dep add or in the task panel.</div>}
        {data.sets.map((s, i) => <LinkSetView key={i} s={s} tasks={tasks} onGo={id => { close(); onGo(id); }} />)}
      </div>}
    </div>
  </div>;
}

function LinkSetView({ s, tasks, onGo }: { s: LinkSet; tasks: Task[]; onGo: Go }) {
  const c = s.counts;
  const tiles: [number, string, string][] = [[c.waitsForYou, 'Wait for you', 'needs'], [c.blocked, 'Blocked', 'blocked'], [c.working, 'Working', 'working'], [c.other, 'Idle or other', 'idle'], [c.replaced, 'Replaced or folded', 'super'], [c.archived, 'Archived', 'archived']];
  const brief = (id: string) => s.tasks.find(t => t.id === id);
  return <section className="lw-set">
    <h3>Linked set: {s.tasks.map(t => <TaskNum key={t.id} id={t.id} tasks={tasks} onGo={onGo} />).reduce<React.ReactNode[]>((a, x, i) => i ? [...a, ' ', x] : [x], [])}</h3>
    <div className="lw-tiles">{tiles.filter(([n]) => n).map(([n, k, cls]) => <div key={k} className={`lw-tile ${cls}`}><b>{n}</b><span>{k}</span></div>)}</div>
    {s.chain.length > 0 && <div className="lw-chain"><div className="lk-h">Longest chain of open work</div>
      <div className="lw-steps">{s.chain.map((id, i) => { const t = brief(id); return <span key={id} className="lw-stepwrap">{i > 0 && <span className="lw-arrow">→</span>}
        <span className={`lw-step ${t?.state === 'blocked' ? 'blocked' : ''}`}><span className={`dot ${t?.status}`} /> <TaskNum id={id} tasks={tasks} onGo={onGo} /> {t?.title}<span className="lk-st">{t ? STATUS_LABEL[t.status] : ''}</span></span></span>; })}</div></div>}
    {s.waiting.length > 0 && <div className="lw-part"><div className="lk-h">Waits for you</div>
      {s.waiting.map(w => <div key={w.id} className="lw-item"><span className={`dot ${w.status}`} /><TaskNum id={w.id} tasks={tasks} onGo={onGo} /> <span>{w.ask || w.title}</span>
        {w.blockedBy.length > 0 ? <span className="lk-badge blocked">still blocked by {w.blockedBy.map(id => '#' + (brief(id)?.num ?? '?')).join(' ')}</span> : <span className="lw-note">Nothing else blocks it.</span>}</div>)}</div>}
    {s.replaced.length > 0 && <div className="lw-part"><div className="lk-h">Replaced or folded</div>
      {s.replaced.map(r => <div key={r.id} className="lw-item"><span className={`dot ${r.status}`} /><TaskNum id={r.id} tasks={tasks} onGo={onGo} /> <span className="lk-strike">{r.title}</span><span className="lk-st">{STATUS_LABEL[r.status]}</span><span className="lw-note">by <TaskNum id={r.by} tasks={tasks} onGo={onGo} />{r.status !== 'archived' ? '. Only you archive it.' : ''}</span></div>)}</div>}
  </section>;
}
