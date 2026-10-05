import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Group, MachineInfo, SpinOffExchange, Task } from './api';
import { AGENT_NAME, ATTN, api, dismissBanner, fmtWait, setViewing, useStore } from './api';
import { awayBanner, linkText } from './serverStatus';
import { ACTIONS, CTX_NAME, fmtCombo, hit, hitIn, inBrowser, keyLabel, keysOf, keysText, useKeymap } from './keys';
import { stepGlass, toggleGlass } from './controllerView';
import { useAppWindow } from './appWindow';
import { Canvas, openInWindow, viewName } from './components/Canvas';
import { Import } from './components/Import';
import { NewTask } from './components/NewTask';
import { StyleSwitcher } from './components/StyleSwitcher';
import { TaskPanel } from './components/TaskPanel';
import { Terminal } from './components/Terminal';
import { overloadBanners } from './agentErrorText';
import { AgentChip, Dot, ErrorMark, StatusLabel, ThreeLines } from './components/ui';
import { ManagerBadge } from './components/ManagerBoard';
import { setManagerGroups } from './managerBoard';
import { BoardView, ListView } from './components/Views';
import { GraphView } from './components/Graph';
import { LinkedWork, LinkMarker } from './components/Links';
import { isReplaced, linkOrder, treeDepth, waitingCount } from './links';
import { InboxPage } from './components/Mail';
import { AccountsPage } from './components/Accounts';
import { SettingsPage } from './components/Settings';
import { PermitsPage } from './components/Permits';
import { NoticeStack } from './components/NoticeStack';
import { liveApprovals, showInStack } from './stack';
import { useCardAlerts } from './cardAlert';
import { WaitingPage, waitingRows } from './components/Waiting';
import { WaitingChips } from './components/WaitingChips';
import { itemsText, rowMatches, targetText, waitingHash, waitTarget, type WaitFilter, type WaitTarget } from './waitingSummary';
import { quietTaskIds } from './dismiss';
import { StatsPage } from './components/Stats';
import { PerfMonitor } from './components/PerfMonitor';
import type { DocumentLink } from './documentLinks';
import { previewHtml, readMarkdown } from './components/Docs';
import { archiveTriageTask, confirmTriageArchive } from './triageArchive';
import { cancelHold, holdView, subscribeHold } from './holdRun';
import { HOLD_MS, SHOW_MS } from './bangCommand';
import type { PanelTab } from './panelShare';

type Page = 'list' | 'board' | 'canvas' | 'graph' | 'waiting' | 'inbox' | 'permits' | 'accounts' | 'stats' | 'settings';
// #list · #board · #canvas · #canvas:<view>  (view = g:<group> | needs | live | t:<id,id>) · #settings:<section>
function parseHash(): { page: Page; view?: string } {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === 'review' || h.startsWith('inbox:')) return { page: 'inbox' }; // #inbox:<messages|sent>:<message id> (MessageCard.tsx)
  if (h.startsWith('canvas:')) return { page: 'canvas', view: h.slice(7) };
  if (h.startsWith('settings:')) return { page: 'settings' }; // #settings:<section> (Settings scrolls to it)
  if (h.startsWith('waiting:')) return { page: 'waiting' }; // #waiting:<filter> (waitingSummary.ts hashKind)
  return { page: (['list', 'board', 'canvas', 'graph', 'waiting', 'inbox', 'permits', 'accounts', 'stats', 'settings'].includes(h) ? h : 'list') as Page };
}
export const SOLO = new URLSearchParams(location.search).get('solo') === '1';
export interface Toast { id: number; text: string; expiresAt: number; action?: { label: string; fn: () => void } }

const TOAST_DURATION = 5000;

function ToastNotice({ toast, dismiss }: { toast: Toast; dismiss: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, toast.expiresAt - Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setRemaining(Math.max(0, toast.expiresAt - Date.now())), 100);
    return () => clearInterval(timer);
  }, [toast.expiresAt]);
  const seconds = Math.ceil(remaining / 1000);
  const circumference = 2 * Math.PI * 11;
  return <div className="toast" role="status">
    <div className="b">{toast.text}<small>Closes automatically</small></div>
    {toast.action && <button className="btn" onClick={() => { toast.action!.fn(); dismiss(); }}>{toast.action.label}</button>}
    <span className="toast-timer" aria-label={`Closes in ${seconds} seconds`}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><circle className="toast-timer-track" cx="14" cy="14" r="11" /><circle className="toast-timer-progress" cx="14" cy="14" r="11" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining / TOAST_DURATION)} /></svg>
      <span>{seconds}</span>
    </span>
    <button className="toast-dismiss" onClick={dismiss}>Dismiss</button>
  </div>;
}

// The card for a hold on a "! <command>" (holdRun.ts). It shows the whole command and the task that gets it.
function HoldCard({ tasks }: { tasks: Task[] }) {
  const hold = useSyncExternalStore(subscribeHold, holdView);
  if (!hold || (hold.phase === 'holding' && hold.elapsed < SHOW_MS)) return null;
  const task = tasks.find(t => t.id === hold.taskId);
  const where = task ? `#${task.num} ${task.title}` : hold.taskId;
  const remaining = Math.max(0, HOLD_MS - hold.elapsed);
  const circumference = 2 * Math.PI * 11;
  const title = hold.phase === 'holding' ? `Running in ${(remaining / 1000).toFixed(1)} s` : hold.phase === 'typing' ? 'Typing the command' : hold.phase === 'ran' ? 'Command sent' : 'Command not run';
  return <div className={`toast hold-card ${hold.phase}`} role="status">
    <div className="b">
      <b>{title}</b>
      <pre className="hold-command">! {hold.command}</pre>
      <small>{hold.message || (hold.phase === 'holding' ? `Types this into ${where} and presses Enter. Release the button, move the pointer or press Escape to cancel.` : `In ${where}`)}</small>
    </div>
    {hold.phase === 'holding' && <span className="toast-timer" aria-label={`Runs in ${Math.ceil(remaining / 1000)} seconds`}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><circle className="toast-timer-track" cx="14" cy="14" r="11" /><circle className="toast-timer-progress" cx="14" cy="14" r="11" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining / HOLD_MS)} /></svg>
      <span>{Math.ceil(remaining / 1000)}</span>
    </span>}
    {hold.phase !== 'typing' && <button className="toast-dismiss" onClick={() => cancelHold()}>{hold.phase === 'holding' ? 'Cancel' : 'Dismiss'}</button>}
  </div>;
}

export function App() {
  const { tasks: allTasks, groups, approvals, pending, dismissedPending, dismissals, machines, connected, link, banner, cardsLoaded } = useStore();
  useCardAlerts(approvals, pending, cardsLoaded);
  // the "for N s" in the server line and the banner count while the server does not answer
  const [, setTick] = useState(0);
  useEffect(() => { if (connected) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [connected]);
  // the banner after a restart goes away after 30 s
  useEffect(() => { if (!banner) return; const timer = setTimeout(dismissBanner, 30000); return () => clearTimeout(timer); }, [banner]);
  const away = awayBanner(link);
  useKeymap();
  const [addMachine, setAddMachine] = useState(false);
  const [keysHelp, setKeysHelp] = useState(false);
  // Taskboard was updated while automatic reloading is off (Settings): offer a reload
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => { const on = () => setUpdateReady(true); addEventListener('taskboard:update', on); return () => removeEventListener('taskboard:update', on); }, []);
  const [machineName, setMachineName] = useState('');
  const [role, setRole] = useState('production');
  useEffect(() => { api.info().then(i => { setMachineName(i.machine); setRole(i.role || 'production'); document.title = `Taskboard · ${i.machine}`; }).catch(() => {}); }, [connected]);
  // The tmux server runs from a deleted folder (server/tmux-health.ts checks every minute). Close hides it for that
  // tmux server process only.
  const [tmuxProblem, setTmuxProblem] = useState<MachineInfo['tmuxProblem']>(null);
  const [tmuxClosed, setTmuxClosed] = useState(0);
  useEffect(() => {
    const read = () => api.info().then(i => setTmuxProblem(i.tmuxProblem || null)).catch(() => {});
    read(); const timer = setInterval(read, 60000); return () => clearInterval(timer);
  }, [connected]);
  // the controller agent is reached with ⌃⌥K and the sidebar; it is not one of the tasks on the board
  const controller = allTasks.find(t => t.role === 'controller');
  const tasks = useMemo(() => allTasks.filter(t => t.role !== 'controller'), [allTasks]);
  const init = parseHash();
  const [page, setPage] = useState<Page>(SOLO ? 'canvas' : init.page);
  const [view, setViewState] = useState<string>(init.view || localStorage.getItem('tb-view') || 'live');
  // the open task panel is kept in the address (?open=<id>&tab=…), so a reload or a reopened window shows it again
  const initParams = new URLSearchParams(location.search);
  const [openId, setOpenIdRaw] = useState<string | null>(initParams.get('open'));
  const [openTab, setOpenTab] = useState<PanelTab | undefined>((initParams.get('tab') as PanelTab) || undefined);
  const [documentLink, setDocumentLink] = useState<DocumentLink | null>(null);
  const setOpenId = (id: string | null, tab?: PanelTab) => { setOpenTab(tab); setOpenIdRaw(id); };
  // the tab in front in the open panel, as TaskPanel reports it; until it does, the tab it opens with
  const [panelShows, setPanelShows] = useState<{ id: string; tab: PanelTab } | null>(null);
  const panelTab = panelShows && panelShows.id === openId ? panelShows.tab : openTab || 'terminal';
  useEffect(() => {
    const onDocument = (event: Event) => {
      const link = (event as CustomEvent<DocumentLink>).detail;
      setDocumentLink(link);
      if (link.reviewId) { setOpenId(null); go('inbox'); }
      else setOpenId(link.task, 'docs');
    };
    const onTask = (event: Event) => setOpenId((event as CustomEvent<string>).detail);
    const onVaultDocument = (event: Event) => {
      const link = (event as CustomEvent<{ path: string; heading?: string }>).detail;
      const name = link.path.split('/').pop() || link.path;
      if (/\.html?$/i.test(link.path)) previewHtml(link.path, name, link.heading);
      else readMarkdown(link.path, name, { heading: link.heading });
    };
    addEventListener('taskboard:document-link', onDocument);
    addEventListener('taskboard:task-link', onTask);
    addEventListener('taskboard:vault-document', onVaultDocument);
    return () => { removeEventListener('taskboard:document-link', onDocument); removeEventListener('taskboard:task-link', onTask); removeEventListener('taskboard:vault-document', onVaultDocument); };
  });
  useEffect(() => {
    const u = new URL(location.href);
    if (openId) u.searchParams.set('open', openId); else u.searchParams.delete('open');
    if (openId && openTab) u.searchParams.set('tab', openTab); else u.searchParams.delete('tab');
    if (u.href !== location.href) history.replaceState(null, '', u);
  }, [openId, openTab]);
  const [newOpen, setNewOpen] = useState(false);
  const [spinOff, setSpinOff] = useState<{ exchange: SpinOffExchange; task: Task } | null>(null);
  const [newTaskToFocus, setNewTaskToFocus] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(() => location.hash === '#import');
  const [triage, setTriage] = useState(false);
  // the linked work overview (components/Links.tsx), opened from any view with showLinkedWork() in links.ts
  const [linked, setLinked] = useState<{ task?: string; group?: string } | null>(null);
  useEffect(() => { const on = (e: Event) => setLinked((e as CustomEvent<{ task?: string; group?: string }>).detail); addEventListener('tb-linked-work', on); return () => removeEventListener('tb-linked-work', on); }, []);
  // groups opened as a tree in the sidebar
  const [openGroups, setOpenGroups] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('tb-rail-groups') || '[]'); } catch { return []; } });
  // the Manager badges read which task manages which group (managerBoard.ts)
  useEffect(() => setManagerGroups(groups), [groups]);
  const toggleGroup = (id: string) => setOpenGroups(l => { const n = l.includes(id) ? l.filter(x => x !== id) : [...l, id]; try { localStorage.setItem('tb-rail-groups', JSON.stringify(n)); } catch { /* storage off */ } return n; });
  const [railHidden, setRailHidden] = useState(() => SOLO || localStorage.getItem('tb-rail') === 'hidden');
  const [focusMode, setFocusMode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [groupPrompt, setGroupPrompt] = useState<string[] | null>(null);

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, action, expiresAt: Date.now() + TOAST_DURATION }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), TOAST_DURATION);
  }, []);

  useEffect(() => { const on = () => { const p = parseHash(); setPage(SOLO ? 'canvas' : p.page); if (p.view) setViewState(p.view); }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => { document.body.dataset.page = page; }, [page]);
  const setView = (v: string) => { setViewState(v); if (!SOLO) localStorage.setItem('tb-view', v); history.replaceState(null, '', `${location.search}#canvas:${encodeURIComponent(v)}`); };
  const go = (p: Page) => { location.hash = p === 'canvas' ? `canvas:${encodeURIComponent(view)}` : p; setPage(p); };

  const open = allTasks.find(t => t.id === openId);
  const openController = async () => { if (openId === 'controller') { setOpenId(null); return; } if (!controller || controller.status === 'suspended') await api.startController().catch(e => toast(String(e.message || e))); setOpenId('controller'); };
  // Inside the Mac app: mark the page so CSS adds drag areas, and follow the window buttons (shown near the top edge).
  useAppWindow();
  // The Mac app (desktop/main.cjs) opens a task, triage or the controller from its menu-bar item with this event.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ task?: string; triage?: boolean; controller?: boolean; newTask?: boolean; settings?: string; waiting?: boolean }>).detail || {};
      if (d.newTask) setNewOpen(true);
      // the app menu item "Restart Taskboard Server…" opens Settings at the server section
      if (d.settings) { location.hash = `settings:${d.settings}`; setPage('settings'); }
      if (d.task) setOpenId(d.task);
      if (d.triage) setTriage(true);
      // the menu-bar item and the Dock menu: "Open Waiting"
      if (d.waiting) go('waiting');
      if (d.controller && openId !== 'controller') openController();
    };
    addEventListener('taskboard:open', on); return () => removeEventListener('taskboard:open', on);
  }, [openId, controller?.status]);
  // quiet: tasks whose waiting item the user dismissed (dismiss.ts); the counts and triage leave them out
  const quiet = useMemo(() => quietTaskIds(tasks, pending, dismissedPending, dismissals), [tasks, pending, dismissedPending, dismissals]);
  const queue = useMemo(() => tasks.filter(t => ATTN.includes(t.status) && !quiet.has(t.id)).sort((a, b) => b.waitMin - a.waitMin), [tasks, quiet]);
  const needs = tasks.filter(t => t.status === 'needs-you' && !quiet.has(t.id)), unread = tasks.filter(t => t.status === 'unread');
  // everything on the Waiting page: question cards, approval cards, and tasks that wait with no card
  const waitRows = useMemo(() => waitingRows(tasks, approvals, pending, quiet, allTasks), [tasks, allTasks, approvals, pending, quiet]);
  const waitingCount = waitRows.length;
  // a click on a waiting count (WaitingChips, the sidebar): the card in the stack, the task panel or the Waiting page.
  // The Waiting page has no stack, so there a click for one card opens the filter of the count.
  const actWait = (t: WaitTarget, kind: WaitFilter | 'all') => {
    if ('task' in t) setOpenId(t.task);
    else if ('stack' in t && page !== 'waiting') showInStack(t.stack);
    else { location.hash = waitingHash('waiting' in t ? t.waiting : kind); setPage('waiting'); }
  };
  const canvasIds = useMemo(() => {
    if (page !== 'canvas') return [];
    if (view.startsWith('g:')) return groups.find(g => g.id === view.slice(2))?.tasks || [];
    if (view.startsWith('t:')) return view.slice(2).split(',');
    return tasks.filter(t => t.status !== 'archived').map(t => t.id);
  }, [page, view, groups, tasks]);

  useEffect(() => { setViewing([...(openId ? [openId] : []), ...canvasIds]); }, [openId, canvasIds.join()]);
  useEffect(() => { document.title = SOLO ? `${viewName(view, groups, tasks)} · Taskboard` : (queue.length + unread.length ? `(${queue.length + unread.length}) ` : '') + 'Taskboard'; }, [queue.length, unread.length, view, groups, tasks]);
  useEffect(() => { if (!SOLO) localStorage.setItem('tb-rail', railHidden ? 'hidden' : 'shown'); }, [railHidden]);

  // keys (keys.ts): a key of the Canvas, Review or Graph page or of triage wins over the same key here (⌃⌥T on the Canvas
  // starts the new task in the canvas view). Esc goes to the task browser page when the focus is in the browser.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((triage && hitIn(e, 'triage')) || (page === 'canvas' && hitIn(e, 'canvas')) || (page === 'inbox' && hitIn(e, 'review')) || (page === 'graph' && hitIn(e, 'graph'))) return;
      const act = (f: () => void) => { e.preventDefault(); e.stopPropagation(); f(); };
      if (hit(e, 'newTask')) return act(() => setNewOpen(true));
      if (hit(e, 'controller')) return act(openController);
      if (hit(e, 'sidebar')) return act(() => { if (!SOLO) setRailHidden(h => !h); });
      if (hit(e, 'triage')) return act(() => setTriage(x => !x));
      if (hit(e, 'needsView')) return act(() => { if (!SOLO) { setView('needs'); setPage('canvas'); } });
      if (hit(e, 'keysHelp')) return act(() => setKeysHelp(x => !x));
      if (hit(e, 'glassMore')) return act(() => stepGlass(1));
      if (hit(e, 'glassLess')) return act(() => stepGlass(-1));
      if (hit(e, 'glassToggle')) return act(() => toggleGlass());
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable=true],.xterm') || inBrowser(e)) return;
      if (e.key === 'Escape') { if (keysHelp) setKeysHelp(false); else if (triage) setTriage(false); else if (openId) setOpenId(null); else if (selected.size) setSelected(new Set()); }
    };
    addEventListener('keydown', on, true); return () => removeEventListener('keydown', on, true);
  });

  const toggleSel = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const showOnCanvas = (id: string) => {
    if (view.startsWith('g:')) { const g = groups.find(x => x.id === view.slice(2)); if (g && !g.tasks.includes(id)) api.updateGroup(g.id, { add: id }); }
    else if (view.startsWith('t:') && !view.slice(2).split(',').includes(id)) setView(view + ',' + id);
    else if (view === 'needs' || (view === 'ungrouped' && groups.some(g => g.tasks.includes(id)))) setView('live');
    setOpenId(null); go('canvas');
  };
  const item = (t: Task) => <div key={t.id} className="rail-item" onClick={() => setOpenId(t.id)}><Dot s={t.status} /><span className="t">{t.title}</span><ManagerBadge id={t.id} /><LinkMarker t={t} tasks={tasks} /><span className="m">{t.agent === 'claude' ? 'CC' : t.agent === 'codex' ? 'CX' : 'AG'}</span></div>;
  const hideChrome = focusMode && page === 'canvas';
  // pending reviews for the sidebar count
  const [reviewCount, setReviewCount] = useState(0);
  useEffect(() => {
    // pending documents, incoming messages that wait for you, and unread notes from tasks (GET /api/a2anotes/inbox-count)
    const load = () => Promise.all([fetch('/api/review').then(r => r.json()), fetch('/api/a2anotes/inbox-count').then(r => r.json()).catch(() => ({ count: 0 }))])
      .then(([docs, inbox]) => setReviewCount(docs.filter((x: { state: string }) => x.state === 'pending').length + (Number(inbox.count) || 0))).catch(() => {});
    void load(); const timer = setInterval(load, 5000); return () => clearInterval(timer);
  }, []);

  return (
    <div className={`app ${railHidden || hideChrome ? 'rail-off' : ''}`}>
      {!railHidden && !hideChrome && <aside className="rail">
        <div className="brand" title={machineName ? `Taskboard on ${machineName}` : undefined}><Logo />Taskboard<small>{connected ? (machineName || 'v0.2') : 'offline'}</small></div>
        <button className="newtask" onClick={() => setNewOpen(true)} title={`New task: ${keysText('newTask')}`}>＋ New task {keyLabel('newTask') && <kbd>{keyLabel('newTask')}</kbd>}</button>
        <div className="rail-item ctl-item" onClick={openController} title={`The controller agent manages the other agents. Shortcut: ${keysText('controller')}`}>{controller ? <Dot s={controller.status} /> : <span className="dot idle" />}<span className="t"><b>Controller</b>{controller ? <span className="sub"> · {AGENT_NAME[controller.agent]}</span> : ' · start'}</span>{controller?.remoteUrl && <a className="rc-link" href={controller.remoteUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title="Remote Control is on: open the controller on claude.ai or the Claude mobile app">📱</a>}{keyLabel('controller') && <kbd>{keyLabel('controller')}</kbd>}</div>
        <button className="importbtn" onClick={() => setImportOpen(true)} title="Bring in Claude Code, Codex and Antigravity sessions you started outside Taskboard">⇪ Import sessions</button>
        <nav className="nav">
          {(['list', 'board', 'graph', 'canvas', 'waiting', 'inbox', 'permits', 'accounts', 'stats', 'settings'] as Page[]).map(p => <a key={p} href={p === 'canvas' ? `#canvas:${encodeURIComponent(view)}` : `#${p}`} className={page === p ? 'on' : ''} onClick={() => go(p)}>{p[0].toUpperCase() + p.slice(1)}{p === 'list' && <span className="n">{tasks.filter(t => t.status !== 'archived').length}</span>}{p === 'waiting' && waitingCount > 0 && <span className="n needs" title={itemsText(waitingCount)}>{waitingCount}</span>}{p === 'inbox' && reviewCount > 0 && <span className="n" style={{ color: 'var(--st-review)' }}>{reviewCount}</span>}</a>)}
        </nav>
        <div className="rail-scroll">
          <div className="rail-sec"><h6>Needs you{needs.length ? (w => <button type="button" className="rail-count" onClick={() => actWait(w, 'needs')} aria-label={`${needs.length} ${needs.length === 1 ? 'task needs' : 'tasks need'} you. ${targetText(w)}`} title={targetText(w)}>{needs.length}</button>)(waitTarget(waitRows.filter(r => rowMatches('needs', r, tasks, pending)), 'needs')) : <span>0</span>}</h6>{needs.map(item)}{!needs.length && <div className="rail-empty">Nothing waiting</div>}</div>
          <div className="rail-sec"><h6>Done · unread<span>{unread.length}</span></h6>{unread.map(item)}{!unread.length && <div className="rail-empty">All read</div>}</div>
          {<div className="rail-sec"><h6>Machines<span className="addg" title="Add a machine" onClick={() => setAddMachine(true)}>＋</span></h6>
            {machines.map(m => <div key={m.id} className={`rail-item ${m.online ? '' : 'off'}`} title={m.local ? 'This machine' : `${m.url}${m.error ? ' · ' + m.error : ''}`}><span className={`mdot ${m.online ? '' : 'off'}`} /><span className="t">{m.name}{m.local ? ' (this)' : ''}</span><span className="m">{m.local ? tasks.filter(t => !t.machine && t.status !== 'archived').length : m.online ? `${m.latency ?? '?'} ms · ${m.tasks ?? 0}` : 'offline'}</span></div>)}
          </div>}
          <div className="rail-sec"><h6>Groups<span className="addg" title="New group" onClick={() => setGroupPrompt([])}>＋</span></h6>
            {groups.map(g => { const w = g.tasks.filter(id => ATTN.includes(tasks.find(t => t.id === id)?.status as Task['status']) && !quiet.has(id)).length; return (
              <div key={g.id}><div className={`rail-item ${page === 'canvas' && view === 'g:' + g.id ? 'on' : ''}`} onClick={() => { setView('g:' + g.id); setPage('canvas'); }}>
                <span className="gcaret" role="button" aria-label={openGroups.includes(g.id) ? 'Close the task tree' : 'Open the task tree'} title="Show the tasks of this group, each under the task it waits for" onClick={e => { e.stopPropagation(); toggleGroup(g.id); }}>{openGroups.includes(g.id) ? '▾' : '▸'}</span>
                <span className="dot" style={{ background: g.color, borderRadius: 3 }} /><span className="t">{g.name}</span><span className="m">{w > 0 && <span style={{ color: 'var(--st-needs)' }}>● </span>}{g.tasks.length}</span>
                <button className="gopen" title="Open in its own window" onClick={e => { e.stopPropagation(); openInWindow('g:' + g.id); }}>↗</button></div>
                {openGroups.includes(g.id) && <GroupTree g={g} tasks={tasks} open={setOpenId} />}</div>); })}
            {!groups.length && <div className="rail-empty">No groups yet</div>}
          </div>
        </div>
        <div className="rail-foot">
          <div className="row" title="The server runs as the login service com.taskboard.server (launchd), not in the app. Quitting the app does not stop it."><span className={`dot ${connected ? 'ok' : link.state === 'restarting' ? 'needs-you' : 'stopped'}`} />{linkText(link)}</div>
          <div className="row" style={{ paddingLeft: 15 }}>{tasks.filter(t => !['archived', 'suspended', 'parked'].includes(t.status) && !t.openElsewhere).length} tmux sessions · vault <code>~/AgentVault</code></div>
          <div className="row" style={{ paddingLeft: 15 }}><button className="btn ghost" onClick={() => setKeysHelp(true)}>Keyboard shortcuts {keyLabel('keysHelp') && <kbd>{keyLabel('keysHelp')}</kbd>}</button></div>
          <div className="row" style={{ paddingLeft: 15 }}><button className="btn ghost" onClick={() => Notification.requestPermission()}>{typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Notifications on' : 'Turn on notifications'}</button></div>
        </div>
      </aside>}
      <div className="main">
        {!hideChrome && <header className="top">
          {!SOLO && <button className="btn icon" title={`Hide or show the sidebar (${keysText('sidebar')})`} onClick={() => setRailHidden(h => !h)}>◧</button>}
          <h1>{SOLO ? viewName(view, groups, tasks) : page[0].toUpperCase() + page.slice(1)}</h1>
          <span className="spacer" />
          <WaitingChips queue={queue} tasks={tasks} approvals={approvals} pending={pending} rows={waitRows} act={actWait} triageKey={keyLabel('triage')} />
          <span className="spacer" />
          {page === 'list' && <label className="opt" title="Show archived tasks"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> <span className="opt-text">Show archived</span></label>}
          <StyleSwitcher />
        </header>}
        <div className="view">
          {page === 'list' && <ListView tasks={tasks} groups={groups} open={setOpenId} showArchived={showArchived} selected={selected} toggleSel={toggleSel} />}
          {page === 'board' && <BoardView tasks={tasks} groups={groups} open={setOpenId} openDocs={id => setOpenId(id, 'docs')} selected={selected} toggleSel={toggleSel} newGroup={() => setGroupPrompt([])} toast={toast} />}
          {page === 'accounts' && <AccountsPage tasks={allTasks} />}
          {page === 'stats' && <StatsPage />}
          {page === 'settings' && <SettingsPage tasks={allTasks} />}
          {page === 'permits' && <PermitsPage openTask={setOpenId} />}
          {page === 'waiting' && <WaitingPage tasks={tasks} allTasks={allTasks} openTask={setOpenId} openController={openController} toast={toast} />}
          {page === 'inbox' && <InboxPage tasks={tasks} open={(id, tab) => setOpenId(id, tab)} documentLink={documentLink?.reviewId ? documentLink : null} />}
          {page === 'graph' && <GraphView tasks={tasks} groups={groups} open={(id, tab) => setOpenId(id, tab)} />}
          {page === 'canvas' && <Canvas tasks={tasks} groups={groups} view={view} setView={setView} openPanel={(id, tab) => setOpenId(id, tab)} panelTaskId={openId} panelTab={panelTab} selected={selected} toggleSel={toggleSel} clearSel={() => setSelected(new Set())} solo={SOLO} focusMode={focusMode} setFocusMode={setFocusMode} toast={toast} newTask={() => setNewOpen(true)} newTaskToFocus={newTaskToFocus} onNewTaskFocused={() => setNewTaskToFocus(null)} onSpinOff={(exchange, task) => { setSpinOff({ exchange, task }); setNewOpen(true); }} />}
        </div>
      </div>
      {selected.size > 0 && <SelectionBar ids={[...selected]} tasks={tasks} groups={groups} clear={() => setSelected(new Set())} newGroup={ids => setGroupPrompt(ids)} toast={toast} />}
      {open && <TaskPanel key={open.id + (openTab || '')} t={open} tasks={tasks} initialTab={openTab} onTab={tab => setPanelShows({ id: open.id, tab })} documentLink={documentLink?.task === open.id && !documentLink.reviewId ? documentLink : null} groups={groups} onClose={() => setOpenId(null)} onCanvas={showOnCanvas} onOpenTask={setOpenId} toast={toast} />}
      {newOpen && <NewTask groups={groups} initialGroup={page === 'canvas' && view.startsWith('g:') && groups.some(g => g.id === view.slice(2)) ? view.slice(2) : undefined} initialFolder={spinOff?.task.folder} initialMachine={spinOff?.task.machine?.id} spinOff={spinOff?.exchange} onClose={() => { setNewOpen(false); setSpinOff(null); }} onStarted={(id, group, choice) => {
        if (choice) toast(`Auto chose ${choice}.`);
        setNewOpen(false); setSpinOff(null);
        if (page === 'canvas') { setView(group ? `g:${group}` : 'ungrouped'); setNewTaskToFocus(id); }
        else setOpenId(id);
      }} />}
      {importOpen && <Import onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); go('list'); }} />}
      {groupPrompt && <GroupPrompt ids={groupPrompt} close={() => setGroupPrompt(null)} done={(g, openWin) => { setGroupPrompt(null); setSelected(new Set()); toast(`Group “${g.name}” created`); if (openWin) openInWindow('g:' + g.id); else { setView('g:' + g.id); go('canvas'); } }} />}
      {role === 'sandbox' && <div className="sandbox-bar" title={`This is a sandbox: a separate test copy of Taskboard (${machineName}). Its agents and tasks are not your real ones.`}>Sandbox · {machineName} · not your real Taskboard</div>}
      {(away || banner) && <div className={`server-bar ${away ? 'away' : ''}`} role="status">{away || banner?.text}{!away && <button className="btn ghost" onClick={dismissBanner}>Close</button>}</div>}
      {overloadBanners(tasks).length > 0 && <div className="server-bar overload-bar" role="status" title="Taskboard does not switch accounts or models because of this. Each task shows its own error and its own auto-continue state.">
        <div>{overloadBanners(tasks).map(b => <div key={b.account}><b>{b.text}</b></div>)}It usually passes. This is a health note, not a limit.</div>
      </div>}
      {tmuxProblem && tmuxProblem.pid !== tmuxClosed && <div className="server-bar away tmux-bar" role="alert">
        <div>
          {tmuxProblem.text}
          <div className="tmux-bar-cmd">Command: <code>{tmuxProblem.command}</code></div>
          {tmuxProblem.tasks.length > 0 && <details><summary>It ends these sessions ({tmuxProblem.tasks.length})</summary><ul>{tmuxProblem.tasks.map(t => <li key={t}>{t}</li>)}</ul></details>}
        </div>
        <button className="btn ghost" onClick={() => setTmuxClosed(tmuxProblem.pid)}>Close</button>
      </div>}
      {updateReady && <div className="update-bar">A new version of Taskboard is ready. <button className="btn primary" onClick={() => location.reload()}>Reload</button><button className="btn ghost" onClick={() => setUpdateReady(false)}>Later</button></div>}
      {keysHelp && <KeysHelp close={() => setKeysHelp(false)} settings={() => { setKeysHelp(false); go('settings'); location.hash = 'settings:keys'; }} />}
      {addMachine && <AddMachine close={() => setAddMachine(false)} />}
      {linked && <LinkedWork q={linked} tasks={tasks} close={() => setLinked(null)} onGo={id => setOpenId(id)} />}
      {triage && <Triage queue={queue} tasks={tasks} close={() => setTriage(false)} open={id => { setTriage(false); setOpenId(id); }} />}
      {page !== 'waiting' && <NoticeStack approvals={liveApprovals(approvals).filter(a => page !== 'permits' || a.action !== 'permit')} pending={pending} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} showAll={() => go('waiting')} />}
      <PerfMonitor />
      <div className="toasts"><HoldCard tasks={allTasks} />{toasts.map(t => <ToastNotice key={t.id} toast={t} dismiss={() => setToasts(x => x.filter(y => y.id !== t.id))} />)}</div>
    </div>
  );
}

// All shortcuts: the ones in keys.ts (changed on the Settings page), then the keys that cannot be changed.
const FIXED: [string, string, string][] = [
  ['Mac app', '⌘N / ⇧⌘N', 'New window / new canvas window (File menu)'],
  ['Anywhere', 'Esc', 'Close the panel or clear the selection (outside a terminal, a text field and the task browser)'],
  ['Canvas', 'Sideways swipe', 'Scrolls the canvas, or turns one page when Per page is on; Shift + mouse wheel does the same. Over a task browser, the page scrolls instead'],
  ['Graph page', 'Arrows / ↩', 'Select the nearest task / open it'],
  ['Board and canvas', '⌘-click', 'Select several tasks, then act on them in the bar at the bottom'],
];
function KeysHelp({ close, settings }: { close: () => void; settings: () => void }) {
  useKeymap();
  const order = ['Anywhere', 'Mac app', 'Triage', 'Canvas', 'Waiting page', 'Review page', 'Graph page', 'Task browser', 'Board and canvas'];
  const rows: [string, string, string][] = [...ACTIONS.map(a => [CTX_NAME[a.ctx], keysOf(a.id).map(fmtCombo).join(' / ') || '—', a.label] as [string, string, string]), ...FIXED]
    .sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0]));
  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 640 }}>
        <header><h2>Keyboard shortcuts</h2><button className="btn ghost icon" onClick={close}>✕</button></header>
        <div className="body">
          <div className="sub" style={{ marginBottom: 8 }}>Symbols: ⌘ Command · ⌥ Option · ⌃ Control · ⇧ Shift. Keys with ⌘ or ⌃ also work inside a terminal. In the task browser every key goes to the page, except the key that leaves the browser. <button className="btn ghost" onClick={settings}>Change the keys in Settings</button>.</div>
          <table className="keys"><tbody>{rows.map(([where, k, what], i) => <tr key={i}><td className="sub">{i === 0 || rows[i - 1][0] !== where ? where : ''}</td><td><kbd>{k}</kbd></td><td>{what}</td></tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}

function AddMachine({ close }: { close: () => void }) {
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const ok = async () => { setBusy(true); setErr(''); try { await api.addMachine(name.trim(), url.trim(), token.trim()); close(); } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); } };
  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 620 }}>
        <header><h2>Add a machine</h2><button className="btn ghost icon" onClick={close}>✕</button></header>
        <div className="body">
          <div className="help" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            On the other machine: install Taskboard (<code>git clone … ~/taskboard && pnpm install && pnpm build && pnpm start</code>), then publish it on your Tailscale network only with <code>tailscale serve --bg 4317</code>. Its address is shown by <code>tailscale serve status</code> (for example <code>https://studio.your-tailnet.ts.net</code>) and its token is in <code>~/.taskboard/token</code> on that machine.
          </div>
          <div className="field"><label>Name</label><input type="text" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. studio, gpu-box" /></div>
          <div className="field"><label>Address</label><input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://studio.your-tailnet.ts.net" /></div>
          <div className="field"><label>Token</label><input type="text" value={token} onChange={e => setToken(e.target.value)} placeholder="contents of ~/.taskboard/token on that machine" /></div>
          {err && <div className="banner stopped">{err}</div>}
        </div>
        <footer><span style={{ flex: 1 }} /><button className="btn" onClick={close}>Cancel</button><button className="btn primary" disabled={busy || !name || !url || !token} onClick={ok}>{busy ? 'Connecting…' : 'Connect'}</button></footer>
      </div>
    </div>
  );
}

function SelectionBar({ ids, tasks, groups, clear, newGroup, toast }: { ids: string[]; tasks: Task[]; groups: Group[]; clear: () => void; newGroup: (ids: string[]) => void; toast: (s: string) => void }) {
  const list = ids.map(id => tasks.find(t => t.id === id)).filter(Boolean) as Task[];
  const [confirmRm, setConfirmRm] = useState(false);
  const run = async (ps: Promise<unknown>[], verb: string) => { const r = await Promise.allSettled(ps); const bad = r.filter(x => x.status === 'rejected').length; toast(`${verb} ${r.length - bad} task${r.length - bad === 1 ? '' : 's'}${bad ? ` · ${bad} failed` : ''}.`); setConfirmRm(false); clear(); };
  return (
    <div className="selbar">
      <b>{list.length} selected</b><span className="sel-list">{list.map(t => <span key={t.id} className="chip"><Dot s={t.status} /> #{t.num}</span>)}</span>
      <button className="btn primary" onClick={() => openInWindow('t:' + list.map(t => t.id).join(','))} title="A separate browser window with only these terminals">↗ Open together in a new window</button>
      <button className="btn" onClick={() => newGroup(list.map(t => t.id))} title="A named group: a tab on the canvas and a column on the board">＋ New group from these</button>
      <select className="btn" value="" onChange={async e => { const g = groups.find(x => x.id === e.target.value); if (!g) return; await api.updateGroup(g.id, { add: list.map(t => t.id) }); toast(`Added ${list.length} to ${g.name}`); clear(); }}>
        <option value="">Add to group…</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <span className="sel-sep" />
      <button className="btn" onClick={() => run(list.map(t => api.setStatus(t.id, 'parked')), 'Set aside')} title="Take it off Needs you, Unread and triage. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.">Set aside</button>
      <button className="btn" onClick={() => run(list.map(t => api.kill(t.id)), 'Ended and archived')} title="Ends each tmux session (sessions in another terminal keep running) and archives the tasks">End & archive</button>
      {!confirmRm ? <button className="btn danger" onClick={() => setConfirmRm(true)} title="Delete these tasks from Taskboard (asks first). Notes go to ~/.taskboard/trash; the conversations stay in the agents' own history">Remove…</button>
        : <><span className="sel-warn">Remove {list.length} from Taskboard? Their notes go to ~/.taskboard/trash; the conversations stay in Claude Code, Codex or Antigravity.</span>
          <button className="btn danger" onClick={() => run(list.map(t => api.remove(t.id)), 'Removed')}>Yes, remove</button><button className="btn ghost" onClick={() => setConfirmRm(false)}>Cancel</button></>}
      <button className="btn ghost" onClick={clear} title="Unselect all">Clear <kbd>Esc</kbd></button>
    </div>
  );
}

function GroupPrompt({ ids, close, done }: { ids: string[]; close: () => void; done: (g: Group, openWin: boolean) => void }) {
  const [name, setName] = useState('');
  const [openWin, setOpenWin] = useState(false);
  const ok = async () => { if (name.trim()) done(await api.createGroup(name.trim(), ids), openWin); };
  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') close(); if (e.key === 'Enter') ok(); }}>
      <div className="modal" style={{ width: 440 }}>
        <header><h2>New group</h2><button className="btn ghost icon" onClick={close}>✕</button></header>
        <div className="body">
          <div className="field"><label>Name</label><input type="text" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Release 2.3, Needs review, Friday" /></div>
          {ids.length > 0 && <div className="help" style={{ color: 'var(--muted)', fontSize: 12.5 }}>Starts with {ids.length} task{ids.length === 1 ? '' : 's'}.</div>}
          <label className="opt"><input type="checkbox" checked={openWin} onChange={e => setOpenWin(e.target.checked)} /> Open it in its own window</label>
          <div className="help" style={{ fontSize: 12, color: 'var(--dim)' }}>A task can be in any number of groups. Each group is a tab on the canvas and a column on the board.</div>
        </div>
        <footer><span style={{ flex: 1 }} /><button className="btn" onClick={close}>Cancel</button><button className="btn primary" onClick={ok}>Create</button></footer>
      </div>
    </div>
  );
}

// The tasks of a group in the sidebar, each under the open task it waits for. Replaced tasks are one row at the end.
function GroupTree({ g, tasks, open }: { g: Group; tasks: Task[]; open: (id: string) => void }) {
  const [showReplaced, setShowReplaced] = useState(false);
  const list = g.tasks.map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && t.status !== 'archived');
  const replaced = list.filter(isReplaced);
  const rows = treeDepth(linkOrder(showReplaced ? list : list.filter(t => !isReplaced(t)), tasks), tasks, 'deps');
  return <>
    {rows.map(({ t, depth, also }) => <div key={t.id} className="rail-item lk-child" style={{ '--depth': depth } as React.CSSProperties} onClick={() => open(t.id)} title={`#${t.num} ${t.title}${also.length ? ` · also blocked by ${also.map(id => '#' + tasks.find(x => x.id === id)?.num).join(' ')}` : ''}`}>
      {depth > 0 && <span className="lk-indent">└</span>}<Dot s={t.status} /><span className="t">#{t.num} {t.title}</span><ErrorMark t={t} /><ManagerBadge id={t.id} /><LinkMarker t={t} tasks={tasks} /></div>)}
    {replaced.length > 0 && <div className="rail-item lk-child" onClick={() => setShowReplaced(x => !x)} title={replaced.map(t => `#${t.num} ${t.title}`).join('\n')}><span className="lk-mk super">⤳</span><span className="t">{showReplaced ? 'Hide' : 'Show'} {replaced.length} replaced</span></div>}
    {!list.length && <div className="rail-empty lk-child">No live tasks</div>}
  </>;
}

// Triage order: a task that other tasks wait on comes first (rule 1), then a task that nothing else blocks (rule 2),
// then the longest wait (rule 3, the old order). The header switches back to the longest wait first.
function triageWhy(t: Task, tasks: Task[]) {
  const n = waitingCount(t, tasks), blocked = t.link?.state === 'blocked';
  const num = (id: string) => '#' + (tasks.find(x => x.id === id)?.num ?? '?');
  return {
    n, blocked,
    text: [n ? `${n} task${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} on it.` : 'No task waits on it.',
      blocked ? `Also blocked by ${(t.link?.blockedBy || []).map(num).join(' ')}, so your answer does not finish it.` : 'Nothing else blocks it.'].join(' '),
  };
}
function Triage({ queue: byWait, tasks, close, open }: { queue: Task[]; tasks: Task[]; close: () => void; open: (id: string) => void }) {
  const [order, setOrder] = useState<'links' | 'wait'>(() => localStorage.getItem('tb-triage-order') === 'wait' ? 'wait' : 'links');
  const setOrderSaved = (o: 'links' | 'wait') => { setOrder(o); try { localStorage.setItem('tb-triage-order', o); } catch { /* storage off */ } };
  const queue = useMemo(() => order === 'wait' ? byWait : [...byWait].sort((a, b) => {
    const x = triageWhy(a, tasks), y = triageWhy(b, tasks);
    return y.n - x.n || Number(x.blocked) - Number(y.blocked) || b.waitMin - a.waitMin;
  }), [byWait, tasks, order]);
  const blockers = order === 'links' ? tasks.filter(t => !ATTN.includes(t.status) && t.status !== 'archived' && !isReplaced(t) && (t.link?.waitedOnBy?.length || 0) > 0) : [];
  const [i, setI] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [ending, setEnding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  useKeymap();
  useEffect(() => {
    setHidden(ids => {
      const current = [...ids].filter(id => queue.some(t => t.id === id));
      return current.length === ids.size ? ids : new Set(current);
    });
  }, [queue, hidden]);
  const visible = queue.filter(t => !hidden.has(t.id));
  const t = visible[Math.min(i, visible.length - 1)];
  const endAndArchive = async (task: Task) => {
    setEnding(null);
    setError(null);
    setBusy(task.id);
    try {
      await archiveTriageTask(task, api.kill, api.setStatus);
      setHidden(ids => new Set(ids).add(task.id));
    } catch (e) {
      setError({ id: task.id, text: `Could not end and archive #${task.num}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const d = hit(e, 'triageNext') ? 1 : hit(e, 'triagePrev') ? visible.length - 1 : 0;
      if (d && visible.length) { e.preventDefault(); e.stopImmediatePropagation(); setI(x => (x + d) % visible.length); }
    };
    addEventListener('keydown', on, true); return () => removeEventListener('keydown', on, true);
  }, [visible.length]);
  return (
    <div className="triage open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="tr-box">
        <div className="tr-head"><h2>Triage</h2><span className="sub">{visible.length ? `${Math.min(i, visible.length - 1) + 1} of ${visible.length} waiting · ${order === 'links' ? 'tasks that unblock others first' : 'longest first'}` : 'Nothing is waiting for you'}</span>
          <span className="tr-order">Order <span className="seg"><button className={order === 'links' ? 'on' : ''} onClick={() => setOrderSaved('links')} title="Tasks that other tasks wait on first, then tasks that nothing else blocks, then the longest wait">Unblocks others</button><button className={order === 'wait' ? 'on' : ''} onClick={() => setOrderSaved('wait')}>Longest wait</button></span></span><span style={{ flex: 1 }} /><span className="sub">{keyLabel('triageNext') && <><kbd>{keyLabel('triageNext')}</kbd> next </>}{keyLabel('triage') && <><kbd>{keyLabel('triage')}</kbd> close</>}</span><button className="btn ghost icon" onClick={close}>✕</button></div>
        {t ? <div className="tr-main">
          <div className="tr-list">{visible.map((x, k) => <div key={x.id} className={`tq ${x.id === t.id ? 'on' : ''}`} onClick={() => { setI(k); setEnding(null); }}><Dot s={x.status} /><span className="t">#{x.num} {x.title}{order === 'links' && <span className="why">{triageWhy(x, tasks).text}</span>}</span><LinkMarker t={x} tasks={tasks} /><span className="m">{fmtWait(x.waitMin)}</span></div>)}
            {blockers.length > 0 && <><div className="tr-sec" title="These tasks do not wait for you, but other tasks wait on them">Blocks others, does not wait for you</div>
              {blockers.map(x => <div key={x.id} className="tq" onClick={() => open(x.id)}><Dot s={x.status} /><span className="t">#{x.num} {x.title}<span className="why">{x.link!.waitedOnBy!.map(id => '#' + tasks.find(y => y.id === id)?.num).join(' ')} wait{x.link!.waitedOnBy!.length === 1 ? 's' : ''} on it.</span></span><span className="m">{x.status}</span></div>)}</>}</div>
          <div className="tr-item">
            <div className="tr-title"><Dot s={t.status} /><span className="num">#{t.num}</span><h3>{t.title}</h3><ManagerBadge id={t.id} /><StatusLabel s={t.status} /><span className="waitchip">waiting {fmtWait(t.waitMin)}</span><AgentChip a={t.agent} /></div>
            <ThreeLines t={t} fixed />
            {order === 'links' && (w => <div className="tr-why"><b>Why this place</b><ol><li>{w.n ? `${w.n} open task${w.n === 1 ? '' : 's'} wait${w.n === 1 ? 's' : ''} on it.` : 'No task waits on it.'}</li><li>{w.blocked ? `It is also blocked by ${(t.link?.blockedBy || []).map(id => '#' + tasks.find(x => x.id === id)?.num).join(' ')}. Your answer does not finish it.` : 'Nothing else blocks it. Your answer lets it continue.'}</li><li>Waiting {fmtWait(t.waitMin)}.</li></ol></div>)(triageWhy(t, tasks))}
            <div className="tr-term"><Terminal key={t.id} taskId={t.id} autoFocus /></div>
            {error?.id === t.id && <div className="banner stopped" role="alert">{error.text}</div>}
            <div className="tr-actions"><button className="btn" onClick={() => open(t.id)} title="Terminal, log and documents of this task">Open task panel</button><button className="btn" onClick={() => api.setStatus(t.id, 'parked')} title="Take it off Needs you, Unread and triage. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.">Set aside</button>{ending === t.id ? <><span className="sel-warn">End this task and archive it? Ending it stops the agent.</span><button className="btn danger" disabled={busy !== null} onClick={() => void endAndArchive(t)}>Yes, end and archive</button><button className="btn ghost" onClick={() => setEnding(null)}>Cancel</button></> : <button className="btn" disabled={busy !== null} onClick={() => confirmTriageArchive(t) ? setEnding(t.id) : void endAndArchive(t)} title="Ends the task, then archives it">{busy === t.id ? 'Ending…' : 'End and archive'}</button>}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setI(x => (x + 1) % visible.length)}>Skip to next {keyLabel('triageNext')}</button></div>
          </div>
        </div> : <div className="tr-empty">Every agent is either working or done. ✓</div>}
      </div>
    </div>
  );
}

const Logo = () => <svg width="20" height="20" viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#1d2433" stroke="#3d4b6b" /><path d="M5 7.5 8 10l-3 2.5" stroke="#7aa2ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /><circle cx="14" cy="6" r="2" fill="#f5a524" /><path d="M10 13h5" stroke="#9aa3af" strokeWidth="1.6" strokeLinecap="round" /></svg>;
