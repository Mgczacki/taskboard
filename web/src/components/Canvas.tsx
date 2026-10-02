// Canvas: live terminals for one view at a time. A view is a group (tab), a status-based set, or a hand-picked
// list of tasks (a separate window). Layouts: Columns (full-height terminals in one row that scrolls sideways),
// Grid, Rows. The keys are in keys.ts (⌃⌥ + key by default, so typing into agents is not affected).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, SpinOffExchange, Task } from '../api';
import { ATTN, STATUS_LABEL, api, confirmEnd, useStore } from '../api';
import { AgentChip, Dot, MachineChip, WhereChip } from './ui';
import { Terminal, terminalDebugRecord } from './Terminal';
import { hit as key, hitIn, inBrowser, keyLabel, keysText, useKeymap } from '../keys';
import { AskPanel } from './Ask';
import { archiveAll, archiveAndDelete, archivePlan, restoreAll, restoreGroupAndTasks, type ArchiveResult, type ArchiveTarget } from '../groupArchive';
import { dropHint, planCanvasTabDrop, planUngroup, type DropPlan } from '../groupMove';
import { runGroupChange } from '../groupActions';
import { inOrder, moveBy, moveToSlot, slotAt, slotHint } from '../groupOrder';
import { orderKey, renderOrder, slotNear, tileHint, withSavedOrder } from '../tileOrder';
import { GroupRuntime } from './GroupRuntime';
import { RuntimeButton, canRun, type RuntimeTab } from './TaskRuntime';
import { panelHolds, type PanelTab } from '../panelShare';
import { BrowserView } from './TaskBrowser';
import { readSplit, writeSplit, type Split } from '../browserSplit';
import { countText, sumCounts } from '../runtimeText';

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
  tasks: Task[]; groups: Group[]; view: string; setView: (v: string) => void; openPanel: (id: string | null, tab?: RuntimeTab) => void;
  panelTaskId?: string | null; // the task whose panel is open
  panelTab?: PanelTab; // the tab in front in that panel: its tile yields only the part that tab shows (panelShare.ts)
  selected: Set<string>; toggleSel: (id: string) => void; clearSel: () => void; solo: boolean;
  focusMode: boolean; setFocusMode: (f: boolean) => void; toast: (s: string, action?: { label: string; fn: () => void }) => void;
  newTask: () => void; newTaskToFocus: string | null; onNewTaskFocused: () => void;
  onSpinOff: (exchange: SpinOffExchange, task: Task) => void;
}

export function Canvas({ tasks, groups: saved, view, setView, openPanel, panelTaskId, panelTab, selected, toggleSel, clearSel, solo, focusMode, setFocusMode, toast, newTask, newTaskToFocus, onNewTaskFocused, onSpinOff }: Props) {
  const lk = (k: string) => `tb-cv-${view}-${k}`;
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(lk('layout')) as Layout) || 'columns');
  const [visible, setVisible] = useState<number | 'auto'>(() => { const v = localStorage.getItem(lk('visible')); return v && v !== 'auto' ? Number(v) : 'auto'; });
  const [perPage, setPerPage] = useState<number | 'off'>(() => { const v = localStorage.getItem(lk('perpage')); return v && v !== 'off' ? Number(v) : 'off'; });
  const [page, setPage] = useState(() => Number(localStorage.getItem(lk('page'))) || 0);
  // the browsers and processes of this view's tasks (GroupRuntime), shown above the windows
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [maxId, setMaxId] = useState<string | null>(null);
  const [font, setFont] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<null | 'add' | 'new' | { group: string }>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);     // status-based views do not move windows on their own
  const [extra, setExtra] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);              // ungrouped tasks removed from the Ungrouped view with ✕
  const [dropTab, setDropTab] = useState<{ key: string; refused?: string } | null>(null); // the tab under a dragged window: g:<id> or ungrouped
  const [reveal, setReveal] = useState(false);
  // Dragging a group tab: the dragged group and the slot (gap between two tabs) under the pointer (groupOrder.ts).
  const [tabDrag, setTabDrag] = useState<{ id: string; slot: number | null } | null>(null);
  // The new tab order until the server sends the saved groups back, so the tabs do not jump back for a moment.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  useEffect(() => setPendingOrder(null), [saved]);
  const groups = useMemo(() => inOrder(saved, pendingOrder), [saved, pendingOrder]);
  const draggedTab = useRef(false); // true from the end of a tab drag until its click event, so the drop does not open the tab
  // Dragging a window: the dragged task and the slot (gap between two windows on screen) under the pointer (tileOrder.ts).
  const [tileDrag, setTileDrag] = useState<{ id: string; slot: number | null } | null>(null);
  // The saved order of the views that are not a group (server/canvasOrder.ts).
  const { canvasOrder: savedOrder, runtime: runtimeCounts } = useStore();
  // The new window order of a view until the server sends the saved order back, so the windows do not jump back.
  const [pendingTiles, setPendingTiles] = useState<{ view: string; ids: string[] } | null>(null);
  useEffect(() => setPendingTiles(null), [saved, savedOrder, view]);
  const [ending, setEnding] = useState<string | null>(null); // the window whose header asks "End & archive?"
  const [archiving, setArchiving] = useState<{ group: Group; deleteGroup: boolean } | null>(null);
  const [asking, setAsking] = useState<Set<string>>(new Set()); // tiles with the Ask panel (labeled BTW) open
  // The browser of a task inside its window (browserSplit.ts), saved for each task. Only a click on 🌐 starts a stopped
  // browser: a window that opens with the browser shown from an earlier visit waits for the Start button.
  const [splits, setSplits] = useState<Record<string, Split>>({});
  const startHere = useRef(new Set<string>());
  const splitOf = (id: string) => splits[id] ?? readSplit(id);
  // the parts of a task that its open panel shows: the tile does not show them as well
  const held = (id: string) => panelHolds(id, panelTaskId, panelTab);
  const setSplit = (id: string, s: Split) => { writeSplit(id, s); setSplits(m => ({ ...m, [id]: s })); };
  const toggleBrowser = (id: string) => { const s = splitOf(id); if (s.open) startHere.current.delete(id); else startHere.current.add(id); setSplit(id, { ...s, open: !s.open }); };
  const toggleAsk = (id: string) => setAsking(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stage = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1200);
  useKeymap();

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
    // a group view shows the order of the group's tasks list; the other views have their own saved order
    const key = orderKey(view);
    if (key) base = withSavedOrder(base, savedOrder[key]);
    if (pendingTiles?.view === view) base = withSavedOrder(base, pendingTiles.ids);
    return base.filter(id => live(tasks.find(t => t.id === id)));
  }, [view, group, ungrouped, hidden, frozen, extra, tasks, savedOrder, pendingTiles]);
  const suspendedHere = (view.startsWith('g:') ? (group?.tasks || []) : view.startsWith('t:') ? view.slice(2).split(',') : view === 'ungrouped' ? ungrouped : []).map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && t.status === 'suspended');
  const newInSmart = (view === 'needs' || view === 'live') && frozen ? liveSet().filter(x => !frozen.includes(x)).length : 0;

  const wins = ids.map(id => tasks.find(t => t.id === id)!).filter(Boolean);
  // the tasks whose browsers and processes the view lists: in a group view every task of the group that is not archived
  // (a suspended task can keep a stopped browser), in other views the windows on screen
  const runtimeTasks = group ? group.tasks.map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && t.status !== 'archived') : wins;
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
  const tileCount = shown.length;
  const fit = Math.max(1, Math.floor((W - 8) / (MINW + 8)));
  const vis = per || layout !== 'columns' ? tileCount : visible === 'auto' ? Math.min(tileCount, fit) : Math.min(tileCount, visible);
  const gridCols = Math.max(1, Math.min(tileCount || 1, Math.round(Math.sqrt(tileCount * (W / 900)))));
  const lastRow = tileCount % gridCols || gridCols;
  // Give each tile in the last grid row an equal share of the full width.
  const gridTracks = gridCols * lastRow;
  const style: React.CSSProperties = maxId ? { gridTemplateColumns: '1fr' }
    : layout === 'columns' ? { gridAutoFlow: 'column', gridAutoColumns: `calc((100% - ${(Math.max(1, vis) - 1) * 8}px) / ${Math.max(1, vis)})`, overflowX: 'auto' }
    : layout === 'grid' ? { gridTemplateColumns: `repeat(${gridTracks}, 1fr)` }
    : { gridTemplateRows: `repeat(${tileCount || 1}, minmax(160px, 1fr))`, overflowY: 'auto' };

  const addToView = (id: string) => { if (group) api.updateGroup(group.id, { add: id }); else { setExtra(e => [...e, id]); setHidden(h => h.filter(x => x !== id)); } };
  const removeFromView = (id: string) => {
    if (group) { const p = planUngroup(id, tasks.find(t => t.id === id)?.num ?? '?', groups, group.id); if ('change' in p) runGroupChange(p.change, toast); }
    else if (view === 'ungrouped') { setHidden(h => [...h, id]); setExtra(e => e.filter(x => x !== id)); }
    else if (view.startsWith('t:')) setView('t:' + view.slice(2).split(',').filter(x => x !== id).join(','));
    else { setFrozen(f => (f || []).filter(x => x !== id)); setExtra(e => e.filter(x => x !== id)); }
  };
  // the tile header's ⚙: copies this task's terminal debug record (Terminal.tsx) for a freeze that needs a diagnosis
  const copyDebugRecord = (t: Task) => {
    const record = terminalDebugRecord(t.id);
    if (!record) { toast(`#${t.num} has no open terminal in this window, so there is no debug record.`); return; }
    navigator.clipboard.writeText(JSON.stringify(record, null, 1)).then(() => toast(`Copied the terminal debug record of #${t.num}.`), e => toast(`Could not copy: ${e.message || e}`));
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
  useEffect(() => { if (newTaskToFocus && wins.some(t => t.id === newTaskToFocus)) { focus(newTaskToFocus); onNewTaskFocused(); } }, [newTaskToFocus, wins]);
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
      if (document.querySelector('.scrim.open')) return;
      if (e.key === 'Escape' && focusMode && !(e.target as HTMLElement)?.closest?.('.xterm') && !inBrowser(e)) { setFocusMode(false); return; }
      if (document.querySelector('.triage.open') && hitIn(e, 'triage')) return; // triage is on top and uses these keys
      const i = wins.findIndex(t => t.id === focused);
      const move = (d: number) => { const n = wins[(Math.max(0, i) + d + wins.length) % wins.length]; if (n) { if (maxId) setMaxId(n.id); focus(n.id); } };
      const turnView = (d: number) => setView(tabs[(Math.max(0, tabs.indexOf(view)) + d + tabs.length) % tabs.length]);
      const nth = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(n => key(e, `window${n}`));
      let hit = true;
      if (key(e, 'maximize')) setMaxId(m => m ? null : focused);
      else if (key(e, 'nextWindow')) move(1);
      else if (key(e, 'prevWindow')) move(-1);
      else if (key(e, 'layout')) setLayout(l => l === 'columns' ? 'grid' : l === 'grid' ? 'rows' : 'columns');
      else if (key(e, 'focusMode')) setFocusMode(!focusMode);
      else if (key(e, 'groupLeft') || key(e, 'groupRight')) { if (group && !solo) reorderTabs(group.id, moveBy(groups.map(g => g.id), group.id, key(e, 'groupLeft') ? -1 : 1)); }
      else if (key(e, 'windowEarlier') || key(e, 'windowLater')) { if (focused && !maxId) { const next = moveBy(wins.map(t => t.id), focused, key(e, 'windowEarlier') ? -1 : 1); reorderTiles(focused, next); if (next && per) setPage(Math.floor(next.indexOf(focused) / per)); } }
      else if (key(e, 'newGroup')) setMenu('new');
      else if (key(e, 'canvasNewTask')) newTask();
      else if (key(e, 'nextView')) { if (!solo) turnView(1); }
      else if (key(e, 'prevView')) { if (!solo) turnView(-1); }
      else if (key(e, 'nextPage')) { if (per) turnPage(1); else hit = false; }
      else if (key(e, 'prevPage')) { if (per) turnPage(-1); else hit = false; }
      else if (key(e, 'nextNeedy')) { const w = wins.filter(t => ATTN.includes(t.status)); if (w.length) focus(w[(w.findIndex(t => t.id === focused) + 1) % w.length].id); }
      else if (key(e, 'fontUp') || key(e, 'fontDown')) { const d = key(e, 'fontUp') ? 1 : -1; if (focused) setFont(f => ({ ...f, [focused]: Math.max(10, Math.min(20, (f[focused] || 13) + d)) })); }
      else if (key(e, 'removeWindow')) { if (focused) removeFromView(focused); }
      else if (nth) { const t = (maxId ? wins : pageWins)[nth - 1]; if (t) { if (maxId) setMaxId(t.id); focus(t.id); } }
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

  // Drag a window by its header (the ⠿ handle shows where) to move it. Two kinds of drop:
  // - between two windows: the window moves to that position in this view. Its groups do not change.
  // - on a tab: a group tab moves the task from the current group, or adds it from another view. The Ungrouped tab
  //   takes the task out of the group of the current tab, or out of every group when the current tab is not a group.
  //   A tab that refuses the drop shows why (groupMove.ts).
  // A bar shows the drop position between the windows. Esc cancels the drag.
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    if (e.metaKey || e.shiftKey) { toggleSel(id); return; }
    const num = tasks.find(t => t.id === id)?.num ?? '?';
    const fromGroup = group?.id;
    const order = wins.map(t => t.id);
    const first = per && !maxId ? pg * per : 0; // the place in `order` of the first window on screen
    const onScreen = shown.map(t => t.id);
    const sx = e.clientX, sy = e.clientY; let moving = false, key: string | null = null, plan: DropPlan | null = null, next: string[] | null = null, x = sx, y = sy;
    const ghost = document.createElement('div');
    const idle = `#${num} → drop between two windows, on a group tab or on Ungrouped`;
    const show = () => {
      const tab = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-drop]') as HTMLElement | null;
      key = tab ? tab.dataset.drop! : null;
      plan = planCanvasTabDrop(id, num, groups, key, fromGroup);
      // over the stage (and not over a tab), the slot between the windows on screen; a maximized window has no slot
      const box = stage.current?.getBoundingClientRect();
      const inStage = !tab && !maxId && !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      const rects = onScreen.map(w => stage.current?.querySelector(`[data-win="${w}"]`)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r);
      let slot = inStage && rects.length === onScreen.length ? slotNear(rects, x, y, layout === 'rows') : null;
      next = slot === null ? null : moveToSlot(order, id, first + slot);
      if (!next) slot = null;
      setTileDrag({ id, slot });
      const refused = plan && 'refused' in plan ? plan.refused : undefined;
      ghost.textContent = inStage ? tileHint(next, id, num) : !plan ? idle : 'change' in plan ? `#${num} → ${dropHint(plan.change)}` : `⊘ ${refused}`;
      ghost.classList.toggle('refused', !inStage && !!refused);
      setDropTab(key ? { key, refused } : null);
    };
    const mv = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      if (!moving) { moving = true; ghost.className = 'drag-ghost'; document.body.appendChild(ghost); }
      x = ev.clientX; y = ev.clientY;
      ghost.style.left = x + 12 + 'px'; ghost.style.top = y + 12 + 'px';
      // near the left or right edge of a stage that scrolls sideways, scroll it so the windows out of view can be reached
      const el = stage.current, box = el?.getBoundingClientRect();
      if (el && box && y >= box.top && y <= box.bottom) { if (x < box.left + 40) el.scrollLeft -= 24; else if (x > box.right - 40) el.scrollLeft += 24; }
      show();
    };
    const end = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('keydown', esc, true);
      ghost.remove(); setDropTab(null); setTileDrag(null);
    };
    const up = (ev: PointerEvent) => {
      end();
      if (!moving) return;
      x = ev.clientX; y = ev.clientY; show(); setDropTab(null); setTileDrag(null);
      if (next) reorderTiles(id, next);
      else if (!key) return;
      else if (plan && 'change' in plan) runGroupChange(plan.change, toast); else if (plan) toast(plan.refused + '.');
    };
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(); } };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('keydown', esc, true);
  };

  // Saves a new window order for this view. Undo puts back the order from before the change.
  const reorderTiles = (moved: string, next: string[] | null) => {
    if (!next) return;
    const before = wins.map(t => t.id);
    const num = tasks.find(t => t.id === moved)?.num ?? '?';
    const at = view, inGroup = group?.id, k = orderKey(view);
    const save = (list: string[]) => inGroup ? api.reorderGroupTasks(inGroup, list) : api.setCanvasOrder(k!, list);
    setPendingTiles({ view: at, ids: next });
    save(next).then(
      () => toast(`Moved #${num} to position ${next.indexOf(moved) + 1} of ${next.length}.`, { label: 'Undo', fn: () => { setPendingTiles({ view: at, ids: before }); save(before).catch(e => { setPendingTiles(null); toast(`Could not undo the move: ${e instanceof Error ? e.message : String(e)}`); }); } }),
      e => { setPendingTiles(null); toast(`Could not save the window order: ${e instanceof Error ? e.message : String(e)}`); });
  };
  // the bar for the drop slot: before the window at the slot, or after the last window for the slot at the end
  const tileSlotClass = (i: number) => tileDrag?.slot === i ? 'slot-before' : tileDrag?.slot === shown.length && i === shown.length - 1 ? 'slot-after' : '';

  // Saves a new tab order. Undo puts back the order from before the change.
  const reorderTabs = (moved: string, next: string[] | null) => {
    if (!next) return;
    const before = groups.map(g => g.id);
    const name = groups.find(g => g.id === moved)?.name || 'the group';
    setPendingOrder(next);
    api.reorderGroups(next).then(
      () => toast(`Moved ${name} to position ${next.indexOf(moved) + 1} of ${next.length}.`, { label: 'Undo', fn: () => { setPendingOrder(before); api.reorderGroups(before).catch(e => { setPendingOrder(null); toast(`Could not undo the move: ${e instanceof Error ? e.message : String(e)}`); }); } }),
      e => { setPendingOrder(null); toast(`Could not save the tab order: ${e instanceof Error ? e.message : String(e)}`); });
  };

  // Drag a group tab sideways to put it in a new position. A bar shows the slot where it goes. Esc cancels the drag.
  const startTabDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input')) return;
    const g = groups.find(x => x.id === id); if (!g) return;
    const ids = groups.map(x => x.id);
    const sx = e.clientX, sy = e.clientY; let moving = false, slot: number | null = null;
    const ghost = document.createElement('div');
    const rects = () => [...document.querySelectorAll<HTMLElement>('.gtabs [data-group-tab]')].map(el => el.getBoundingClientRect());
    const mv = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      if (!moving) { moving = true; ghost.className = 'drag-ghost'; document.body.appendChild(ghost); }
      const r = rects();
      // over the tab row (with some room above and below it), the slot under the pointer; elsewhere no slot
      const row = r.length ? { top: Math.min(...r.map(x => x.top)) - 24, bottom: Math.max(...r.map(x => x.bottom)) + 24 } : null;
      slot = row && ev.clientY >= row.top && ev.clientY <= row.bottom ? slotAt(r, ev.clientX) : null;
      if (slot !== null && !moveToSlot(ids, id, slot)) slot = null;
      ghost.textContent = slotHint(ids, id, g.name, slot);
      ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 12 + 'px';
      setTabDrag({ id, slot });
    };
    const end = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('keydown', esc, true);
      ghost.remove(); setTabDrag(null);
    };
    const up = () => {
      end();
      if (!moving) return;
      draggedTab.current = true; setTimeout(() => { draggedTab.current = false; }, 0);
      if (slot !== null) reorderTabs(id, moveToSlot(ids, id, slot));
    };
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(); if (moving) { draggedTab.current = true; setTimeout(() => { draggedTab.current = false; }, 0); } } };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('keydown', esc, true);
  };
  // the bar for the drop slot: before the tab at the slot, or after the last tab for the slot at the end
  const slotClass = (i: number) => tabDrag?.slot === i ? 'slot-before' : tabDrag?.slot === groups.length && i === groups.length - 1 ? 'slot-after' : '';

  const dropClass = (k: string) => dropTab?.key === k ? (dropTab.refused ? 'nodrop' : 'drop') : '';
  const dropTitle = (k: string) => dropTab?.key === k && dropTab.refused ? `Cannot drop here: ${dropTab.refused}.` : undefined;
  const off = tasks.filter(t => !ids.includes(t.id) && live(t));
  const focusedTask = tasks.find(t => t.id === focused);
  const waiting = (list: string[]) => list.filter(id => ATTN.includes(tasks.find(t => t.id === id)?.status as Task['status'])).length;

  return (
    <div className={`canvas ${focusMode ? 'focus-mode' : ''} ${reveal ? 'reveal' : ''}`}>
      {!solo && <div className="gtabs">
        {groups.map((g, i) => { const l = g.tasks.filter(id => live(tasks.find(t => t.id === id))); const w = waiting(l); return (
          <div key={g.id} data-drop={'g:' + g.id} data-group-tab={g.id} className={`gtab ${view === 'g:' + g.id ? 'on' : ''} ${dropClass('g:' + g.id)} ${tabDrag?.id === g.id ? 'dragging' : ''} ${slotClass(i)}`} style={{ '--gc': g.color } as React.CSSProperties}
            onPointerDown={e => startTabDrag(e, g.id)}
            onClick={e => { if (!draggedTab.current && !(e.target as HTMLElement).closest('button,input')) setView('g:' + g.id); }} onDoubleClick={() => setMenu({ group: g.id })} title={dropTitle('g:' + g.id) ?? `Drag sideways to move this tab. Drop a window here to move it from the current group, or add it from another view. Double-click for options. Next / previous tab: ${keysText('nextView')} / ${keysText('prevView')}. Move this tab left / right: ${keysText('groupLeft')} / ${keysText('groupRight')}`}>
            <span className="gdot" /><span className="gname">{g.name}</span><span className="gn">{l.length}</span>{w > 0 && <span className="gw">● {w}</span>}
            <span className="gact"><button title="Open in its own window" onClick={() => openInWindow('g:' + g.id)}>↗</button><button title="Rename, colour, delete" onClick={() => setMenu({ group: g.id })}>⋯</button></span>
          </div>); })}
        {(() => { const l = ungrouped.filter(id => live(tasks.find(t => t.id === id))); const w = waiting(l); return (
          <div data-drop="ungrouped" className={`gtab ${view === 'ungrouped' ? 'on' : ''} ${dropClass('ungrouped')}`} style={{ '--gc': UNGROUPED_COLOR } as React.CSSProperties}
            onClick={e => { if (!(e.target as HTMLElement).closest('button')) setView('ungrouped'); }} title={dropTitle('ungrouped') ?? 'Every task that is not in a group. Drop a window here to take it out of the current group (out of every group from Live or Needs you).'}>
            <span className="gdot" /><span className="gname">Ungrouped</span><span className="gn">{l.length}</span>{w > 0 && <span className="gw">● {w}</span>}
            <span className="gact"><button title="Open in its own window" onClick={() => openInWindow('ungrouped')}>↗</button></span>
          </div>); })()}
        <span className="gsep" />
        {(['needs', 'live'] as const).map(v => { const l = v === 'needs' ? tasks.filter(t => ATTN.includes(t.status) || t.status === 'unread') : tasks.filter(t => live(t) && t.status !== 'parked'); return (
          <div key={v} className={`gtab smart ${view === v ? 'on' : ''}`} onClick={() => setView(v)} title={v === 'needs' ? `Shortcut: ${keysText('needsView')}` : undefined}><span className="gdot" /><span className="gname">{viewName(v, groups, tasks)}</span><span className="gn">{l.length}</span></div>); })}
        {view.startsWith('t:') && <div className="gtab on smart"><span className="gdot" /><span className="gname">{viewName(view, groups, tasks)}</span></div>}
        <div className="gtab newg" onClick={() => setMenu('new')} title={`New group (${keysText('newGroup')})`}>＋ New group</div>
      </div>}
      <div className="ctool">
        {solo && <span className="solo-name">{viewName(view, groups, tasks)}</span>}
        <button className="btn primary" onClick={newTask} title={`New task (${keysText('canvasNewTask')})`}>＋ New task {keyLabel('canvasNewTask') && <kbd>{keyLabel('canvasNewTask')}</kbd>}</button>
        {!solo && <button className="btn" onClick={() => openInWindow(view)} title="Open this view in its own browser window">↗ New window</button>}
        <div style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setMenu(m => m === 'add' ? null : 'add')}>＋ Add window</button>
          {menu === 'add' && <div className="menu" onMouseLeave={() => setMenu(null)}><div className="mh">{group ? `Add to “${group.name}”` : 'Show here'}</div>{off.length ? off.map(t => <div className="mi" key={t.id} onClick={() => { addToView(t.id); setMenu(null); setTimeout(() => focus(t.id), 80); }}><Dot s={t.status} />#{t.num} {t.title}</div>) : <div className="mi">Every live task is already here.</div>}</div>}
        </div>
        <div className="seg">{(['columns', 'grid', 'rows'] as Layout[]).map(l => <button key={l} className={layout === l ? 'on' : ''} onClick={() => setLayout(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}</div>
        {layout === 'columns' && !per && <><span className="lbl">Visible</span><div className="seg">{(['auto', 2, 3, 4, 5] as const).map(v => <button key={v} className={visible === v ? 'on' : ''} onClick={() => setVisible(v)}>{v === 'auto' ? 'Auto' : v}</button>)}</div></>}
        <span className="lbl">Per page</span><div className="seg">{PER_PAGE.map(v => <button key={v} className={perPage === v ? 'on' : ''} onClick={() => { setPerPage(v); setPage(0); }} title={v === 'off' ? 'Show every window' : `Show ${v} windows at a time`}>{v === 'off' ? 'Off' : v}</button>)}</div>
        {per > 0 && pageCount > 1 && <div className="pager">
          <button className="btn" disabled={pg === 0} onClick={() => turnPage(-1)} title={`Previous page (${keysText('prevPage')})`}>‹<span className="pw" style={needBefore > 0 ? undefined : { visibility: 'hidden' }}>● {needBefore}</span></button>
          <span className="lbl" title={`Page ${pg + 1} of ${pageCount}`}>Page {pg + 1}/{pageCount} · windows {pg * per + 1}–{Math.min(wins.length, (pg + 1) * per)} of {wins.length}</span>
          <button className="btn" disabled={pg === pageCount - 1} onClick={() => turnPage(1)} title={`Next page (${keysText('nextPage')})`}><span className="pw" style={needAfter > 0 ? undefined : { visibility: 'hidden' }}>● {needAfter}</span>›</button>
          {/* hidden, not removed, when nothing waits: the toolbar wraps, and a new line would shrink every terminal below it */}
          <button className="btn pneed" style={needBefore + needAfter > 0 ? undefined : { visibility: 'hidden' }} onClick={() => { const t = nextNeedy(); if (t) focus(t.id); }} title={`Go to the next window on another page that needs you (${keysText('nextNeedy')})`}>● {needBefore + needAfter} need you on other pages</button>
        </div>}
        {newInSmart > 0 && <button className="btn" onClick={() => { setFrozen(liveSet()); }} title="Windows never appear on their own while you work">{newInSmart} new · refresh</button>}
        <span className="sp" />
        <span className="lbl">{per && pageCount > 1 ? '' : `${wins.length} windows`}{focusedTask ? `${per && pageCount > 1 ? '' : ' · '}typing into #${focusedTask.num}` : ''}</span>
        {suspendedHere.length > 0 && <button className="btn" title={`Not running: ${suspendedHere.map(t => '#' + t.num + ' ' + t.title).join(', ')}. Resume starts their agents again and continues their conversations.`} onClick={() => suspendedHere.forEach(t => api.resume(t.id).catch(() => {}))}>{suspendedHere.length} suspended · Resume</button>}
        {(() => { const n = countText(sumCounts(runtimeCounts, runtimeTasks.map(t => t.id))); return (
          <button className={`btn ${runtimeOpen ? 'on' : ''}`} onClick={() => setRuntimeOpen(o => !o)} title={`The browsers and processes of the tasks in this view, with their memory. Each task owns its own.${n ? ` Running now: ${n}.` : ''}`}>Browsers & processes{n && <span className="rtb-total">{n}</span>}</button>); })()}
        <button className="btn" onClick={() => setFocusMode(!focusMode)} title={`Focus mode (${keysText('focusMode')})`}>Focus mode {keyLabel('focusMode') && <kbd>{keyLabel('focusMode')}</kbd>}</button>
      </div>
      {menu === 'new' && <NewGroupMenu tasks={tasks} onScreen={ids} selected={[...selected].filter(id => tasks.some(t => t.id === id))} close={() => setMenu(null)} done={g => { clearSel(); setMenu(null); setView('g:' + g.id); toast(`Group “${g.name}” created`); }} />}
      {menu && typeof menu === 'object' && <GroupMenu g={groups.find(x => x.id === menu.group)!} archiveCount={(g => g ? archivePlan(g, groups, tasks).targets.length : 0)(groups.find(x => x.id === menu.group))} onArchiveAll={(g, deleteGroup) => { setMenu(null); setArchiving({ group: { ...g, tasks: [...g.tasks] }, deleteGroup }); }} close={() => setMenu(null)} onDeleted={g => { if (view === 'g:' + g.id) setView('live'); toast(`Deleted “${g.name}”. Its tasks keep running.`, { label: 'Undo', fn: () => { api.restoreGroup(g); setView('g:' + g.id); } }); }} />}
      {archiving && <ArchiveAllPanel g={archiving.group} deleteGroup={archiving.deleteGroup} groups={groups} tasks={tasks} close={() => setArchiving(null)} onDeleted={() => { if (view === 'g:' + archiving.group.id) setView('live'); }} onRestored={() => setView('g:' + archiving.group.id)} onEnded={ids => { if (panelTaskId && ids.includes(panelTaskId)) openPanel(null); }} toast={toast} />}
      {runtimeOpen && <GroupRuntime tasks={runtimeTasks} group={group} onOpen={(id, tab) => openPanel(id, tab)} />}
      <div className="stage-grid" ref={stage} style={style}>
        {!wins.length && <div className="emptyview"><h2>{group ? `“${group.name}” is empty` : view === 'ungrouped' && !hidden.length ? 'Every live task is in a group' : 'No windows'}</h2><p>Use <b>＋ New task</b> to start an agent here. Use <b>＋ Add window</b> to show a task that already exists.</p></div>}
        {/* renderOrder: the page keeps the windows in one fixed order and CSS order puts them in place, so a move does not remount a terminal */}
        {renderOrder(shown).map(({ item: t, at: i }) => (
          <div key={t.id} data-win={t.id} className={`win ${t.status} ${focused === t.id ? 'focus' : ''} ${selected.has(t.id) ? 'selected' : ''} ${tileDrag?.id === t.id ? 'dragging' : ''} ${tileSlotClass(i)} ${layout === 'rows' ? 'vslot' : ''}`} style={{ order: i, ...(layout === 'grid' && !maxId ? { gridColumn: `span ${i < tileCount - lastRow ? lastRow : gridCols}` } : {}) }} onMouseDown={() => { setFocused(t.id); if (t.status === 'unread') api.seen(t.id); }}>
            <div className="wh" onPointerDown={e => startDrag(e, t.id)} onDoubleClick={() => setMaxId(m => m ? null : t.id)}>
              <span className="grip" title={`Drag to move this window between two others, or onto a group tab. Move it one place: ${keysText('windowEarlier')} / ${keysText('windowLater')}`}>⠿</span><span className="ix">{i + 1}</span><Dot s={t.status} /><span className="n">#{t.num}</span><span className="ti">{t.title}</span>
              <span className={`st st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} /><RuntimeButton t={t} small onOpen={tab => openPanel(t.id, tab)} />
              {ending === t.id ? <><span className="sel-warn">End & archive?</span><button className="b" onClick={() => endTask(t)}>Yes, end it</button><button className="b" onClick={() => setEnding(null)}>Cancel</button></> : <>
              {(t.status === 'suspended' || t.openElsewhere) && <button className="b" onClick={() => openPanel(t.id)}>{t.openElsewhere ? 'Options…' : 'Resume…'}</button>}
              {canRun(t) && !t.openElsewhere && t.status !== 'suspended' && !held(t.id).terminal && !held(t.id).browser && (sp => <>
                <button className={`b ${sp.open ? 'on' : ''}`} onClick={() => toggleBrowser(t.id)} title={sp.open ? 'Close the browser here and show only the terminal. The browser keeps running.' : 'Open the browser of this task here, above a smaller terminal. A stopped browser starts.'}>🌐</button>
                {sp.open && <button className="b" onClick={() => setSplit(t.id, { ...sp, side: sp.side === 'bottom' ? 'side' : 'bottom' })} title={sp.side === 'bottom' ? 'Put the terminal at the right side of the browser' : 'Put the terminal in a strip below the browser'}>{sp.side === 'bottom' ? '◨' : '⬓'}</button>}
              </>)(splitOf(t.id))}
              <button className={`b ${asking.has(t.id) ? 'on' : ''}`} title="BTW: ask a separate agent a side question about this session. The running agent does not see it." aria-label="BTW: side question about this session" onClick={() => toggleAsk(t.id)}>BTW</button>
              <button className="b" title={`Maximize (${keysText('maximize')})`} onClick={() => setMaxId(m => m ? null : t.id)}>{maxId === t.id ? '⤡' : '⤢'}</button>
              <button className="b" title="Task panel" onClick={() => openPanel(t.id)}>☰</button>
              <button className="b" title="Copy the terminal debug record: recent output sizes and escape sequences, without text. Use it when the terminal stops drawing." onClick={() => copyDebugRecord(t)}>⚙</button>
              {t.role !== 'controller' && <button className="b" title={t.openElsewhere ? 'End & archive: archives the task; the session in the other terminal keeps running' : 'End & archive: ends the tmux session and archives the task'} onClick={() => confirmEnd() ? setEnding(t.id) : endTask(t)}>⏻</button>}
              <button className="b" title={`${group ? `Remove from ${group.name}` : 'Remove from this view'} (${keysText('removeWindow')}). The agent keeps running.`} onClick={() => removeFromView(t.id)}>✕</button></>}
            </div>
            <div className={`wb ${(sp => sp.open && canRun(t) && !held(t.id).browser ? `split ${sp.side}` : '')(splitOf(t.id))}`}>{asking.has(t.id) && <AskPanel task={t} close={() => toggleAsk(t.id)} onSpinOff={onSpinOff} />}{t.openElsewhere ? <div className="empty" style={{ padding: 16 }}>Running in another terminal ({t.openElsewhere?.tty}). <button className="btn" onClick={() => openPanel(t.id)}>Options…</button></div>
              : t.status === 'suspended' ? <div className="empty" style={{ padding: 16 }}>Suspended. <button className="btn" onClick={() => openPanel(t.id)}>Resume…</button></div>
              // a tmux window has one size: while this task's panel shows its terminal, the tile waits
              : held(t.id).terminal ? <div className="tile-in-panel"><div>The terminal shows in the Terminal tab of the task panel.</div><div className="sub">One terminal per task at a time, so neither is cut off. Another tab in the panel, or closing the panel, brings it back here.</div><button className="btn" onClick={() => openPanel(null)}>Show it here instead</button></div>
              // the terminal stays the last child, so opening or closing the browser does not mount it again
              : <>{splitOf(t.id).open && canRun(t) && !held(t.id).browser && <div className="wb-browser"><BrowserView id={t.id} title={`#${t.num} ${t.title}`} autostart={startHere.current.has(t.id)} /></div>}
                <Terminal taskId={t.id} fontSize={font[t.id] || 13} onFocus={() => setFocused(t.id)} /></>}</div>
          </div>
        ))}
      </div>
      {focusMode && <div className="fm-bar" title="Move the pointer to the top edge to show the tabs and toolbar"><span>Focus mode</span><button className="btn primary" onClick={() => setFocusMode(false)}>Exit {keyLabel('focusMode') && <kbd>{keyLabel('focusMode')}</kbd>}</button></div>}
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

function GroupMenu({ g, archiveCount, onArchiveAll, close, onDeleted }: { g: Group; archiveCount: number; onArchiveAll: (g: Group, deleteGroup: boolean) => void; close: () => void; onDeleted: (g: Group) => void }) {
  const [name, setName] = useState(g?.name || '');
  if (!g) return null;
  return (
    <div className="gmenu" style={{ left: 12, top: 44 }} onKeyDown={e => { if (e.key === 'Escape') close(); }}>
      <h4>Group</h4>
      <input type="text" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { api.updateGroup(g.id, { name }); close(); } }} />
      <div style={{ color: 'var(--dim)', margin: '8px 0 2px' }}>Colour</div>
      <div className="colors">{GCOLORS.map(c => <i key={c} className={c === g.color ? 'on' : ''} style={{ background: c }} onClick={() => api.updateGroup(g.id, { color: c })} />)}</div>
      <div className="mi" onClick={() => { openInWindow('g:' + g.id); close(); }}>↗ Open in its own window</div>
      <div className={`mi danger ${archiveCount ? '' : 'off'}`} title={archiveCount ? 'Ends every task in this group and archives it. You confirm first.' : 'No task in this group is left to archive'} onClick={() => { if (archiveCount) onArchiveAll(g, false); }}>Close and archive all ({archiveCount})</div>
      {archiveCount > 0 && <div className="mi danger" onClick={() => onArchiveAll(g, true)}>Close, archive all and delete group</div>}
      <div className="mi danger" onClick={async () => { const d = await api.deleteGroup(g.id); close(); onDeleted(d); }}>Delete group <span style={{ color: 'var(--dim)' }}>(tasks are not affected)</span></div>
      <div className="row"><button className="btn" onClick={close}>Close</button><button className="btn primary" onClick={() => { if (name.trim() && name !== g.name) api.updateGroup(g.id, { name: name.trim() }); close(); }}>Save</button></div>
    </div>
  );
}

// One confirmation and summary for both group archive actions. The task list is fixed when the user confirms.
// The combined action deletes the group only after all tasks archive. Its summary keeps the deleted group for undo.
function ArchiveAllPanel({ g, deleteGroup, groups, tasks, close, onDeleted, onRestored, onEnded, toast }: { g: Group; deleteGroup: boolean; groups: Group[]; tasks: Task[]; close: () => void; onDeleted: () => void; onRestored: () => void; onEnded: (ids: string[]) => void; toast: Props['toast'] }) {
  const plan = archivePlan(g, groups, tasks);
  const [run, setRun] = useState<null | { list: ArchiveTarget[]; finished: number; result?: ArchiveResult; deleted?: Group; deleteError?: string; restored?: 'running' | 'done' | string[] }>(null);
  const list = run ? run.list : plan.targets;
  const num = (id: string) => '#' + (tasks.find(t => t.id === id)?.num ?? '?');
  const plural = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  const restore = async (done: ArchiveResult['done'], deleted?: Group) => {
    setRun(r => r && { ...r, restored: 'running' });
    let failed: string[];
    try {
      failed = deleted ? await restoreGroupAndTasks(deleted, done, api.restoreGroup, api.setStatus) : await restoreAll(done, api.setStatus);
      if (deleted) onRestored();
    } catch (e) { toast(`Could not restore group “${g.name}”: ${e instanceof Error ? e.message : String(e)}`); setRun(r => r && { ...r, restored: undefined }); return; }
    setRun(r => r && { ...r, restored: failed.length ? failed : 'done' });
    toast(failed.length ? `Could not restore ${failed.map(num).join(', ')}.` : `Restored ${deleted ? 'the group and ' : ''}${plural(done.length)} in ${g.name}. Tasks that were set aside stay set aside. The others are suspended.`);
  };
  const start = async () => {
    const frozen = plan.targets;
    setRun({ list: frozen, finished: 0 });
    const outcome = deleteGroup
      ? await archiveAndDelete(g, frozen.map(x => x.task), api.kill, id => api.deleteGroup(id, true), finished => setRun(r => r && { ...r, finished }))
      : { archive: await archiveAll(frozen.map(x => x.task), api.kill, finished => setRun(r => r && { ...r, finished })) };
    const result = outcome.archive;
    setRun(r => r && { ...r, result, deleted: outcome.deleted, deleteError: outcome.deleteError });
    onEnded(result.done.map(d => d.id));
    if (outcome.deleted) onDeleted();
    if (outcome.deleted) toast(`Archived ${plural(result.done.length)} and deleted “${g.name}”.`, { label: 'Restore group and tasks', fn: () => restore(result.done, outcome.deleted) });
    else if (result.done.length) toast(`Archived ${plural(result.done.length)} in ${g.name}.${result.failed.length ? ` ${result.failed.length} failed.` : ''}${outcome.deleteError ? ` Group deletion failed: ${outcome.deleteError}` : ''}`, { label: 'Restore all', fn: () => restore(result.done) });
    else toast(`Could not archive any task in ${g.name}.`);
  };
  const busy = !!run && !run.result;
  const risky = plan.working + plan.waiting;
  return (
    <div className="gmenu garch" style={{ left: 12, top: 44 }} onKeyDown={e => { if (e.key === 'Escape' && !busy) close(); }}>
      <h4>{deleteGroup ? 'Close, archive all and delete' : 'Close and archive all'} in “{g.name}”</h4>
      {!run && <>
        <div>This ends the tmux session of {plural(plan.targets.length)} and archives {plan.targets.length === 1 ? 'it' : 'them'}. {deleteGroup ? 'The group is deleted only after every task is archived.' : 'The group stays.'}</div>
        <div className="garch-sum">{plan.working} working now · {plan.waiting} waiting for you (needs you, stopped or review){plan.notRunning ? ` · ${plan.notRunning} not running (suspended or set aside)` : ''}</div>
        {risky > 0 && <div className="sel-warn garch-warn">⚠ {plural(risky)} {risky === 1 ? 'is' : 'are'} working or waiting for you. {risky === 1 ? 'Its' : 'Their'} running session ends now: a turn in progress stops and an open question is lost.</div>}
      </>}
      {busy && <div className="garch-sum">Archiving… {run.finished} of {run.list.length} done</div>}
      {run?.result && <div className="garch-sum">Archived {run.result.done.length} of {plural(run.list.length)} in {g.name}.{run.result.failed.length ? ` ${run.result.failed.length} failed (listed below).` : ''}</div>}
      {run?.result && deleteGroup && <div className={run.deleted ? 'garch-sum' : 'sel-warn'}>{run.deleted ? 'The group was deleted.' : run.deleteError ? `The group stays. Deletion failed: ${run.deleteError}` : 'The group stays. Retry the failed tasks from this group.'}</div>}
      <div className="garch-list">{list.map(({ task: t, alsoIn }) => { const f = run?.result?.failed.find(x => x.id === t.id); const ok = run?.result?.done.some(x => x.id === t.id); return (
        <div key={t.id} className="garch-row"><Dot s={t.status} /><span className="n">#{t.num}</span><span className="ti" title={t.title}>{t.title}</span>
          <span className={`st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span>
          {alsoIn.length > 0 && <span className="garch-also">also in {alsoIn.join(', ')}</span>}
          {ok && <span className="garch-ok">archived</span>}{f && <span className="sel-warn">failed: {f.error}</span>}</div>); })}</div>
      {run?.result && run.result.done.length > 0 && <div className="garch-sum">Restore all sets them back as the single Restore does. They come back suspended and show on the canvas again after you resume them.</div>}
      {Array.isArray(run?.restored) && <div className="sel-warn">Could not restore {run.restored.map(num).join(', ')}.</div>}
      <div className="row">
        {!run && <><button className="btn" autoFocus onClick={close}>Cancel</button><button className="btn danger" disabled={!plan.targets.length} onClick={start}>{deleteGroup ? `Close, archive ${plural(plan.targets.length)} and delete ${g.name}` : `Close and archive ${plural(plan.targets.length)}`}</button></>}
        {run?.result && <>{run.result.done.length > 0 && <button className="btn" disabled={!!run.restored} onClick={() => restore(run.result!.done, run.deleted)}>{run.restored === 'done' ? 'Restored' : run.restored === 'running' ? 'Restoring…' : run.deleted ? 'Restore group and tasks' : `Restore all (${run.result.done.length})`}</button>}<button className="btn primary" onClick={close}>Close</button></>}
      </div>
    </div>
  );
}
