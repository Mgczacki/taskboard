import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { moveBy, moveToSlot } from '../web/src/groupOrder.ts';
import { orderKey, renderOrder, slotNear, tileHint, withSavedOrder } from '../web/src/tileOrder.ts';

// three windows in one row (Columns), 100 px wide with an 8 px gap
const row = [0, 108, 216].map(left => ({ left, top: 0, width: 100, height: 400 }));

test('a pointer over the first half of a window is the slot before it, over the second half the slot after it', () => {
  assert.equal(slotNear(row, 20, 200, false), 0);
  assert.equal(slotNear(row, 80, 200, false), 1);
  assert.equal(slotNear(row, 130, 200, false), 1);
  assert.equal(slotNear(row, 300, 200, false), 3);
  // in the gap or outside the windows, the nearest window decides
  assert.equal(slotNear(row, 104, 200, false), 1);
  assert.equal(slotNear(row, 500, -50, false), 3);
  assert.equal(slotNear([], 10, 10, false), null);
});

test('in a grid the window under the pointer decides, and in Rows the top and bottom halves do', () => {
  const grid = [{ left: 0, top: 0 }, { left: 108, top: 0 }, { left: 0, top: 108 }, { left: 108, top: 108 }].map(p => ({ ...p, width: 100, height: 100 }));
  assert.equal(slotNear(grid, 180, 150, false), 4);
  assert.equal(slotNear(grid, 20, 150, false), 2);
  const rows = [0, 108, 216].map(top => ({ left: 0, top, width: 600, height: 100 }));
  assert.equal(slotNear(rows, 590, 120, true), 1);
  assert.equal(slotNear(rows, 590, 190, true), 2);
});

test('a drop moves the window to the slot, and a drop next to itself changes nothing', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveToSlot(ids, 'a', 3), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveToSlot(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.equal(moveToSlot(ids, 'b', 2), null);
  assert.deepEqual(moveBy(ids, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.equal(tileHint(['b', 'c', 'a', 'd'], 'a', 7), '#7 → position 3 of 4');
  assert.equal(tileHint(null, 'a', 7), '#7: drop between two windows, or on a group tab');
});

test('a saved order puts the moved windows first and a new task after them', () => {
  assert.deepEqual(withSavedOrder(['new', 'c', 'b', 'a'], ['a', 'c', 'b']), ['a', 'c', 'b', 'new']);
  // a saved id that is no longer in the view is left out
  assert.deepEqual(withSavedOrder(['b', 'a'], ['gone', 'a', 'b']), ['a', 'b']);
  // without a saved order the view keeps its own order
  assert.deepEqual(withSavedOrder(['c', 'b', 'a'], undefined), ['c', 'b', 'a']);
});

test('a group view has no key, and a hand-picked view keeps its key when its windows move', () => {
  assert.equal(orderKey('g:auth'), null);
  assert.equal(orderKey('ungrouped'), 'ungrouped');
  assert.equal(orderKey('t:b,a,c'), orderKey('t:c,b,a'));
});

test('a move changes only the CSS order of the windows, not their order in the page, so no terminal is remounted', () => {
  const tiles = ['t3', 't1', 't2', 't4'].map(id => ({ id }));
  const before = renderOrder(tiles);
  const after = renderOrder([tiles[2], tiles[0], tiles[3], tiles[1]]);
  // the same windows in the same sequence: React keeps every terminal element where it is
  assert.deepEqual(after.map(x => x.item), before.map(x => x.item));
  // CSS order is the position on screen
  assert.deepEqual(after.map(x => [x.item.id, x.at]), [['t1', 3], ['t2', 0], ['t3', 1], ['t4', 2]]);
});

test('the window order is saved on the server, keeps the groups as they are, and stays after a reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskboard-tile-order-'));
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  process.env.TASKBOARD_DIR = join(root, 'private');
  try {
    const groups = await import('../server/groups.ts');
    const canvasOrder = await import('../server/canvasOrder.ts');
    const dir = join(root, 'vault', 'groups');

    // a group view: the order of the tasks list. t2 is archived, so the page does not send it, and it keeps its place
    const g = groups.create('Auth', ['t1', 't2', 't3', 't4']);
    const other = groups.create('Beta', ['t9']);
    let events = 0;
    groups.onGroupsChange(() => events++);
    assert.deepEqual(groups.reorderTasks(g.id, ['t4', 't1', 't3']).tasks, ['t4', 't2', 't1', 't3']);
    assert.equal(events, 1);
    // a task of another group in the list is ignored: a move never adds a task to the group
    assert.deepEqual(groups.reorderTasks(g.id, ['t9', 't3', 't4', 't1']).tasks, ['t3', 't2', 't4', 't1']);
    assert.deepEqual(groups.get(other.id)?.tasks, ['t9']);
    // the same order again writes nothing and sends no update
    groups.reorderTasks(g.id, ['t3', 't4', 't1']);
    assert.equal(events, 2);
    assert.deepEqual(matter(readFileSync(join(dir, g.id + '.md'), 'utf8')).data.tasks, ['t3', 't2', 't4', 't1']);
    assert.throws(() => groups.reorderTasks('gone', ['t1']), /no longer exists/);
    groups.load();
    assert.deepEqual(groups.get(g.id)?.tasks, ['t3', 't2', 't4', 't1']);

    // the other views: canvas-order.json in TASKBOARD_DIR
    let saved = 0;
    canvasOrder.onCanvasOrderChange(() => saved++);
    assert.equal(canvasOrder.set('ungrouped', ['u2', 'u1', 'u2']), true);
    assert.equal(canvasOrder.set('ungrouped', ['u2', 'u1']), false);
    canvasOrder.set(orderKey('t:a,b')!, ['b', 'a']);
    assert.equal(saved, 2);
    assert.throws(() => canvasOrder.set('g:auth', ['t1']), /keeps its own order/);
    assert.ok(existsSync(join(root, 'private', 'canvas-order.json')));
    canvasOrder.load();
    assert.deepEqual(canvasOrder.all(), { ungrouped: ['u2', 'u1'], 't:a,b': ['b', 'a'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
