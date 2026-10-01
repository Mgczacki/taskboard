import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { inOrder, moveBy, moveToSlot, slotAt, slotHint } from '../web/src/groupOrder.ts';

const ids = ['a', 'b', 'c', 'd'];

test('a pointer over the left half of a tab is the slot before it, over the right half the slot after it', () => {
  const tabs = [{ left: 0, width: 100 }, { left: 102, width: 100 }, { left: 204, width: 100 }];
  assert.equal(slotAt(tabs, -20), 0);
  assert.equal(slotAt(tabs, 40), 0);
  assert.equal(slotAt(tabs, 60), 1);
  assert.equal(slotAt(tabs, 160), 2);
  assert.equal(slotAt(tabs, 400), 3);
});

test('moving a tab to a slot puts it in that gap', () => {
  assert.deepEqual(moveToSlot(ids, 'a', 4), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveToSlot(ids, 'a', 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveToSlot(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveToSlot(ids, 'c', 1), ['a', 'c', 'b', 'd']);
});

test('a slot next to the tab itself, or an unknown tab, changes nothing', () => {
  assert.equal(moveToSlot(ids, 'b', 1), null);
  assert.equal(moveToSlot(ids, 'b', 2), null);
  assert.equal(moveToSlot(ids, 'x', 0), null);
});

test('the keys move the tab one place and stop at either end', () => {
  assert.deepEqual(moveBy(ids, 'b', -1), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveBy(ids, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.equal(moveBy(ids, 'a', -1), null);
  assert.equal(moveBy(ids, 'd', 1), null);
});

test('the drag label names the new position, or asks for a slot', () => {
  assert.equal(slotHint(ids, 'a', 'Auth', 3), 'Auth → position 3 of 4');
  assert.equal(slotHint(ids, 'a', 'Auth', 1), 'Auth: drop between two group tabs');
  assert.equal(slotHint(ids, 'a', 'Auth', null), 'Auth: drop between two group tabs');
});

test('the order waiting for the server sorts the groups, and a group it does not list goes at the end', () => {
  const gs = ['a', 'b', 'c', 'new'].map(id => ({ id }));
  assert.deepEqual(inOrder(gs, ['c', 'a', 'b']).map(g => g.id), ['c', 'a', 'b', 'new']);
  assert.equal(inOrder(gs, null), gs);
});

test('reorder saves the order in the group files, keeps what each group contains, and survives a reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskboard-group-order-'));
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  process.env.TASKBOARD_DIR = join(root, 'private');
  try {
    const groups = await import('../server/groups.ts');
    const dir = join(root, 'vault', 'groups');
    const a = groups.create('Auth', ['t1']);
    const b = groups.create('Beta', ['t2', 't3']);
    const c = groups.create('Release', []);
    // groups written before the order field existed: oldest first, and no order in the file
    assert.deepEqual(groups.all().map(g => g.id), [a.id, b.id, c.id]);
    assert.equal(matter(readFileSync(join(dir, a.id + '.md'), 'utf8')).data.order, undefined);
    const before = Object.fromEntries([a, b, c].map(g => [g.id, matter(readFileSync(join(dir, g.id + '.md'), 'utf8'))]));

    let events = 0;
    groups.onGroupsChange(() => events++);
    assert.deepEqual(groups.reorder([c.id, a.id, b.id]).map(g => g.id), [c.id, a.id, b.id]);
    assert.equal(events, 1);
    for (const g of [a, b, c]) {
      const now = matter(readFileSync(join(dir, g.id + '.md'), 'utf8'));
      const { order, ...rest } = now.data;
      const { order: _old, ...was } = before[g.id].data;
      assert.deepEqual(rest, was, `${g.id} keeps its name, colour, tasks and created time`);
      assert.equal(now.content, before[g.id].content);
      assert.equal(typeof order, 'number');
    }

    // the same order again writes nothing and sends no update
    groups.reorder([c.id, a.id, b.id]);
    assert.equal(events, 1);

    // an id of a deleted group is ignored, and a group that the list leaves out goes after the listed groups
    groups.reorder(['gone', b.id, c.id]);
    assert.deepEqual(groups.all().map(g => g.id), [b.id, c.id, a.id]);

    // a new group goes at the end
    const d = groups.create('Docs');
    assert.deepEqual(groups.all().map(g => g.id), [b.id, c.id, a.id, d.id]);

    // the server reads the files again after a restart
    groups.load();
    assert.deepEqual(groups.all().map(g => g.id), [b.id, c.id, a.id, d.id]);
    assert.deepEqual(groups.get(b.id)?.tasks, ['t2', 't3']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
