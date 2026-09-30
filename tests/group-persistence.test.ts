import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

test('moving a task saves both group files before it reports the new groups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskboard-group-move-'));
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  process.env.TASKBOARD_DIR = join(root, 'private');
  try {
    const groups = await import('../server/groups.ts');
    const from = groups.create('Source', ['t1', 't2']);
    const to = groups.create('Target', ['t2']);
    let event = 0;
    groups.onGroupsChange(() => {
      event++;
      const dir = join(root, 'vault', 'groups');
      const sourceOnDisk = matter(readFileSync(join(dir, from.id + '.md'), 'utf8')).data.tasks;
      const targetOnDisk = matter(readFileSync(join(dir, to.id + '.md'), 'utf8')).data.tasks;
      assert.deepEqual(sourceOnDisk, groups.get(from.id)?.tasks);
      assert.deepEqual(targetOnDisk, groups.get(to.id)?.tasks);
    });
    groups.moveTask('t2', from.id, to.id);
    assert.equal(event, 1);
    groups.load();
    assert.deepEqual(groups.get(from.id)?.tasks, ['t1']);
    assert.deepEqual(groups.get(to.id)?.tasks, ['t2']);
    assert.throws(() => groups.moveTask('t2', from.id, to.id), /no longer in the source/);
    assert.throws(() => groups.moveTask('t1', from.id, from.id), /same/);
    assert.equal(event, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
