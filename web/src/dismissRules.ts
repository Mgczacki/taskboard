// The rules of Dismiss on the dashboard, with no import of the store (tests load this file; dismiss.ts has the calls).
import type { Dismissal, PendingItem, Task } from './api';

const WAITS: Task['status'][] = ['needs-you', 'stopped', 'review']; // the same list as ATTN in api.ts

// The ids of the tasks that wait on the user but show nothing: the task row is dismissed (waitSig), or the task has
// dismissed question cards and no card that shows. Counts and triage leave them out.
export function quietTaskIds(tasks: Pick<Task, 'id' | 'status' | 'waitSig'>[], shown: Pick<PendingItem, 'taskId'>[], hidden: Pick<PendingItem, 'taskId'>[], dismissals: Pick<Dismissal, 'sig'>[]): Set<string> {
  const sigs = new Set(dismissals.map(d => d.sig));
  const out = new Set<string>();
  for (const t of tasks) {
    if (!WAITS.includes(t.status)) continue;
    if ((t.waitSig && sigs.has(t.waitSig)) || (hidden.some(i => i.taskId === t.id) && !shown.some(i => i.taskId === t.id))) out.add(t.id);
  }
  return out;
}

// The Dismissed view of the Waiting page: newest dismiss first, with the card or the task when it still waits.
// A task entry gets its task only while the task row has the same signature.
export function dismissedList<T extends Pick<Task, 'id' | 'waitSig'>>(dismissals: Dismissal[], hidden: PendingItem[], tasks: T[]) {
  return [...dismissals].sort((a, b) => b.at.localeCompare(a.at)).map(d => ({
    dismissal: d,
    item: d.kind === 'item' ? hidden.find(i => i.sig === d.sig) : undefined,
    task: d.kind === 'task' ? tasks.find(t => t.id === d.taskId && t.waitSig === d.sig) : undefined,
    owner: tasks.find(t => t.id === d.taskId),
  }));
}
