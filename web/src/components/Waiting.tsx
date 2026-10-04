// The Waiting page: one list of everything that waits on the user, oldest first.
//   - question cards (server/pending.ts): permission dialogs, choices, end-of-turn questions, dialogs, plans
//   - approval cards (server/approvals.ts): permits, pushes, releases and the other approvals, with their own rules
//   - Message cards: A2A Notes drafts and incoming messages that wait on you (server/a2anotes/cards.ts, MessageCard.tsx)
//   - tasks that need you, stopped or wait for a review with no card (the former Triage list)
//   - Undelivered message rows: a message to a task or to the controller that failed or waits longer than 5 minutes
//     (server/message-queue.ts, QueuedMessage.tsx)
// The views All, Agent questions, Permits, Push and release, and Answered filter this one list.
// Dismissed lists the items that the user dismissed (server/dismiss.ts), with Bring back. A dismissed item is not in
// the other views until its signature changes. Approval and Message cards have no Dismiss: they carry their own decision.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Approval, Dismissal, PendingItem, QueuedMessage, Task } from '../api';
import { ATTN, AGENT_NAME, api, fmtWait, useStore } from '../api';
import { dismissedList } from '../dismissRules';
import { backAt, bringBack, DISMISS_TITLE, dismissItem, dismissTask, quietTaskIds, SET_ASIDE_TITLE } from '../dismiss';
import type { Toast } from '../groupActions';
import { hit, keyLabel, keysText, useKeymap } from '../keys';
import { liveApprovals, SHOW_EVENT } from '../stack';
import { ApprovalCard } from './ApprovalCard';
import { LATE_KIND, lateMessages, QueueActions, queueLabel, queueReason } from './QueuedMessage';
import { KIND_LABEL, PendingCard } from './PendingCard';
import { isMessage, reminder, sortTime } from '../messageCard';
import { Terminal } from './Terminal';
import { AgentChip, Dot, StatusLabel, ThreeLines } from './ui';

type Row = { id: string; at: string; taskId?: string; agent?: Agent; title: string; question: string; kind: string; risky?: boolean; screen?: boolean; late?: boolean; item?: PendingItem; approval?: Approval; task?: Task; done?: boolean; dismissal?: Dismissal; queued?: { t: Task; q: QueuedMessage } };
type View = 'all' | 'questions' | 'messages' | 'permits' | 'git' | 'answered' | 'dismissed';
const VIEWS: [View, string][] = [['all', 'All'], ['questions', 'Agent questions'], ['messages', 'Messages'], ['permits', 'Permits'], ['git', 'Push and release'], ['answered', 'Answered'], ['dismissed', 'Dismissed']];
const GIT = ['git-push', 'git-merge', 'release', 'restart'];
// the kind chip of a decided approval card in the Answered view
const KIND_OF_ACTION: Record<string, string> = { permit: 'Permit', external: 'External action', plan: 'Plan', 'git-push': 'Push', 'git-merge': 'Merge', release: 'Release', restart: 'Restart', scope: 'Scope', new: 'New task', send: 'Message', 'mail-in': 'Message', 'mail-out': 'Message' };
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

// quiet: the tasks whose waiting item the user dismissed (dismiss.ts quietTaskIds). They get no task row.
// withController: the tasks and the controller, whose undelivered messages get a row each.
export function waitingRows(tasks: Task[], approvals: Approval[], pending: PendingItem[], quiet: Set<string> = new Set(), withController: Task[] = tasks): Row[] {
  const live = liveApprovals(approvals);
  const numOf = (id: string) => tasks.find(t => t.id === id);
  const rows: Row[] = [
    ...pending.map(i => ({ id: `p:${i.id}`, at: i.createdAt, taskId: i.taskId, agent: i.agent, title: `#${i.taskNum} ${i.taskTitle}`, question: i.question, kind: KIND_LABEL[i.kind], risky: i.options.some(o => o.risk), screen: i.source === 'screen', item: i })),
    ...live.map(a => { const t = numOf(a.actor); return { id: `a:${a.id}`, at: sortTime(a), taskId: t?.id, agent: t?.agent, title: a.actor === 'controller' ? 'The controller' : t ? `#${t.num} ${t.title}` : a.actor, question: a.summary, kind: isMessage(a) ? 'Message' : KIND_OF_ACTION[a.action] || 'Approval', late: !!reminder(a), approval: a }; }),
  ];
  for (const { t, q } of lateMessages(withController))
    rows.push({ id: `q:${t.id}:${q.id}`, at: q.queued, taskId: t.id, agent: t.agent, title: t.role === 'controller' ? 'The controller' : `#${t.num} ${t.title}`, question: `${queueLabel(q)}. ${q.state === 'failed' ? 'The agent did not read it.' : q.seen || q.reason}`, kind: LATE_KIND, late: true, queued: { t, q } });
  const covered = new Set(rows.filter(r => !r.queued).map(r => r.taskId).filter(Boolean));
  for (const t of tasks) if (ATTN.includes(t.status) && !covered.has(t.id) && !quiet.has(t.id))
    rows.push({ id: `t:${t.id}`, at: new Date(Date.now() - t.waitMin * 60000).toISOString(), taskId: t.id, agent: t.agent, title: `#${t.num} ${t.title}`, question: t.ask || t.stopReason || (t.status === 'review' ? 'Waits for your review' : 'Waits on you'), kind: t.status === 'stopped' ? 'Stopped' : t.status === 'review' ? 'Review' : 'Needs you', task: t });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

// the Dismissed view: newest dismiss first, with the card or task when it still waits (dismissRules.ts)
export function dismissedRows(dismissals: Dismissal[], hidden: PendingItem[], tasks: Task[]): Row[] {
  return dismissedList(dismissals, hidden, tasks).map(({ dismissal: d, item, task, owner }) =>
    ({ id: `d:${d.sig}`, at: d.at, taskId: d.taskId, agent: item?.agent || owner?.agent, title: `#${d.taskNum} ${d.title}`, question: d.question, kind: d.label, item, task, dismissal: d, done: true }));
}

export function WaitingPage({ tasks, allTasks, openTask, openController, toast }: { tasks: Task[]; allTasks: Task[]; openTask: (id: string) => void; openController: () => void; toast: Toast }) {
  const { approvals, pending, answered, dismissedPending, dismissals } = useStore();
  useKeymap();
  const [view, setView] = useState<View>('all');
  const [agent, setAgent] = useState<Agent | 'any'>('any');
  const [sel, setSel] = useState<string | null>(null);
  const [showTerm, setShowTerm] = useState(() => { try { return localStorage.getItem('tb-waiting-term') !== 'off'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('tb-waiting-term', showTerm ? 'on' : 'off'); } catch { /* storage off */ } }, [showTerm]);
  // the reminder on a Message card depends on the time: the list is made again each minute
  const [minute, setMinute] = useState(0);
  useEffect(() => { const t = setInterval(() => setMinute(m => m + 1), 60_000); return () => clearInterval(t); }, []);
  const quiet = useMemo(() => quietTaskIds(tasks, pending, dismissedPending, dismissals), [tasks, pending, dismissedPending, dismissals]);
  const all = useMemo(() => waitingRows(tasks, approvals, pending, quiet, allTasks), [tasks, allTasks, approvals, pending, quiet, minute]);
  const gone = useMemo(() => dismissedRows(dismissals, dismissedPending, tasks), [dismissals, dismissedPending, tasks]);
  // the notification stack is off on this page: a marker button in the task panel selects the task's card here
  const latest = useRef(all); latest.current = all;
  useEffect(() => {
    const on = (e: Event) => { const r = latest.current.find(x => x.item && x.taskId === (e as CustomEvent<string>).detail); if (r) { setView('all'); setAgent('any'); setSel(r.id); } };
    window.addEventListener(SHOW_EVENT, on);
    return () => window.removeEventListener(SHOW_EVENT, on);
  }, []);
  const done: Row[] = [...answered.map(i => ({ id: `p:${i.id}`, at: i.answer?.at || i.createdAt, taskId: i.taskId, agent: i.agent, title: `#${i.taskNum} ${i.taskTitle}`, question: i.question, kind: KIND_LABEL[i.kind], item: i, done: true })),
    // decided Message cards, with their result: sent, failed with the reason, rejected, or sent back
    ...approvals.filter(a => (isMessage(a) || a.action !== 'tool-refusal') && ['approved', 'failed', 'denied', 'returned', ...(isMessage(a) ? [] : ['expired', 'unknown'])].includes(a.state)).map(a => { const t = tasks.find(x => x.id === a.actor); return { id: `a:${a.id}`, at: a.decidedBy?.at || a.created, taskId: t?.id, agent: t?.agent, title: a.actor === 'controller' ? 'The controller' : t ? `#${t.num} ${t.title}` : a.actor, question: a.summary, kind: isMessage(a) ? 'Message' : KIND_OF_ACTION[a.action] || 'Approval', approval: a, done: true }; })]
    .sort((x, y) => y.at.localeCompare(x.at));
  const test: Record<View, (r: Row) => boolean> = {
    all: () => true, questions: r => !!r.item, answered: () => true, messages: r => r.kind === 'Message' || r.kind === LATE_KIND,
    permits: r => r.item?.kind === 'command' || ['permit', 'tool-refusal'].includes(r.approval?.action || ''),
    git: r => GIT.includes(r.approval?.action || ''), dismissed: () => true,
  };
  const rows = (view === 'answered' ? done : view === 'dismissed' ? gone : all.filter(test[view])).filter(r => agent === 'any' || r.agent === agent);
  const displayRows = [...rows].sort((a, b) => Number(!!a.queued) - Number(!!b.queued) || (a.taskId || '').localeCompare(b.taskId || '') || a.at.localeCompare(b.at));
  const userRows = all.filter(r => !r.queued);
  const waitingTasks = new Set(userRows.map(r => r.taskId || r.id)).size;
  const cardCount = userRows.filter(r => r.approval || r.item).length;
  const cur = rows.find(r => r.id === sel) || rows[0];
  // Dismiss for a question card or a task row; approval and Message cards have no Dismiss
  const dismiss = (r: Row | undefined) => {
    if (!r || r.done) return;
    if (r.item) void dismissItem(r.item, r.kind, toast);
    else if (r.task) void dismissTask(r.task, r.kind, toast);
    else toast('An approval or Message card has no Dismiss. Decide it on its card.');
  };
  const latestCur = useRef(cur); latestCur.current = cur;
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (hit(e, 'waitingDismiss')) { e.preventDefault(); dismiss(latestCur.current); } };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  }, []);
  const risky = all.filter(r => r.risky).length, late = all.filter(r => r.late).length;
  return <div className="waiting">
    <div className="wt-head"><div><div className="sub">{userRows.length ? `${waitingTasks} tasks wait on you (${cardCount} cards)${risky ? ` · ${risky} with a risky option` : ''}${late ? ` · ${late} late items` : ''}` : 'Nothing waits on you.'}</div></div>
      <span className="pc-sp" /><label className="opt"><input type="checkbox" checked={showTerm} onChange={e => setShowTerm(e.target.checked)} /> Show the terminal below the card</label></div>
    <div className="wt-tabs">{VIEWS.map(([v, label]) => <button key={v} className={`wt-tab ${view === v ? 'on' : ''}`} onClick={() => { setView(v); setSel(null); }}>{label}<span className="n">{v === 'answered' ? done.length : v === 'dismissed' ? gone.length : all.filter(test[v]).length}</span></button>)}</div>
    <div className="wt-filters">{(['any', 'claude', 'codex', 'antigravity'] as const).map(a => <button key={a} className={`chip wt-chip ${agent === a ? 'on' : ''}`} onClick={() => { setAgent(a); setSel(null); }}>{a === 'any' ? 'All agents' : AGENT_NAME[a]}</button>)}
      {view === 'permits' && <span className="sub">Permit requests and command permissions from agents.</span>}
      {view === 'dismissed' && <span className="sub">Items that you dismissed. Each one shows again by itself when something new happens for it.</span>}
      {view !== 'dismissed' && view !== 'answered' && keyLabel('waitingDismiss') && <span className="sub" title={`Dismiss the selected item: ${keysText('waitingDismiss')}`}>Dismiss the selected item: <kbd>{keyLabel('waitingDismiss')}</kbd></span>}</div>
    <div className="wt-split">
      <div className="wt-list">{displayRows.length ? displayRows.map((r, i) => <div key={r.id}>
        {(i === 0 || !!displayRows[i - 1].queued !== !!r.queued) && <h3 className="wt-group-label">{r.queued ? 'Others' : 'You'}</h3>}
        {(i === 0 || displayRows[i - 1].taskId !== r.taskId) && <div className="wt-task-label">{r.title}</div>}
        <button className={`wt-row ${cur?.id === r.id ? 'on' : ''} ${r.done ? 'done' : ''}`} onClick={() => setSel(r.id)}>
        <span className={`dot ${r.done ? 'idle' : r.kind === 'Stopped' ? 'stopped' : r.kind === 'Review' ? 'review' : 'needs-you'}`} />
        <span className="t">{r.title}</span><span className="a">{fmtWait(minutesSince(r.at))}</span>
        <span className="q">{r.question}{r.approval && <small> · valid {r.approval.validUntil || 'until facts change'}{r.approval.unblocks?.length ? ` · unblocks ${r.approval.unblocks.join(', ')}` : ''}</small>}</span>
        <span className="k">{r.agent && <AgentChip a={r.agent} />}<span className="chip">{r.kind}</span>{r.risky && <span className="chip warn">risky option</span>}{r.screen && <span className="chip">screen</span>}{r.late && !r.queued && <span className="chip warn" title="Nobody approved this draft for a long time. It is not sent.">reminder</span>}{r.queued && <span className="chip warn" title="Taskboard could not give this message to the agent yet.">not delivered</span>}{r.done && r.approval && <span className="chip">{r.approval.state === 'approved' ? r.approval.decidedBy?.by === 'controller' ? 'approved by the controller' : 'done' : r.approval.state}</span>}{r.dismissal && <span className="chip">dismissed{r.dismissal.until ? ' for 10 min' : ''}</span>}{r.done && !r.dismissal && r.item?.state && <span className="chip">{r.item.state === 'answered' ? `answered by ${r.item.answer?.by === 'controller' ? 'the controller' : 'you'}` : r.item.state}</span>}</span>
        </button></div>) : <div className="wt-empty">Nothing here.</div>}</div>
      <div className="wt-detail">{cur ? <>
        {cur.dismissal && <div className="pcard"><div className="pc-h"><b>{cur.title}</b>{cur.agent && <AgentChip a={cur.agent} />}<span className="chip">{cur.kind}</span><span className="pc-sp" /><span className="pc-age">dismissed at {new Date(cur.dismissal.at).toLocaleTimeString()}</span></div>
          <p className="pc-q">{cur.question}</p>
          <div className="pc-note info">{cur.dismissal.until ? <>The agent still waits on this answer. The card was not answered. {backAt(cur.dismissal)}</> : <>Hidden until something new happens for this item. The task status is not changed.</>}{!cur.item && !cur.task && ' The item no longer waits. Taskboard removes this entry soon.'}</div>
          <div className="pc-row"><button className="btn primary" onClick={() => void bringBack(cur.dismissal!.sig, toast)} title="Show this item again in the lists">Bring back</button><button className="btn" onClick={() => openTask(cur.dismissal!.taskId)}>Open task panel</button></div></div>}
        {cur.item && !cur.done && <PendingCard key={cur.id} item={cur.item} openTask={openTask} toast={toast} />}
        {cur.item && cur.done && !cur.dismissal && <div className={`pcard ${cur.item.state}`}><div className="pc-h"><b>#{cur.item.taskNum} {cur.item.taskTitle}</b><AgentChip a={cur.item.agent} /><span className="chip">{KIND_LABEL[cur.item.kind]}</span></div><p className="pc-q">{cur.item.question}</p>
          <div className={`pc-note ${cur.item.state === 'answered' ? 'ok' : 'info'}`}>{cur.item.answer ? <><b>Answered:</b> {cur.item.answer.label} · by {cur.item.answer.by === 'controller' ? `the controller (${cur.item.answer.rule})` : 'you'} · {new Date(cur.item.answer.at).toLocaleTimeString()}{cur.item.answer.tasks ? ` · one answer for ${cur.item.answer.tasks.map(n => '#' + n).join(', ')}` : ''}<br />{cur.item.result}</> : cur.item.result}</div></div>}
        {cur.queued && <QueuedCard t={cur.queued.t} q={cur.queued.q} openTask={openTask} openController={openController} toast={toast} />}
        {cur.approval && <ApprovalCard key={cur.id} a={cur.approval} allTasks={allTasks} setOpenId={openTask} openController={openController} toast={toast} />}
        {cur.task && !cur.dismissal && <div className="pcard"><div className="pc-h"><Dot s={cur.task.status} /><b>#{cur.task.num} {cur.task.title}</b><StatusLabel s={cur.task.status} /><AgentChip a={cur.task.agent} /><span className="pc-sp" /><span className="pc-age">waiting {fmtWait(cur.task.waitMin)}</span></div>
          <ThreeLines t={cur.task} />
          <div className="pc-row"><button className="btn" onClick={() => openTask(cur.task!.id)} title="Open task panel: the terminal and the details of this task.">Open task panel</button>
            <button className="btn" onClick={() => dismiss(cur)} title={`${DISMISS_TITLE} Key: ${keysText('waitingDismiss')}.`}>Dismiss</button>
            <button className="btn" onClick={() => void api.setStatus(cur.task!.id, 'parked')} title={SET_ASIDE_TITLE}>Set aside</button></div></div>}
        {showTerm && cur.taskId && !cur.done && <div className="wt-term"><Terminal key={cur.taskId} taskId={cur.taskId} /></div>}
      </> : <div className="wt-empty">Every agent is working or done.</div>}</div>
    </div>
  </div>;
}

// An undelivered message: the whole start of the text, the reason, and Deliver by hook, Type now and Remove.
function QueuedCard({ t, q, openTask, openController, toast }: { t: Task; q: QueuedMessage; openTask: (id: string) => void; openController: () => void; toast: Toast }) {
  const act = (p: Promise<unknown>) => p.catch(e => { toast(String((e as Error).message || e)); });
  return <div className="pcard"><div className="pc-h"><b>{t.role === 'controller' ? 'The controller' : `#${t.num} ${t.title}`}</b><AgentChip a={t.agent} /><span className="chip warn">{LATE_KIND}</span><span className="pc-sp" /><span className="pc-age">queued at {new Date(q.queued).toLocaleTimeString()}</span></div>
    <p className="pc-q">{queueLabel(q)}</p>
    <pre className="mail-flagged-body">{q.text}</pre>
    <div className={`pc-note ${q.state === 'failed' ? 'warn' : 'info'}`}>{queueReason(q)}</div>
    <div className="pc-row"><QueueActions t={t} q={q} act={act} toast={toast} /><button className="btn" onClick={() => t.role === 'controller' ? openController() : openTask(t.id)}>Open {t.role === 'controller' ? 'the controller' : 'task panel'}</button></div></div>;
}
