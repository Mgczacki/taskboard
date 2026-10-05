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

// Hide hides the stack until a card arrives (arrivals in stack.ts), not for the whole browser session.
import { alertText } from '../web/src/cardAlert.ts';
import { arrivals, frontAfterArrival, readHidden, seenCards } from '../web/src/stack.ts';

test('a new card arrives while the stack is hidden; the same list does not', () => {
  const before = stackEntries([approval('a1', '2026-10-02T10:00:00Z')], [item('p1', 't1', '2026-10-02T10:01:00Z')]);
  const hidden = seenCards(before);
  assert.deepEqual(arrivals(hidden, before), []);
  const after = stackEntries([approval('a1', '2026-10-02T10:00:00Z'), approval('a2', '2026-10-02T10:05:00Z')], [item('p1', 't1', '2026-10-02T10:01:00Z')]);
  assert.deepEqual(arrivals(hidden, after).map(e => e.id), ['a:a2']);
  // a card that left does not count, and a card that came back (for example a dismissed question) counts again
  assert.deepEqual(arrivals(hidden, before.slice(0, 1)), []);
  assert.deepEqual(arrivals(seenCards(before.slice(0, 1)), before).map(e => e.id), ['p:p1']);
  // before the page has a list, nothing arrives
  assert.deepEqual(arrivals(null, after), []);
});

test('a card that the server updated in place keeps its id and arrives again', () => {
  // approvals.request (task 242) keeps the id of a pending card of the same actor, action and target and sets updated
  const first = { ...approval('s1', '2026-10-02T10:00:00Z'), summary: 'read /p', version: 'v1' } as Approval;
  const hidden = seenCards(stackEntries([first], []));
  assert.deepEqual(arrivals(hidden, stackEntries([{ ...first }], [])), []);
  assert.deepEqual(arrivals(hidden, stackEntries([{ ...first, updated: '2026-10-02T10:03:00Z' }], [])).map(e => e.id), ['a:s1']);
  // a merge or push card whose head changed gets a new version
  assert.deepEqual(arrivals(hidden, stackEntries([{ ...first, version: 'v2' }], [])).map(e => e.id), ['a:s1']);
});

test('a screen card with a new id after a terminal resize is the same question', () => {
  const screen = (id: string) => ({ ...item(id, 't1', '2026-10-02T10:00:00Z'), source: 'screen' }) as PendingItem;
  const hidden = seenCards(stackEntries([], [screen('old')]));
  assert.deepEqual(arrivals(hidden, stackEntries([], [screen('new')])), []);
  assert.deepEqual(arrivals(hidden, stackEntries([], [{ ...screen('new'), question: 'Other?' }])).length, 1);
});

test('after a reconnect of the events socket, the full lists show what arrived during the outage', () => {
  // api.ts keeps the lists while the socket is closed; the server sends approvals and pending again on connect
  const beforeOutage = stackEntries([approval('a1', '2026-10-02T10:00:00Z')], []);
  const seen = seenCards(beforeOutage);
  const resent = stackEntries([approval('a1', '2026-10-02T10:00:00Z'), approval('a3', '2026-10-02T10:09:00Z')], [item('p9', 't9', '2026-10-02T10:08:00Z')]);
  assert.deepEqual(arrivals(seen, resent).map(e => e.id), ['p:p9', 'a:a3']);
  // a reconnect with no change shows nothing new
  assert.deepEqual(arrivals(seen, stackEntries([approval('a1', '2026-10-02T10:00:00Z')], [])), []);
});

test('the stack shows again with the old front card when it still waits, else with the oldest arrived card', () => {
  const e = stackEntries([approval('a1', '2026-10-02T10:00:00Z'), approval('a2', '2026-10-02T10:05:00Z'), approval('a3', '2026-10-02T10:06:00Z')], []);
  const arrived = [e[2], e[1]].sort((x, y) => x.at.localeCompare(y.at));
  assert.equal(frontAfterArrival(e, 'a:a1', arrived), 'a:a1');
  assert.equal(frontAfterArrival(e, 'a:gone', arrived), 'a:a2');
  assert.equal(frontAfterArrival(e, null, arrived), 'a:a2');
  assert.equal(frontAfterArrival([], null, []), null);
});

test('the hidden flag of older pages ("1") shows the stack; a saved list keeps it hidden', () => {
  assert.equal(readHidden('1'), null);
  assert.equal(readHidden('0'), null);
  assert.equal(readHidden(null), null);
  assert.equal(readHidden('not json'), null);
  assert.equal(readHidden('[1]'), null);
  assert.deepEqual(readHidden('{"a:a1":"x"}'), { 'a:a1': 'x' });
  assert.deepEqual(readHidden('{}'), {});
});

test('the notification names the card, or the number of cards', () => {
  const [a] = stackEntries([{ ...approval('a1', '2026-10-02T10:00:00Z'), summary: 'attach a worktree' } as Approval], []);
  assert.deepEqual(alertText([a]), { title: 'A card waits on you', body: 'attach a worktree' });
  const [q] = stackEntries([], [item('p1', 't1', '2026-10-02T10:00:00Z')]);
  assert.equal(alertText([q]).body, '#1 T: Q?');
  assert.equal(alertText([a, q]).title, '2 cards wait on you');
});

// An approved permit card leaves the stack APPROVED_CARD_MS after this page first saw it running (task 300). Before,
// the card of permit 3fb83041 (task 281) stayed in the stack as "Running" after the user approved it.
import { APPROVED_CARD_MS, leavesStackAt, stackApprovals, trackRunning, type RunningSeen } from '../web/src/stack.ts';

test('a running permit card shows for APPROVED_CARD_MS, a pending card stays', () => {
  const seen: RunningSeen = new Map();
  const live = [withState('p', 'pending'), withState('r', 'running')];
  const t0 = 1_000_000;
  assert.deepEqual(trackRunning(live, live, seen, t0), { failed: [], nextAt: t0 + APPROVED_CARD_MS });
  assert.equal(leavesStackAt(live[1], seen, t0), t0 + APPROVED_CARD_MS);
  assert.equal(leavesStackAt(live[0], seen, t0), undefined);
  assert.deepEqual(stackApprovals(live, seen, t0 + APPROVED_CARD_MS - 1).map(a => a.id), ['p', 'r']);
  // a later update of the list does not start the time again
  assert.deepEqual(trackRunning(live, live, seen, t0 + 3000), { failed: [], nextAt: t0 + APPROVED_CARD_MS });
  assert.deepEqual(stackApprovals(live, seen, t0 + APPROVED_CARD_MS).map(a => a.id), ['p']);
  assert.equal(trackRunning(live, live, seen, t0 + APPROVED_CARD_MS).nextAt, null);
  // a pending card stays however long it waits
  assert.deepEqual(stackApprovals(live, seen, t0 + 3_600_000).map(a => a.id), ['p']);
});

test('a running permit card that this page has not recorded yet shows', () => {
  // the first render comes before the effect that records the time
  assert.deepEqual(stackApprovals([withState('r', 'running')], new Map(), 5).map(a => a.id), ['r']);
});

test('a permit that this page saw running and that failed is reported once; an approved one is not', () => {
  const seen: RunningSeen = new Map();
  const live = [withState('ok', 'running'), withState('bad', 'running'), withState('lost', 'running')];
  trackRunning(live, live, seen, 0);
  const all = [withState('ok', 'approved'), withState('bad', 'failed', 'permit', 'Step 1 exited with 2.'), withState('lost', 'unknown')];
  assert.deepEqual(trackRunning([], all, seen, 9000).failed.map(a => a.id), ['bad', 'lost']);
  assert.equal(seen.size, 0);
  assert.deepEqual(trackRunning([], all, seen, 9500).failed, []);
  // a failed permit that this page never saw running gives no toast: the task panel notice shows it
  assert.deepEqual(trackRunning([], [withState('old', 'failed')], new Map(), 0).failed, []);
});

test('a running permit that the Permits page leaves out of the stack keeps its time', () => {
  const seen: RunningSeen = new Map();
  const card = withState('r', 'running');
  trackRunning([card], [card], seen, 100);
  assert.deepEqual(trackRunning([], [card], seen, 200), { failed: [], nextAt: null });
  assert.equal(seen.get('r'), 100);
});
