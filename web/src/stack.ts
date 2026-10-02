// The order of the notification stack (NoticeStack.tsx), and the request that brings a task's question card to its
// front. Canvas windows and the task panel show only a one-line marker for a question (PendingMarker in
// PendingCard.tsx). Its button calls showInStack, NoticeStack and the Waiting page listen for the event.
import type { Approval, PendingItem } from './api';

export type StackEntry = { id: string; at: string; approval?: Approval; item?: PendingItem };

// approval cards and question cards, oldest first
export function stackEntries(approvals: Approval[], pending: PendingItem[]): StackEntry[] {
  return [
    ...approvals.map(a => ({ id: `a:${a.id}`, at: a.created, approval: a })),
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
