import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Status, Task } from '../web/src/api.ts';
import { archiveTriageTask, confirmTriageArchive } from '../web/src/triageArchive.ts';

const task = (status: Status) => ({ id: 'task-1', status }) as Task;

test('triage asks before it ends a working task only', () => {
  assert.equal(confirmTriageArchive(task('working')), true);
  for (const status of ['needs-you', 'review', 'stopped'] as Status[]) {
    assert.equal(confirmTriageArchive(task(status)), false);
  }
});

test('triage uses the existing end and archive call for a task with a session', async () => {
  const calls: string[] = [];
  await archiveTriageTask(task('needs-you'), async id => { calls.push(`end and archive ${id}`); }, async () => { calls.push('archive'); });
  assert.deepEqual(calls, ['end and archive task-1']);
});

test('triage only archives a stopped task', async () => {
  const calls: string[] = [];
  await archiveTriageTask(task('stopped'), async () => { calls.push('end'); }, async (id, status) => { calls.push(`${status} ${id}`); });
  assert.deepEqual(calls, ['archived task-1']);
});

test('triage does not send another archive call when ending fails', async () => {
  const calls: string[] = [];
  await assert.rejects(
    archiveTriageTask(task('review'), async () => { calls.push('end'); throw new Error('end failed'); }, async () => { calls.push('archive'); }),
    /end failed/,
  );
  assert.deepEqual(calls, ['end']);
});
