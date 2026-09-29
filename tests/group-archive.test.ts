import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Group, Status, Task } from '../web/src/api.ts';
import { archiveAll, archivePlan, restoreAll } from '../web/src/groupArchive.ts';

const task = (id: string, status: Status, extra: Partial<Task> = {}) => ({ id, num: Number(id.slice(1)), title: 'Task ' + id, status, ...extra }) as Task;
const group = (id: string, name: string, tasks: string[]): Group => ({ id, name, color: '#fff', tasks, created: '' });

const tasks = [
  task('t1', 'working'), task('t2', 'idle'), task('t3', 'needs-you'), task('t4', 'review'), task('t5', 'archived'),
  task('t6', 'suspended'), task('t7', 'parked'), task('c', 'idle', { role: 'controller' }), task('t9', 'stopped'),
];
const a = group('a', 'Alpha', ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 'c', 'missing', 't1']);
const b = group('b', 'Beta', ['t2', 't9']);
const c = group('c', 'Gamma', ['t2']);

test('the plan lists every task in the group that is not archived, without the controller', () => {
  const plan = archivePlan(a, [a, b, c], tasks);
  assert.deepEqual(plan.targets.map(x => x.task.id), ['t1', 't2', 't3', 't4', 't6', 't7']);
  assert.equal(plan.working, 1);
  assert.equal(plan.waiting, 2);
  assert.equal(plan.notRunning, 2);
});

test('the plan names the other groups of a task', () => {
  const plan = archivePlan(a, [a, b, c], tasks);
  assert.deepEqual(plan.targets.find(x => x.task.id === 't2')!.alsoIn, ['Beta', 'Gamma']);
  assert.deepEqual(plan.targets.find(x => x.task.id === 't1')!.alsoIn, []);
  const planB = archivePlan(b, [a, b, c], tasks);
  assert.deepEqual(planB.targets.map(x => x.task.id), ['t2', 't9']);
  assert.equal(planB.waiting, 1);
});

test('an empty or fully archived group gives 0 targets', () => {
  assert.equal(archivePlan(group('e', 'Empty', []), [], tasks).targets.length, 0);
  assert.equal(archivePlan(group('z', 'Done', ['t5', 'c']), [], tasks).targets.length, 0);
});

test('archiveAll calls the end call once per task, at most 3 at a time, and goes on after a failure', async () => {
  const list = ['t1', 't2', 't3', 't4', 't6', 't7'].map(id => tasks.find(t => t.id === id)!);
  const calls: string[] = [];
  let open = 0, most = 0;
  const progress: number[] = [];
  const end = async (id: string) => {
    calls.push(id); open++; most = Math.max(most, open);
    await new Promise(r => setTimeout(r, id === 't1' ? 20 : 5));
    open--;
    if (id === 't3') throw new Error('tmux did not answer');
  };
  const r = await archiveAll(list, end, n => progress.push(n));
  assert.deepEqual([...calls].sort(), ['t1', 't2', 't3', 't4', 't6', 't7']);
  assert.equal(most, 3);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.done.map(d => d.id), ['t1', 't2', 't4', 't6', 't7']);
  assert.deepEqual(r.failed, [{ id: 't3', error: 'tmux did not answer' }]);
  assert.equal(r.done.find(d => d.id === 't7')!.before, 'parked');
});

test('restoreAll sets idle, or parked for a task that was set aside, and reports failures', async () => {
  const calls: [string, string][] = [];
  const failed = await restoreAll([{ id: 't1', before: 'working' }, { id: 't7', before: 'parked' }, { id: 'x', before: 'idle' }],
    async (id, s) => { calls.push([id, s]); if (id === 'x') throw new Error('404'); });
  assert.deepEqual(calls, [['t1', 'idle'], ['t7', 'parked'], ['x', 'idle']]);
  assert.deepEqual(failed, ['x']);
});
