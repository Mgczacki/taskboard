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
