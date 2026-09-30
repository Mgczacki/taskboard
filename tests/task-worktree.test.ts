import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareWorktreeDependencies, useTaskWorktree } from '../server/task-worktree.ts';

test('Git roots use a task worktree unless the caller asks to use the folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-worktree-'));
  const plain = join(root, 'plain');
  const repo = join(root, 'repo');
  const nested = join(repo, 'nested');
  mkdirSync(plain); mkdirSync(repo); mkdirSync(nested);
  try {
    const init = spawnSync('git', ['init', '-b', 'master', repo], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(await useTaskWorktree(repo), true);
    assert.equal(await useTaskWorktree(nested), false);
    assert.equal(await useTaskWorktree(plain), false);
    assert.equal(await useTaskWorktree(repo, false), false);
    assert.equal(await useTaskWorktree(plain, true), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new worktree can use modules from the source checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-modules-'));
  const source = join(root, 'source');
  const work = join(root, 'work');
  mkdirSync(source); mkdirSync(work);
  try {
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, 'node_modules', 'ready'), 'yes');
    await prepareWorktreeDependencies(source, work);
    assert.equal(readlinkSync(join(work, 'node_modules')), join(source, 'node_modules'));
    assert.equal(existsSync(join(work, 'node_modules', 'ready')), true);
    await prepareWorktreeDependencies(source, work);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new worktree installs locked packages when the source has no modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-task-install-'));
  const source = join(root, 'source');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(source); mkdirSync(work); mkdirSync(bin);
  const script = join(bin, 'pnpm');
  writeFileSync(script, '#!/bin/sh\nprintf "%s" "$*" > install-args\n');
  chmodSync(script, 0o755);
  writeFileSync(join(work, 'package.json'), '{}');
  writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    await prepareWorktreeDependencies(source, work);
    assert.equal(readFileSync(join(work, 'install-args'), 'utf8'), 'install --frozen-lockfile');
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
