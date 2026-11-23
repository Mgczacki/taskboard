import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../server/store.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-permission-pending-'));
process.env.TASKBOARD_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const pending = await import('../server/pending.ts');
const tasks = new Map<string, Task>();
const logs: string[] = [];
pending.setIo({ capture: async () => '', key: async () => {}, cancelCopyMode: async () => {}, sendText: async () => ({ submitted: true }),
  getTask: id => tasks.get(id), log: (_task, text) => { logs.push(text); }, answered: () => {}, wait: async () => {} });
let on = false;
pending.setAutoApprover(() => on);
let num = 0;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hold = (command: string, tool = 'Bash', input?: unknown) => {
  const t = { id: `task-${++num}`, num, title: 'test', agent: 'claude', session: `session-${num}`, status: 'needs-you', cwd: root } as Task;
  tasks.set(t.id, t);
  let close = () => {};
  const output = pending.holdClaude(t, { tool_name: tool, tool_input: input || { command } }, fn => { close = fn; }, 10000);
  return { item: pending.list().find(item => item.taskId === t.id)!, output, close };
};

test('new read-only questions approve once and record task, card and type', async () => {
  on = true;
  const held = hold('pwd');
  const output = await held.output;
  await tick();
  assert.equal(held.item.state, 'answered');
  assert.equal(held.item.answer?.by, 'permissions');
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const rows = readFileSync(join(root, 'approval-decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.permissionType === 'pending:command' && row.card === held.item.id && row.actor === held.item.taskId).length, 1);
  assert.ok(logs.some(line => line.includes(`pending:command card ${held.item.id} for task #${held.item.taskNum}`)));
  held.close();
});

test('existing questions stay pending and disabling before dispatch prevents the answer', async () => {
  on = false;
  const existing = hold('pwd');
  on = true;
  await tick();
  assert.equal(existing.item.state, 'pending');
  const next = hold('pwd');
  on = false;
  await tick();
  assert.equal(next.item.state, 'pending');
  existing.close(); next.close();
  await Promise.all([existing.output, next.output]);
});

test('protected commands and questions with no automatic answer stay manual', async () => {
  on = true;
  for (const command of ['git push --force', 'gh pr create', 'gh pr merge 2', 'pnpm release', 'pnpm rollback', 'tb restart', 'pwd\npnpm release', 'git branch -D master', 'rg --pre script x']) {
    const held = hold(command);
    await tick();
    assert.equal(held.item.state, 'pending', command);
    held.close(); await held.output;
  }
  for (const [tool, input] of [['AskUserQuestion', { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] }], ['ExitPlanMode', { plan: 'Run the plan.' }]] as const) {
    const held = hold('', tool, input);
    await tick();
    assert.equal(held.item.state, 'pending', tool);
    held.close(); await held.output;
  }
});

test('an automatic answer never selects a risky option', async () => {
  on = true;
  const held = hold('git status');
  held.item.options[0].risk = 'wide-access';
  await tick();
  assert.equal(held.item.state, 'pending');
  await assert.rejects(pending.answer(held.item.id, { option: 'once', by: 'permissions' }), /manual answer/);
  held.close(); await held.output;
});
