// The guard (server/hooks/guard.mjs) in urgent mode (server/urgent.ts): with a record that names the task, every command
// runs. Without it, or with a record of another task, the normal rules apply. A task cannot write the urgent mode files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));

test('urgent mode lets every command of its task run, and only that task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-urgent-guard-'));
  const run = (command, env = {}) => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASKBOARD_PORT: '4317', TASK_ID: 'task-9', TASK_WORKTREE: '/tmp/wt', ...env },
    });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  const blocked = ['git commit -m x', 'git push origin task/x', 'git -C /tmp/main reset --hard', 'pnpm release', 'pnpm rollback', 'pkill -f "tsx server/index.ts"', 'tb restart'];
  try {
    for (const c of blocked) assert.match(run(c), /permissionDecision.*deny/, `off: ${c}`);
    mkdirSync(join(dir, 'urgent'));
    writeFileSync(join(dir, 'urgent', 'task-9.json'), JSON.stringify({ taskId: 'task-9', taskNum: 9, by: 'user', reason: 'outage', startedAt: '2026-10-09T00:00:00Z' }));
    for (const c of blocked) assert.equal(run(c), '', `on: ${c}`);
    // another task, the controller, a record that names another task, a damaged record
    assert.match(run('git commit -m x', { TASK_ID: 'task-8' }), /deny/);
    assert.match(run('pnpm release', { TASK_ID: 'controller' }), /deny/);
    writeFileSync(join(dir, 'urgent', 'task-8.json'), JSON.stringify({ taskId: 'task-9' }));
    assert.match(run('git commit -m x', { TASK_ID: 'task-8' }), /deny/, 'the record must name the task');
    writeFileSync(join(dir, 'urgent', 'task-8.json'), '{');
    assert.match(run('git commit -m x', { TASK_ID: 'task-8' }), /deny/, 'a damaged record is off');
    // a task without urgent mode cannot write the urgent mode files; reading them is allowed
    for (const c of [`echo '{"taskId":"task-8"}' > ${join(dir, 'urgent', 'task-8.json')}`, 'cp x ~/.taskboard/urgent/task-8.json', `rm ${join(dir, 'urgent-mode.jsonl')}`])
      assert.match(run(c, { TASK_ID: 'task-8' }), /only the user or the controller turns urgent mode on or off/, c);
    assert.equal(run(`cat ${join(dir, 'urgent', 'task-9.json')}`, { TASK_ID: 'task-8' }), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
