// One message that waits in a task's message queue (server/message-queue.ts): who sent it, its age, what the last screen
// check saw, and the actions. Used in the task panel and on the Waiting page.
// - Deliver by hook: the agent gets the message at its next hook event (Claude Code: a tool call, a prompt or the end of
//   a turn). Taskboard stops typing it. Only for agents with such a hook.
// - Type now: one typing try at once. Taskboard still does not type into text in the box or into a question.
// - Remove: the message is not delivered. The sender task is told that the receiver did not read it.
import type { QueuedMessage, Task } from '../api';
import { api, fmtWait } from '../api';

export const LATE_KIND = 'Undelivered message';
const WHAT = { message: 'Message', review: 'Review feedback', permit: 'Permit result', inbox: 'Inbox notice' };
const age = (q: QueuedMessage) => fmtWait(Math.max(0, Math.round((Date.now() - Date.parse(q.queued)) / 60000)));

export function queueLabel(q: QueuedMessage) {
  return `${q.state === 'failed' ? 'Not delivered' : q.late ? `Not delivered after ${age(q)}` : 'Queued'} · ${WHAT[q.kind]} from ${q.from}`;
}
// The reason in plain words: the last screen check, the number of checks, and the last typing error.
export function queueReason(q: QueuedMessage) {
  if (q.kind === 'inbox') return q.reason;
  const parts = [q.state === 'failed' ? `Failed: ${q.reason} The agent did not read it.` : q.via === 'hook' ? q.reason : ''];
  if (q.checks) parts.push(`Checked the screen ${q.checks} time${q.checks > 1 ? 's' : ''}${q.checkedAt ? `, last at ${new Date(q.checkedAt).toLocaleTimeString()}` : ''}: ${q.seen}`);
  if (q.state !== 'failed' && q.via !== 'hook') parts.push(q.checks ? `Last typing try: ${q.reason}` : q.reason);
  if (q.state !== 'failed' && q.via !== 'hook' && q.hook) parts.push(`A hook also delivers it when ${q.hook}.`);
  return parts.filter(Boolean).join(' ');
}

export function QueueActions({ t, q, act, toast }: { t: Task; q: QueuedMessage; act: (p: Promise<unknown>) => Promise<unknown>; toast?: (s: string) => void }) {
  if (q.kind === 'inbox') return null;
  const typeNow = async () => {
    const r = await act(api.queueAction(t.id, q.id, 'type')) as { state?: string; reason?: string } | undefined;
    if (r?.state && toast) toast(r.state === 'delivered' ? `Typed into #${t.num}.` : `Not typed: ${r.reason}`);
  };
  return <>
    {q.hook && q.via !== 'hook' && <button className="btn ghost" title={`Give the message to the agent when ${q.hook}. Taskboard stops typing it.`} onClick={() => void act(api.queueAction(t.id, q.id, 'hook'))}>Deliver by hook</button>}
    {q.state !== 'failed' && <button className="btn ghost" title="Try to type the message now. Nothing is typed when the box holds text or a question shows." onClick={() => void typeNow()}>Type now</button>}
    {q.state === 'failed' && <button className="btn ghost" title="Wait for an empty input box again, then type the message" onClick={() => void act(api.queueAction(t.id, q.id, 'retry'))}>Type again</button>}
    <button className="btn ghost" title="Remove the message. It is not delivered, and the sender task is told." onClick={() => void act(api.queueAction(t.id, q.id, 'remove'))}>Remove</button>
  </>;
}

// Messages for the Waiting page: each one that failed or waits longer than 5 minutes, on any task or the controller.
export function lateMessages(tasks: Task[]) {
  return tasks.flatMap(t => (t.queue || []).filter(q => q.kind !== 'inbox' && (q.late || q.state === 'failed')).map(q => ({ t, q })));
}
