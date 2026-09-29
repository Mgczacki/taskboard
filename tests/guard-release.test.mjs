import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));

test('a dashboard permit lets one task run one release command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-release-guard-'));
  const taskId = 'task-41';
  const run = command => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: taskId },
    });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  try {
    assert.match(run('pnpm release'), /permissionDecision.*deny/);
    const permits = join(dir, 'release-permits');
    mkdirSync(permits);
    const permit = join(permits, taskId + '.json');
    writeFileSync(permit, JSON.stringify({ taskId, expiresAt: Date.now() + 120_000 }));
    assert.equal(run('pnpm release'), '');
    assert.match(run('pnpm release'), /permissionDecision.*deny/);
    writeFileSync(permit, JSON.stringify({ taskId, expiresAt: Date.now() - 1 }));
    assert.match(run('pnpm release'), /permissionDecision.*deny/);
    writeFileSync(permit, JSON.stringify({ taskId, expiresAt: Date.now() + 120_000 }));
    assert.match(run('pnpm rollback'), /permissionDecision.*deny/);
    assert.match(run('node scripts/release.mjs'), /permissionDecision.*deny/);
    assert.match(run('pnpm release && pnpm rollback'), /permissionDecision.*deny/);
    assert.equal(run('pnpm release'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree task uses Taskboard for Git writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-git-guard-'));
  const run = command => spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
    env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-41', TASK_WORKTREE: join(dir, 'work') },
  }).stdout;
  try {
    assert.match(run('git commit -m test'), /permissionDecision.*deny/);
    assert.match(run('git -C other merge master'), /permissionDecision.*deny/);
    assert.equal(run('tb git commit "test"'), '');
    assert.equal(run('tb git merge-request'), '');
    assert.equal(run('git status --short'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
