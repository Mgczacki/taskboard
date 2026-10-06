// The task panel: a bar, the notice strip, the info section (status, goal/now/waiting, links, actions), and tabs for
// the live terminal and the log. The bar folds the info section and the strip away (task 280): the bar keeps the
// number, the title, the status, the agent, the account and the number of notices.
import { useEffect, useRef, useState } from 'react';
import type { Group, Task } from '../api';
import { AGENT_NAME, STATUS_LABEL, api, fmtWait, linkedTaskId, shortPath, useStoreValue } from '../api';
import { liveApprovals } from '../stack';
import { NoticeStrip } from './NoticeStrip';
import { PopMenu } from './PopMenu';
import { moreItems as panelMoreItems } from '../panelMore';
import { countText, infoOpen, isHookNote, lasting, middleEllipsis, noticeHistory, setInfoOpen, taskNotices } from '../taskNotices';
import { ManagerBadge, ManagerRoleButton } from './ManagerBoard';
import { AgentChip, ByController, Dot, ErrorChip, useAutoMessage, MachineChip, ThreeLines, WhereChip, BrowserAskChip } from './ui';
import { Terminal } from './Terminal';
import { PendingMarker } from './PendingCard';
import { DocsTab } from './Docs';
import { LinksSection } from './Links';
import { hasFiles, uploadAll } from '../drop';
import { loadAccounts, type Account } from './Accounts';
import { MoveAccountForm } from './MoveAccountForm';
import { formatTokens } from '../formatTokens';
import { autoText } from '../agentErrorText';
import type { DocumentLink } from '../documentLinks';
import { planUngroup } from '../groupMove';
import { runGroupChange, type Toast } from '../groupActions';
import { TransferPanel } from './TransferPanel';
import { BrowserView } from './TaskBrowser';
import { openBrowserSplit } from '../browserSplit';
import { ProcList } from './TaskProcs';
import { TaskFileText } from './TaskFileText';
import { RuntimeButton } from './TaskRuntime';
import type { PanelTab } from '../panelShare';
import { BAR_ALPHA, applyWindowOpacity, clickThroughHeld, glassAlpha, headerCollapsed, onWindowSeeChange, presetOf, setHeaderCollapsed, stepGlass, windowSee, windowSeeSupported } from '../controllerView';
import { GlassControls, useGlass, useReadable } from './GlassControls';
import { keysText } from '../keys';

// The drawer's width, set by dragging its left edge and kept across reloads. null means the default width.
const WIDTH_KEY = 'tb-drawer-width', MIN_W = 420, EDGE = 120;
const maxW = () => Math.max(MIN_W, innerWidth - EDGE);
const savedWidth = () => { try { const w = Number(localStorage.getItem(WIDTH_KEY)); return w > 0 ? w : null; } catch { return null; } };

export function TaskPanel({ t, tasks, groups, onClose, onCanvas, onOpenTask, initialTab, onTab, documentLink, toast }: { t: Task; tasks: Task[]; groups: Group[]; onClose: () => void; onCanvas: (id: string) => void; onOpenTask: (id: string) => void; initialTab?: PanelTab; onTab?: (tab: PanelTab) => void; documentLink?: DocumentLink | null; toast: Toast }) {
  const [tab, setTab] = useState<PanelTab>(initialTab || 'terminal');
  // the Canvas window of this task shows what this tab does not (panelShare.ts)
  useEffect(() => { onTab?.(tab); }, [tab]);
  const [log, setLog] = useState('');
  const [err, setErr] = useState('');
  const [dropMsg, setDropMsg] = useState('');
  const [confirmTake, setConfirmTake] = useState(false);
  const [accts, setAccts] = useState<Account[]>([]);
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(t.tokenEstimate ?? null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetAccount, setTargetAccount] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  useEffect(() => {
    const load = () => loadAccounts().then(setAccts).catch(() => {});
    load(); const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [t.id, t.status, t.account]);
  useEffect(() => { setMoveOpen(false); setTargetAccount(''); }, [t.id]);
  useEffect(() => {
    setTokenEstimate(t.tokenEstimate ?? null);
    if (t.agent !== 'antigravity' || t.machine) return;
    let live = true;
    const load = () => api.tokenEstimate(t.id).then(r => { if (live) setTokenEstimate(r.tokens); }).catch(() => { if (live) setTokenEstimate(null); });
    void load(); const timer = setInterval(load, 5000); return () => { live = false; clearInterval(timer); };
  }, [t.id, t.agent, t.machine?.id, t.tokenEstimate]);
  const acct = accts.find(a => a.id === (t.account || `${t.agent}-default`));
  // stopped for its account (server/launch-limit.ts): the reason names the account and t.ask says what to do
  const accountStop = !!acct && !!t.stopReason?.startsWith(acct.name);

  // read what changed since your last visit first, then mark the task as seen
  const [since, setSince] = useState<Awaited<ReturnType<typeof api.since>> | null>(null);
  const [sinceOpen, setSinceOpen] = useState(false);
  useEffect(() => { api.since(t.id).then(s => { setSince(s); api.seen(t.id).catch(() => {}); }).catch(() => api.seen(t.id).catch(() => {})); }, [t.id]);
  useEffect(() => { if (tab === 'log') api.log(t.id).then(setLog).catch(() => setLog('')); }, [tab, t.id, t.updated]);
  // opening a suspended task resumes it
  useEffect(() => { if (t.status === 'suspended' && !t.transfer) api.resume(t.id).catch(e => setErr(String(e.message || e))); }, [t.id]);

  const act = (p: Promise<unknown>) => p.catch(e => setErr(String(e.message || e)));
  const [confirmRm, setConfirmRm] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  // the task description starts folded to two lines so the terminal keeps its space
  const [briefOpen, setBriefOpen] = useState(false);
  useEffect(() => setBriefOpen(false), [t.id]);
  // the task list has only the start of a long description (t.descCut, server/index.ts listView): read the whole text
  // when the user opens it, and again when the start changes
  const [fullDesc, setFullDesc] = useState<{ id: string; desc: string } | null>(null);
  useEffect(() => {
    if (!briefOpen || !t.descCut) return;
    let on = true;
    api.desc(t.id).then(r => { if (on) setFullDesc({ id: t.id, desc: r.desc }); }).catch(() => {});
    return () => { on = false; };
  }, [briefOpen, t.id, t.descCut, t.desc]);
  const desc = t.descCut ? (briefOpen && fullDesc?.id === t.id ? fullDesc.desc : `${t.desc}…`) : t.desc;
  // The notices of the task (taskNotices.ts): the strip shows them one at a time, the bar shows their number
  const pendingAll = useStoreValue(s => s.pending), approvalsAll = useStoreValue(s => s.approvals);
  const pending = pendingAll.filter(i => i.taskId === t.id);
  const autoMessage = useAutoMessage();
  const notices = taskNotices({ t, pending, approvals: liveApprovals(approvalsAll).filter(a => a.actor === t.id), closed: approvalsAll.filter(a => a.actor === t.id), error: err, drop: dropMsg, autoMessage });
  const attention = ['needs-you', 'stopped', 'review'].includes(t.status);
  // The bar folds the info section to one row and the terminal gets the room. The terminal stays mounted when the
  // section folds or opens; its ResizeObserver refits it and tells tmux the new size.
  // - The controller (controllerView.ts) starts folded; folded, it also hides the tabs.
  // - A task opens folded or open as the user left it, else by the default on the Settings page (taskNotices.ts infoOpen):
  //   open when the task waits on you or has a notice. The tabs stay.
  const isCtl = t.role === 'controller';
  const [collapsed, setCollapsedRaw] = useState(() => isCtl ? headerCollapsed('controller') && (initialTab || 'terminal') === 'terminal' : !infoOpen(t.id, { attention, notices: lasting(notices).length }));
  const setCollapsed = (c: boolean) => {
    setCollapsedRaw(c);
    if (isCtl) { setHeaderCollapsed('controller', c); if (c) setTab('terminal'); }
    else setInfoOpen(t.id, !c);
  };
  const infoId = `dr-info-${t.id}`;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const glass = useGlass(), readable = useReadable(glass);
  const see = isCtl && glass.see > 0 ? glass : null;
  const [glassOpen, setGlassOpen] = useState(false);
  // the popover closes on a click outside it and on Esc
  useEffect(() => {
    if (!glassOpen) return;
    const down = (e: PointerEvent) => { if (!(e.target as Element)?.closest?.('.glass-pop, .dr-bar-glass')) setGlassOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setGlassOpen(false); } };
    addEventListener('pointerdown', down, true); addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key, true); };
  }, [glassOpen]);
  // Window see-through (Settings, the app only): the whole window at the saved opacity while the controller view is open
  const [winSee, setWinSee] = useState(windowSee);
  useEffect(() => onWindowSeeChange(() => setWinSee(windowSee())), []);
  useEffect(() => {
    if (!isCtl || !winSee.on || !windowSeeSupported()) return;
    applyWindowOpacity(winSee.opacity / 100);
    return () => applyWindowOpacity(1);
  }, [isCtl, winSee.on, winSee.opacity]);
  // Alt held over the see-through terminal: the terminal ignores the pointer and clicks reach the page behind it.
  // The bar and the resize handle still take clicks. Only window listeners read the key, so the terminal keeps its focus.
  const [through, setThrough] = useState(false);
  useEffect(() => {
    if (!see) { setThrough(false); return; }
    const key = (e: KeyboardEvent) => setThrough(clickThroughHeld(e));
    const off = () => setThrough(false);
    addEventListener('keydown', key, true); addEventListener('keyup', key, true); addEventListener('blur', off);
    return () => { removeEventListener('keydown', key, true); removeEventListener('keyup', key, true); removeEventListener('blur', off); };
  }, [!!see]);
  const [dropping, setDropping] = useState(false);
  const [width, setWidth] = useState<number | null>(savedWidth);
  const [resizing, setResizing] = useState(false);
  // dragging the left edge widens the drawer; the terminal's ResizeObserver refits it and resizes the tmux pane
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget, x0 = e.clientX, w0 = handle.parentElement!.getBoundingClientRect().width;
    let w = w0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: PointerEvent) => { w = Math.round(Math.min(maxW(), Math.max(MIN_W, w0 + x0 - ev.clientX))); setWidth(w); };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      setResizing(false);
      if (w !== w0) try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  };
  const moreItems = panelMoreItems(t, {
    moveAccount: () => { setMoveError(''); setMoveOpen(o => !o); }, moveMachine: () => setTransferOpen(o => !o), canvas: () => onCanvas(t.id), remove: () => setConfirmRm(true),
    copyAttach: () => navigator.clipboard.writeText(t.attach).then(() => toast(`Copied: ${t.attach}`), () => toast('The browser did not allow the copy.')),
    setAside: () => act(api.setStatus(t.id, 'parked')), archive: () => act(api.kill(t.id).then(onClose)),
  });
  const resetWidth = () => { setWidth(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* private mode */ } };

  return (
    <aside className={`drawer open ${dropping ? 'dropping' : ''} ${resizing ? 'resizing' : ''} ${isCtl ? 'ctl-view' : ''} ${see ? `glass txt-${readable.level} tint-${see.tint}` : ''} ${see && through ? 'through' : ''}`} style={{ width: width ? `clamp(${MIN_W}px, ${width}px, calc(100vw - ${EDGE}px))` : 'min(880px, 55vw)', ...(see ? { '--glass-a': `${glassAlpha(see) * 100}%`, '--glass-bar-a': `${Math.max(BAR_ALPHA, glassAlpha(see)) * 100}%`, '--glass-s': see.see / 100, backdropFilter: `blur(${see.blur}px)`, WebkitBackdropFilter: `blur(${see.blur}px)` } as React.CSSProperties : {}) }}
      onDragOver={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(false); uploadAll(t.id, e.dataTransfer.files, setDropMsg); }}>
      <div className={`drawer-resize ${resizing ? 'on' : ''}`} onPointerDown={startResize} onDoubleClick={resetWidth} title="Drag to resize. Double-click to reset." />
      {dropping && <div className="dropnote">Drop to put in #{t.num}'s inbox</div>}
      <div className={`dr-head thin ${isCtl ? 'ctl' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="dr-bar">
          <button className="dr-bar-toggle" aria-expanded={!collapsed} aria-controls={infoId} onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Show the details: notices, chips, goal, now, links and buttons' : 'Fold the details so the terminal gets the room'}>
            <span className="chev" aria-hidden="true">{collapsed ? '▸' : '▾'}</span><span className="num">#{t.num}</span><b className="dr-bar-t">{isCtl ? 'controller' : t.title}</b>
          </button>
          <ManagerBadge id={t.id} />
          <Dot s={t.status} /><PendingMarker taskId={t.id} small><span className={`st-label ${t.status}`} title={t.statusSource}>{STATUS_LABEL[t.status]}</span></PendingMarker>
          {!isCtl && <span className="dr-bar-chips"><AgentChip a={t.agent} />{acct && <span className="chip" title={acct.dir}>{acct.name}</span>}</span>}
          {collapsed && attention && <button className="dr-bar-attn" onClick={() => setCollapsed(false)} title={t.ask || 'Open the header to see what the task waits for'}>waiting {fmtWait(t.waitMin)}</button>}
          {collapsed && t.ask && !attention && <button className="dr-bar-attn" onClick={() => setCollapsed(false)} title={t.ask}>question</button>}
          {collapsed && lasting(notices).length > 0 && <button className={`dr-bar-attn nss-count lv-${notices[0].level}`} aria-controls={infoId} onClick={() => setCollapsed(false)}
            title={`Show the notices: ${lasting(notices).map(n => n.title).join('; ')}`}>{countText(lasting(notices))}</button>}
          <span className="tabs-sp" />
          {isCtl && <span className="dr-bar-glass">
            <button className="btn ghost icon" onClick={() => stepGlass(-1)} disabled={glass.see === 0} title={`Less see-through (${keysText('glassLess')})`} aria-label="Less see-through">−</button>
            <button className={`btn ghost glass-btn ${glassOpen ? 'on' : ''}`} aria-expanded={glassOpen} onClick={() => setGlassOpen(o => !o)}
              title={`See-through terminal: presets, blur, text strength and tint. ${keysText('glassToggle')} switches between the saved value and Off.`}>◐ {glass.see ? `${presetOf(glass)?.label || 'Custom'} ${glass.see}%` : 'Off'}{see && readable.raised ? ' !' : ''}</button>
            <button className="btn ghost icon" onClick={() => stepGlass(1)} disabled={glass.see === 100} title={`More see-through (${keysText('glassMore')})`} aria-label="More see-through">+</button>
          </span>}
          {see && <span className="dr-bar-hint" title="Hold the Alt (Option) key to click the page behind the terminal. The panel stays open.">hold ⌥ to click behind</span>}
          <button className="btn ghost icon" onClick={onClose} title="Close" aria-label="Close">✕</button>
        </div>
        {isCtl && glassOpen && <div className="glass-pop"><GlassControls g={glass} r={readable} /></div>}
        {!collapsed && <NoticeStrip list={notices} ctx={{ t, pending, act, toast, autoMessage, clearError: () => setErr(''), clearDrop: () => setDropMsg(''),
          moveAccount: isCtl ? undefined : () => { setMoveError(''); setMoveOpen(true); }, resumeAnyway: () => { setErr(''); act(api.resume(t.id, true)); } }} />}
        <div id={infoId} className="dr-info" hidden={collapsed}>
        {isCtl && <div className="banner intro">The controller is {t.agent === 'antigravity' ? 'an' : 'a'} {AGENT_NAME[t.agent]} session in <code>~/AgentVault/controller</code> (choose its account and agent on the Accounts page).{t.remoteUrl && <> Remote Control is on: <a href={t.remoteUrl} target="_blank" rel="noreferrer">open it on claude.ai or the Claude app</a>.</>} It manages agents with the <code>tb</code> command: reading and organising run without asking; starting agents, typing into them and archiving wait for your approval here. Try: “what needs me?” or “split X into three parallel tasks”.</div>}
        <div className="dr-actions">
          {t.status === 'suspended' && !t.transfer && <button className="btn primary" onClick={() => act(api.resume(t.id))} title="Start the agent again in tmux and continue its saved conversation">Resume</button>}
          {t.status === 'parked' && <button className="btn" onClick={() => act(api.setStatus(t.id, 'idle'))} title="Put it back on your lists as Idle">Bring back</button>}
          {t.status === 'archived' && <button className="btn" onClick={() => act(api.setStatus(t.id, 'idle'))} title="Take it out of the archive; open it to resume the conversation">Restore</button>}
          {isCtl && !t.newSessionWhenDone && <button className="btn" onClick={() => setConfirmNew(o => !o)} title="End this conversation and start the controller in a new one, with the current instructions and tools">New session…</button>}
          <ManagerRoleButton t={t} variant="button" toast={toast} />
          <button ref={moreBtn} className="btn" aria-haspopup="true" aria-expanded={moreOpen} onClick={() => setMoreOpen(o => !o)} title="More actions: move, copy the tmux command, show on canvas, set aside, end, remove">⋯ More</button>
          {moreOpen && <PopMenu anchor={moreBtn.current} close={() => setMoreOpen(false)} className="dr-more" align="left" label={`More actions for #${t.num}`}>
            {moreItems.map(m => <button key={m.label} className={`mi ${m.danger ? 'danger' : ''}`} title={m.title} onClick={() => { setMoreOpen(false); void m.run(); }}>{m.label}</button>)}
          </PopMenu>}
          {confirmRm && <><span className="sel-warn">Remove from Taskboard? The note goes to ~/.taskboard/trash; the conversation stays in {AGENT_NAME[t.agent]}.</span><button className="btn danger" onClick={() => api.remove(t.id).then(onClose, e => setErr(String(e.message || e)))}>Yes, remove</button><button className="btn ghost" onClick={() => setConfirmRm(false)}>Cancel</button></>}
        </div>
        {moveOpen && t.role !== 'controller' && <MoveAccountForm accounts={accts} current={t.account || `${t.agent}-default`}
          target={targetAccount} moving={moving} error={moveError} status={t.status} openElsewhere={!!t.openElsewhere}
          select={id => { setTargetAccount(id); setMoveError(''); }} cancel={() => setMoveOpen(false)} move={async () => {
            setMoving(true); setMoveError('');
            try { await api.moveAccount(t.id, targetAccount); setMoveOpen(false); setTargetAccount(''); }
            catch (e) { setMoveError(String((e as Error).message || e)); }
            finally { setMoving(false); }
          }} />}
        {transferOpen && t.role !== 'controller' && <TransferPanel task={t} close={() => setTransferOpen(false)} openTarget={onOpenTask} />}
        {t.transfer && <div className="banner">{t.transfer.direction === 'source' ? 'This task moved to another machine.' : 'This task came from another machine.'} {t.transfer.state === 'started' && <button className="btn" onClick={() => act(linkedTaskId(t.transfer!.peerIdentity, t.transfer!.task).then(id => id ? onOpenTask(id) : toast('The linked machine is not paired with this dashboard.')))}>Open linked task</button>}{t.transfer.direction === 'source' && t.transfer.state !== 'started' && <><span>Check the target before either task resumes.</span><button className="btn" onClick={() => act(api.transferRecover(t.id, 'status').then(r => toast(`Target transfer: ${r.state}.`)))}>Check target</button><button className="btn" onClick={() => act(api.transferRecover(t.id, 'retry-target').then(r => toast(`Target transfer: ${r.state}.`)))}>Retry target</button><button className="btn" onClick={() => act(api.transferRecover(t.id, 'resume-source').then(() => api.resume(t.id)))}>Resume source</button></>}</div>}
        {/* a restart that gives the agent a new scope (server/index.ts applyScope), and a restart that failed */}
        {t.restartWhenDone && t.restartFor && <div className="banner">
          <div style={{ flex: '1 1 100%' }}><b>Restart pending.</b> {t.restartWait || `Waiting for the end of the turn ${t.restartFor}.`} The restart resumes the same conversation.</div>
          {t.restartOverdue && <button className="btn primary" onClick={() => act(api.restart(t.id, 'now'))} title="Ends the current turn, including a running command. The saved conversation is kept.">Restart now</button>}
          <button className="btn ghost" onClick={() => act(api.restart(t.id, 'cancel'))} title="The agent gets the new folder at the next start of this session">Cancel the restart</button>
        </div>}
        {t.unscrollable && !t.openElsewhere && <div className="banner">
          <div style={{ flex: '1 1 100%' }}><b>This terminal cannot be scrolled.</b> {t.agent === 'codex' ? 'This Codex session was started in full-screen mode, which keeps its history to itself.' : 'The program runs full screen without mouse support.'} Restarting it continues the same conversation{t.agent === 'codex' ? ' in inline mode, which the mouse wheel scrolls' : ''}. Until then, Ctrl+T in Codex opens its transcript, which you can scroll with the arrow keys.</div>
          {t.restartWhenDone ? <><span>It restarts when the current turn ends. The agent is not interrupted.</span><button className="btn ghost" onClick={() => act(api.restart(t.id, 'cancel'))}>Cancel</button></>
            : ['idle', 'unread'].includes(t.status) ? <button className="btn primary" onClick={() => act(api.restart(t.id, 'now'))} title="The agent is between turns, so nothing is interrupted">Restart it now</button>
            : <><button className="btn primary" onClick={() => act(api.restart(t.id, 'after-turn'))} title="Waits until the agent finishes its current turn, then restarts it">Restart when this turn ends</button><button className="btn ghost" onClick={() => act(api.restart(t.id, 'now'))} title="Cuts off the current turn, including a running command; the saved conversation is kept">Restart now</button></>}
        </div>}
        {t.openElsewhere && <div className="banner elsewhere">
          <div style={{ flex: '1 1 100%' }}><b>This session is running in another terminal ({t.openElsewhere?.tty}).</b> Taskboard can only show terminals it started, so its status is read from the transcript. When you exit it there, this task becomes ready to resume here by itself.</div>
          {t.moveWhenDone ? <><span>It moves here when its current turn ends. The agent is not interrupted.</span><button className="btn ghost" onClick={() => act(api.takeover(t.id, 'cancel'))}>Cancel the move</button></>
            : !confirmTake ? <button className="btn" onClick={() => setConfirmTake(true)}>Move it here…</button>
            : (t.status === 'idle' || t.status === 'unread')
              ? <><span>The agent is between turns, so nothing is interrupted. This ends process {t.openElsewhere?.pid} in {t.openElsewhere?.tty} and resumes the conversation here.</span><button className="btn primary" onClick={() => { setConfirmTake(false); act(api.takeover(t.id)); }}>Move it here</button><button className="btn ghost" onClick={() => setConfirmTake(false)}>Cancel</button></>
              : <><span>The agent is in the middle of a turn. Stopping it now cuts that turn off, including any command it is running; the saved conversation is kept.</span><button className="btn primary" onClick={() => { setConfirmTake(false); act(api.takeover(t.id, 'after-turn')); }}>Move it when this turn ends</button><button className="btn danger" onClick={() => { setConfirmTake(false); act(api.takeover(t.id)); }}>Stop it now and move it</button><button className="btn ghost" onClick={() => setConfirmTake(false)}>Cancel</button></>}
        </div>}
        {t.role === 'controller' && t.newSessionWhenDone && <div className="banner"><span>The controller starts a new session when its current turn ends. The turn is not interrupted.</span><button className="btn ghost" onClick={() => act(api.newControllerSession('cancel'))}>Cancel</button></div>}
        {t.role === 'controller' && confirmNew && !t.newSessionWhenDone && <div className="banner">
          <div style={{ flex: '1 1 100%' }}><b>Start the controller in a new session?</b> It starts a new conversation with the current Taskboard instructions and tools. The current conversation stays in {AGENT_NAME[t.agent]}'s history, but the controller does not remember it.</div>
          {['idle', 'unread', 'suspended', 'stopped', 'archived'].includes(t.status)
            ? <button className="btn primary" onClick={() => { setConfirmNew(false); act(api.newControllerSession('now')); }}>Start new session</button>
            : <><button className="btn primary" onClick={() => { setConfirmNew(false); act(api.newControllerSession('after-turn')); }} title="Waits until the controller finishes its current turn">Start it when this turn ends</button><button className="btn danger" onClick={() => { setConfirmNew(false); act(api.newControllerSession('now')); }} title="Cuts off the current turn, including a running command">Stop it now and start</button></>}
          <button className="btn ghost" onClick={() => setConfirmNew(false)}>Cancel</button>
        </div>}
        <div className="dr-meta"><ByController t={t} />{isCtl && <AgentChip a={t.agent} />}<MachineChip t={t} /><WhereChip t={t} /><BrowserAskChip t={t} />{isCtl && acct && <span className="chip" title={acct.dir}>{acct.name}</span>}<span className="chip mono" title={t.cwd}>{middleEllipsis(shortPath(t.cwd), 56)}</span>{t.branch && <span className="chip mono">{t.worktree ? 'worktree · ' : ''}{t.branch}</span>}{t.agent === 'antigravity' && <span className="chip mono" title="Estimate from visible transcript text. Repeated model context is not included.">{tokenEstimate === null ? 'Estimate unavailable' : `~${formatTokens(tokenEstimate)} tokens`}</span>}
          {groups.filter(g => g.tasks.includes(t.id)).map(g => <span key={g.id} className="chip gchip" style={{ borderColor: g.color + '66', color: g.color }}><span className="sw" style={{ background: g.color }} />{g.name}<button className="gx" title={`Remove #${t.num} from ${g.name}. The agent keeps running.`} aria-label={`Remove from ${g.name}`} onClick={() => { const p = planUngroup(t.id, t.num, groups, g.id); if ('change' in p) runGroupChange(p.change, toast); }}>×</button></span>)}
          <select className="gsel" value="" aria-label="Add to group" onChange={async e => { const v = e.target.value; if (v === '__new') { const n = prompt('Name for the new group'); if (n) await api.createGroup(n, [t.id]); } else if (v) await api.updateGroup(v, { add: t.id }); }}>
            <option value="">＋ Add to group…</option>{groups.filter(g => !g.tasks.includes(t.id)).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__new">New group…</option>
          </select>
        </div>
        {!!t.scopes?.length && <ScopeList t={t} toast={toast} />}
        <div className={`dr-status ${t.status}`}><Dot s={t.status} /><div title={t.statusSource}><span className={`st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span> <ErrorChip t={t} />{attention && <span className="waitchip">waiting {fmtWait(t.waitMin)}</span>}{t.statusSource && !isHookNote(t.statusSource) ? ` · ${t.statusSource}` : ''}</div></div>
        {t.status === 'stopped' && t.errorLabel && t.agentError && <AutoContinueRow t={t} act={act} message={autoMessage} />}
        <div className="ctx"><ThreeLines t={t} fixed /></div>
        {since && !since.first && (since.entries.length > 0 || since.files.length > 0 || since.commits.length > 0) && <div className="since">
          <button className="since-h" aria-expanded={sinceOpen} onClick={() => setSinceOpen(o => !o)}>{sinceOpen ? '▾' : '▸'} Since you last looked <span>{fmtWait(Math.round((Date.now() - Date.parse(since.since)) / 60000))} ago · {[
            since.entries.length ? `${since.entries.length} log ${since.entries.length === 1 ? 'entry' : 'entries'}` : '', since.files.length ? `${since.files.length} file${since.files.length === 1 ? '' : 's'} changed` : '', since.commits.length ? `${since.commits.length} commit${since.commits.length === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(' · ')}</span></button>
          {sinceOpen && <ul>
            {since.entries.length > 0 && <li>{since.entries.length} log {since.entries.length === 1 ? 'entry' : 'entries'}: {since.entries[since.entries.length - 1].split('\n').filter(l => l.startsWith('- Did:')).map(l => l.slice(7))[0] || ''}</li>}
            {since.files.length > 0 && <li>Files changed: {since.files.slice(0, 8).map(f => <code key={f}>{f}</code>)}{since.files.length > 8 ? ` and ${since.files.length - 8} more` : ''}</li>}
            {since.commits.length > 0 && <li>Commits: {since.commits.slice(0, 4).map(c => <code key={c}>{c}</code>)}</li>}
          </ul>}
        </div>}
        <LinksSection t={t} tasks={tasks} onGo={onOpenTask} toast={toast} />
        </div>
        <div className="tabs">
          <button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>Terminal</button>
          {t.role !== 'controller' && <button className={tab === 'browser' ? 'on' : ''} onClick={() => setTab('browser')} title={t.machine ? `This task's own Chrome, on ${t.machine.name}` : "This task's own Chrome, which its agent uses"}>Browser</button>}
          {!t.machine && t.role !== 'controller' && <button className={tab === 'procs' ? 'on' : ''} onClick={() => setTab('procs')} title="Dev servers, databases and other processes of this task">Processes</button>}
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
          <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>Inbox / Outbox<span className="n">{(t.docs?.inbox || 0) + (t.docs?.outbox || 0)}</span></button>
          <span className="tabs-sp" /><RuntimeButton t={t} onOpen={setTab} />
        </div>
      </div>
      <div className={`dr-body ${tab !== 'terminal' && tab !== 'browser' ? 'pad' : ''}`}>
        {tab === 'docs' && <DocsTab t={t} tasks={tasks} documentLink={documentLink} />}
        {tab === 'terminal' && t.openElsewhere && <div className="empty" style={{ padding: 20 }}>The terminal for this session belongs to {t.openElsewhere?.tty}. Last message from the agent:<pre className="logtext" style={{ marginTop: 10 }}>{t.now || '—'}</pre></div>}
        {tab === 'terminal' && !t.openElsewhere && (t.status === 'suspended'
          ? <div className="empty" style={{ padding: 20 }}>Resuming with {t.agent === 'claude' ? 'claude --resume' : t.agent === 'codex' ? 'codex resume' : 'agy --conversation'} {t.sessionId}…</div>
          : <div className="term-wrap">{!collapsed && <div className={`term-brief ${briefOpen ? 'open' : ''}`} onClick={() => setBriefOpen(o => !o)} title={briefOpen ? 'Click to show only the first lines' : 'Click to show the whole task description'}><b>Task</b><span><TaskFileText taskId={t.id} text={desc} /></span><i className="more">{briefOpen ? 'less' : 'more'}</i></div>}<Terminal taskId={t.id} autoFocus glass={see ? glassAlpha(see) : 1} tint={see ? see.tint : 'panel'} /></div>)}
        {tab === 'log' && <>{noticeHistory(t.id).length > 0 && <div className="ns-history"><b>Notices in this panel since the page loaded</b><ul>{noticeHistory(t.id).map(h => <li key={h.key}><span className="sub">{new Date(h.at).toLocaleTimeString()}</span> {h.title}: {h.reason}</li>)}</ul></div>}<pre className="logtext">{log || 'No log entries yet.'}</pre></>}
        {tab === 'browser' && <BrowserView key={t.id} id={t.id} title={`#${t.num} ${t.title}`} archived={t.status === 'archived'} remote={t.machine?.name} onCanvas={() => { openBrowserSplit(t.id); onCanvas(t.id); }} />}
        {tab === 'procs' && <ProcList key={t.id} scope="tasks" id={t.id} cwd={t.cwd} />}
      </div>
    </aside>
  );
}

// The worktrees and read folders that the user approved for this task after its start (tb scope request). Remove keeps
// the branch. The server refuses to remove a worktree with uncommitted changes, and asks first about ignored files.
function ScopeList({ t, toast }: { t: Task; toast: Toast }) {
  const remove = async (name: string, label: string) => {
    if (!confirm(`Remove ${label} from #${t.num}? The branch stays in the repository. The agent gets a note in its inbox.`)) return;
    try {
      let r = await api.removeScope(t.id, name, false);
      if (r.ignored) {
        if (!confirm(`${r.error}\n\n${r.ignored.join('\n')}`)) return;
        r = await api.removeScope(t.id, name, true);
      }
      toast(r.result || r.error || 'Removed.');
    } catch (e) { toast((e as Error).message); }
  };
  const copy = (path: string) => navigator.clipboard.writeText(path).then(() => toast(`Copied: ${path}`), () => toast('The browser did not allow the copy.'));
  return <div className="dr-scopes">{t.scopes!.map(s => <div key={s.id} className="scope-row"
    title={s.kind === 'worktree' ? `Repository ${s.repo || ''}\nBranch ${s.branch}, base ${s.base} at ${s.baseCommit}\n${s.path}` : s.path}>
    <span className="chip mono">{s.kind === 'worktree' ? `worktree · ${s.name}` : 'read only'}</span>
    <span className="mono scope-path">{middleEllipsis(shortPath(s.path), 56)}</span>
    <button className="btn ghost icon" onClick={() => void copy(s.path)} title={`Copy the path: ${s.path}`} aria-label="Copy the path">⧉</button>
    <button className="btn ghost" title={s.reason} onClick={() => void remove(s.name, s.kind === 'worktree' ? `the worktree ${s.name}` : `read access to ${s.path}`)}>Remove</button>
  </div>)}</div>;
}

// A task that stopped on a model or API error (server/agent-error-watch.ts). The notice strip shows the error with
// Continue and Dismiss (taskNotices.ts). This row in the details says what auto-continue does and changes it.
function AutoContinueRow({ t, act, message }: { t: Task; act: (p: Promise<unknown>) => void; message: string }) {
  const capacity = t.agent === 'codex' && /^Selected model is at capacity\b/i.test(t.agentError?.text || '');
  return <div className="ae-row">
    <span className="sub">{autoText(t, message)}</span>
    {capacity ? <span className="sub">Change Codex capacity retries in Settings.</span> :
    <label className="ae-auto" title="On: after a model error (overloaded, rate limit, server error, lost connection) Taskboard types the message after 1, 2, 5, 10 and 10 minutes, at most 5 times. Each try is an ordinary turn of the agent.">Auto-continue for this task
      <select value={t.autoContinue || 'default'} onChange={ev => act(api.setAutoContinue(t.id, ev.target.value as 'on' | 'off' | 'default'))}>
        <option value="default">{t.autoContinue ? 'Default (account or Settings)' : `Default (${t.autoContinueOn ? 'on' : 'off'})`}</option><option value="on">On</option><option value="off">Off</option>
      </select></label>}
  </div>;
}
