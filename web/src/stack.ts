// The order of the notification stack (NoticeStack.tsx), and the request that brings a task's question card to its
// front. Canvas windows and the task panel show only a one-line marker for a question (PendingMarker in
// PendingCard.tsx). Its button calls showInStack, NoticeStack and the Waiting page listen for the event.
import type { Approval, PendingItem } from './api';
import { sortTime } from './messageCard';

// The approval cards that wait on the user: pending, and a permit while its steps run. A closed card (expired,
// denied, approved, failed, unknown, returned) is not in the stack, the Waiting list or the counts. The Waiting page
// shows closed cards in its Answered view, without buttons.
export const liveApprovals = (approvals: Approval[]) => approvals.filter(a => a.state === 'pending' || (a.action === 'permit' && a.state === 'running'));

export type StackEntry = { id: string; at: string; approval?: Approval; item?: PendingItem };

// approval cards and question cards, oldest first
export function stackEntries(approvals: Approval[], pending: PendingItem[]): StackEntry[] {
  return [
    // a Message card keeps the place of its message when a new version of the draft replaces it
    ...approvals.map(a => ({ id: `a:${a.id}`, at: sortTime(a), approval: a })),
    ...pending.map(i => ({ id: `p:${i.id}`, at: i.createdAt, item: i })),
  ].sort((x, y) => x.at.localeCompare(y.at));
}

// the id of the oldest question card of the task, or null when the task has no card in the stack
export function entryForTask(entries: StackEntry[], taskId: string): string | null {
  return entries.find(e => e.item?.taskId === taskId)?.id ?? null;
}

// The index of the front card. A screen card gets a new id when the terminal size changes the screen rows (for
// example when the task panel opens or closes). When the front card is gone, the next card of the same task takes its
// place. Without one, the oldest card is in front.
export function frontIndex(entries: StackEntry[], frontId: string | null, frontTask?: string): number {
  const i = entries.findIndex(e => e.id === frontId);
  if (i >= 0) return i;
  const same = frontTask ? entryForTask(entries, frontTask) : null;
  return Math.max(0, entries.findIndex(e => e.id === same));
}

export const SHOW_EVENT = 'tb-stack-show';
export function showInStack(taskId: string) {
  window.dispatchEvent(new CustomEvent<string>(SHOW_EVENT, { detail: taskId }));
}

// The words for a card that closed without a decision while it was the front card of the stack: an approval card
// that expired or has an unknown result, or a question that the agent no longer waits on. The stack shows it greyed,
// with no buttons, for CLOSED_MS or until the next click. A card that someone decided gets no notice: the click
// already showed the result. The text comes from the closed card: approvals.ts keeps the last closed cards, and
// pending.ts keeps the answered and gone question cards.
export const CLOSED_MS = 5000;
export function closedNotice(entry: StackEntry, approvals: Approval[], answered: PendingItem[], at: Date = new Date()): { title: string; state: string; text: string } | null {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (entry.approval) {
    const a = approvals.find(x => x.id === entry.approval!.id);
    if (!a || (a.state !== 'expired' && a.state !== 'unknown')) return null;
    return { title: a.summary, state: a.state === 'expired' ? `Expired at ${time}` : `Closed at ${time}, result unknown`, text: `${a.result || ''} No action is possible on this card.`.trim() };
  }
  if (entry.item) {
    const i = answered.find(x => x.id === entry.item!.id);
    if (!i || i.state !== 'gone') return null;
    return { title: entry.item.question, state: `Closed at ${time}`, text: `${i.result || 'The agent no longer waits on this question.'} No action is possible on this card.` };
  }
  return null;
}
