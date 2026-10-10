// The rules of urgent mode without a server (server/urgent.ts): the check of the user's chat message for the controller,
// and the card kinds that urgent mode never approves.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TASKBOARD_DIR = mkdtempSync(join(tmpdir(), 'tb-urgent-unit-'));
const urgent = await import('../server/urgent.ts');

test('the controller turns urgent mode on only with one user message that says urgent and names the task', () => {
  const wrote = (n: number) => () => n;
  const never = () => 0;
  assert.equal(urgent.checkUserRequest('urgent mode for #216', 216, wrote(1), never), 'urgent mode for #216');
  assert.equal(urgent.checkUserRequest('Task 216 is urgent', 216, wrote(1), never), 'Task 216 is urgent');
  assert.throws(() => urgent.checkUserRequest('', 216, wrote(1), never), /--user-request/);
  assert.throws(() => urgent.checkUserRequest('turn off restrictions for 216', 216, wrote(1), never), /word urgent/);
  assert.throws(() => urgent.checkUserRequest('urgent mode for 2160', 216, wrote(1), never), /must name task 216/);
  assert.throws(() => urgent.checkUserRequest('do not use urgent mode for 216', 216, wrote(1), never), /says no/);
  assert.throws(() => urgent.checkUserRequest('urgent mode off for 216', 216, wrote(1), never), /says no/);
  assert.throws(() => urgent.checkUserRequest('urgent mode for 216', 216, never, never), /not one user message/);
  assert.throws(() => urgent.checkUserRequest('urgent mode for 216', 216, wrote(1), wrote(1)), /already turned on/);
  assert.equal(urgent.checkUserRequest('urgent mode for 216', 216, wrote(2), wrote(1)), 'urgent mode for 216', 'the user wrote it twice');
});

test('urgent mode approves the cards of its task, except messages to people, plans and refused commands', () => {
  const t = { id: 't7', num: 7 };
  assert.equal(urgent.active('t7'), false);
  assert.equal(urgent.autoApprove({ id: 'c0', actor: 't7', action: 'permit', summary: 'x' }), false, 'off by default');
  urgent.turnOn(t, 'user', 'outage');
  for (const action of ['permit', 'scope', 'git-merge', 'git-push', 'github-pr', 'release', 'send', 'kill', 'external'] as const)
    assert.equal(urgent.autoApprove({ id: 'c1', actor: 't7', action, summary: 'x' }), true, action);
  for (const action of ['mail-in', 'mail-out', 'plan', 'tool-refusal'] as const)
    assert.equal(urgent.autoApprove({ id: 'c2', actor: 't7', action, summary: 'x' }), false, action);
  assert.equal(urgent.autoApprove({ id: 'c3', actor: 't8', action: 'permit', summary: 'x' }), false, 'another task');
  assert.throws(() => urgent.turnOn({ id: 'controller', num: 0, role: 'controller' }, 'user', 'x'), /controller/);
  urgent.load();
  assert.equal(urgent.active('t7'), true, 'the record survives a restart');
  assert.equal(urgent.turnOff(t, 'user'), true);
  assert.equal(urgent.turnOff(t, 'user'), false);
  assert.equal(urgent.active('t7'), false);
});
