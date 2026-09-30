// Who may approve a message, from the permission levels on the Settings page (machine.json `messages`).
// Level 1: the user approves every message. Level 2: the controller approves messages that pass the check, the user
// approves the rest. Level 3: the controller also approves messages the check is unsure about.
// The route handlers call these functions on every request and never store the answer, so a changed level applies to
// the next approve, route or send. A message from or to a person who is not a trusted sender always needs the user.
import type { MailData, Message, Verdict } from './store.ts';

export type Level = 1 | 2 | 3;
export type Approver = 'user' | 'controller' | 'nobody';
export interface Levels { incoming: Level; outgoing: Level; checkPrivateNotes?: boolean }

const rank: Record<Verdict, number> = { communication: 0, uncertain: 1, 'action-request': 2, quarantine: 3 };
// the most serious of two verdicts
export const worse = (a: Verdict, b: Verdict): Verdict => rank[b] > rank[a] ? b : a;

// The verdict of the message and all its files. Undefined while any part has no review.
export function combinedVerdict(m: Message): Verdict | undefined {
  if (!m.review || m.files?.some(f => !f.review)) return undefined;
  return (m.files || []).reduce((v, f) => worse(v, f.review!.verdict), m.review.verdict);
}

// Messages from local tasks (tb mail submit) come from the user's own agents.
export function isTrusted(m: Message, data: Pick<MailData, 'trustedSenders'>) {
  if (m.direction === 'inbox' && m.source === 'agent') return true;
  const person = m.direction === 'inbox' ? m.from : m.to;
  return !!data.trustedSenders?.some(t => t.user === person);
}

export function incomingApprover(verdict: Verdict | undefined, level: Level, trusted: boolean): Approver {
  if (!verdict || verdict === 'quarantine') return 'nobody';
  if (verdict === 'action-request') return level === 3 ? 'nobody' : 'user'; // level 3 holds a failed safety check
  if (!trusted || level === 1) return 'user';
  if (verdict === 'uncertain') return level === 3 ? 'controller' : 'user';
  return 'controller';
}

export function outgoingApprover(verdict: Verdict | undefined, level: Level, trusted: boolean): Approver {
  if (!verdict || verdict === 'quarantine') return 'nobody';
  if (verdict === 'action-request' || !trusted || level === 1) return 'user';
  if (verdict === 'uncertain') return level === 3 ? 'controller' : 'user';
  return 'controller';
}

export function approverFor(m: Message, data: Pick<MailData, 'trustedSenders'>, levels: Levels): Approver {
  if (m.dismissedAt || m.rejectedAt) return 'nobody';
  const verdict = combinedVerdict(m), trusted = isTrusted(m, data);
  const answer = m.direction === 'inbox' ? incomingApprover(verdict, levels.incoming, trusted) : outgoingApprover(verdict, levels.outgoing, trusted);
  if (m.direction === 'outbox' && levels.checkPrivateNotes !== false && answer === 'controller' && (m.quality?.state !== 'done' || m.quality.flags.length)) return 'user';
  return answer;
}

// An approval still counts when it matches the current text and the level still permits the one who gave it.
export function approvalValid(m: Message, data: Pick<MailData, 'trustedSenders'>, levels: Levels) {
  if (!m.approval || m.approval.hash !== m.hash || m.dismissedAt || m.rejectedAt) return false;
  const approver = approverFor(m, data, levels);
  return m.approval.by === 'user' ? approver !== 'nobody' : approver === 'controller';
}
