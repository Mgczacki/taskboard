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

// the id of the oldest question card of the task, or null when the task has no card in the stack. A stack entry id
// (a:<approval id> or p:<card id>, from the waiting indicator in WaitingChips.tsx) selects that entry.
export function entryForTask(entries: StackEntry[], taskId: string): string | null {
  return entries.find(e => e.id === taskId)?.id ?? entries.find(e => e.item?.taskId === taskId)?.id ?? null;
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
// taskId: a task id (the task's oldest question card) or a stack entry id
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

// ---------- Hide, and the cards that arrive while the stack is hidden ----------
// Hide hides the stack until a card arrives. Before, Hide kept the stack hidden for the whole browser session, and a new
// card only raised the number on the pill. A card arrives when:
//   - its id is not in the cards that the page saw before (a new card, or a card that came back, for example a
//     dismissed question that shows again)
//   - the server updated it in place: approvals.request in server/approvals.ts keeps the id of a pending card of the
//     same actor, action and target, and sets `updated` (also when the facts of a merge or push card changed), and
//     `version` changes with the payload
// A screen card (source 'screen') gets a new id when the terminal size changes its rows. It is the same question, so its
// key is the task and the question text, not the id.
// The page keeps the keys of the cards it saw (seenCards). When the events socket connects again, the server sends the
// full lists, and arrivals compares them with the cards from before the reconnect. Hide saves the keys in
// sessionStorage (HIDDEN_KEY), so a reload of the page also finds the cards that arrived while the stack was hidden.
export type Seen = Record<string, string>;
const entryKey = (e: StackEntry) => e.item?.source === 'screen' ? `screen:${e.item.taskId}:${e.item.question}` : e.id;
const entryStamp = (e: StackEntry) => e.approval ? `${e.approval.updated || e.approval.created}|${e.approval.version || ''}` : '';
export const seenCards = (entries: StackEntry[]): Seen => Object.fromEntries(entries.map(e => [entryKey(e), entryStamp(e)]));
// the cards that are new or updated since `seen`, oldest first; none when the page has not seen a list yet
export function arrivals(seen: Seen | null, entries: StackEntry[]): StackEntry[] {
  if (!seen) return [];
  return entries.filter(e => seen[entryKey(e)] !== entryStamp(e));
}

// The front card when the stack shows again for arrived cards: the card that was in front before Hide, while it still
// waits, so the front card does not change by itself. With no such card, the oldest arrived card.
export function frontAfterArrival(entries: StackEntry[], frontId: string | null, arrived: StackEntry[]): string | null {
  if (frontId && entries.some(e => e.id === frontId)) return frontId;
  return arrived[0]?.id ?? entries[0]?.id ?? null;
}

// sessionStorage: the keys of the cards that the stack showed when the user clicked Hide (JSON), or nothing when the
// stack shows. Taskboard before this change saved "1" here. readHidden treats that value as "show the stack".
export const HIDDEN_KEY = 'tb-stack-hidden';
export function readHidden(raw: string | null): Seen | null {
  if (!raw || raw === '0' || raw === '1') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v as Seen : null; } catch { return null; }
}
