// Shared parts of the message pages: the dashboard's view of a message (GET /api/a2anotes/view/:id, made by toView in
// server/a2anotes/routes.ts), its state labels, and the body with the flagged sentences marked.
import type { Task } from '../api';

export interface QualityView { state: string; flags: { text: string; start: number; end: number; reason: string; code?: string }[] }
export interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string; created: string;
  audience?: 'person' | 'agent' | 'both'; state?: string; person: string; peerName: string; picture: string;
  delivery?: { nextAttemptAt?: string; stoppedAt?: string; failureCode?: string; lastMethod?: string };
  source?: string;
  sentAt?: string; rejectedAt?: string; sending?: boolean; error?: string; dismissedAt?: string;
  proposedBy?: { actor: 'user' | 'controller' | 'task'; task?: string; agent?: string };
  review?: { verdict: string; reason: string }; approval?: { by: string; at?: string };
  approver?: 'user' | 'controller' | 'nobody'; trusted?: boolean;
  routes: { task: string; at?: string }[]; proposedRoute?: { task: string | null };
  triage?: string;
  quality?: QualityView; files: number; agentFile?: string; returns?: { comment: string; at: string }[]; failure?: string;
}

export async function request(path: string, body?: unknown) {
  const response = await fetch('/api/a2anotes' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error([data.error || 'Request failed', data.next].filter(Boolean).join(' '));
  return data;
}

// The body as plain text, with each flagged sentence marked and its reason shown.
export function FlaggedBody({ body, quality }: { body: string; quality?: QualityView }) {
  const flags = (quality?.flags || []).filter(f => f.end > f.start).sort((a, b) => a.start - b.start);
  if (!flags.length) return <pre className="mail-flagged-body">{body}</pre>;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const flag of flags) {
    if (flag.start < offset) continue;
    parts.push(body.slice(offset, flag.start));
    parts.push(<mark className="mail-flag" key={flag.start} title={flag.reason}>{body.slice(flag.start, flag.end)}<small>{flag.reason}</small></mark>);
    offset = flag.end;
  }
  parts.push(body.slice(offset));
  return <pre className="mail-flagged-body">{parts}</pre>;
}

export function sentState(m: Pick<Message, 'state' | 'sentAt' | 'sending' | 'error' | 'rejectedAt' | 'review' | 'approver' | 'approval'>) {
  if (m.sentAt) return 'Sent';
  if (m.state === 'queued') return 'Queued';
  if (m.state === 'permanent_failure') return 'Delivery stopped';
  if (m.sending && m.error) return 'Delivery uncertain';
  if (m.sending) return 'Sending';
  if (m.rejectedAt) return 'Rejected';
  if (m.review?.verdict === 'quarantine' || (m.review && m.approver === 'nobody')) return 'Blocked';
  if (m.approval) return 'Approved';
  if (m.review) return m.approver === 'controller' ? 'Awaiting the controller' : 'Awaiting your approval';
  return 'Awaiting the check';
}
function taskLabel(id: string, tasks: Task[]) { const t = tasks.find(x => x.id === id); return t ? `#${t.num} ${t.title}` : id; }
// What happens next to an incoming message, from the levels in A2A Notes
export function inboxState(m: Message, tasks: Task[]) {
  if (m.failure) return 'The message could not be read. No agent receives it.';
  if (m.rejectedAt) return 'Rejected. No agent receives it.';
  if (m.routes.length) return 'Given to ' + m.routes.map(r => taskLabel(r.task, tasks)).join(', ') + '.';
  if (m.triage) return `${m.state === 'approved' ? 'Accepted for' : 'Waiting for'} controller triage. ${m.triage}`;
  if (m.approval) return `Accepted by ${m.approval.by === 'user' ? 'you' : 'the controller'}. The controller checks its destination.`;
  if (!m.review) return 'Waiting for the check.';
  if (m.review.verdict === 'quarantine') return 'Quarantine: the check found a problem. No agent receives it.';
  if (m.approver === 'nobody') return 'Held: the message failed the safety check. No agent receives it at this level.';
  if (m.approver === 'controller') return 'The controller may approve it and give it to a task.';
  if (m.proposedRoute?.task) return `Waiting for your approval. The controller proposes ${taskLabel(m.proposedRoute.task, tasks)}.`;
  if (m.proposedRoute) return 'The controller says that no task needs this message.';
  return 'Waiting for your approval.';
}
export function date(at?: string) { return at ? new Date(at).toLocaleString() : 'Unknown'; }
export function proposer(m: Pick<Message, 'proposedBy'>, tasks: Task[]) {
  if (!m.proposedBy) return 'Unknown';
  if (m.proposedBy.actor !== 'task') return m.proposedBy.actor === 'user' ? 'You' : 'Controller';
  const task = tasks.find(t => t.id === m.proposedBy?.task);
  return `${task ? `#${task.num} ${task.title}` : m.proposedBy.task || 'Unknown task'}${m.proposedBy.agent ? ` (${m.proposedBy.agent})` : ''}`;
}
