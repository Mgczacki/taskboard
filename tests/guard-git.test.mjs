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
  const run = (command, env = {}) => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-145', ...env },
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
      'tb git check --base origin/prod', 'git log --oneline master..HEAD', 'git diff origin/master...HEAD',
      'git status --short; git branch --show-current', 'git -C /tmp/repo status --short && git -C /tmp/repo branch --show-current'])
      assert.equal(run(command), '', command);
    const scopes = JSON.stringify([{ name: 'python', path: '/tmp/python-wt' }, { name: 'sekai-agent-ts', path: '/tmp/sekai-wt' }]);
    assert.equal(run('git status --short; git branch --show-current', { TASK_ATTACHED_WORKTREES: scopes }), '');
    for (const command of ['git add -A', 'git -C /tmp/main branch -f master HEAD', 'git -C /tmp/other-wt reset --hard HEAD']) {
      const result = run(command, { TASK_ATTACHED_WORKTREES: scopes });
      assert.match(result, /attached worktrees: python, sekai-agent-ts/);
      assert.match(result, /main checkouts and other tasks' worktrees are outside this task's write scope/);
      assert.doesNotMatch(result, /this task has no worktree/);
    }
    assert.match(run('git branch --show-current -D master', { TASK_ATTACHED_WORKTREES: scopes }), /permissionDecision.*deny/);
    // git merge and git pull stay blocked. The refusal names tb git merge-from and does not add the text about stopping the server.
    for (const command of ['git merge origin/main', 'git pull origin main', 'git merge --continue']) {
      const result = run(command, { TASK_WORKTREE: '1' });
      assert.match(result, /permissionDecision.*deny.*tb git merge-from origin\/main/, command);
      assert.doesNotMatch(result, /stopping it would cut off/, command);
    }
    for (const command of ['tb git merge-from origin/main', 'tb git merge-from --continue --stage src/a.ts', '/Users/me/.taskboard/bin/tb git merge-from --abort'])
      assert.equal(run(command), '', command);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
