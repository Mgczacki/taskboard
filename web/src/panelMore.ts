// The items of the ⋯ More menu in the task panel (TaskPanel.tsx). The actions row keeps only the buttons for the state
// of the task (Resume, Bring back, Restore), the controller's New session and the manager role. The rest is here.
import type { Task } from './api';

export interface MoreItem { label: string; title: string; run: () => unknown; danger?: boolean }
export interface MoreHandlers {
  moveAccount: () => void; moveMachine: () => void; copyAttach: () => unknown; canvas: () => void;
  setAside: () => unknown; archive: () => unknown; remove: () => void;
}

export function moreItems(t: Pick<Task, 'role' | 'status' | 'transfer' | 'attach' | 'openElsewhere'>, h: MoreHandlers): MoreItem[] {
  const ctl = t.role === 'controller';
  return [
    ...(ctl ? [] : [{ label: 'Move account…', title: 'Continue the task with another account', run: h.moveAccount }]),
    ...(ctl || t.transfer ? [] : [{ label: 'Move to machine…', title: 'Move the task to another paired machine', run: h.moveMachine }]),
    { label: 'Copy tmux command', title: `Copy "${t.attach}" to open this agent in iTerm or Terminal`, run: h.copyAttach },
    { label: 'Show on canvas', title: "Open this agent's live terminal as a window on the canvas", run: h.canvas },
    ...(t.status === 'parked' ? [] : [{ label: 'Set aside', title: 'Take it off Needs you, Unread and triage. The agent is not stopped; the task comes back by itself the next time the agent works or finishes a turn.', run: h.setAside }]),
    ...(t.status === 'archived' ? [] : [{ label: 'End and archive', title: t.openElsewhere ? 'Archives the task; the session in the other terminal keeps running' : 'Ends the tmux session and archives the task', run: h.archive }]),
    ...(ctl ? [] : [{ label: 'Remove…', title: "Delete the task from Taskboard (asks first). Its note goes to ~/.taskboard/trash; the conversation stays in the agent's own history", run: h.remove, danger: true }]),
  ];
}
