// What a Message card shows (web/src/components/MessageCard.tsx). A Message card is an approval card with the action
// mail-out or mail-in (server/a2anotes/cards.ts). These functions have no React, so tests can import them.
import type { Approval } from './api';

export const isMessage = (a: Pick<Approval, 'action'>) => a.action === 'mail-out' || a.action === 'mail-in';
// The time that orders a Message card: when the message was written. A new version of a draft gets a new card, but it
// keeps its place in the notification stack and on the Waiting page.
export const sortTime = (a: Pick<Approval, 'created' | 'payload'>) => a.payload?.since || a.created;
export const waitedMin = (a: Pick<Approval, 'created' | 'payload'>, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(sortTime(a))) / 60000));

// A reminder for a draft that nobody approved after remindAfterMin minutes (10 by default on the server).
export function reminder(a: Pick<Approval, 'created' | 'payload' | 'state' | 'action'>, now = Date.now()): string {
  const p = a.payload;
  if (!p?.stage || a.state !== 'pending' || p.stage === 'incoming') return '';
  const min = waitedMin(a, now);
  if (min < (p.remindAfterMin ?? 10)) return '';
  const minutes = `${min} minute${min === 1 ? '' : 's'}`;
  return p.stage === 'send' ? `This draft was written ${minutes} ago. It is approved and still not sent.` : `Nobody approved this draft in ${minutes}. It is not sent.`;
}

export function stageLabel(stage?: string): string {
  return stage === 'checking' ? 'Not sent yet · the checks are running'
    : stage === 'held' ? 'Not sent yet · the safety check holds it'
    : stage === 'send' ? 'Approved · not sent yet'
    : stage === 'incoming' ? 'Waits for your approval'
    : 'Not sent yet';
}

export interface MessageButtons { approve: string; recheck: boolean; removeFlagged: boolean; sendBack: boolean }
// The buttons of a pending Message card. approve is the label of the Approve button, or '' for no Approve button.
export function messageButtons(a: Pick<Approval, 'action' | 'payload' | 'returnable' | 'state'>): MessageButtons {
  const p = a.payload, stage = p?.stage || (a.action === 'mail-in' ? 'incoming' : 'draft');
  const notes = p?.notes || [];
  const approve = a.state !== 'pending' ? ''
    : stage === 'draft' ? 'Approve and send'
    : stage === 'send' ? 'Send again'
    : stage === 'incoming' ? (p?.proposal?.task ? 'Approve and give to the task' : 'Approve') : '';
  return {
    approve,
    recheck: a.state === 'pending' && a.action === 'mail-out' && (stage === 'checking' || stage === 'held' || notes.some(n => n.actions.includes('recheck'))),
    removeFlagged: a.state === 'pending' && a.action === 'mail-out' && stage !== 'send' && notes.some(n => n.actions.includes('remove-flagged')),
    sendBack: a.state === 'pending' && !!a.returnable && stage !== 'send',
  };
}

// The label of a decided Message card, in place of its stage.
export function doneLabel(a: Pick<Approval, 'state' | 'action'>): string {
  const out = a.action === 'mail-out';
  return a.state === 'approved' ? (out ? 'Sent' : 'Approved') : a.state === 'failed' ? (out ? 'Not sent' : 'Failed') : a.state === 'denied' || a.state === 'returned' ? 'Rejected' : 'Closed';
}

// The result line of a decided Message card.
export function resultLine(a: Pick<Approval, 'state' | 'result' | 'action'>): string {
  const r = a.result || '';
  if (a.state === 'running') return a.action === 'mail-out' ? 'Sending now…' : 'Working…';
  if (a.state === 'approved') return r || 'Done.';
  if (a.state === 'failed') return `Failed: ${r}`;
  if (a.state === 'returned') return r || 'Sent back with your comment.';
  if (a.state === 'denied') return r || 'Rejected.';
  if (a.state === 'expired') return r || 'This card closed.';
  return r;
}
