// Urgent mode permits local Git writes. Protected commands still need their normal approval path.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));

test('Taskboard push requests and results pass while shell pushes stay blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-push-guard-'));
  const run = command => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-9' },
    });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  try {
    for (const command of [
      'tb git push-request --reason "Publish the tested feature"',
      `${join(dir, 'bin', 'tb')} git push-request --branch master --reason "Publish the tested feature"`,
      'tb git push-result card-id --wait',
      `${join(dir, 'bin', 'tb')} git push-result card-id`,
      'tb git push-request --reason "This asks for git push approval"',
    ]) assert.equal(run(command), '', command);
    for (const command of [
      'git push origin master',
      'git push --force origin task/x',
      'tb git push-request --reason x && git push origin master',
      'tb git push-result id; git push origin master',
      'tb git push-request --reason "$(git push origin master)"',
      'tb git push-request --reason `git push origin master`',
      '/tmp/other/tb git push-request --reason x',
    ]) assert.match(run(command), /permissionDecision.*deny/, command);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('urgent mode permits local Git writes and keeps protected commands blocked', () => {
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
    for (const c of ['git commit -m x', 'git -C /tmp/main reset --hard']) assert.equal(run(c), '', `on: ${c}`);
    for (const c of [...blocked.filter(c => !['git commit -m x', 'git -C /tmp/main reset --hard'].includes(c)), 'git push --force origin task/x', 'git -c core.pager=cat push --force-with-lease origin task/x', 'gh pr create', 'gh pr merge 42', 'gh --repo owner/repo pr merge 42'])
      assert.match(run(c), /permissionDecision.*deny/, `on: ${c}`);
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
