// The waiting indicator at the top of the dashboard (WaitingChips.tsx) and the filters of the Waiting page that its
// chips open. The counts are the counts that the top bar showed before (task 270):
//   - "N to approve": the approval cards in state pending
//   - "N waiting on you": the tasks in `queue` of App.tsx (status needs-you, stopped or review, not dismissed)
// The chips split the second count by the kind of wait, so the chips of the tasks add up to N:
//   - question: a task with status needs-you that has a question card (server/pending.ts)
//   - input: a task with status needs-you and no question card
//   - review: a task with status review
//   - stopped: a task with status stopped
// A click goes to the place where the user acts. One item: its card in front of the notice stack (showInStack in
// stack.ts), or the task panel for a task that waits with no card. More items: the Waiting page with the filter of the
// chip (#waiting:<kind>).
import type { Approval, PendingItem, Task } from './api';

export type WaitKind = 'decide' | 'question' | 'input' | 'review' | 'stopped';
export const WAIT_KINDS: WaitKind[] = ['decide', 'question', 'input', 'review', 'stopped'];
// The filters of the Waiting page: one for each chip, and 'needs' for the "Needs you" count of the sidebar (the tasks
// with status needs-you: question and input together).
export type WaitFilter = WaitKind | 'needs';
const FILTERS: WaitFilter[] = [...WAIT_KINDS, 'needs'];

// the words of a chip, for 1 and for more items
const WORDS: Record<WaitKind, [string, string]> = {
  decide: ['to approve', 'to approve'],
  question: ['question', 'questions'],
  input: ['needs input', 'need input'],
  review: ['to review', 'to review'],
  stopped: ['stopped', 'stopped'],
};
// the name of the filter on the Waiting page
export const KIND_NAME: Record<WaitFilter, string> = {
  decide: 'Approval cards to decide', question: 'Tasks with a question card', input: 'Tasks that need input',
  review: 'Tasks to review', stopped: 'Stopped tasks', needs: 'Tasks that need you',
};
export const chipText = (kind: WaitKind, n: number) => `${n} ${WORDS[kind][n === 1 ? 0 : 1]}`;
export const itemsText = (n: number) => `${n} ${n === 1 ? 'item waits' : 'items wait'} on you`;

// the kind of a waiting task, or null for a task that does not wait
export function taskKind(t: Task | undefined, pending: PendingItem[]): WaitKind | null {
  if (!t) return null;
  if (t.status === 'review') return 'review';
  if (t.status === 'stopped') return 'stopped';
  if (t.status === 'needs-you') return pending.some(p => p.taskId === t.id) ? 'question' : 'input';
  return null;
}

export const pendingApprovals = (approvals: Approval[]) => approvals.filter(a => a.state === 'pending');

// the chips with a count above 0, in the order of WAIT_KINDS
export function waitingChips(queue: Task[], approvals: Approval[], pending: PendingItem[]): { kind: WaitKind; n: number }[] {
  const n: Record<WaitKind, number> = { decide: pendingApprovals(approvals).length, question: 0, input: 0, review: 0, stopped: 0 };
  for (const t of queue) { const k = taskKind(t, pending); if (k) n[k]++; }
  return WAIT_KINDS.filter(k => n[k] > 0).map(kind => ({ kind, n: n[kind] }));
}

// A row of the Waiting page (waitingRows in Waiting.tsx), with the fields that the filter and the click target read.
export type WaitRow = { id: string; taskId?: string; item?: PendingItem; approval?: Approval; task?: Task; queued?: unknown };

// Does a row of the Waiting page belong to the filter of a chip? Rows of undelivered messages (queued) wait on
// others, not on the user: no chip shows them.
export function rowMatches(kind: WaitFilter, r: WaitRow, tasks: Task[], pending: PendingItem[]): boolean {
  if (r.queued) return false;
  if (kind === 'decide') return r.approval?.state === 'pending';
  const k = taskKind(tasks.find(t => t.id === r.taskId), pending);
  return kind === 'needs' ? k === 'question' || k === 'input' : k === kind;
}

export type WaitTarget = { stack: string } | { task: string } | { waiting: WaitFilter | 'all' };

// Where a click goes for these rows: one card goes to the notice stack with that card in front (the stack entry id is
// the row id), one task without a card opens its task panel, and anything else opens the Waiting page.
export function waitTarget(rows: WaitRow[], kind: WaitFilter | 'all'): WaitTarget {
  const mine = rows.filter(r => !r.queued);
  if (mine.length === 1) {
    const r = mine[0];
    if (r.item || r.approval) return { stack: r.id };
    if (r.task) return { task: r.task.id };
  }
  return { waiting: kind };
}

// #waiting:<kind> opens the Waiting page with that filter; #waiting has no filter
export const waitingHash = (kind: WaitFilter | 'all') => kind === 'all' ? 'waiting' : `waiting:${kind}`;
export function hashKind(hash: string): WaitFilter | null {
  const k = decodeURIComponent(hash.replace(/^#/, '')).split(':');
  return k[0] === 'waiting' && FILTERS.includes(k[1] as WaitFilter) ? k[1] as WaitFilter : null;
}

// the words that say what a click does, for the tooltip and the accessible name
export function targetText(t: WaitTarget): string {
  if ('stack' in t) return 'Click to show its card.';
  if ('task' in t) return 'Click to open the task panel.';
  return t.waiting === 'all' ? 'Click to open the Waiting page.' : `Click to open the Waiting page with the filter "${KIND_NAME[t.waiting]}".`;
}
