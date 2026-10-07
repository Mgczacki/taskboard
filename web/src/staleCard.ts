// The words of a merge card (action git-merge) whose branch head or master head moved after the card was made
// (server/merge-stale.ts, staleFacts on the card). Approve runs nothing on such a card, and Deny tells the task that
// the user rejects the merge. "Ask task to refresh" (server/approvals.ts refresh) closes the card in state stale: the
// task is told that the merge was not denied and is asked for a new tb git merge-request.
import type { Approval, Task } from './api';

export const isStaleMerge = (a: Pick<Approval, 'action' | 'state' | 'staleFacts'>) => a.action === 'git-merge' && a.state === 'pending' && !!a.staleFacts;
export const REFRESH_LABEL = 'Ask task to refresh';
// What each button does on a stale merge card
export const STALE_HELP = [
  'Approve is not shown. Taskboard does not merge heads that you did not see on the card.',
  `${REFRESH_LABEL} closes this card as stale, not denied. Taskboard tells the task what moved and asks it to rebase or inspect, then to run tb git merge-request. Nothing is merged.`,
  'The new card shows the current branch head and master head. It needs your approval.',
  'Deny tells the task that you reject this merge.',
];
// When the task gets the message of "Ask task to refresh", from the status of the task
export function deliveryText(t: Pick<Task, 'num' | 'status'> | undefined): string {
  if (!t) return 'The task is gone. No message can be sent.';
  const task = `Task #${t.num}`;
  if (t.status === 'archived') return `${task} is archived. No message can be sent.`;
  if (t.status === 'parked') return `${task} is parked. The message waits in its queue. Taskboard types it after you resume the task.`;
  if (t.status === 'suspended') return `${task} is suspended. Taskboard resumes it to type the message.`;
  if (t.status === 'working') return `${task} is working. It gets the message in this turn.`;
  return `${task} is idle. The message starts a new turn.`;
}
// The chip of a decided card in the Answered view of the Waiting page
export const STALE_CHIP = 'stale, refresh asked';
