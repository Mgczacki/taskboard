// The task panel: status, goal/now/waiting, actions, and tabs for the live terminal and the log.
import { useEffect, useState } from 'react';
import type { Group, Task } from '../api';
import { AGENT_NAME, STATUS_LABEL, api, fmtWait, linkedTaskId, shortPath } from '../api';
import { AgentChip, ByController, Dot, MachineChip, ThreeLines, WhereChip } from './ui';
import { Terminal } from './Terminal';
import { PendingMarker } from './PendingCard';
import { DocsTab } from './Docs';
import { LinksSection } from './Links';
import { hasFiles, uploadAll } from '../drop';
import { loadAccounts, usageText, type Account } from './Accounts';
import { formatTokens } from '../formatTokens';
import type { DocumentLink } from '../documentLinks';
import { planUngroup } from '../groupMove';
import { runGroupChange, type Toast } from '../groupActions';
import { TransferPanel } from './TransferPanel';
import { BrowserView } from './TaskBrowser';
import { openBrowserSplit } from '../browserSplit';
import { ProcList } from './TaskProcs';
import { RuntimeButton } from './TaskRuntime';
import type { PanelTab } from '../panelShare';
import { BAR_ALPHA, applyWindowOpacity, clickThroughHeld, glassAlpha, headerCollapsed, onWindowSeeChange, presetOf, setHeaderCollapsed, stepGlass, taskThinBar, windowSee, windowSeeSupported } from '../controllerView';
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
  const [copied, setCopied] = useState(false);
  const [confirmTake, setConfirmTake] = useState(false);
  const [accts, setAccts] = useState<Account[]>([]);
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(t.tokenEstimate ?? null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetAccount, setTargetAccount] = useState('');
  const [moving, setMoving] = useState(false);
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
  const [sinceOpen, setSinceOpen] = useState(true);
  useEffect(() => { api.since(t.id).then(s => { setSince(s); api.seen(t.id).catch(() => {}); }).catch(() => api.seen(t.id).catch(() => {})); }, [t.id]);
  useEffect(() => { if (tab === 'log') api.log(t.id).then(setLog).catch(() => setLog('')); }, [tab, t.id, t.updated]);
  // opening a suspended task resumes it
  useEffect(() => { if (t.status === 'suspended' && !t.transfer) api.resume(t.id).catch(e => setErr(String(e.message || e))); }, [t.id]);

  const act = (p: Promise<unknown>) => p.catch(e => setErr(String(e.message || e)));
  const [confirmRm, setConfirmRm] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  // the task description starts folded to two lines so the terminal keeps its space
  const [briefOpen, setBriefOpen] = useState(false);
  // details folded away (kept for the next panel too): only the title, status and tabs stay above the terminal
  const [compact, setCompactRaw] = useState(() => { try { return localStorage.getItem('tb-panel-compact') === '1'; } catch { return false; } });
  const setCompact = (f: (c: boolean) => boolean) => setCompactRaw(c => { const n = f(c); try { localStorage.setItem('tb-panel-compact', n ? '1' : '0'); } catch { /* storage off */ } return n; });
  useEffect(() => setBriefOpen(false), [t.id]);
  // The controller view (controllerView.ts): the header folds to a thin bar and the terminal gets the whole height.
  // Normal tasks get the same bar only when the setting on the Settings page is on. The terminal stays mounted when the
  // header folds or opens; its ResizeObserver refits it and tells tmux the new size.
  const isCtl = t.role === 'controller', headKind = isCtl ? 'controller' : 'task';
  const [thin] = useState(() => isCtl || taskThinBar());
  const [collapsed, setCollapsedRaw] = useState(() => thin && headerCollapsed(headKind) && (initialTab || 'terminal') === 'terminal');
  const setCollapsed = (c: boolean) => { setCollapsedRaw(c); setHeaderCollapsed(headKind, c); if (c) setTab('terminal'); };
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
  const attention = ['needs-you', 'stopped', 'review'].includes(t.status);
  const [dropping, setDropping] = useState(false);
  const [dropMsg, setDropMsg] = useState('');
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
  const resetWidth = () => { setWidth(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* private mode */ } };

  return (
    <aside className={`drawer open ${dropping ? 'dropping' : ''} ${resizing ? 'resizing' : ''} ${isCtl ? 'ctl-view' : ''} ${see ? `glass txt-${readable.level} tint-${see.tint}` : ''} ${see && through ? 'through' : ''}`} style={{ width: width ? `clamp(${MIN_W}px, ${width}px, calc(100vw - ${EDGE}px))` : 'min(880px, 55vw)', ...(see ? { '--glass-a': `${glassAlpha(see) * 100}%`, '--glass-bar-a': `${Math.max(BAR_ALPHA, glassAlpha(see)) * 100}%`, '--glass-s': see.see / 100, backdropFilter: `blur(${see.blur}px)`, WebkitBackdropFilter: `blur(${see.blur}px)` } as React.CSSProperties : {}) }}
      onDragOver={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(false); uploadAll(t.id, e.dataTransfer.files, setDropMsg); }}>
      <div className={`drawer-resize ${resizing ? 'on' : ''}`} onPointerDown={startResize} onDoubleClick={resetWidth} title="Drag to resize. Double-click to reset." />
      {dropping && <div className="dropnote">Drop to put in #{t.num}'s inbox</div>}
      <div className={`dr-head ${compact && !thin ? 'compact' : ''} ${thin ? 'thin' : ''} ${collapsed ? 'collapsed' : ''}`}>
        {thin && <div className="dr-bar">
          <span className="num">#{t.num}</span><b className="dr-bar-t">{isCtl ? 'controller' : t.title}</b>
          <Dot s={t.status} /><PendingMarker taskId={t.id} small><span className={`st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span></PendingMarker>
          {collapsed && attention && <button className="dr-bar-attn" onClick={() => setCollapsed(false)} title={t.ask || 'Open the header to see what the task waits for'}>waiting {fmtWait(t.waitMin)}</button>}
          {collapsed && t.ask && !attention && <button className="dr-bar-attn" onClick={() => setCollapsed(false)} title={t.ask}>question</button>}
          <span className="tabs-sp" />
          {isCtl && <span className="dr-bar-glass">
            <button className="btn ghost icon" onClick={() => stepGlass(-1)} disabled={glass.see === 0} title={`Less see-through (${keysText('glassLess')})`} aria-label="Less see-through">−</button>
            <button className={`btn ghost glass-btn ${glassOpen ? 'on' : ''}`} aria-expanded={glassOpen} onClick={() => setGlassOpen(o => !o)}
              title={`See-through terminal: presets, blur, text strength and tint. ${keysText('glassToggle')} switches between the saved value and Off.`}>◐ {glass.see ? `${presetOf(glass)?.label || 'Custom'} ${glass.see}%` : 'Off'}{see && readable.raised ? ' !' : ''}</button>
            <button className="btn ghost icon" onClick={() => stepGlass(1)} disabled={glass.see === 100} title={`More see-through (${keysText('glassMore')})`} aria-label="More see-through">+</button>
          </span>}
          {see && <span className="dr-bar-hint" title="Hold the Alt (Option) key to click the page behind the terminal. The panel stays open.">hold ⌥ to click behind</span>}
          <button className="btn ghost icon" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Show the header: details, buttons, tabs, log, inbox and outbox' : 'Hide the header so the terminal gets the whole height'}>{collapsed ? '▾' : '▴'}</button>
          <button className="btn ghost icon" onClick={onClose} title="Close">✕</button>
        </div>}
        {isCtl && thin && glassOpen && <div className="glass-pop"><GlassControls g={glass} r={readable} /></div>}
        {!thin && <div className="dr-row1"><span className="num">#{t.num}</span><h2>{t.title}</h2><button className="btn ghost icon" onClick={() => setCompact(c => !c)} title={compact ? 'Show the details (chips, goal, now, since you last looked, buttons)' : 'Fold the details so the terminal gets the room'}>{compact ? '▾' : '▴'}</button><button className="btn ghost icon" onClick={onClose} title="Close">✕</button></div>}
        {t.role === 'controller' && <div className="banner intro">The controller is {t.agent === 'antigravity' ? 'an' : 'a'} {AGENT_NAME[t.agent]} session in <code>~/AgentVault/controller</code> (choose its account and agent on the Accounts page).{t.remoteUrl && <> Remote Control is on: <a href={t.remoteUrl} target="_blank" rel="noreferrer">open it on claude.ai or the Claude app</a>.</>} It manages agents with the <code>tb</code> command: reading and organising run without asking; starting agents, typing into them and archiving wait for your approval here. Try: “what needs me?” or “split X into three parallel tasks”.</div>}
        <div className="dr-meta"><ByController t={t} /><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} />{acct && <span className="chip" title={acct.dir}>{acct.name}</span>}<span className="chip mono">{shortPath(t.cwd)}</span>{t.branch && <span className="chip mono">{t.worktree ? 'worktree · ' : ''}{t.branch}</span>}{t.agent === 'antigravity' && <span className="chip mono" title="Estimate from visible transcript text. Repeated model context is not included.">{tokenEstimate === null ? 'Estimate unavailable' : `~${formatTokens(tokenEstimate)} tokens`}</span>}</div>
        {!!t.scopes?.length && <ScopeList t={t} toast={toast} />}
        {!!t.queue?.length && <QueueList t={t} act={act} />}
        <div className="dr-meta">
          {groups.filter(g => g.tasks.includes(t.id)).map(g => <span key={g.id} className="chip gchip" style={{ borderColor: g.color + '66', color: g.color }}><span className="sw" style={{ background: g.color }} />{g.name}<button className="gx" title={`Remove #${t.num} from ${g.name}. The agent keeps running.`} aria-label={`Remove from ${g.name}`} onClick={() => { const p = planUngroup(t.id, t.num, groups, g.id); if ('change' in p) runGroupChange(p.change, toast); }}>×</button></span>)}
          <select className="gsel" value="" onChange={async e => { const v = e.target.value; if (v === '__new') { const n = prompt('Name for the new group'); if (n) await api.createGroup(n, [t.id]); } else if (v) await api.updateGroup(v, { add: t.id }); }}>
            <option value="">＋ Add to group…</option>{groups.filter(g => !g.tasks.includes(t.id)).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__new">New group…</option>
          </select>
        </div>
        <div className={`dr-status ${t.status}`}><Dot s={t.status} /><div title={t.statusSource}><span className={`st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span>{['needs-you', 'stopped', 'review'].includes(t.status) && <span className="waitchip">waiting {fmtWait(t.waitMin)}</span>} · {t.statusSource}</div>{!thin && <PendingMarker taskId={t.id} />}</div>
        <div className="ctx"><ThreeLines t={t} fixed />
          {since && !since.first && (since.entries.length > 0 || since.files.length > 0 || since.commits.length > 0) && <div className="since">
            <div className="since-h" onClick={() => setSinceOpen(o => !o)} style={{ cursor: 'pointer' }}>Since you last looked <span>{fmtWait(Math.round((Date.now() - Date.parse(since.since)) / 60000))} ago · {sinceOpen ? 'hide' : 'show'}</span></div>
            {sinceOpen && <ul>
              {since.entries.length > 0 && <li>{since.entries.length} log {since.entries.length === 1 ? 'entry' : 'entries'}: {since.entries[since.entries.length - 1].split('\n').filter(l => l.startsWith('- Did:')).map(l => l.slice(7))[0] || ''}</li>}
              {since.files.length > 0 && <li>Files changed: {since.files.slice(0, 8).map(f => <code key={f}>{f}</code>)}{since.files.length > 8 ? ` and ${since.files.length - 8} more` : ''}</li>}
              {since.commits.length > 0 && <li>Commits: {since.commits.slice(0, 4).map(c => <code key={c}>{c}</code>)}</li>}
            </ul>}
          </div>}
        </div>
        {t.interrupted && t.status !== 'suspended' && <div className="banner"><b>Resumed.</b> {t.interrupted} <button className="btn" onClick={() => act(api.send(t.id, 'continue where you left off'))}>Continue</button></div>}
        {t.status === 'stopped' && <div className="banner stopped"><b>{(t.stopReason || 'Stopped').replace(/\.$/, '')}.</b> {acct?.limited && !accountStop ? `${acct.name} has a limit mark (${acct.limited.note}). ` : ''}{accountStop && t.ask ? `${t.ask} ` : ''}The agent is not working. <button className="btn" onClick={() => act(api.send(t.id, 'continue'))}>Retry now</button>{t.role !== 'controller' && <button className="btn" onClick={() => setMoveOpen(true)}>Move account…</button>}<a className="btn ghost" href="#accounts">Accounts…</a></div>}
        {moveOpen && t.role !== 'controller' && <div className="banner">
          <label htmlFor="move-account">Move to account</label>
          <select id="move-account" className="acct-sel" value={targetAccount} disabled={moving} onChange={e => setTargetAccount(e.target.value)}>
            <option value="">Choose an account</option>
            {accts.filter(a => a.id !== (t.account || `${t.agent}-default`)).map(a => <option key={a.id} value={a.id} disabled={!a.status.signedIn}>
              {a.name} · {AGENT_NAME[a.agent]} · {usageText(a) || 'usage unknown'}{a.limited ? ' · usage limit reached' : ''}{!a.status.signedIn ? ' · not signed in' : ''}
            </option>)}
          </select>
          <span className="sub">The task keeps its files and worktree. A different agent continues with a handoff. Moving stops the current session.</span>
          <button className="btn primary" disabled={!targetAccount || moving || !!t.openElsewhere} onClick={async () => {
            setMoving(true); setErr('');
            try { await api.moveAccount(t.id, targetAccount); setMoveOpen(false); setTargetAccount(''); }
            catch (e) { setErr(String((e as Error).message || e)); }
            finally { setMoving(false); }
          }}>{moving ? 'Moving…' : t.status === 'working' ? 'Stop and move' : 'Move and continue'}</button>
          {t.openElsewhere && <span>Move the session here from its other terminal first.</span>}
          <button className="btn ghost" disabled={moving} onClick={() => setMoveOpen(false)}>Cancel</button>
        </div>}
        {transferOpen && t.role !== 'controller' && <TransferPanel task={t} close={() => setTransferOpen(false)} openTarget={onOpenTask} />}
        {t.transfer && <div className="banner">{t.transfer.direction === 'source' ? 'This task moved to another machine.' : 'This task came from another machine.'} {t.transfer.state === 'started' && <button className="btn" onClick={() => act(linkedTaskId(t.transfer!.peerIdentity, t.transfer!.task).then(id => id ? onOpenTask(id) : toast('The linked machine is not paired with this dashboard.')))}>Open linked task</button>}{t.transfer.direction === 'source' && t.transfer.state !== 'started' && <><span>Check the target before either task resumes.</span><button className="btn" onClick={() => act(api.transferRecover(t.id, 'status').then(r => toast(`Target transfer: ${r.state}.`)))}>Check target</button><button className="btn" onClick={() => act(api.transferRecover(t.id, 'retry-target').then(r => toast(`Target transfer: ${r.state}.`)))}>Retry target</button><button className="btn" onClick={() => act(api.transferRecover(t.id, 'resume-source').then(() => api.resume(t.id)))}>Resume source</button></>}</div>}
        {dropMsg && <div className="banner">{dropMsg} <button className="btn ghost" onClick={() => setDropMsg('')}>OK</button></div>}
        {err && <div className="banner stopped">{err}{err.startsWith('Still open') && <button className="btn" onClick={() => { setErr(''); act(api.resume(t.id, true)); }} title="Only if you are sure the other terminal is not using this conversation">Resume here anyway</button>}<button className="btn ghost" onClick={() => setErr('')}>Dismiss</button></div>}
        {t.imported && t.status === 'suspended' && !err && <div className="banner">Imported: {t.imported}.</div>}
        {/* a restart that gives the agent a new scope (server/index.ts applyScope), and a restart that failed */}
        {t.restartWhenDone && t.restartFor && <div className="banner">
          <div style={{ flex: '1 1 100%' }}><b>Restart pending.</b> {t.restartWait || `Waiting for the end of the turn ${t.restartFor}.`} The restart resumes the same conversation.</div>
          {t.restartOverdue && <button className="btn primary" onClick={() => act(api.restart(t.id, 'now'))} title="Ends the current turn, including a running command. The saved conversation is kept.">Restart now</button>}
          <button className="btn ghost" onClick={() => act(api.restart(t.id, 'cancel'))} title="The agent gets the new folder at the next start of this session">Cancel the restart</button>
        </div>}
        {t.restartFailed && <div className="banner stopped"><span><b>The restart failed.</b> {t.restartFailed}</span><button className="btn" onClick={() => act(api.resume(t.id))}>Try again</button></div>}
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
        <LinksSection t={t} tasks={tasks} onGo={onOpenTask} toast={toast} />
        <div className="dr-actions">
          {t.role !== 'controller' && <button className="btn" disabled={moving} onClick={() => setMoveOpen(o => !o)}>Move account…</button>}
          {t.role !== 'controller' && !t.transfer && <button className="btn" onClick={() => setTransferOpen(o => !o)}>Move to machine…</button>}
          <button className="btn" onClick={() => { navigator.clipboard.writeText(t.attach); setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Open this agent in iTerm or Terminal">⧉ {copied ? 'Copied' : <>Copy <code>{t.attach}</code></>}</button>
          {t.role === 'controller' && !t.newSessionWhenDone && <button className="btn" onClick={() => setConfirmNew(o => !o)} title="End this conversation and start the controller in a new one, with the current instructions and tools">New session…</button>}
          <button className="btn" onClick={() => onCanvas(t.id)} title="Open this agent's live terminal as a window on the canvas">⊞ Show on canvas</button>
          {t.status === 'suspended' && !t.transfer && <button className="btn primary" onClick={() => act(api.resume(t.id))} title="Start the agent again in tmux and continue its saved conversation">Resume</button>}
          {t.status === 'parked' ? <button className="btn" onClick={() => act(api.setStatus(t.id, 'idle'))} title="Put it back on your lists as Idle">Bring back</button> : <button className="btn" onClick={() => act(api.setStatus(t.id, 'parked'))} title="Take it off Needs you, Unread and triage. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.">Set aside</button>}
          {t.status === 'archived' ? <button className="btn" onClick={() => act(api.setStatus(t.id, 'idle'))} title="Take it out of the archive; open it to resume the conversation">Restore</button> : <button className="btn" onClick={() => act(api.kill(t.id).then(onClose))} title={t.openElsewhere ? 'Archives the task; the session in the other terminal keeps running' : 'Ends the tmux session and archives the task'}>End & archive</button>}
          {t.role !== 'controller' && (!confirmRm ? <button className="btn ghost danger" onClick={() => setConfirmRm(true)} title="Delete the task from Taskboard (asks first). Its note goes to ~/.taskboard/trash; the conversation stays in the agent's own history">Remove…</button>
            : <><span className="sel-warn">Remove from Taskboard? The note goes to ~/.taskboard/trash; the conversation stays in {AGENT_NAME[t.agent]}.</span><button className="btn danger" onClick={() => api.remove(t.id).then(onClose, e => setErr(String(e.message || e)))}>Yes, remove</button><button className="btn ghost" onClick={() => setConfirmRm(false)}>Cancel</button></>)}
        </div>
        <div className="tabs">
          <button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>Terminal</button>
          {!t.machine && t.role !== 'controller' && <button className={tab === 'browser' ? 'on' : ''} onClick={() => setTab('browser')} title="This task's own Chrome, which its agent uses">Browser</button>}
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
          : <div className="term-wrap">{!collapsed && <div className={`term-brief ${briefOpen ? 'open' : ''}`} onClick={() => setBriefOpen(o => !o)} title={briefOpen ? 'Click to show only the first lines' : 'Click to show the whole task description'}><b>Task</b><span>{t.desc}</span><i className="more">{briefOpen ? 'less' : 'more'}</i></div>}<Terminal taskId={t.id} autoFocus glass={see ? glassAlpha(see) : 1} tint={see ? see.tint : 'panel'} /></div>)}
        {tab === 'log' && <pre className="logtext">{log || 'No log entries yet.'}</pre>}
        {tab === 'browser' && <BrowserView key={t.id} id={t.id} title={`#${t.num} ${t.title}`} archived={t.status === 'archived'} onCanvas={() => { openBrowserSplit(t.id); onCanvas(t.id); }} />}
        {tab === 'procs' && <ProcList key={t.id} scope="tasks" id={t.id} cwd={t.cwd} />}
      </div>
    </aside>
  );
}

// The worktrees and read folders that the user approved for this task after its start (tb scope request). Remove keeps
// the branch. The server refuses to remove a worktree with uncommitted changes, and asks first about ignored files.
// Messages that Taskboard could not type into this agent yet, with the reason (server/message-queue.ts), and inbox
// notices that the agent was not told about yet (server/inbox-delivery.ts).
function QueueList({ t, act }: { t: Task; act: (p: Promise<unknown>) => Promise<unknown> }) {
  const what = { message: 'Message', review: 'Review feedback', permit: 'Permit result', inbox: 'Inbox notice' };
  return <div className="dr-scopes">{t.queue!.map(q => <div key={q.kind + q.id} className="scope-row" title={q.text}>
    <span className={`chip${q.state === 'failed' ? ' failed' : ''}`}>{q.state === 'failed' ? 'Not delivered' : 'Queued'} · {what[q.kind]} from {q.from}</span>
    <span>{q.reason}</span>
    {q.kind !== 'inbox' && q.state === 'failed' && <button className="btn ghost" title="Wait for an empty input box again, then type the message" onClick={() => void act(api.queueAction(t.id, q.id, 'retry'))}>Type again</button>}
    {q.kind !== 'inbox' && <button className="btn ghost" title="Remove the message. It is not typed." onClick={() => void act(api.queueAction(t.id, q.id, 'remove'))}>Remove</button>}
  </div>)}</div>;
}

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
  return <div className="dr-scopes">{t.scopes!.map(s => <div key={s.id} className="scope-row">
    <span className="chip mono">{s.kind === 'worktree' ? `worktree · ${s.name}` : 'read only'}</span>
    {s.kind === 'worktree' && <><span className="mono" title="Repository (main checkout)">{shortPath(s.repo || '')}</span><span className="mono" title={`Base ${s.base} at ${s.baseCommit}`}>{s.branch}</span></>}
    <span className="mono" title={s.path}>{shortPath(s.path)}</span>
    <button className="btn ghost" title={s.reason} onClick={() => void remove(s.name, s.kind === 'worktree' ? `the worktree ${s.name}` : `read access to ${s.path}`)}>Remove</button>
  </div>)}</div>;
}
