// Canvas: live terminals for one view at a time. A view is a group (tab), a status-based set, or a hand-picked
// list of tasks (a separate window). Layouts: Columns (full-height terminals in one row that scrolls sideways),
// Grid, Rows. Every command is ⌃⌥ + key so typing into agents is not affected.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, Task } from '../api';
import { ATTN, STATUS_LABEL, api, confirmEnd } from '../api';
import { AgentChip, Dot, MachineChip, WhereChip } from './ui';
import { Terminal } from './Terminal';
import { AskPanel } from './Ask';

type Layout = 'columns' | 'grid' | 'rows';
const MINW = 640;
const PER_PAGE = ['off', 2, 3, 4, 6, 8] as const;
const GESTURE_GAP = 150;  // ms without a wheel event that ends one trackpad swipe
const AXIS_LOCK = 8;      // px a swipe moves before it is locked to one axis
const PAGE_SWIPE = 60;    // px a horizontal swipe moves before it changes the page
const GCOLORS = ['#e3b341', '#58a6ff', '#3fb950', '#db61a2', '#a371f7', '#f78166', '#2dd4bf', '#8b949e'];
const UNGROUPED_COLOR = '#6e7681'; // a gray that is not in GCOLORS, so no group has the same colour

// view ids: g:<group id> · ungrouped · needs · live · t:<id,id,...>
// ungrouped is not a group file: it is every task that no group lists, computed here from the groups
export function viewName(view: string, groups: Group[], tasks: Task[]) {
  if (view.startsWith('g:')) return groups.find(g => g.id === view.slice(2))?.name || 'Group';
  if (view === 'ungrouped') return 'Ungrouped';
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
  const [perPage, setPerPage] = useState<number | 'off'>(() => { const v = localStorage.getItem(lk('perpage')); return v && v !== 'off' ? Number(v) : 'off'; });
  const [page, setPage] = useState(() => Number(localStorage.getItem(lk('page'))) || 0);
  const [focused, setFocused] = useState<string | null>(null);
  const [maxId, setMaxId] = useState<string | null>(null);
  const [font, setFont] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<null | 'add' | 'new' | { group: string }>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);     // status-based views do not move windows on their own
  const [extra, setExtra] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);              // ungrouped tasks removed from the Ungrouped view with ✕
  const [dropTab, setDropTab] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [ending, setEnding] = useState<string | null>(null); // the window whose header asks "End & archive?"
  const [asking, setAsking] = useState<Set<string>>(new Set()); // tiles with the Ask panel open
  const toggleAsk = (id: string) => setAsking(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stage = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1200);

  useEffect(() => { setLayout((localStorage.getItem(lk('layout')) as Layout) || 'columns'); const v = localStorage.getItem(lk('visible')); setVisible(v && v !== 'auto' ? Number(v) : 'auto'); const pp = localStorage.getItem(lk('perpage')); setPerPage(pp && pp !== 'off' ? Number(pp) : 'off'); setPage(Number(localStorage.getItem(lk('page'))) || 0); setFrozen(null); setExtra([]); setHidden([]); setMaxId(null); setFocused(null); }, [view]);
  useEffect(() => { localStorage.setItem(lk('layout'), layout); localStorage.setItem(lk('visible'), String(visible)); localStorage.setItem(lk('perpage'), String(perPage)); localStorage.setItem(lk('page'), String(page)); }, [layout, visible, perPage, page, view]);
  useEffect(() => { const ro = new ResizeObserver(() => setW(stage.current?.clientWidth || 1200)); if (stage.current) ro.observe(stage.current); return () => ro.disconnect(); }, []);

  // windows are for running agents: archived and suspended tasks are left out (suspended ones: see the Resume button)
  const live = (t?: Task) => !!t && t.status !== 'archived' && t.status !== 'suspended';
  const liveSet = useCallback(() => view === 'needs' ? tasks.filter(t => ATTN.includes(t.status) || t.status === 'unread').map(t => t.id) : tasks.filter(t => live(t) && t.status !== 'parked').map(t => t.id), [tasks, view]);
  useEffect(() => { if ((view === 'needs' || view === 'live') && !frozen && tasks.length) setFrozen(liveSet()); }, [view, frozen, tasks.length, liveSet]);
  const group = view.startsWith('g:') ? groups.find(g => g.id === view.slice(2)) : undefined;
  const ungrouped = useMemo(() => { const inGroup = new Set(groups.flatMap(g => g.tasks)); return tasks.filter(t => !inGroup.has(t.id)).map(t => t.id); }, [tasks, groups]);
  const ids = useMemo(() => {
    let base: string[] = view.startsWith('g:') ? (group?.tasks || []) : view.startsWith('t:') ? view.slice(2).split(',') : view === 'ungrouped' ? ungrouped.filter(id => !hidden.includes(id)) : (frozen || []);
    base = [...base, ...extra.filter(x => !base.includes(x))];
    return base.filter(id => live(tasks.find(t => t.id === id)));
  }, [view, group, ungrouped, hidden, frozen, extra, tasks]);
  const suspendedHere = (view.startsWith('g:') ? (group?.tasks || []) : view.startsWith('t:') ? view.slice(2).split(',') : view === 'ungrouped' ? ungrouped : []).map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && t.status === 'suspended');
  const newInSmart = (view === 'needs' || view === 'live') && frozen ? liveSet().filter(x => !frozen.includes(x)).length : 0;

  const wins = ids.map(id => tasks.find(t => t.id === id)!).filter(Boolean);
  // pages: only the tiles of one page are on screen (and connected); the others wait
  const per = perPage === 'off' ? 0 : perPage;
  const pageCount = per ? Math.max(1, Math.ceil(wins.length / per)) : 1;
  const pg = Math.min(page, pageCount - 1);
  useEffect(() => { if (wins.length && page !== pg) setPage(pg); }, [wins.length, page, pg]); // wait for the tasks before clamping a saved page
  const pageWins = per ? wins.slice(pg * per, (pg + 1) * per) : wins;
  const pageOf = (id: string) => per ? Math.floor(wins.findIndex(t => t.id === id) / per) : 0;
  const needsYou = (t: Task) => ATTN.includes(t.status);
  const needBefore = per ? wins.slice(0, pg * per).filter(needsYou).length : 0;
  const needAfter = per ? wins.slice((pg + 1) * per).filter(needsYou).length : 0;
  const shown = maxId ? wins.filter(t => t.id === maxId) : pageWins;
  // with pages every page has the same tile size, so a short last page does not resize the tmux windows
  const slots = per && !maxId ? per : shown.length;
  const fit = Math.max(1, Math.floor((W - 8) / (MINW + 8)));
  const vis = layout !== 'columns' ? shown.length : per ? slots : visible === 'auto' ? Math.min(shown.length, fit) : Math.min(shown.length, visible);
  const gridCols = Math.max(1, Math.min(slots || 1, Math.round(Math.sqrt(slots * (W / 900)))));
  const style: React.CSSProperties = maxId ? { gridTemplateColumns: '1fr' }
    : layout === 'columns' ? { gridAutoFlow: 'column', gridAutoColumns: `calc((100% - ${(Math.max(1, vis) - 1) * 8}px) / ${Math.max(1, vis)})`, overflowX: 'auto' }
    : layout === 'grid' ? { gridTemplateColumns: `repeat(${gridCols}, 1fr)` }
    : { gridTemplateRows: `repeat(${slots || 1}, minmax(160px, 1fr))`, overflowY: 'auto' };

  const addToView = (id: string) => { if (group) api.updateGroup(group.id, { add: id }); else { setExtra(e => [...e, id]); setHidden(h => h.filter(x => x !== id)); } };
  const removeFromView = (id: string) => {
    if (group) { api.updateGroup(group.id, { remove: id }); toast(`Removed from ${group.name}. The agent keeps running.`); }
    else if (view === 'ungrouped') { setHidden(h => [...h, id]); setExtra(e => e.filter(x => x !== id)); }
    else if (view.startsWith('t:')) setView('t:' + view.slice(2).split(',').filter(x => x !== id).join(','));
    else { setFrozen(f => (f || []).filter(x => x !== id)); setExtra(e => e.filter(x => x !== id)); }
  };
  // ends the tmux session and archives the task (as in its panel); the window then leaves the canvas by itself
  const endTask = (t: Task) => {
    setEnding(null);
    api.kill(t.id).then(() => {
      if (panelTaskId === t.id) openPanel(null);
      toast(`#${t.num} ended and archived.`, { label: 'Restore', fn: () => { api.setStatus(t.id, 'idle'); } });
    }, e => toast(`Could not end #${t.num}: ${e.message || e}`));
  };

  // a tile on another page is mounted only after the page changes, so look for it after the next render
  const focus = (id: string) => {
    setFocused(id);
    if (per && !maxId) setPage(pageOf(id));
    setTimeout(() => {
      const el = stage.current?.querySelector(`[data-win="${id}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      setTimeout(() => (el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.focus(), 30);
    }, 0);
  };
  const turnPage = (d: number) => setPage(p => Math.max(0, Math.min(pageCount - 1, p + d)));
  const nextNeedy = () => { const l = wins.filter((t, i) => needsYou(t) && Math.floor(i / per) !== pg); return l.find(t => pageOf(t.id) > pg) || l[0]; };

  // Wheel over the canvas. tmux runs with mouse on, so xterm.js cancels every wheel event over a terminal, horizontal
  // ones included. This listener runs first (capture phase). It locks each swipe to the axis it starts on: a vertical
  // swipe goes on to the terminal, a horizontal one scrolls the canvas (or, with pages, turns one page) and never
  // reaches the terminal. Shift + a vertical mouse wheel counts as horizontal.
  const gesture = useRef({ last: -1e9, axis: null as null | 'x' | 'y', dx: 0, dy: 0, moved: 0, paged: false });
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = e => {
    const g = gesture.current;
    if (e.timeStamp - g.last > GESTURE_GAP) Object.assign(g, { axis: null, dx: 0, dy: 0, moved: 0, paged: false });
    g.last = e.timeStamp;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (stage.current?.clientWidth || 800) : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    if (!g.axis) {
      g.dx += dx; g.dy += dy;
      if (Math.max(Math.abs(g.dx), Math.abs(g.dy)) >= AXIS_LOCK) { g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : 'y'; if (g.axis === 'x') dx = g.dx; }
      else if (Math.abs(dx) <= Math.abs(dy)) return;
      else { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (g.axis === 'y') return;
    e.preventDefault(); e.stopPropagation();
    if (per && !maxId) {
      g.moved += dx;
      if (!g.paged && Math.abs(g.moved) >= PAGE_SWIPE) { g.paged = true; turnPage(Math.sign(g.moved)); }
    } else if (stage.current) stage.current.scrollLeft += dx;
  };
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const on = (e: WheelEvent) => onWheel.current(e);
    el.addEventListener('wheel', on, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', on, { capture: true });
  }, []);

  const tabs = [...groups.map(g => 'g:' + g.id), 'ungrouped', 'needs', 'live'];
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
      else if (e.code === 'PageDown' || e.code === 'BracketRight') { if (per) turnPage(1); else hit = false; }
      else if (e.code === 'PageUp' || e.code === 'BracketLeft') { if (per) turnPage(-1); else hit = false; }
      else if (e.code === 'KeyN') { const w = wins.filter(t => ATTN.includes(t.status)); if (w.length) focus(w[(w.findIndex(t => t.id === focused) + 1) % w.length].id); }
      else if (e.code === 'Period' || e.code === 'Comma') { if (focused) setFont(f => ({ ...f, [focused]: Math.max(10, Math.min(20, (f[focused] || 13) + (e.code === 'Period' ? 1 : -1))) })); }
      else if (e.code === 'KeyW') { if (focused) removeFromView(focused); }
      else if (/^Digit[1-9]$/.test(e.code)) { const t = (maxId ? wins : pageWins)[Number(e.code.slice(5)) - 1]; if (t) { if (maxId) setMaxId(t.id); focus(t.id); } }
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
        {(() => { const l = ungrouped.filter(id => live(tasks.find(t => t.id === id))); const w = waiting(l); return (
          <div className={`gtab ${view === 'ungrouped' ? 'on' : ''}`} style={{ '--gc': UNGROUPED_COLOR } as React.CSSProperties}
            onClick={e => { if (!(e.target as HTMLElement).closest('button')) setView('ungrouped'); }} title="Every task that is not in a group">
            <span className="gdot" /><span className="gname">Ungrouped</span><span className="gn">{l.length}</span>{w > 0 && <span className="gw">● {w}</span>}
            <span className="gact"><button title="Open in its own window" onClick={() => openInWindow('ungrouped')}>↗</button></span>
          </div>); })()}
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
        {layout === 'columns' && !per && <><span className="lbl">Visible</span><div className="seg">{(['auto', 2, 3, 4, 5] as const).map(v => <button key={v} className={visible === v ? 'on' : ''} onClick={() => setVisible(v)}>{v === 'auto' ? 'Auto' : v}</button>)}</div></>}
        <span className="lbl">Per page</span><div className="seg">{PER_PAGE.map(v => <button key={v} className={perPage === v ? 'on' : ''} onClick={() => { setPerPage(v); setPage(0); }} title={v === 'off' ? 'Show every window' : `Show ${v} windows at a time`}>{v === 'off' ? 'Off' : v}</button>)}</div>
        {per > 0 && pageCount > 1 && <div className="pager">
          <button className="btn" disabled={pg === 0} onClick={() => turnPage(-1)} title="Previous page (⌃⌥PageUp or ⌃⌥[)">‹{needBefore > 0 && <span className="pw">● {needBefore}</span>}</button>
          <span className="lbl" title={`Page ${pg + 1} of ${pageCount}`}>Page {pg + 1}/{pageCount} · windows {pg * per + 1}–{Math.min(wins.length, (pg + 1) * per)} of {wins.length}</span>
          <button className="btn" disabled={pg === pageCount - 1} onClick={() => turnPage(1)} title="Next page (⌃⌥PageDown or ⌃⌥])">{needAfter > 0 && <span className="pw">● {needAfter}</span>}›</button>
          {needBefore + needAfter > 0 && <button className="btn pneed" onClick={() => { const t = nextNeedy(); if (t) focus(t.id); }} title="Go to the next window on another page that needs you">● {needBefore + needAfter} need you on other pages</button>}
        </div>}
        {newInSmart > 0 && <button className="btn" onClick={() => { setFrozen(liveSet()); }} title="Windows never appear on their own while you work">{newInSmart} new · refresh</button>}
        <span className="sp" />
        <span className="lbl">{per && pageCount > 1 ? '' : `${wins.length} windows`}{focusedTask ? `${per && pageCount > 1 ? '' : ' · '}typing into #${focusedTask.num}` : ''}</span>
        {suspendedHere.length > 0 && <button className="btn" title={`Not running: ${suspendedHere.map(t => '#' + t.num + ' ' + t.title).join(', ')}. Resume starts their agents again and continues their conversations.`} onClick={() => suspendedHere.forEach(t => api.resume(t.id).catch(() => {}))}>{suspendedHere.length} suspended · Resume</button>}
        <button className="btn" onClick={() => setFocusMode(!focusMode)}>Focus mode <kbd>⌃⌥F</kbd></button>
      </div>
      {menu === 'new' && <NewGroupMenu tasks={tasks} onScreen={ids} selected={[...selected].filter(id => tasks.some(t => t.id === id))} close={() => setMenu(null)} done={g => { clearSel(); setMenu(null); setView('g:' + g.id); toast(`Group “${g.name}” created`); }} />}
      {menu && typeof menu === 'object' && <GroupMenu g={groups.find(x => x.id === menu.group)!} close={() => setMenu(null)} onDeleted={g => { if (view === 'g:' + g.id) setView('live'); toast(`Deleted “${g.name}”. Its tasks keep running.`, { label: 'Undo', fn: () => { api.restoreGroup(g); setView('g:' + g.id); } }); }} />}
      <div className="stage-grid" ref={stage} style={style}>
        {!wins.length && <div className="emptyview"><h2>{group ? `“${group.name}” is empty` : view === 'ungrouped' && !hidden.length ? 'Every live task is in a group' : 'No windows'}</h2><p>Use <b>＋ Add window</b>, drag a window's header onto a tab, or <b>Show on canvas</b> in a task's panel.</p></div>}
        {shown.map((t, i) => (
          <div key={t.id} data-win={t.id} className={`win ${t.status} ${focused === t.id ? 'focus' : ''} ${selected.has(t.id) ? 'selected' : ''}`} onMouseDown={() => { setFocused(t.id); if (t.status === 'unread') api.seen(t.id); }}>
            <div className="wh" onPointerDown={e => startDrag(e, t.id)} onDoubleClick={() => setMaxId(m => m ? null : t.id)}>
              <span className="ix">{i + 1}</span><Dot s={t.status} /><span className="n">#{t.num}</span><span className="ti">{t.title}</span>
              <span className={`st st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} />
              {ending === t.id ? <><span className="sel-warn">End & archive?</span><button className="b" onClick={() => endTask(t)}>Yes, end it</button><button className="b" onClick={() => setEnding(null)}>Cancel</button></> : <>
              {(t.status === 'suspended' || t.openElsewhere) && <button className="b" onClick={() => openPanel(t.id)}>{t.openElsewhere ? 'Options…' : 'Resume…'}</button>}
              <button className={`b ${asking.has(t.id) ? 'on' : ''}`} title="Ask a separate agent about this session. This agent does not see the question." onClick={() => toggleAsk(t.id)}>?</button>
              <button className="b" title="Maximize (⌃⌥↩)" onClick={() => setMaxId(m => m ? null : t.id)}>{maxId === t.id ? '⤡' : '⤢'}</button>
              <button className="b" title="Task panel" onClick={() => openPanel(t.id)}>☰</button>
              {t.role !== 'controller' && <button className="b" title={t.openElsewhere ? 'End & archive: archives the task; the session in the other terminal keeps running' : 'End & archive: ends the tmux session and archives the task'} onClick={() => confirmEnd() ? setEnding(t.id) : endTask(t)}>⏻</button>}
              <button className="b" title="Remove from this view (⌃⌥W). The agent keeps running." onClick={() => removeFromView(t.id)}>✕</button></>}
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
