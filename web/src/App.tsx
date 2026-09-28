import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Group, Task } from './api';
import { ATTN, api, fmtWait, setViewing, useStore } from './api';
import { Canvas, openInWindow, viewName } from './components/Canvas';
import { Import } from './components/Import';
import { NewTask } from './components/NewTask';
import { StyleSwitcher } from './components/StyleSwitcher';
import { TaskPanel } from './components/TaskPanel';
import { Terminal } from './components/Terminal';
import { AgentChip, Dot, StatusLabel, ThreeLines } from './components/ui';
import { BoardView, ListView } from './components/Views';
import { GraphView } from './components/Graph';
import { ReviewPage } from './components/Review';
import { AccountsPage } from './components/Accounts';
import { SettingsPage } from './components/Settings';

type Page = 'list' | 'board' | 'canvas' | 'graph' | 'review' | 'accounts' | 'settings';
// #list · #board · #canvas · #canvas:<view>  (view = g:<group> | needs | live | t:<id,id>)
function parseHash(): { page: Page; view?: string } {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('canvas:')) return { page: 'canvas', view: h.slice(7) };
  return { page: (['list', 'board', 'canvas', 'graph', 'review', 'accounts', 'settings'].includes(h) ? h : 'list') as Page };
}
export const SOLO = new URLSearchParams(location.search).get('solo') === '1';
// inside the Mac app (desktop/preload.cjs sets this): ⌘T is New task there; a browser keeps ⌘T for its tabs
const IN_APP = !!(window as unknown as { taskboardApp?: { isApp: boolean } }).taskboardApp?.isApp;
export interface Toast { id: number; text: string; action?: { label: string; fn: () => void } }

export function App() {
  const { tasks: allTasks, groups, approvals, machines, connected } = useStore();
  const [addMachine, setAddMachine] = useState(false);
  const [keysHelp, setKeysHelp] = useState(false);
  const [machineName, setMachineName] = useState('');
  const [role, setRole] = useState('production');
  useEffect(() => { api.info().then(i => { setMachineName(i.machine); setRole(i.role || 'production'); document.title = `Taskboard · ${i.machine}`; }).catch(() => {}); }, [connected]);
  // the controller agent is reached with ⌃⌥K and the sidebar; it is not one of the tasks on the board
  const controller = allTasks.find(t => t.role === 'controller');
  const tasks = useMemo(() => allTasks.filter(t => t.role !== 'controller'), [allTasks]);
  const init = parseHash();
  const [page, setPage] = useState<Page>(SOLO ? 'canvas' : init.page);
  const [view, setViewState] = useState<string>(init.view || localStorage.getItem('tb-view') || 'live');
  // the open task panel is kept in the address (?open=<id>&tab=…), so a reload or a reopened window shows it again
  const initParams = new URLSearchParams(location.search);
  const [openId, setOpenIdRaw] = useState<string | null>(initParams.get('open'));
  const [openTab, setOpenTab] = useState<'terminal' | 'log' | 'docs' | undefined>((initParams.get('tab') as 'terminal' | 'log' | 'docs') || undefined);
  const setOpenId = (id: string | null, tab?: 'terminal' | 'log' | 'docs') => { setOpenTab(tab); setOpenIdRaw(id); };
  useEffect(() => {
    const u = new URL(location.href);
    if (openId) u.searchParams.set('open', openId); else u.searchParams.delete('open');
    if (openId && openTab) u.searchParams.set('tab', openTab); else u.searchParams.delete('tab');
    if (u.href !== location.href) history.replaceState(null, '', u);
  }, [openId, openTab]);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(() => location.hash === '#import');
  const [triage, setTriage] = useState(false);
  const [railHidden, setRailHidden] = useState(() => SOLO || localStorage.getItem('tb-rail') === 'hidden');
  const [focusMode, setFocusMode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [groupPrompt, setGroupPrompt] = useState<string[] | null>(null);

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, action }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? 9000 : 4500);
  }, []);

  useEffect(() => { const on = () => { const p = parseHash(); setPage(SOLO ? 'canvas' : p.page); if (p.view) setViewState(p.view); }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => { document.body.dataset.page = page; }, [page]);
  const setView = (v: string) => { setViewState(v); if (!SOLO) localStorage.setItem('tb-view', v); history.replaceState(null, '', `${location.search}#canvas:${encodeURIComponent(v)}`); };
  const go = (p: Page) => { location.hash = p === 'canvas' ? `canvas:${encodeURIComponent(view)}` : p; setPage(p); };

  const open = allTasks.find(t => t.id === openId);
  const openController = async () => { if (openId === 'controller') { setOpenId(null); return; } if (!controller || controller.status === 'suspended') await api.startController().catch(e => toast(String(e.message || e))); setOpenId('controller'); };
  // Inside the Mac app: mark the page so CSS adds drag areas, and follow the window buttons (shown near the top edge).
  useEffect(() => {
    if (!(window as unknown as { taskboardApp?: { isApp: boolean } }).taskboardApp?.isApp) return;
    document.body.classList.add('in-app');
    const on = (e: Event) => document.body.classList.toggle('app-buttons', !!(e as CustomEvent<{ buttons: boolean }>).detail?.buttons);
    addEventListener('taskboard:chrome', on); return () => removeEventListener('taskboard:chrome', on);
  }, []);
  // The Mac app (desktop/main.cjs) opens a task, triage or the controller from its menu-bar item with this event.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ task?: string; triage?: boolean; controller?: boolean; newTask?: boolean }>).detail || {};
      if (d.newTask) setNewOpen(true);
      if (d.task) setOpenId(d.task);
      if (d.triage) setTriage(true);
      if (d.controller && openId !== 'controller') openController();
    };
    addEventListener('taskboard:open', on); return () => removeEventListener('taskboard:open', on);
  }, [openId, controller?.status]);
  const queue = useMemo(() => tasks.filter(t => ATTN.includes(t.status)).sort((a, b) => b.waitMin - a.waitMin), [tasks]);
  const needs = tasks.filter(t => t.status === 'needs-you'), unread = tasks.filter(t => t.status === 'unread');
  const canvasIds = useMemo(() => {
    if (page !== 'canvas') return [];
    if (view.startsWith('g:')) return groups.find(g => g.id === view.slice(2))?.tasks || [];
    if (view.startsWith('t:')) return view.slice(2).split(',');
    return tasks.filter(t => t.status !== 'archived').map(t => t.id);
  }, [page, view, groups, tasks]);

  useEffect(() => { setViewing([...(openId ? [openId] : []), ...canvasIds]); }, [openId, canvasIds.join()]);
  useEffect(() => { document.title = SOLO ? `${viewName(view, groups, tasks)} · Taskboard` : (queue.length + unread.length ? `(${queue.length + unread.length}) ` : '') + 'Taskboard'; }, [queue.length, unread.length, view, groups, tasks]);
  useEffect(() => { if (!SOLO) localStorage.setItem('tb-rail', railHidden ? 'hidden' : 'shown'); }, [railHidden]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const inTerm = (e.target as HTMLElement)?.closest?.('.xterm');
      const typing = (e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable=true]');
      // Command-T: new task, also from inside a terminal (the Mac app sends it from its File menu; a browser keeps ⌘T for tabs)
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyT') { e.preventDefault(); e.stopPropagation(); setNewOpen(true); return; }
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); if (!SOLO) setRailHidden(h => !h); return; }
      if (e.ctrlKey && e.altKey && e.code === 'KeyQ') { e.preventDefault(); setTriage(x => !x); return; }
      // controller: Command-K works everywhere, also while a terminal has focus (Control-Option-K still works too)
      if ((e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyK') || (e.ctrlKey && e.altKey && e.code === 'KeyK')) { e.preventDefault(); e.stopPropagation(); openController(); return; }
      if (inTerm || typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setNewOpen(true); }
      if ((e.key === 'c' || e.key === 'C') && page !== 'review') { e.preventDefault(); openController(); } // C comments on the Review page
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); setTriage(x => !x); }
      if (e.key === '?') { e.preventDefault(); setKeysHelp(x => !x); }
      if (e.key === 'Escape') { if (keysHelp) setKeysHelp(false); else if (triage) setTriage(false); else if (openId) setOpenId(null); else if (selected.size) setSelected(new Set()); }
    };
    addEventListener('keydown', on, true); return () => removeEventListener('keydown', on, true);
  }, [triage, openId, selected.size, controller?.status, keysHelp, page]);

  const toggleSel = (id: string) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const showOnCanvas = (id: string) => {
    if (view.startsWith('g:')) { const g = groups.find(x => x.id === view.slice(2)); if (g && !g.tasks.includes(id)) api.updateGroup(g.id, { add: id }); }
    else if (view.startsWith('t:') && !view.slice(2).split(',').includes(id)) setView(view + ',' + id);
    else if (view === 'needs') setView('live');
    setOpenId(null); go('canvas');
  };
  const item = (t: Task) => <div key={t.id} className="rail-item" onClick={() => setOpenId(t.id)}><Dot s={t.status} /><span className="t">{t.title}</span><span className="m">{t.agent === 'claude' ? 'CC' : 'CX'}</span></div>;
  const hideChrome = focusMode && page === 'canvas';
  // pending reviews for the sidebar count
  const [reviewCount, setReviewCount] = useState(0);
  useEffect(() => { fetch('/api/review').then(r => r.json()).then((l: { state: string }[]) => setReviewCount(l.filter(x => x.state === 'pending').length)).catch(() => {}); }, [tasks]);

  return (
    <div className={`app ${railHidden || hideChrome ? 'rail-off' : ''}`}>
      {!railHidden && !hideChrome && <aside className="rail">
        <div className="brand" title={machineName ? `Taskboard on ${machineName}` : undefined}><Logo />Taskboard<small>{connected ? (machineName || 'v0.2') : 'offline'}</small></div>
        <button className="newtask" onClick={() => setNewOpen(true)} title={IN_APP ? 'New task: Command-T, from anywhere (N also works outside a terminal)' : 'New task: N (outside a terminal)'}>＋ New task <kbd>{IN_APP ? '⌘T' : 'N'}</kbd></button>
        <div className="rail-item ctl-item" onClick={openController} title="The controller agent manages the other agents. Shortcut: Command-K (or C)">{controller ? <Dot s={controller.status} /> : <span className="dot idle" />}<span className="t"><b>Controller</b>{controller ? '' : ' · start'}</span>{controller?.remoteUrl && <a className="rc-link" href={controller.remoteUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title="Remote Control is on: open the controller on claude.ai or the Claude mobile app">📱</a>}<kbd>⌘K</kbd></div>
        <button className="importbtn" onClick={() => setImportOpen(true)} title="Bring in Claude Code and Codex sessions you started outside Taskboard">⇪ Import sessions</button>
        <nav className="nav">
          {(['list', 'board', 'graph', 'canvas', 'review', 'accounts', 'settings'] as Page[]).map(p => <a key={p} className={page === p ? 'on' : ''} onClick={() => go(p)}>{p[0].toUpperCase() + p.slice(1)}{p === 'list' && <span className="n">{tasks.filter(t => t.status !== 'archived').length}</span>}{p === 'review' && reviewCount > 0 && <span className="n" style={{ color: 'var(--st-review)' }}>{reviewCount}</span>}</a>)}
        </nav>
        <div className="rail-scroll">
          <div className="rail-sec"><h6>Needs you<span>{needs.length}</span></h6>{needs.map(item)}{!needs.length && <div className="rail-empty">Nothing waiting</div>}</div>
          <div className="rail-sec"><h6>Done · unread<span>{unread.length}</span></h6>{unread.map(item)}{!unread.length && <div className="rail-empty">All read</div>}</div>
          {<div className="rail-sec"><h6>Machines<span className="addg" title="Add a machine" onClick={() => setAddMachine(true)}>＋</span></h6>
            {machines.map(m => <div key={m.id} className={`rail-item ${m.online ? '' : 'off'}`} title={m.local ? 'This machine' : `${m.url}${m.error ? ' · ' + m.error : ''}`}><span className={`mdot ${m.online ? '' : 'off'}`} /><span className="t">{m.name}{m.local ? ' (this)' : ''}</span><span className="m">{m.local ? tasks.filter(t => !t.machine && t.status !== 'archived').length : m.online ? `${m.latency ?? '?'} ms · ${m.tasks ?? 0}` : 'offline'}</span></div>)}
          </div>}
          <div className="rail-sec"><h6>Groups<span className="addg" title="New group" onClick={() => setGroupPrompt([])}>＋</span></h6>
            {groups.map(g => { const w = g.tasks.filter(id => ATTN.includes(tasks.find(t => t.id === id)?.status as Task['status'])).length; return (
              <div key={g.id} className={`rail-item ${page === 'canvas' && view === 'g:' + g.id ? 'on' : ''}`} onClick={() => { setView('g:' + g.id); setPage('canvas'); }}>
                <span className="dot" style={{ background: g.color, borderRadius: 3 }} /><span className="t">{g.name}</span><span className="m">{w > 0 && <span style={{ color: 'var(--st-needs)' }}>● </span>}{g.tasks.length}</span>
                <button className="gopen" title="Open in its own window" onClick={e => { e.stopPropagation(); openInWindow('g:' + g.id); }}>↗</button></div>); })}
            {!groups.length && <div className="rail-empty">No groups yet</div>}
          </div>
        </div>
        <div className="rail-foot">
          <div className="row"><span className={`dot ${connected ? 'ok' : 'stopped'}`} />server {connected ? 'connected' : 'not reachable'}</div>
          <div className="row" style={{ paddingLeft: 15 }}>{tasks.filter(t => !['archived', 'suspended', 'parked'].includes(t.status) && !t.openElsewhere).length} tmux sessions · vault <code>~/AgentVault</code></div>
          <div className="row" style={{ paddingLeft: 15 }}><a onClick={() => setKeysHelp(true)}>Keyboard shortcuts <kbd>?</kbd></a></div>
          <div className="row" style={{ paddingLeft: 15 }}><a onClick={() => Notification.requestPermission()}>{typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Notifications on' : 'Turn on notifications'}</a></div>
        </div>
      </aside>}
      <div className="main">
        {!hideChrome && <header className="top">
          {!SOLO && <button className="btn icon" title="Hide or show the sidebar (⌘S)" onClick={() => setRailHidden(h => !h)}>◧</button>}
          <h1>{SOLO ? viewName(view, groups, tasks) : page[0].toUpperCase() + page.slice(1)}</h1>
          <span className="spacer" />
          <div className="attn-wrap">{approvals.some(a => a.state === 'pending') && <span className="attn" style={{ marginRight: 8 }}>{approvals.filter(a => a.state === 'pending').length} to approve</span>}{queue.length
            ? <button className="attn" onClick={() => setTriage(true)} title="Triage: everything waiting on you. Shortcut: T (or Control-Option-Q)">{queue.length} waiting on you<span className="sep">·</span><span className="long">longest {fmtWait(queue[0].waitMin)}</span><kbd>T</kbd></button>
            : <span className="attn quiet">Nothing waiting</span>}</div>
          <span className="spacer" />
          {page === 'list' && <label className="opt"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>}
          <StyleSwitcher />
        </header>}
        <div className="view">
          {page === 'list' && <ListView tasks={tasks} groups={groups} open={setOpenId} showArchived={showArchived} selected={selected} toggleSel={toggleSel} />}
          {page === 'board' && <BoardView tasks={tasks} groups={groups} open={setOpenId} openDocs={id => setOpenId(id, 'docs')} selected={selected} toggleSel={toggleSel} newGroup={() => setGroupPrompt([])} toast={toast} />}
          {page === 'accounts' && <AccountsPage tasks={allTasks} />}
          {page === 'settings' && <SettingsPage tasks={allTasks} />}
          {page === 'review' && <ReviewPage tasks={tasks} open={(id, tab) => setOpenId(id, tab)} />}
          {page === 'graph' && <GraphView tasks={tasks} groups={groups} open={(id, tab) => setOpenId(id, tab)} />}
          {page === 'canvas' && <Canvas tasks={tasks} groups={groups} view={view} setView={setView} openPanel={id => setOpenId(id)} panelTaskId={openId} selected={selected} toggleSel={toggleSel} clearSel={() => setSelected(new Set())} solo={SOLO} focusMode={focusMode} setFocusMode={setFocusMode} toast={toast} />}
        </div>
      </div>
      {selected.size > 0 && <SelectionBar ids={[...selected]} tasks={tasks} groups={groups} clear={() => setSelected(new Set())} newGroup={ids => setGroupPrompt(ids)} toast={toast} />}
      {open && <TaskPanel key={open.id + (openTab || '')} t={open} tasks={tasks} initialTab={openTab} groups={groups} onClose={() => setOpenId(null)} onCanvas={showOnCanvas} />}
      {newOpen && <NewTask onClose={() => setNewOpen(false)} onStarted={id => { setNewOpen(false); setOpenId(id); }} />}
      {importOpen && <Import onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); go('list'); }} />}
      {groupPrompt && <GroupPrompt ids={groupPrompt} close={() => setGroupPrompt(null)} done={(g, openWin) => { setGroupPrompt(null); setSelected(new Set()); toast(`Group “${g.name}” created`); if (openWin) openInWindow('g:' + g.id); else { setView('g:' + g.id); go('canvas'); } }} />}
      {role === 'sandbox' && <div className="sandbox-bar" title={`This is a sandbox: a separate test copy of Taskboard (${machineName}). Its agents and tasks are not your real ones.`}>Sandbox · {machineName} · not your real Taskboard</div>}
      {keysHelp && <KeysHelp close={() => setKeysHelp(false)} />}
      {addMachine && <AddMachine close={() => setAddMachine(false)} />}
      {triage && <Triage queue={queue} close={() => setTriage(false)} open={id => { setTriage(false); setOpenId(id); }} />}
      {approvals.some(a => a.state === 'pending') && <div className="approvals">{approvals.filter(a => a.state === 'pending').map(a => (
        <div key={a.id} className="approval">
          <div className="ap-h"><span className="dot needs-you" /><b>The controller wants to {a.summary}</b></div>
          {a.detail && <pre className="ap-d">{a.detail}</pre>}
          <div className="ap-a"><button className="btn primary" onClick={() => api.decide(a.id, true)}>Approve</button><button className="btn" onClick={() => api.decide(a.id, false)}>Deny</button><button className="btn ghost" onClick={openController}>Open controller</button></div>
        </div>))}</div>}
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast"><div className="b">{t.text}</div>{t.action && <button className="btn" onClick={() => { t.action!.fn(); setToasts(x => x.filter(y => y.id !== t.id)); }}>{t.action.label}</button>}</div>)}</div>
    </div>
  );
}

// All shortcuts, with the modifier keys written out: ⌘ Command, ⌥ Option, ⌃ Control, ⇧ Shift.
const KEYS: [string, string, string][] = [
  ['Anywhere', '⌘K', 'Open the controller (Command-K). Also works inside a terminal.'],
  ['Anywhere', '⌘S', 'Hide or show the sidebar (Command-S)'],
  ['Mac app', '⌘T', 'New task (Command-T), also from inside a terminal'],
  ['Mac app', '⌘N / ⇧⌘N', 'New window / new canvas window (Command-N / Shift-Command-N)'],
  ['Anywhere', '⌃⌥Q', 'Triage: everything waiting on you (Control-Option-Q)'],
  ['Outside a terminal', 'N', 'New task (in the Mac app, ⌘T works everywhere)'],
  ['Outside a terminal', 'C', 'Open the controller (on the Review page C adds a comment instead)'],
  ['Outside a terminal', 'T', 'Triage'],
  ['Outside a terminal', '?', 'This list'],
  ['Outside a terminal', 'Esc', 'Close the panel or clear the selection'],
  ['Canvas', '⌃⌥← / ⌃⌥→', 'Focus the previous / next window (Control-Option-Left / Right)'],
  ['Canvas', '⌃⌥↩', 'Maximize the focused window (Control-Option-Return)'],
  ['Canvas', '⌃⌥L', 'Change layout: columns, grid, rows (Control-Option-L)'],
  ['Canvas', '⌃⌥F', 'Focus mode (Control-Option-F); Esc or the button bottom-right exits'],
  ['Canvas', '⌃⌥G', 'Next group tab (Control-Option-G)'],
  ['Canvas', '⌃⌥N', 'Next task waiting on you (Control-Option-N)'],
  ['Canvas', '⌃⌥. / ⌃⌥,', 'Larger / smaller text (Control-Option-Period / Comma)'],
  ['Canvas', '⌃⌥W', 'Remove the focused window (Control-Option-W)'],
  ['Board and canvas', '⌘-click', 'Select several tasks (Command-click), then act on them in the bar at the bottom'],
];
function KeysHelp({ close }: { close: () => void }) {
  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 640 }}>
        <header><h2>Keyboard shortcuts</h2><button className="btn ghost icon" onClick={close}>✕</button></header>
        <div className="body">
          <div className="sub" style={{ marginBottom: 8 }}>Symbols: ⌘ Command · ⌥ Option · ⌃ Control · ⇧ Shift. Single letters work when the cursor is not in a terminal or a text field.</div>
          <table className="keys"><tbody>{KEYS.map(([where, k, what], i) => <tr key={i}><td className="sub">{i === 0 || KEYS[i - 1][0] !== where ? where : ''}</td><td><kbd>{k}</kbd></td><td>{what}</td></tr>)}</tbody></table>
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
        : <><span className="sel-warn">Remove {list.length} from Taskboard? Their notes go to ~/.taskboard/trash; the conversations stay in Claude Code / Codex.</span>
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

function Triage({ queue, close, open }: { queue: Task[]; close: () => void; open: (id: string) => void }) {
  const [i, setI] = useState(0);
  const t = queue[Math.min(i, queue.length - 1)];
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.code === 'ArrowDown' || e.code === 'ArrowUp') && queue.length) { e.preventDefault(); e.stopPropagation(); setI(x => (x + (e.code === 'ArrowDown' ? 1 : queue.length - 1)) % queue.length); }
    };
    addEventListener('keydown', on, true); return () => removeEventListener('keydown', on, true);
  }, [queue.length]);
  return (
    <div className="triage open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="tr-box">
        <div className="tr-head"><h2>Triage</h2><span className="sub">{queue.length ? `${Math.min(i, queue.length - 1) + 1} of ${queue.length} waiting · longest first` : 'Nothing is waiting for you'}</span><span style={{ flex: 1 }} /><span className="sub"><kbd>⌃⌥↓</kbd> next <kbd>⌃⌥Q</kbd> close</span><button className="btn ghost icon" onClick={close}>✕</button></div>
        {t ? <div className="tr-main">
          <div className="tr-list">{queue.map((x, k) => <div key={x.id} className={`tq ${x.id === t.id ? 'on' : ''}`} onClick={() => setI(k)}><Dot s={x.status} /><span className="t">#{x.num} {x.title}</span><span className="m">{fmtWait(x.waitMin)}</span></div>)}</div>
          <div className="tr-item">
            <div className="tr-title"><Dot s={t.status} /><span className="num">#{t.num}</span><h3>{t.title}</h3><StatusLabel s={t.status} /><span className="waitchip">waiting {fmtWait(t.waitMin)}</span><AgentChip a={t.agent} /></div>
            <ThreeLines t={t} />
            <div className="tr-term"><Terminal key={t.id} taskId={t.id} autoFocus /></div>
            <div className="tr-actions"><button className="btn" onClick={() => open(t.id)} title="Terminal, log and documents of this task">Open task panel</button><button className="btn" onClick={() => api.setStatus(t.id, 'parked')} title="Take it off Needs you, Unread and triage. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.">Set aside</button><span style={{ flex: 1 }} /><button className="btn" onClick={() => setI(x => (x + 1) % queue.length)}>Skip to next ⌃⌥↓</button></div>
          </div>
        </div> : <div className="tr-empty">Every agent is either working or done. ✓</div>}
      </div>
    </div>
  );
}

const Logo = () => <svg width="20" height="20" viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="5" fill="#1d2433" stroke="#3d4b6b" /><path d="M5 7.5 8 10l-3 2.5" stroke="#7aa2ff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /><circle cx="14" cy="6" r="2" fill="#f5a524" /><path d="M10 13h5" stroke="#9aa3af" strokeWidth="1.6" strokeLinecap="round" /></svg>;
