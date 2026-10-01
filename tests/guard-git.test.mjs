import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));

test('the guard still blocks raw Git ref changes in a task and lets the tb git commands run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-git-guard-'));
  const run = command => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-145' },
    });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  try {
    for (const command of ['git reset --soft master', 'git rebase origin/prod', 'git rebase -i master', 'git update-ref refs/heads/task/x HEAD~1',
      'git push --force origin task/x', 'git -C /tmp/repo branch -f master HEAD', 'git checkout prod', 'GIT_DIR=x git reset --hard origin/master',
      'cd /tmp && git reset --soft master', '/usr/bin/git rebase --onto a b'])
      assert.match(run(command), /permissionDecision.*deny.*tb git repair/, command);
    for (const command of ['tb git repair --squash --base origin/master -m "One commit"', '/Users/me/.taskboard/bin/tb git rebase origin/prod',
      'tb git check --base origin/prod', 'git log --oneline master..HEAD', 'git diff origin/master...HEAD'])
      assert.equal(run(command), '', command);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
