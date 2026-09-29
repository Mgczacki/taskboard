// Canvas: live terminals for one view at a time. A view is a group (tab), a status-based set, or a hand-picked
// list of tasks (a separate window). Layouts: Columns (full-height terminals in one row that scrolls sideways),
// Grid, Rows. Every command is ⌃⌥ + key so typing into agents is not affected.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, Task } from '../api';
import { ATTN, STATUS_LABEL, api } from '../api';
import { AgentChip, Dot, MachineChip, WhereChip } from './ui';
import { Terminal } from './Terminal';
import { AskPanel } from './Ask';

type Layout = 'columns' | 'grid' | 'rows';
const MINW = 640;
const GCOLORS = ['#e3b341', '#58a6ff', '#3fb950', '#db61a2', '#a371f7', '#f78166', '#2dd4bf', '#8b949e'];

// view ids: g:<group id> · needs · live · t:<id,id,...>
export function viewName(view: string, groups: Group[], tasks: Task[]) {
  if (view.startsWith('g:')) return groups.find(g => g.id === view.slice(2))?.name || 'Group';
  if (view === 'needs') return 'Needs you + unread';
  if (view === 'live') return 'All live tasks';
  return view.slice(2).split(',').map(id => '#' + (tasks.find(t => t.id === id)?.num ?? '?')).join(' ');
}
export function openInWindow(view: string) {
  window.open(`/?solo=1#canvas:${encodeURIComponent(view)}`, 'tb-' + view.slice(0, 60), 'popup,width=1500,height=950');
}

interface Props {
  tasks: Task[]; groups: Group[]; view: string; setView: (v: string) => void; openPanel: (id: string | null) => void;
  panelTaskId?: string | null; // the task whose panel is open (its tile then does not attach a second terminal)
  selected: Set<string>; toggleSel: (id: string) => void; clearSel: () => void; solo: boolean;
  focusMode: boolean; setFocusMode: (f: boolean) => void; toast: (s: string, action?: { label: string; fn: () => void }) => void;
}

export function Canvas({ tasks, groups, view, setView, openPanel, panelTaskId, selected, toggleSel, clearSel, solo, focusMode, setFocusMode, toast }: Props) {
  const lk = (k: string) => `tb-cv-${view}-${k}`;
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(lk('layout')) as Layout) || 'columns');
  const [visible, setVisible] = useState<number | 'auto'>(() => { const v = localStorage.getItem(lk('visible')); return v && v !== 'auto' ? Number(v) : 'auto'; });
  const [focused, setFocused] = useState<string | null>(null);
  const [maxId, setMaxId] = useState<string | null>(null);
  const [font, setFont] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<null | 'add' | 'new' | { group: string }>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);     // status-based views do not move windows on their own
  const [extra, setExtra] = useState<string[]>([]);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [asking, setAsking] = useState<Set<string>>(new Set()); // tiles with the Ask panel open
  const toggleAsk = (id: string) => setAsking(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stage = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1200);

  useEffect(() => { setLayout((localStorage.getItem(lk('layout')) as Layout) || 'columns'); const v = localStorage.getItem(lk('visible')); setVisible(v && v !== 'auto' ? Number(v) : 'auto'); setFrozen(null); setExtra([]); setMaxId(null); setFocused(null); }, [view]);
  useEffect(() => { localStorage.setItem(lk('layout'), layout); localStorage.setItem(lk('visible'), String(visible)); }, [layout, visible, view]);
  useEffect(() => { const ro = new ResizeObserver(() => setW(stage.current?.clientWidth || 1200)); if (stage.current) ro.observe(stage.current); return () => ro.disconnect(); }, []);

  // windows are for running agents: archived and suspended tasks are left out (suspended ones: see the Resume button)
  const live = (t?: Task) => !!t && t.status !== 'archived' && t.status !== 'suspended';
  const liveSet = useCallback(() => view === 'needs' ? tasks.filter(t => ATTN.includes(t.status) || t.status === 'unread').map(t => t.id) : tasks.filter(t => live(t) && t.status !== 'parked').map(t => t.id), [tasks, view]);
  useEffect(() => { if ((view === 'needs' || view === 'live') && !frozen && tasks.length) setFrozen(liveSet()); }, [view, frozen, tasks.length, liveSet]);
  const group = view.startsWith('g:') ? groups.find(g => g.id === view.slice(2)) : undefined;
  const ids = useMemo(() => {
    let base: string[] = view.startsWith('g:') ? (group?.tasks || []) : view.startsWith('t:') ? view.slice(2).split(',') : (frozen || []);
    base = [...base, ...extra.filter(x => !base.includes(x))];
    return base.filter(id => live(tasks.find(t => t.id === id)));
  }, [view, group, frozen, extra, tasks]);
  const suspendedHere = (view.startsWith('g:') ? (group?.tasks || []) : view.startsWith('t:') ? view.slice(2).split(',') : []).map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && t.status === 'suspended');
  const newInSmart = (view === 'needs' || view === 'live') && frozen ? liveSet().filter(x => !frozen.includes(x)).length : 0;

  const wins = ids.map(id => tasks.find(t => t.id === id)!).filter(Boolean);
  const shown = maxId ? wins.filter(t => t.id === maxId) : wins;
  const fit = Math.max(1, Math.floor((W - 8) / (MINW + 8)));
  const vis = layout !== 'columns' ? shown.length : visible === 'auto' ? Math.min(shown.length, fit) : Math.min(shown.length, visible);
  const gridCols = Math.max(1, Math.min(shown.length || 1, Math.round(Math.sqrt(shown.length * (W / 900)))));
  const style: React.CSSProperties = maxId ? { gridTemplateColumns: '1fr' }
    : layout === 'columns' ? { gridAutoFlow: 'column', gridAutoColumns: `calc((100% - ${(Math.max(1, vis) - 1) * 8}px) / ${Math.max(1, vis)})`, overflowX: 'auto' }
    : layout === 'grid' ? { gridTemplateColumns: `repeat(${gridCols}, 1fr)` }
    : { gridTemplateRows: `repeat(${shown.length || 1}, minmax(160px, 1fr))`, overflowY: 'auto' };

  const addToView = (id: string) => { if (group) api.updateGroup(group.id, { add: id }); else setExtra(e => [...e, id]); };
  const removeFromView = (id: string) => {
    if (group) { api.updateGroup(group.id, { remove: id }); toast(`Removed from ${group.name}. The agent keeps running.`); }
    else if (view.startsWith('t:')) setView('t:' + view.slice(2).split(',').filter(x => x !== id).join(','));
    else { setFrozen(f => (f || []).filter(x => x !== id)); setExtra(e => e.filter(x => x !== id)); }
  };

  const focus = useCallback((id: string) => {
    setFocused(id);
    const el = stage.current?.querySelector(`[data-win="${id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    setTimeout(() => (el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.focus(), 30);
  }, []);

  const tabs = [...groups.map(g => 'g:' + g.id), 'needs', 'live'];
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focusMode && !(e.target as HTMLElement)?.closest?.('.xterm')) { setFocusMode(false); return; }
      if (!(e.ctrlKey && e.altKey)) return;
      const i = wins.findIndex(t => t.id === focused);
      const move = (d: number) => { const n = wins[(Math.max(0, i) + d + wins.length) % wins.length]; if (n) { if (maxId) setMaxId(n.id); focus(n.id); } };
      let hit = true;
      if (e.code === 'Enter') setMaxId(m => m ? null : focused);
      else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') move(1);
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') move(-1);
      else if (e.code === 'KeyL') setLayout(l => l === 'columns' ? 'grid' : l === 'grid' ? 'rows' : 'columns');
      else if (e.code === 'KeyF') setFocusMode(!focusMode);
      else if (e.code === 'KeyG' && e.shiftKey) setMenu('new');
      else if (e.code === 'KeyG' && !solo) setView(tabs[(tabs.indexOf(view) + 1) % tabs.length]);
      else if (e.code === 'KeyN') { const w = wins.filter(t => ATTN.includes(t.status)); if (w.length) focus(w[(w.findIndex(t => t.id === focused) + 1) % w.length].id); }
      else if (e.code === 'Period' || e.code === 'Comma') { if (focused) setFont(f => ({ ...f, [focused]: Math.max(10, Math.min(20, (f[focused] || 13) + (e.code === 'Period' ? 1 : -1))) })); }
      else if (e.code === 'KeyW') { if (focused) removeFromView(focused); }
      else if (/^Digit[1-9]$/.test(e.code)) { const t = wins[Number(e.code.slice(5)) - 1]; if (t) { if (maxId) setMaxId(t.id); focus(t.id); } }
      else hit = false;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', on, true);
    return () => removeEventListener('keydown', on, true);
  });

  // focus mode: the tabs and toolbar come back while the pointer is at the top edge
  useEffect(() => {
    if (!focusMode) { setReveal(false); return; }
    const on = (e: MouseEvent) => { if (e.clientY < 6) setReveal(true); else if (e.clientY > 110 && !menu) setReveal(false); };
    addEventListener('mousemove', on); return () => removeEventListener('mousemove', on);
  }, [focusMode, menu]);

  // drag a window header onto a tab to add that task to the group
  const startDrag = (e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.metaKey || e.shiftKey) { toggleSel(id); return; }
    const sx = e.clientX, sy = e.clientY; let moving = false, target: string | null = null;
    const ghost = document.createElement('div');
    const mv = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      if (!moving) { moving = true; ghost.className = 'drag-ghost'; ghost.textContent = '#' + (tasks.find(t => t.id === id)?.num ?? '') + ' → drop on a group tab'; document.body.appendChild(ghost); }
      ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 12 + 'px';
      const tab = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-gtab]') as HTMLElement | null;
      target = tab ? tab.dataset.gtab! : null; setDropTab(target);
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); ghost.remove(); setDropTab(null);
      if (moving && target) { const g = groups.find(x => x.id === target)!; if (g.tasks.includes(id)) toast(`Already in ${g.name}`); else { api.updateGroup(g.id, { add: id }); toast(`Added to ${g.name}`); } }
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };

  const off = tasks.filter(t => !ids.includes(t.id) && live(t));
  const focusedTask = tasks.find(t => t.id === focused);
  const waiting = (list: string[]) => list.filter(id => ATTN.includes(tasks.find(t => t.id === id)?.status as Task['status'])).length;

  return (
    <div className={`canvas ${focusMode ? 'focus-mode' : ''} ${reveal ? 'reveal' : ''}`}>
      {!solo && <div className="gtabs">
        {groups.map(g => { const l = g.tasks.filter(id => live(tasks.find(t => t.id === id))); const w = waiting(l); return (
          <div key={g.id} data-gtab={g.id} className={`gtab ${view === 'g:' + g.id ? 'on' : ''} ${dropTab === g.id ? 'drop' : ''}`} style={{ '--gc': g.color } as React.CSSProperties}
            onClick={e => { if (!(e.target as HTMLElement).closest('button,input')) setView('g:' + g.id); }} onDoubleClick={() => setMenu({ group: g.id })} title="Drop a window here to add it. Double-click for options.">
            <span className="gdot" /><span className="gname">{g.name}</span><span className="gn">{l.length}</span>{w > 0 && <span className="gw">● {w}</span>}
            <span className="gact"><button title="Open in its own window" onClick={() => openInWindow('g:' + g.id)}>↗</button><button title="Rename, colour, delete" onClick={() => setMenu({ group: g.id })}>⋯</button></span>
          </div>); })}
        <span className="gsep" />
        {(['needs', 'live'] as const).map(v => { const l = v === 'needs' ? tasks.filter(t => ATTN.includes(t.status) || t.status === 'unread') : tasks.filter(t => live(t) && t.status !== 'parked'); return (
          <div key={v} className={`gtab smart ${view === v ? 'on' : ''}`} onClick={() => setView(v)}><span className="gdot" /><span className="gname">{viewName(v, groups, tasks)}</span><span className="gn">{l.length}</span></div>); })}
        {view.startsWith('t:') && <div className="gtab on smart"><span className="gdot" /><span className="gname">{viewName(view, groups, tasks)}</span></div>}
        <div className="gtab newg" onClick={() => setMenu('new')} title="New group (⌃⌥⇧G)">＋ New group</div>
      </div>}
      <div className="ctool">
        {solo && <span className="solo-name">{viewName(view, groups, tasks)}</span>}
        {!solo && <button className="btn" onClick={() => openInWindow(view)} title="Open this view in its own browser window">↗ New window</button>}
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setMenu(m => m === 'add' ? null : 'add')}>＋ Add window</button>
          {menu === 'add' && <div className="menu" onMouseLeave={() => setMenu(null)}><div className="mh">{group ? `Add to “${group.name}”` : 'Show here'}</div>{off.length ? off.map(t => <div className="mi" key={t.id} onClick={() => { addToView(t.id); setMenu(null); setTimeout(() => focus(t.id), 80); }}><Dot s={t.status} />#{t.num} {t.title}</div>) : <div className="mi">Every live task is already here.</div>}</div>}
        </div>
        <div className="seg">{(['columns', 'grid', 'rows'] as Layout[]).map(l => <button key={l} className={layout === l ? 'on' : ''} onClick={() => setLayout(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}</div>
        {layout === 'columns' && <><span className="lbl">Visible</span><div className="seg">{(['auto', 2, 3, 4, 5] as const).map(v => <button key={v} className={visible === v ? 'on' : ''} onClick={() => setVisible(v)}>{v === 'auto' ? 'Auto' : v}</button>)}</div></>}
        {newInSmart > 0 && <button className="btn" onClick={() => { setFrozen(liveSet()); }} title="Windows never appear on their own while you work">{newInSmart} new · refresh</button>}
        <span className="sp" />
        <span className="lbl">{wins.length} windows{focusedTask ? ` · typing into #${focusedTask.num}` : ''}</span>
        {suspendedHere.length > 0 && <button className="btn" title={`Not running: ${suspendedHere.map(t => '#' + t.num + ' ' + t.title).join(', ')}. Resume starts their agents again and continues their conversations.`} onClick={() => suspendedHere.forEach(t => api.resume(t.id).catch(() => {}))}>{suspendedHere.length} suspended · Resume</button>}
        <button className="btn" onClick={() => setFocusMode(!focusMode)}>Focus mode <kbd>⌃⌥F</kbd></button>
      </div>
      {menu === 'new' && <NewGroupMenu tasks={tasks} onScreen={ids} selected={[...selected].filter(id => tasks.some(t => t.id === id))} close={() => setMenu(null)} done={g => { clearSel(); setMenu(null); setView('g:' + g.id); toast(`Group “${g.name}” created`); }} />}
      {menu && typeof menu === 'object' && <GroupMenu g={groups.find(x => x.id === menu.group)!} close={() => setMenu(null)} onDeleted={g => { if (view === 'g:' + g.id) setView('live'); toast(`Deleted “${g.name}”. Its tasks keep running.`, { label: 'Undo', fn: () => { api.restoreGroup(g); setView('g:' + g.id); } }); }} />}
      <div className="stage-grid" ref={stage} style={style}>
        {!wins.length && <div className="emptyview"><h2>{group ? `“${group.name}” is empty` : 'No windows'}</h2><p>Use <b>＋ Add window</b>, drag a window's header onto a tab, or <b>Show on canvas</b> in a task's panel.</p></div>}
        {shown.map((t, i) => (
          <div key={t.id} data-win={t.id} className={`win ${t.status} ${focused === t.id ? 'focus' : ''} ${selected.has(t.id) ? 'selected' : ''}`} onMouseDown={() => { setFocused(t.id); if (t.status === 'unread') api.seen(t.id); }}>
            <div className="wh" onPointerDown={e => startDrag(e, t.id)} onDoubleClick={() => setMaxId(m => m ? null : t.id)}>
              <span className="ix">{i + 1}</span><Dot s={t.status} /><span className="n">#{t.num}</span><span className="ti">{t.title}</span>
              <span className={`st st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} />
              {(t.status === 'suspended' || t.openElsewhere) && <button className="b" onClick={() => openPanel(t.id)}>{t.openElsewhere ? 'Options…' : 'Resume…'}</button>}
              <button className={`b ${asking.has(t.id) ? 'on' : ''}`} title="Ask a separate agent about this session. This agent does not see the question." onClick={() => toggleAsk(t.id)}>?</button>
              <button className="b" title="Maximize (⌃⌥↩)" onClick={() => setMaxId(m => m ? null : t.id)}>{maxId === t.id ? '⤡' : '⤢'}</button>
              <button className="b" title="Task panel" onClick={() => openPanel(t.id)}>☰</button>
              <button className="b" title="Remove from this view (⌃⌥W). The agent keeps running." onClick={() => removeFromView(t.id)}>✕</button>
            </div>
            <div className="wb">{asking.has(t.id) && <AskPanel task={t} close={() => toggleAsk(t.id)} />}{t.openElsewhere ? <div className="empty" style={{ padding: 16 }}>Running in another terminal ({t.openElsewhere?.tty}). <button className="btn" onClick={() => openPanel(t.id)}>Options…</button></div>
              : t.status === 'suspended' ? <div className="empty" style={{ padding: 16 }}>Suspended. <button className="btn" onClick={() => openPanel(t.id)}>Resume…</button></div>
              // a tmux window has one size: while this task's panel is open, the panel shows the terminal and the tile waits
              : t.id === panelTaskId ? <div className="tile-in-panel"><div>Shown in the task panel.</div><div className="sub">One terminal per task at a time, so neither is cut off. Closing the panel brings it back here.</div><button className="btn" onClick={() => openPanel(null)}>Show it here instead</button></div>
              : <Terminal taskId={t.id} fontSize={font[t.id] || 13} onFocus={() => setFocused(t.id)} />}</div>
          </div>
        ))}
      </div>
      {focusMode && <div className="fm-bar" title="Move the pointer to the top edge to show the tabs and toolbar"><span>Focus mode</span><button className="btn primary" onClick={() => setFocusMode(false)}>Exit <kbd>⌃⌥F</kbd></button></div>}
    </div>
  );
}

function NewGroupMenu({ tasks, onScreen, selected, close, done }: { tasks: Task[]; onScreen: string[]; selected: string[]; close: () => void; done: (g: Group) => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState<'sel' | 'screen' | 'empty'>(selected.length ? 'sel' : 'screen');
  const ok = async () => {
    if (!name.trim()) return;
    const list = from === 'sel' ? selected : from === 'screen' ? onScreen : [];
    done(await api.createGroup(name.trim(), list));
  };
  const nums = (l: string[]) => l.map(id => '#' + tasks.find(t => t.id === id)?.num).join(', ');
  return (
    <div className="gmenu" style={{ left: 12, top: 44 }} onKeyDown={e => { if (e.key === 'Escape') close(); if (e.key === 'Enter') ok(); }}>
      <h4>New group</h4>
      <input type="text" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Release 2.3, Friday, Auth" />
      <div style={{ marginTop: 10, color: 'var(--dim)' }}>Start with</div>
      {selected.length > 0 && <label className="opt"><input type="radio" checked={from === 'sel'} onChange={() => setFrom('sel')} /> the {selected.length} selected ({nums(selected)})</label>}
      <label className="opt"><input type="radio" checked={from === 'screen'} onChange={() => setFrom('screen')} /> the {onScreen.length} windows on screen now</label>
      <label className="opt"><input type="radio" checked={from === 'empty'} onChange={() => setFrom('empty')} /> nothing (add windows afterwards)</label>
      <div style={{ color: 'var(--dim)', fontSize: 11.5, marginTop: 6 }}>⌘-click window headers to select them. Drag a header onto a tab to add it later.</div>
      <div className="row"><button className="btn" onClick={close}>Cancel</button><button className="btn primary" onClick={ok}>Create and show</button></div>
    </div>
  );
}

function GroupMenu({ g, close, onDeleted }: { g: Group; close: () => void; onDeleted: (g: Group) => void }) {
  const [name, setName] = useState(g?.name || '');
  if (!g) return null;
  return (
    <div className="gmenu" style={{ left: 12, top: 44 }} onKeyDown={e => { if (e.key === 'Escape') close(); }}>
      <h4>Group</h4>
      <input type="text" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { api.updateGroup(g.id, { name }); close(); } }} />
      <div style={{ color: 'var(--dim)', margin: '8px 0 2px' }}>Colour</div>
      <div className="colors">{GCOLORS.map(c => <i key={c} className={c === g.color ? 'on' : ''} style={{ background: c }} onClick={() => api.updateGroup(g.id, { color: c })} />)}</div>
      <div className="mi" onClick={() => { openInWindow('g:' + g.id); close(); }}>↗ Open in its own window</div>
      <div className="mi danger" onClick={async () => { const d = await api.deleteGroup(g.id); close(); onDeleted(d); }}>Delete group <span style={{ color: 'var(--dim)' }}>(tasks are not affected)</span></div>
      <div className="row"><button className="btn" onClick={close}>Close</button><button className="btn primary" onClick={() => { if (name.trim() && name !== g.name) api.updateGroup(g.id, { name: name.trim() }); close(); }}>Save</button></div>
    </div>
  );
}
