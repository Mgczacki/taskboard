import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    await assert.rejects(mergeState(task), /Master has local changes.*tb git merge-request/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an approved merge with same-line edits finishes after task conflict resolution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-conflict-'));
  const main = join(root, 'main'), work = join(root, 'task'), pending = join(root, 'pending.json');
  mkdirSync(main);
  try {
    git(main, 'init', '-b', 'master');
    git(main, 'config', 'user.email', 'taskboard-test@example.invalid');
    git(main, 'config', 'user.name', 'Taskboard Test');
    writeFileSync(join(main, 'shared.txt'), 'base\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
    git(main, 'worktree', 'add', '-b', 'task/conflict', work);
    const task = { cwd: work, folder: main, branch: 'task/conflict', worktree: true, role: 'task' } as Task;
    writeFileSync(join(work, 'shared.txt'), 'task\n');
    await commitTask(task, 'Task change');
    writeFileSync(join(main, 'shared.txt'), 'master\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'Master change');
    const masterHead = git(main, 'rev-parse', 'HEAD');
    const approved = await mergeState(task);
    assert.match(await mergeTask(task, approved, pending), /tb git rebase --continue/);
    assert.equal(git(main, 'rev-parse', 'HEAD'), masterHead);
    assert.equal(git(main, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(main, '.git', 'MERGE_HEAD')), false);
    assert.equal(existsSync(pending), true);
    assert.match(readFileSync(join(work, 'shared.txt'), 'utf8'), /<<<<<<< /);
    await assert.rejects(rebaseTask(task, 'continue', pending), /Resolve conflict markers/);
    writeFileSync(join(work, 'shared.txt'), 'master and task\n');
    assert.match(await rebaseTask(task, 'continue', pending), /Merged/);
    assert.equal(git(main, 'show', 'HEAD:shared.txt'), 'master and task');
    assert.equal(git(main, 'status', '--porcelain'), '');
    assert.equal(existsSync(pending), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a task can abort a rebase with conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-abort-'));
  const main = join(root, 'main'), work = join(root, 'task');
  mkdirSync(main);
  try {
    git(main, 'init', '-b', 'master');
    git(main, 'config', 'user.email', 'taskboard-test@example.invalid');
    git(main, 'config', 'user.name', 'Taskboard Test');
    writeFileSync(join(main, 'shared.txt'), 'base\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
    git(main, 'worktree', 'add', '-b', 'task/abort', work);
    const task = { cwd: work, folder: main, branch: 'task/abort', worktree: true, role: 'task' } as Task;
    writeFileSync(join(work, 'shared.txt'), 'task\n'); await commitTask(task, 'Task change');
    const taskHead = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(main, 'shared.txt'), 'master\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'Master change');
    await assert.rejects(rebaseTask(task), /tb git rebase --continue/);
    assert.match(await rebaseTask(task, 'abort'), /Aborted/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), taskHead);
    assert.equal(git(work, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed merge restores master before reporting the next command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-merge-failure-'));
  const main = join(root, 'main'), work = join(root, 'task');
  mkdirSync(main);
  try {
    git(main, 'init', '-b', 'master');
    git(main, 'config', 'user.email', 'taskboard-test@example.invalid');
    git(main, 'config', 'user.name', 'Taskboard Test');
    writeFileSync(join(main, 'base.txt'), 'base\n');
    git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
    git(main, 'worktree', 'add', '-b', 'task/fail', work);
    const task = { cwd: work, folder: main, branch: 'task/fail', worktree: true, role: 'task' } as Task;
    writeFileSync(join(work, 'change.txt'), 'change\n'); await commitTask(task, 'Task change');
    const masterHead = git(main, 'rev-parse', 'HEAD');
    writeFileSync(join(main, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(mergeTask(task, await mergeState(task)), /master was restored.*tb git rebase/);
    assert.equal(git(main, 'rev-parse', 'HEAD'), masterHead);
    assert.equal(git(main, 'status', '--porcelain'), '');
    assert.equal(existsSync(join(main, '.git', 'MERGE_HEAD')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
