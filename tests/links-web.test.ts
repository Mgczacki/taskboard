// The helpers that the views use to show links between tasks (web/src/links.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskLink } from '../web/src/api.ts';
import { current, linkedSets, linkOrder, linkRows, recentlyReady, setLead, treeDepth, waitingCount } from '../web/src/links.ts';

const at = '2026-10-02T06:00:00.000Z';
const link = (kind: TaskLink['kind'], to: string, extra: Partial<TaskLink> = {}): TaskLink => ({ id: kind + to, kind, to, at, by: { actor: 'user' }, ...extra });
const task = (num: number, extra: Partial<Task> = {}) => ({ id: `t${num}`, num, title: `Task ${num}`, status: 'working', statusAt: at, ...extra }) as Task;

test('link order puts a task after the open task that blocks it, and a replaced task after its replacement', () => {
  const t164 = task(164, { links: [link('dependsOn', 't166')] });
  const t166 = task(166, { links: [link('replaces', 't163')] });
  const t163 = task(163, { status: 'parked' });
  const t85 = task(85);
  const all = [t164, t163, t85, t166];
  assert.deepEqual(linkOrder(all, all).map(t => t.num), [166, 164, 163, 85]);
  // the blocker is archived: the link no longer orders the windows
  const done = [t164, task(166, { status: 'archived' })];
  assert.deepEqual(linkOrder(done, done).map(t => t.num), [164, 166]);
});

test('a dependency on a replaced task points to the task that replaced it', () => {
  const waiter = task(1, { links: [link('dependsOn', 't2')] });
  const old = task(2, { status: 'archived' });
  const fresh = task(3, { links: [link('replaces', 't2')] });
  const all = [waiter, old, fresh];
  assert.equal(current('t2', all), 't3');
  const rows = linkRows(waiter, all);
  assert.equal(rows[0].label, 'Blocked by');
  assert.equal(rows[0].other, 't3');
  assert.deepEqual(linkRows(old, all).map(r => r.label), ['Replaced by']);
  assert.deepEqual(linkRows(fresh, all).map(r => [r.label, r.other, r.movedFrom]), [['Replaces', 't2', undefined], ['Waited on by', 't1', 't2']]);
  assert.equal(linkRows(old, [old, task(4, { links: [link('replaces', 't2', { folded: true })] })])[0].label, 'Folded into');
});

test('tree depth puts a task under its first open blocker or under the task that started it', () => {
  const a = task(1), b = task(2, { links: [link('dependsOn', 't1')] }), c = task(3, { links: [link('dependsOn', 't2'), link('dependsOn', 't1')] }), d = task(4, { parent: 't1' });
  const all = [a, b, c, d];
  assert.deepEqual(treeDepth(all, all, 'deps').map(x => [x.t.num, x.depth, x.also.length]), [[1, 0, 0], [2, 1, 0], [3, 2, 1], [4, 0, 0]]);
  assert.deepEqual(treeDepth(all, all, 'parent').map(x => [x.t.num, x.depth]), [[1, 0], [4, 1], [2, 0], [3, 0]]);
});

test('linked sets join links and task parents, leave out lone tasks, and are named after the task with most links', () => {
  const sets = linkedSets([task(1), task(2, { parent: 't1' }), task(3, { links: [link('relatedTo', 't1')] }), task(4, { parent: 'controller' }), task(5, { links: [link('dependsOn', 't6')] }), task(6)]);
  assert.deepEqual(sets.map(s => s.map(t => t.num).sort()), [[1, 2, 3], [5, 6]]);
  assert.equal(setLead(sets[0]).num, 1);
});

test('waiting count follows open dependencies through other tasks, and ready shows for one day', () => {
  const a = task(1, { link: { count: 1, waitedOnBy: ['t2'] } }), b = task(2, { link: { count: 2, waitedOnBy: ['t3'] } }), c = task(3);
  assert.equal(waitingCount(a, [a, b, c]), 2);
  const blocker = task(9, { status: 'archived', statusAt: '2026-10-02T06:00:00.000Z' });
  const ready = task(8, { links: [link('dependsOn', 't9')], link: { count: 1, state: 'ready' } });
  assert.equal(recentlyReady(ready, [ready, blocker], Date.parse('2026-10-02T12:00:00.000Z')), true);
  assert.equal(recentlyReady(ready, [ready, blocker], Date.parse('2026-10-04T12:00:00.000Z')), false);
});
