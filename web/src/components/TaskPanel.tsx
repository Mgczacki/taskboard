// The task panel: status, goal/now/waiting, actions, and tabs for the live terminal and the log.
import { useEffect, useState } from 'react';
import type { Group, Task } from '../api';
import { AGENT_NAME, STATUS_LABEL, api, fmtWait, linkedTaskId, shortPath } from '../api';
import { AgentChip, ByController, Dot, MachineChip, ThreeLines, WhereChip } from './ui';
import { Terminal } from './Terminal';
import { DocsTab } from './Docs';
import { hasFiles, uploadAll } from '../drop';
import { loadAccounts, usageText, type Account } from './Accounts';
import { formatTokens } from '../formatTokens';
import type { DocumentLink } from '../documentLinks';
import { planUngroup } from '../groupMove';
import { runGroupChange, type Toast } from '../groupActions';
import { TransferPanel } from './TransferPanel';
import { BrowserView } from './TaskBrowser';
import { ProcList } from './TaskProcs';
import { RuntimeButton } from './TaskRuntime';

// The drawer's width, set by dragging its left edge and kept across reloads. null means the default width.
const WIDTH_KEY = 'tb-drawer-width', MIN_W = 420, EDGE = 120;
const maxW = () => Math.max(MIN_W, innerWidth - EDGE);
const savedWidth = () => { try { const w = Number(localStorage.getItem(WIDTH_KEY)); return w > 0 ? w : null; } catch { return null; } };

export function TaskPanel({ t, tasks, groups, onClose, onCanvas, onOpenTask, initialTab, documentLink, toast }: { t: Task; tasks: Task[]; groups: Group[]; onClose: () => void; onCanvas: (id: string) => void; onOpenTask: (id: string) => void; initialTab?: 'terminal' | 'log' | 'docs' | 'browser' | 'procs'; documentLink?: DocumentLink | null; toast: Toast }) {
  const [tab, setTab] = useState<'terminal' | 'log' | 'docs' | 'browser' | 'procs'>(initialTab || 'terminal');
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
    <aside className={`drawer open ${dropping ? 'dropping' : ''} ${resizing ? 'resizing' : ''}`} style={{ width: width ? `clamp(${MIN_W}px, ${width}px, calc(100vw - ${EDGE}px))` : 'min(880px, 55vw)' }}
      onDragOver={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={e => { if (!hasFiles(e) || t.machine) return; e.preventDefault(); setDropping(false); uploadAll(t.id, e.dataTransfer.files, setDropMsg); }}>
      <div className={`drawer-resize ${resizing ? 'on' : ''}`} onPointerDown={startResize} onDoubleClick={resetWidth} title="Drag to resize. Double-click to reset." />
      {dropping && <div className="dropnote">Drop to put in #{t.num}'s inbox</div>}
      <div className={`dr-head ${compact ? 'compact' : ''}`}>
        <div className="dr-row1"><span className="num">#{t.num}</span><h2>{t.title}</h2><button className="btn ghost icon" onClick={() => setCompact(c => !c)} title={compact ? 'Show the details (chips, goal, now, since you last looked, buttons)' : 'Fold the details so the terminal gets the room'}>{compact ? '▾' : '▴'}</button><button className="btn ghost icon" onClick={onClose} title="Close">✕</button></div>
        {t.role === 'controller' && <div className="banner">The controller is {t.agent === 'antigravity' ? 'an' : 'a'} {AGENT_NAME[t.agent]} session in <code>~/AgentVault/controller</code> (choose its account and agent on the Accounts page).{t.remoteUrl && <> Remote Control is on: <a href={t.remoteUrl} target="_blank" rel="noreferrer">open it on claude.ai or the Claude app</a>.</>} It manages agents with the <code>tb</code> command: reading and organising run without asking; starting agents, typing into them and archiving wait for your approval here. Try: “what needs me?” or “split X into three parallel tasks”.</div>}
        <div className="dr-meta"><ByController t={t} /><AgentChip a={t.agent} /><MachineChip t={t} /><WhereChip t={t} />{acct && <span className="chip" title={acct.dir}>{acct.name}</span>}<span className="chip mono">{shortPath(t.cwd)}</span>{t.branch && <span className="chip mono">{t.worktree ? 'worktree · ' : ''}{t.branch}</span>}{t.agent === 'antigravity' && <span className="chip mono" title="Estimate from visible transcript text. Repeated model context is not included.">{tokenEstimate === null ? 'Estimate unavailable' : `~${formatTokens(tokenEstimate)} tokens`}</span>}</div>
        <div className="dr-meta">
          {groups.filter(g => g.tasks.includes(t.id)).map(g => <span key={g.id} className="chip gchip" style={{ borderColor: g.color + '66', color: g.color }}><span className="sw" style={{ background: g.color }} />{g.name}<button className="gx" title={`Remove #${t.num} from ${g.name}. The agent keeps running.`} aria-label={`Remove from ${g.name}`} onClick={() => { const p = planUngroup(t.id, t.num, groups, g.id); if ('change' in p) runGroupChange(p.change, toast); }}>×</button></span>)}
          <select className="gsel" value="" onChange={async e => { const v = e.target.value; if (v === '__new') { const n = prompt('Name for the new group'); if (n) await api.createGroup(n, [t.id]); } else if (v) await api.updateGroup(v, { add: t.id }); }}>
            <option value="">＋ Add to group…</option>{groups.filter(g => !g.tasks.includes(t.id)).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="__new">New group…</option>
          </select>
        </div>
        <div className={`dr-status ${t.status}`}><Dot s={t.status} /><div><span className={`st-label ${t.status}`}>{STATUS_LABEL[t.status]}</span>{['needs-you', 'stopped', 'review'].includes(t.status) && <span className="waitchip">waiting {fmtWait(t.waitMin)}</span>} · {t.statusSource}</div></div>
        <div className="ctx"><ThreeLines t={t} />
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
          : <div className="term-wrap"><div className={`term-brief ${briefOpen ? 'open' : ''}`} onClick={() => setBriefOpen(o => !o)} title={briefOpen ? 'Click to show only the first lines' : 'Click to show the whole task description'}><b>Task</b><span>{t.desc}</span><i className="more">{briefOpen ? 'less' : 'more'}</i></div><Terminal taskId={t.id} autoFocus /></div>)}
        {tab === 'log' && <pre className="logtext">{log || 'No log entries yet.'}</pre>}
        {tab === 'browser' && <BrowserView key={t.id} id={t.id} title={`#${t.num} ${t.title}`} archived={t.status === 'archived'} />}
        {tab === 'procs' && <ProcList key={t.id} scope="tasks" id={t.id} cwd={t.cwd} />}
      </div>
    </aside>
  );
}
