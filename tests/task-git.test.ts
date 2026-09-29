import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitTask, mergeState, mergeTask, rebaseTask } from '../server/task-git.ts';
import type { Task } from '../server/store.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

test('a task commits its worktree and merges only the approved branch head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-git-'));
  const main = join(root, 'main'), work = join(root, 'task');
  mkdirSync(main);
  try {
    git(main, 'init', '-b', 'master');
    git(main, 'config', 'user.email', 'taskboard-test@example.invalid');
    git(main, 'config', 'user.name', 'Taskboard Test');
    writeFileSync(join(main, 'base.txt'), 'base\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
    git(main, 'worktree', 'add', '-b', 'task/example', work);
    const task = { cwd: work, folder: main, branch: 'task/example', worktree: true, role: 'task' } as Task;
    writeFileSync(join(work, 'change.txt'), 'change\n');
    assert.match(await commitTask(task, 'Task change'), /Committed/);
    await rebaseTask(task);
    const approved = await mergeState(task);
    assert.match(await mergeTask(task, approved), /Merged/);
    assert.equal(git(main, 'show', 'HEAD:change.txt'), 'change');
    writeFileSync(join(work, 'next.txt'), 'next\n');
    await commitTask(task, 'Next change');
    await assert.rejects(mergeTask(task, approved), /changed after approval/);
    await assert.rejects(mergeState({ ...task, branch: 'task/another' }), /branch changed|not in its worktree/);
    writeFileSync(join(main, 'local.txt'), 'uncommitted\n');
    await assert.rejects(mergeState(task), /no local changes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
