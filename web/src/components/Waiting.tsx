// The Waiting page: one list of everything that waits on the user, oldest first.
//   - question cards (server/pending.ts): permission dialogs, choices, end-of-turn questions, dialogs, plans
//   - approval cards (server/approvals.ts): permits, pushes, releases and the other approvals, with their own rules
//   - Message cards: A2A Notes drafts and incoming messages that wait on you (server/a2anotes/cards.ts, MessageCard.tsx)
//   - tasks that need you, stopped or wait for a review with no card (the former Triage list)
// The views All, Agent questions, Permits, Push and release, and Answered filter this one list.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Approval, PendingItem, Task } from '../api';
import { ATTN, AGENT_NAME, api, fmtWait, useStore } from '../api';
import { SHOW_EVENT } from '../stack';
import { ApprovalCard } from './ApprovalCard';
import { KIND_LABEL, PendingCard } from './PendingCard';
import { isMessage, reminder, sortTime } from '../messageCard';
import { Terminal } from './Terminal';
import { AgentChip, Dot, StatusLabel, ThreeLines } from './ui';

type Row = { id: string; at: string; taskId?: string; agent?: Agent; title: string; question: string; kind: string; risky?: boolean; screen?: boolean; late?: boolean; item?: PendingItem; approval?: Approval; task?: Task; done?: boolean };
type View = 'all' | 'questions' | 'messages' | 'permits' | 'git' | 'answered';
const VIEWS: [View, string][] = [['all', 'All'], ['questions', 'Agent questions'], ['messages', 'Messages'], ['permits', 'Permits'], ['git', 'Push and release'], ['answered', 'Answered']];
const GIT = ['git-push', 'git-merge', 'release', 'restart'];
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

export function waitingRows(tasks: Task[], approvals: Approval[], pending: PendingItem[]): Row[] {
  const live = approvals.filter(a => a.state === 'pending' || (a.action === 'permit' && a.state === 'running'));
  const numOf = (id: string) => tasks.find(t => t.id === id);
  const rows: Row[] = [
    ...pending.map(i => ({ id: `p:${i.id}`, at: i.createdAt, taskId: i.taskId, agent: i.agent, title: `#${i.taskNum} ${i.taskTitle}`, question: i.question, kind: KIND_LABEL[i.kind], risky: i.options.some(o => o.risk), screen: i.source === 'screen', item: i })),
    ...live.map(a => { const t = numOf(a.actor); return { id: `a:${a.id}`, at: sortTime(a), taskId: t?.id, agent: t?.agent, title: a.actor === 'controller' ? 'The controller' : t ? `#${t.num} ${t.title}` : a.actor, question: a.summary, kind: isMessage(a) ? 'Message' : a.action === 'permit' ? 'Permit' : a.action === 'git-push' ? 'Git push' : a.action === 'release' ? 'Release' : a.action === 'tool-refusal' ? 'Refused command' : 'Approval', late: !!reminder(a), approval: a }; }),
  ];
  const covered = new Set(rows.map(r => r.taskId).filter(Boolean));
  for (const t of tasks) if (ATTN.includes(t.status) && !covered.has(t.id))
    rows.push({ id: `t:${t.id}`, at: new Date(Date.now() - t.waitMin * 60000).toISOString(), taskId: t.id, agent: t.agent, title: `#${t.num} ${t.title}`, question: t.ask || t.stopReason || (t.status === 'review' ? 'Waits for your review' : 'Waits on you'), kind: t.status === 'stopped' ? 'Stopped' : t.status === 'review' ? 'Review' : 'Needs you', task: t });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

export function WaitingPage({ tasks, allTasks, openTask, openController, toast }: { tasks: Task[]; allTasks: Task[]; openTask: (id: string) => void; openController: () => void; toast: (s: string) => void }) {
  const { approvals, pending, answered } = useStore();
  const [view, setView] = useState<View>('all');
  const [agent, setAgent] = useState<Agent | 'any'>('any');
  const [sel, setSel] = useState<string | null>(null);
  const [showTerm, setShowTerm] = useState(() => { try { return localStorage.getItem('tb-waiting-term') !== 'off'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('tb-waiting-term', showTerm ? 'on' : 'off'); } catch { /* storage off */ } }, [showTerm]);
  // the reminder on a Message card depends on the time: the list is made again each minute
  const [minute, setMinute] = useState(0);
  useEffect(() => { const t = setInterval(() => setMinute(m => m + 1), 60_000); return () => clearInterval(t); }, []);
  const all = useMemo(() => waitingRows(tasks, approvals, pending), [tasks, approvals, pending, minute]);
  // the notification stack is off on this page: a marker button in the task panel selects the task's card here
  const latest = useRef(all); latest.current = all;
  useEffect(() => {
    const on = (e: Event) => { const r = latest.current.find(x => x.item && x.taskId === (e as CustomEvent<string>).detail); if (r) { setView('all'); setAgent('any'); setSel(r.id); } };
    window.addEventListener(SHOW_EVENT, on);
    return () => window.removeEventListener(SHOW_EVENT, on);
  }, []);
  const done: Row[] = [...answered.map(i => ({ id: `p:${i.id}`, at: i.answer?.at || i.createdAt, taskId: i.taskId, agent: i.agent, title: `#${i.taskNum} ${i.taskTitle}`, question: i.question, kind: KIND_LABEL[i.kind], item: i, done: true })),
    // decided Message cards, with their result: sent, failed with the reason, rejected, or sent back
    ...approvals.filter(a => isMessage(a) && ['approved', 'failed', 'denied', 'returned'].includes(a.state)).map(a => { const t = tasks.find(x => x.id === a.actor); return { id: `a:${a.id}`, at: a.created, taskId: t?.id, agent: t?.agent, title: a.actor === 'controller' ? 'The controller' : t ? `#${t.num} ${t.title}` : a.actor, question: a.summary, kind: 'Message', approval: a, done: true }; })]
    .sort((x, y) => y.at.localeCompare(x.at));
  const test: Record<View, (r: Row) => boolean> = {
    all: () => true, questions: r => !!r.item, answered: () => true, messages: r => r.kind === 'Message',
    permits: r => r.item?.kind === 'command' || ['permit', 'tool-refusal'].includes(r.approval?.action || ''),
    git: r => GIT.includes(r.approval?.action || ''),
  };
  const rows = (view === 'answered' ? done : all.filter(test[view])).filter(r => agent === 'any' || r.agent === agent);
  const cur = rows.find(r => r.id === sel) || rows[0];
  const risky = all.filter(r => r.risky).length, late = all.filter(r => r.late).length;
  return <div className="waiting">
    <div className="wt-head"><div><div className="sub">{all.length ? `${all.length === 1 ? '1 item waits' : `${all.length} items wait`} on you · oldest first${risky ? ` · ${risky} with a risky option` : ''}${late ? ` · ${late === 1 ? '1 message draft waits' : `${late} message drafts wait`} too long` : ''}` : 'Nothing waits on you.'}</div></div>
      <span className="pc-sp" /><label className="opt"><input type="checkbox" checked={showTerm} onChange={e => setShowTerm(e.target.checked)} /> Show the terminal below the card</label></div>
    <div className="wt-tabs">{VIEWS.map(([v, label]) => <button key={v} className={`wt-tab ${view === v ? 'on' : ''}`} onClick={() => { setView(v); setSel(null); }}>{label}<span className="n">{v === 'answered' ? done.length : all.filter(test[v]).length}</span></button>)}</div>
    <div className="wt-filters">{(['any', 'claude', 'codex', 'antigravity'] as const).map(a => <button key={a} className={`chip wt-chip ${agent === a ? 'on' : ''}`} onClick={() => { setAgent(a); setSel(null); }}>{a === 'any' ? 'All agents' : AGENT_NAME[a]}</button>)}
      {view === 'permits' && <span className="sub">Permit requests and command permissions from agents.</span>}</div>
    <div className="wt-split">
      <div className="wt-list">{rows.length ? rows.map(r => <button key={r.id} className={`wt-row ${cur?.id === r.id ? 'on' : ''} ${r.done ? 'done' : ''}`} onClick={() => setSel(r.id)}>
        <span className={`dot ${r.done ? 'idle' : r.kind === 'Stopped' ? 'stopped' : r.kind === 'Review' ? 'review' : 'needs-you'}`} />
        <span className="t">{r.title}</span><span className="a">{fmtWait(minutesSince(r.at))}</span>
        <span className="q">{r.question}</span>
        <span className="k">{r.agent && <AgentChip a={r.agent} />}<span className="chip">{r.kind}</span>{r.risky && <span className="chip warn">risky option</span>}{r.screen && <span className="chip">screen</span>}{r.late && <span className="chip warn" title="Nobody approved this draft for a long time. It is not sent.">reminder</span>}{r.done && r.approval && <span className="chip">{r.approval.state === 'approved' ? 'done' : r.approval.state}</span>}{r.done && r.item?.state && <span className="chip">{r.item.state === 'answered' ? `answered by ${r.item.answer?.by === 'controller' ? 'the controller' : 'you'}` : r.item.state}</span>}</span>
      </button>) : <div className="wt-empty">Nothing here.</div>}</div>
      <div className="wt-detail">{cur ? <>
        {cur.item && !cur.done && <PendingCard key={cur.id} item={cur.item} openTask={openTask} toast={toast} />}
        {cur.item && cur.done && <div className={`pcard ${cur.item.state}`}><div className="pc-h"><b>#{cur.item.taskNum} {cur.item.taskTitle}</b><AgentChip a={cur.item.agent} /><span className="chip">{KIND_LABEL[cur.item.kind]}</span></div><p className="pc-q">{cur.item.question}</p>
          <div className={`pc-note ${cur.item.state === 'answered' ? 'ok' : 'info'}`}>{cur.item.answer ? <><b>Answered:</b> {cur.item.answer.label} · by {cur.item.answer.by === 'controller' ? `the controller (${cur.item.answer.rule})` : 'you'} · {new Date(cur.item.answer.at).toLocaleTimeString()}{cur.item.answer.tasks ? ` · one answer for ${cur.item.answer.tasks.map(n => '#' + n).join(', ')}` : ''}<br />{cur.item.result}</> : cur.item.result}</div></div>}
        {cur.approval && <ApprovalCard key={cur.id} a={cur.approval} allTasks={allTasks} setOpenId={openTask} openController={openController} toast={toast} />}
        {cur.task && <div className="pcard"><div className="pc-h"><Dot s={cur.task.status} /><b>#{cur.task.num} {cur.task.title}</b><StatusLabel s={cur.task.status} /><AgentChip a={cur.task.agent} /><span className="pc-sp" /><span className="pc-age">waiting {fmtWait(cur.task.waitMin)}</span></div>
          <ThreeLines t={cur.task} />
          <div className="pc-row"><button className="btn" onClick={() => openTask(cur.task!.id)}>Open task panel</button><button className="btn" onClick={() => void api.setStatus(cur.task!.id, 'parked')} title="Take it off this list. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.">Set aside</button></div></div>}
        {showTerm && cur.taskId && !cur.done && <div className="wt-term"><Terminal key={cur.taskId} taskId={cur.taskId} /></div>}
      </> : <div className="wt-empty">Every agent is working or done.</div>}</div>
    </div>
  </div>;
}
