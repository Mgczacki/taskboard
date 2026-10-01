// The one hold in progress, for the card at the bottom right (HoldCard in App.tsx). Terminal.tsx and documentContent.ts
// call beginHold() from a mousedown on a "! <command>" (bangCommand.ts). Only a hold that the browser reports as a
// real user action (isTrusted) starts, and only the end of that whole hold sends the command.
import { holdTimer } from './bangCommand';
import { api } from './api';

export type HoldPhase = 'holding' | 'typing' | 'ran' | 'failed';
export interface HoldView { taskId: string; command: string; phase: HoldPhase; elapsed: number; message?: string }

let view: HoldView | null = null;
const listeners = new Set<() => void>();
const set = (next: HoldView | null) => { view = next; for (const fn of listeners) fn(); };
export const holdView = () => view;
export const subscribeHold = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

let stopCurrent: ((why: string) => void) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
export const cancelHold = (why = 'button') => { if (stopCurrent) stopCurrent(why); else { clearTimeout(hideTimer); set(null); } };

export function beginHold(event: MouseEvent, taskId: string, command: string) {
  if (!event.isTrusted || event.button !== 0 || view?.phase === 'typing') return;
  stopCurrent?.('replaced');
  clearTimeout(hideTimer);
  const remove = () => {
    removeEventListener('mousemove', move, true);
    removeEventListener('mouseup', release, true);
    removeEventListener('keydown', key, true);
    removeEventListener('blur', blur);
    stopCurrent = null;
  };
  const timer = holdTimer(event.clientX, event.clientY, {
    tick: elapsed => set({ taskId, command, phase: 'holding', elapsed }),
    cancel: () => { remove(); set(null); },
    done: () => {
      remove();
      set({ taskId, command, phase: 'typing', elapsed: 0 });
      const finish = (phase: HoldPhase, message: string) => { set({ taskId, command, phase, elapsed: 0, message }); hideTimer = setTimeout(() => set(null), 8000); };
      api.typeCommand(taskId, command).then(r => finish(r.ran ? 'ran' : 'failed', r.message)).catch(e => finish('failed', (e as Error).message));
    },
  });
  const move = (e: MouseEvent) => timer.move(e.clientX, e.clientY);
  const release = () => timer.cancel('released');
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') timer.cancel('escape'); };
  const blur = () => timer.cancel('blur');
  addEventListener('mousemove', move, true);
  addEventListener('mouseup', release, true);
  addEventListener('keydown', key, true);
  addEventListener('blur', blur);
  stopCurrent = why => timer.cancel(why);
  set({ taskId, command, phase: 'holding', elapsed: 0 });
}
