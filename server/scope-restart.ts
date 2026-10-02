// When Taskboard may restart an agent session that waits for a restart (Task.restartWhenDone): after an approved scope
// (index.ts applyScope), or after "Restart when this turn ends" on the task page. The restart resumes the same
// conversation, so it must not cut off a turn, a question or a dialog. index.ts reconcile() calls restartWaitReason()
// every 2 s with what it read from the task, its transcript and its screen, and restarts the session when the reason is ''.
import type { Status } from './store.ts';

// Claude Code permission dialogs ("Do you want to proceed?", "Do you want to make this edit to x?") and the Codex
// questions that wait above its input box ("? 2 questions" / "shift+← to answer"), in the bottom lines of the screen
const DIALOG = /Do you want to (proceed|make this edit|create|allow|run|overwrite)|Esc to cancel|\?\s+\d+\s+questions?\b[^\n]*\n[^\n]*to answer|Allow command\?/i;

export interface RestartCheck {
  status: Status;
  ended: boolean;        // the transcript shows that the last turn ended (finished or interrupted)
  lastText?: string;     // the last reply in the transcript, when it ended
  quiet: boolean;        // neither the status nor the transcript changed for 15 s (index.ts QUIET_MS)
  quietLong: boolean;    // the same for 60 s: a model can think longer than 15 s after a text block
  screen: string;        // the bottom lines of the agent's screen
  blocking?: RegExp;     // more questions that keys must not answer (agents.ts blockingQuestion)
  restartFor?: string;   // "to give access to the new worktree app"
  waitedMs: number;      // time since restartWhenDone was set
  limitMs: number;       // after this time the task offers "Restart now" (index.ts RESTART_WAIT_MS)
}

const minutes = (ms: number) => ms >= 60000 ? `${Math.round(ms / 60000)} minute${Math.round(ms / 60000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`;

// '' when the agent waits for the user and the restart cuts nothing off. Otherwise the reason why the restart waits,
// and whether it waited longer than limitMs. The statuses that mean "the agent waits":
// - idle, unread and review: the turn ended.
// - needs-you: only when the transcript shows that the turn ended and the last reply is not a question. A permission
//   prompt or a Codex approval leaves a tool call without a result in the transcript, so the turn has not ended.
// - working: only when the transcript shows that the turn ended (the event for the end of the turn did not arrive),
//   and nothing changed for 60 s.
// In each case the status and the transcript must be quiet, and the screen must show no question or dialog.
export function restartWaitReason(c: RestartCheck): { reason: string; overdue: boolean } {
  const turn = `Waiting for the end of the turn${c.restartFor ? ` ${c.restartFor}` : ' to restart the session'}.`;
  const question = 'Waiting: the agent asks a question or waits for an approval. Answer it in the terminal. The restart runs after the turn ends.';
  let reason = '';
  if (c.status === 'needs-you') reason = !c.ended || /\?\s*$/.test((c.lastText || '').trim()) ? question : '';
  else if (c.status === 'working') reason = c.ended && c.quietLong ? '' : turn;
  else if (!['idle', 'unread', 'review'].includes(c.status)) reason = turn;
  if (!reason && !c.quiet) reason = turn;
  if (!reason && (DIALOG.test(c.screen) || c.blocking?.test(c.screen)))
    reason = 'Waiting: the agent shows a question or a dialog on its screen. Answer it in the terminal. The restart runs after that.';
  const overdue = !!reason && c.waitedMs >= c.limitMs;
  if (overdue) reason += ` The turn did not end in ${minutes(c.limitMs)}. Restart now ends the turn and keeps the conversation.`;
  return { reason, overdue };
}
