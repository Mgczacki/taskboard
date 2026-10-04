// The order of the notification stack and the card that a marker button brings to its front (web/src/stack.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, PendingItem } from '../web/src/api.ts';
import { entryForTask, frontIndex, stackEntries } from '../web/src/stack.ts';

const item = (id: string, taskId: string, createdAt: string) => ({ id, taskId, taskNum: 1, taskTitle: 'T', question: 'Q?', createdAt, options: [], state: 'pending' }) as unknown as PendingItem;
const approval = (id: string, created: string) => ({ id, created, actor: 't9', action: 'scope', state: 'pending' }) as unknown as Approval;

test('the stack lists approvals and question cards oldest first', () => {
  const e = stackEntries([approval('a1', '2026-10-02T10:02:00Z')], [item('p1', 't1', '2026-10-02T10:03:00Z'), item('p2', 't2', '2026-10-02T10:01:00Z')]);
  assert.deepEqual(e.map(x => x.id), ['p:p2', 'a:a1', 'p:p1']);
});

test('a marker button picks the oldest card of its task, and nothing for a task with no card', () => {
  const e = stackEntries([approval('a1', '2026-10-02T10:00:00Z')], [item('p3', 't1', '2026-10-02T10:05:00Z'), item('p1', 't1', '2026-10-02T10:03:00Z'), item('p2', 't2', '2026-10-02T10:04:00Z')]);
  assert.equal(entryForTask(e, 't1'), 'p:p1');
  assert.equal(entryForTask(e, 't2'), 'p:p2');
  assert.equal(entryForTask(e, 't9'), null);
});

test('when the front card is replaced, the new card of the same task stays in front', () => {
  // a screen card gets a new id after a resize of the terminal; the stack keeps showing that task
  const e = stackEntries([], [item('old3', 't3', '2026-10-02T10:00:00Z'), item('new1', 't1', '2026-10-02T10:09:00Z'), item('p2', 't2', '2026-10-02T10:05:00Z')]);
  assert.equal(e[frontIndex(e, 'p:gone1', 't1')].id, 'p:new1');
  assert.equal(e[frontIndex(e, 'p:p2', 't1')].id, 'p:p2');
  assert.equal(e[frontIndex(e, 'p:gone9', 't9')].id, 'p:old3');
  assert.equal(frontIndex([], null), 0);
});

// An expired, denied or finished card leaves the stack, the Waiting list and the counts (liveApprovals). A front card
// that closed without a decision shows greyed for a few seconds, with the words of closedNotice.
import { closedNotice, liveApprovals } from '../web/src/stack.ts';
import { permitHeadline, stepWord } from '../web/src/permitText.ts';
const withState = (id: string, state: string, action = 'permit', result?: string) => ({ id, created: '2026-10-02T10:00:00Z', actor: 't9', action, summary: 'run 1 approved step', state, result }) as unknown as Approval;

test('only pending cards and running permits wait on the user', () => {
  const all = ['pending', 'running', 'expired', 'denied', 'approved', 'failed', 'unknown', 'returned'].map(s => withState(s, s));
  assert.deepEqual(liveApprovals(all).map(a => a.id), ['pending', 'running']);
  assert.deepEqual(liveApprovals([withState('r', 'running', 'scope')]), []);
});

test('a front card that expired shows "Expired at" and the result, a decided card shows nothing', () => {
  const entry = stackEntries([withState('a1', 'pending')], [])[0];
  const at = new Date('2026-10-04T03:23:00Z');
  const n = closedNotice(entry, [withState('a1', 'expired', 'permit', 'The permit expired at 11:23 PM. Nothing ran.')], [], at);
  assert.equal(n?.state, `Expired at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  assert.equal(n?.text, 'The permit expired at 11:23 PM. Nothing ran. No action is possible on this card.');
  assert.equal(closedNotice(entry, [withState('a1', 'approved')], []), null);
  assert.equal(closedNotice(entry, [withState('a1', 'denied')], []), null);
  assert.equal(closedNotice(entry, [withState('a1', 'pending')], []), null);
  const q = stackEntries([], [item('p1', 't1', '2026-10-02T10:00:00Z')])[0];
  assert.match(closedNotice(q, [], [{ ...q.item!, state: 'gone', result: 'The task was closed.' }])!.text, /^The task was closed\. No action/);
  assert.equal(closedNotice(q, [], [{ ...q.item!, state: 'answered' }]), null);
});

test('a permit card says when it ended and never that it waits', () => {
  const p = { expiresAt: '2026-10-04T03:23:46Z', finishedAt: '2026-10-04T03:23:46Z' };
  const t = new Date(p.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const expired = permitHeadline({ ...p, state: 'expired' });
  assert.equal(expired.state, `Expired at ${t}`);
  assert.equal(expired.open, false);
  assert.doesNotMatch(`${expired.state} ${expired.when} ${expired.note}`, /wait/i);
  assert.equal(permitHeadline({ ...p, state: 'pending' }).open, true);
  assert.equal(permitHeadline({ ...p, state: 'pending' }).when, `Expires at ${t}`);
  assert.equal(permitHeadline({ ...p, state: 'denied', decidedAt: p.expiresAt }).state, `Denied at ${t}`);
  assert.match(permitHeadline({ ...p, state: 'expired', error: 'Task #7 was archived before a decision.' }).note!, /^Task #7 was archived/);
  assert.equal(stepWord('cancelled'), 'not run');
});
