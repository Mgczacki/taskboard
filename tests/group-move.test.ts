import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Group } from '../web/src/api.ts';
import { applyChange, changeNotice, dropHint, planCanvasTabDrop, planGroupDrop, planUngroup, undoChange, type UpdateGroup } from '../web/src/groupMove.ts';

const group = (id: string, name: string, tasks: string[]): Group => ({ id, name, color: '#fff', tasks, created: '' });

// a copy of the PATCH /api/groups/:id handler in server/index.ts, on an in-memory list of groups
function server(groups: Group[]) {
  const update: UpdateGroup = async (id, patch) => {
    const g = groups.find(x => x.id === id)!;
    let list = patch.tasks ?? g.tasks;
    if (patch.add) list = [...list, patch.add];
    if (patch.remove) list = list.filter(t => t !== patch.remove);
    g.tasks = list;
  };
  return update;
}
const fresh = () => [group('a', 'Auth', ['t1', 't2', 't3']), group('b', 'Beta', ['t2']), group('c', 'Release', [])];

test('Ungrouped from a group tab takes the task out of that group only, and says where it still is', async () => {
  const gs = fresh();
  const p = planUngroup('t2', 2, gs, 'a');
  assert.ok('change' in p);
  assert.equal(changeNotice(p.change), 'Removed #2 from Auth. It is still in Beta.');
  assert.equal(dropHint(p.change), 'Remove from Auth');
  await applyChange(p.change, server(gs));
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't3'], ['t2'], []]);
});

test('Ungrouped from its last group says the task is now in Ungrouped', () => {
  const p = planUngroup('t1', 1, fresh(), 'a');
  assert.ok('change' in p);
  assert.equal(changeNotice(p.change), 'Removed #1 from Auth. It is now in Ungrouped.');
});

test('Ungrouped from a view that is not a group takes the task out of every group', async () => {
  const gs = fresh();
  const p = planUngroup('t2', 2, gs);
  assert.ok('change' in p);
  assert.equal(changeNotice(p.change), 'Removed #2 from Auth and Beta. It is now in Ungrouped.');
  await applyChange(p.change, server(gs));
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't3'], [], []]);
});

test('Ungrouped refuses a task that is in no group, or not in the group it came from', () => {
  assert.deepEqual(planUngroup('t9', 9, fresh()), { refused: '#9 is not in a group' });
  assert.deepEqual(planUngroup('t1', 1, fresh(), 'b'), { refused: '#1 is not in Beta' });
});

test('Undo puts the task back at its old position in each group', async () => {
  const gs = fresh(); const update = server(gs);
  const p = planUngroup('t2', 2, gs);
  assert.ok('change' in p);
  await applyChange(p.change, update);
  gs[0].tasks.push('t4'); // another change after the removal is kept
  assert.deepEqual(await undoChange(p.change, gs, update), []);
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't2', 't3', 't4'], ['t2'], []]);
});

test('Undo reports a group that was deleted in the meantime', async () => {
  const gs = fresh(); const update = server(gs);
  const p = planUngroup('t2', 2, gs, 'b');
  assert.ok('change' in p);
  await applyChange(p.change, update);
  assert.deepEqual(await undoChange(p.change, gs.filter(g => g.id !== 'b'), update), ['Beta']);
});

test('a group tab adds the task, and ⌥ moves it from the group it came from', async () => {
  const add = planGroupDrop('t1', 1, fresh(), 'c', 'a', false);
  assert.ok('change' in add);
  assert.equal(changeNotice(add.change), 'Added #1 to Release. It is also in Auth.');
  const gs = fresh(); const update = server(gs);
  const move = planGroupDrop('t1', 1, gs, 'c', 'a', true);
  assert.ok('change' in move);
  assert.equal(changeNotice(move.change), 'Moved #1 from Auth to Release.');
  assert.equal(dropHint(move.change), 'Move to Release');
  await applyChange(move.change, update);
  assert.deepEqual(gs.map(g => g.tasks), [['t2', 't3'], ['t2'], ['t1']]);
  await undoChange(move.change, gs, update);
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't2', 't3'], ['t2'], []]);
});

test('a group tab refuses its own tab, and a group that already has the task unless ⌥ moves it', () => {
  assert.deepEqual(planGroupDrop('t2', 2, fresh(), 'a', 'a', false), { refused: '#2 is already in Auth' });
  assert.deepEqual(planGroupDrop('t2', 2, fresh(), 'b', 'a', false), { refused: '#2 is already in Beta. Hold ⌥ to move it here' });
  assert.deepEqual(planGroupDrop('t2', 2, fresh(), 'b', undefined, false), { refused: '#2 is already in Beta' });
  const p = planGroupDrop('t2', 2, fresh(), 'b', 'a', true);
  assert.ok('change' in p);
  assert.equal(changeNotice(p.change), 'Removed #2 from Auth. It is still in Beta.');
});

test('a canvas drop moves a tile from its group with one server call', async () => {
  const gs = fresh();
  const p = planCanvasTabDrop('t1', 1, gs, 'g:c', 'a');
  assert.ok(p && 'change' in p);
  const calls: string[] = [];
  await applyChange(p.change, async () => { throw new Error('Separate group updates are not expected'); }, async (taskId, fromId, toId) => {
    calls.push(`${taskId}:${fromId}:${toId}`);
    const from = gs.find(g => g.id === fromId)!;
    const to = gs.find(g => g.id === toId)!;
    from.tasks = from.tasks.filter(id => id !== taskId);
    to.tasks = [...new Set([...to.tasks, taskId])];
  });
  assert.deepEqual(calls, ['t1:a:c']);
  assert.deepEqual(gs.map(g => g.tasks), [['t2', 't3'], ['t2'], ['t1']]);
});

test('a canvas drop on its own tab or outside any tab changes no group', () => {
  assert.deepEqual(planCanvasTabDrop('t1', 1, fresh(), 'g:a', 'a'), { refused: '#1 is already in Auth' });
  assert.equal(planCanvasTabDrop('t1', 1, fresh(), null, 'a'), null);
});

test('a canvas drop removes the source when the target already has the tile', async () => {
  const gs = fresh();
  const p = planCanvasTabDrop('t2', 2, gs, 'g:b', 'a');
  assert.ok(p && 'change' in p);
  assert.deepEqual(p.change.added, []);
  await applyChange(p.change, server(gs));
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't3'], ['t2'], []]);
});

test('a canvas drop from a group keeps membership in other groups', async () => {
  const gs = fresh();
  const p = planCanvasTabDrop('t2', 2, gs, 'g:c', 'a');
  assert.ok(p && 'change' in p);
  await applyChange(p.change, server(gs));
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't3'], ['t2'], ['t2']]);
});

test('a canvas drop from a view without a source group adds the tile', async () => {
  const gs = fresh();
  const p = planCanvasTabDrop('t1', 1, gs, 'g:c');
  assert.ok(p && 'change' in p);
  await applyChange(p.change, server(gs));
  assert.deepEqual(gs.map(g => g.tasks), [['t1', 't2', 't3'], ['t2'], ['t1']]);
});
