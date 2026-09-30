import test from 'node:test';
import assert from 'node:assert/strict';
import { idleSuspendMinutes, maySuspendIdleTask } from '../server/idle-suspend.ts';
import type { Task } from '../server/store.ts';

const now = Date.parse('2026-09-30T12:00:00Z');
const task = { id: 'a', status: 'idle', statusAt: '2026-09-30T11:20:00Z' } as Task;

test('idle suspension is off until a valid timeout is set', () => {
  assert.equal(idleSuspendMinutes(undefined), 0);
  assert.equal(idleSuspendMinutes('30'), 30);
  assert.equal(idleSuspendMinutes('-1'), 0);
  assert.equal(idleSuspendMinutes('9999'), 0);
});

test('idle suspension waits for the last transcript change and keeps open tasks running', () => {
  assert.equal(maySuspendIdleTask(task, now, 30, now - 40 * 60000, 0, false), true);
  assert.equal(maySuspendIdleTask(task, now, 30, now - 5 * 60000, 0, false), false);
  assert.equal(maySuspendIdleTask(task, now, 30, 0, 0, true), false);
  assert.equal(maySuspendIdleTask({ ...task, status: 'unread' }, now, 30, 0, 0, false), false);
  assert.equal(maySuspendIdleTask({ ...task, role: 'controller' }, now, 30, 0, 0, false), false);
});
