import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureAccountAfterMove, failureAccountFromLog } from '../server/failure-account.ts';

test('a saved stop followed by a move keeps the account that ran the failed turn', () => {
  const log = `## 2026-10-06 01:55 UTC
- Did: Stopped: sign-in problem. Read from Claude Code StopFailure hook.
## 2026-10-06 01:56 UTC
- Did: Moved from NYU (claude) to Codex (default) (codex). Started a new conversation.
`;
  assert.deepEqual(failureAccountFromLog(log), { agent: 'claude', name: 'NYU', reason: 'sign-in problem. Read from Claude Code StopFailure hook.' });
  assert.equal(failureAccountFromLog('- Did: Stopped: model overloaded.'), undefined);
});

test('a move saves the old account name with its earlier failure', () => {
  const failure = { account: 'claude-second', agent: 'claude' as const, reason: 'Sign-in problem', at: '2026-10-06T01:55:00Z' };
  assert.deepEqual(failureAccountAfterMove(failure, { id: 'claude-second', name: 'NYU' }), { ...failure, name: 'NYU' });
  assert.deepEqual(failureAccountAfterMove(failure, { id: 'other', name: 'Other' }), failure);
});

test('a stop saves its account before a later move replaces the current account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-failure-account-'));
  process.env.TASKBOARD_DIR = join(root, 'state');
  process.env.TASKBOARD_VAULT = join(root, 'vault');
  const store = await import('../server/store.ts');
  const task = store.create({ id: 'failed-task', num: 1, title: 'Failed task', agent: 'claude', account: 'claude-second', status: 'working', session: 'task-1', cwd: root, folder: root, desc: '' });
  store.update(task.id, { status: 'stopped', stopReason: 'Sign-in problem' });
  store.update(task.id, { status: 'working', account: 'codex-default', agent: 'codex', stopReason: undefined });
  assert.equal(store.get(task.id)?.lastFailure?.account, 'claude-second');
  assert.equal(store.get(task.id)?.lastFailure?.agent, 'claude');
  assert.match(readFileSync(join(root, 'vault', 'tasks', 'failed-task.md'), 'utf8'), /account: claude-second/);
  store.loadAll();
  assert.equal(store.get(task.id)?.lastFailure?.account, 'claude-second');

  const old = store.create({ id: 'older-task', num: 2, title: 'Older task', agent: 'codex', account: 'codex-default', status: 'review', session: 'task-2', cwd: root, folder: root, desc: '' });
  writeFileSync(store.logFile(old.id), '- Did: Stopped: sign-in problem.\n- Did: Moved from NYU (claude) to Codex (default) (codex). Started a new conversation.\n');
  store.loadAll();
  assert.equal(store.get(old.id)?.lastFailure?.name, 'NYU');
});
