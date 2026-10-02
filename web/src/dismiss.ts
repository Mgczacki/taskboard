// Dismiss on the Waiting page, the notification stack and the task panel marker (server/dismiss.ts keeps the entries).
// A dismiss hides one waiting item until its signature changes. It does not change the task status. Set aside does:
// it sets the status parked, and the task comes back when its agent works again.
import type { Dismissal, PendingItem, Task } from './api';
import { api } from './api';
export { quietTaskIds } from './dismissRules';

export const DISMISS_TITLE = 'Dismiss: hide this item until something new happens for it. The task is not changed.';
export const SET_ASIDE_TITLE = 'Set aside: take the task off the lists until its agent works again.';
// a held Claude hook card blocks the agent until an answer: its dismiss lasts 10 minutes (server/dismiss.ts HOOK_MS)
export const HOOK_TITLE = 'Dismiss for 10 minutes. The agent still waits on this answer. The card is not answered, and it comes back after 10 minutes.';
export const holdsHook = (i: Pick<PendingItem, 'source'>) => i.source === 'claude-hook';

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const backAt = (d: { until?: string }) => d.until ? `Comes back at ${clock(d.until)}.` : '';

type ToastFn = (text: string, action?: { label: string; fn: () => void }) => void;
const failed = (toast: ToastFn) => (e: unknown) => toast(`Not dismissed: ${e instanceof Error ? e.message : String(e)}`);
export const bringBack = (sig: string, toast: ToastFn) => api.bringBack(sig).then(() => toast('Brought back.')).catch(e => toast(`Not brought back: ${e instanceof Error ? e.message : String(e)}`));
const undo = (d: Dismissal, toast: ToastFn) => ({ label: 'Undo', fn: () => void bringBack(d.sig, toast) });

export function dismissItem(item: PendingItem, label: string, toast: ToastFn) {
  return api.dismissItem(item.id, label).then(d => toast(`#${item.taskNum}: dismissed. ${d.until ? `The agent still waits. ${backAt(d)}` : 'It shows again when something new happens.'}`, undo(d, toast))).catch(failed(toast));
}
export function dismissTask(t: Pick<Task, 'id' | 'num'>, label: string, toast: ToastFn) {
  return api.dismissTask(t.id, label).then(d => toast(`#${t.num}: dismissed. The status is not changed. It shows again when something new happens.`, undo(d, toast))).catch(failed(toast));
}
