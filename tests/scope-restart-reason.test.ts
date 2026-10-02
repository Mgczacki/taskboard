// restartWaitReason (server/scope-restart.ts): when a session that waits for a restart may restart, and why it waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartWaitReason, type RestartCheck } from '../server/scope-restart.ts';

const base: RestartCheck = { status: 'idle', ended: true, quiet: true, quietLong: true, screen: '> ', restartFor: 'to give access to the new worktree app', waitedMs: 1000, limitMs: 600000 };
const check = (c: Partial<RestartCheck>) => restartWaitReason({ ...base, ...c });

test('every status that means the agent waits lets the restart run', () => {
  for (const status of ['idle', 'unread', 'review'] as const) assert.equal(check({ status }).reason, '', status);
  // the turn ended without a question, and the status still shows an old ask
  assert.equal(check({ status: 'needs-you', lastText: 'Done.' }).reason, '');
  // the event for the end of the turn did not arrive, but the transcript shows it
  assert.equal(check({ status: 'working' }).reason, '');
  // the status of an ended turn does not depend on the transcript
  assert.equal(check({ status: 'review', ended: false }).reason, '');
});

test('a running turn, an open question or a dialog keeps the restart waiting', () => {
  assert.match(check({ status: 'working', ended: false }).reason, /^Waiting for the end of the turn to give access to the new worktree app\.$/);
  // a permission prompt: a tool call without a result, so the turn has not ended
  assert.match(check({ status: 'needs-you', ended: false }).reason, /asks a question or waits for an approval/);
  assert.match(check({ status: 'needs-you', lastText: 'Which branch should I use?' }).reason, /asks a question/);
  assert.match(check({ quiet: false }).reason, /end of the turn/);
  // the transcript looks ended, but the agent may still think: 'working' needs 60 quiet seconds
  assert.match(check({ status: 'working', quietLong: false }).reason, /end of the turn/);
  for (const screen of ['Do you want to proceed?\n❯ 1. Yes', 'Do you want to make this edit to a.ts?', '? 2 questions\nshift+← to answer'])
    assert.match(check({ screen }).reason, /question or a dialog on its screen/, screen);
  assert.match(check({ screen: 'Update available 1 → 2\n1. Update now\n2. Skip', blocking: /Update available[\s\S]*Skip/ }).reason, /dialog/);
  for (const status of ['suspended', 'stopped', 'parked'] as const) assert.notEqual(check({ status }).reason, '', status);
});

test('after the set time the reason says so and the task offers Restart now', () => {
  assert.equal(check({ status: 'working', ended: false }).overdue, false);
  const late = check({ status: 'working', ended: false, waitedMs: 600000 });
  assert.equal(late.overdue, true);
  assert.match(late.reason, /The turn did not end in 10 minutes\. Restart now ends the turn and keeps the conversation\./);
  // nothing to wait for: no Restart now
  assert.equal(check({ waitedMs: 900000 }).overdue, false);
  assert.match(check({ restartFor: undefined, status: 'working', ended: false }).reason, /end of the turn to restart the session/);
});
