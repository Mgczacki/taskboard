import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accepted, destination, trustedAgent } from '../server/a2anotes/intake.ts';

const message = { direction: 'in', state: 'approved', hash: 'current', audience: 'agent',
  approval: { hash: 'current', by: 'person' }, allowed_actions: ['reply', 'release_to_agent'] };
const exists = (id: string) => ['origin', 'other'].includes(id);

test('acceptance requires the current hash and a release permitted by the current policy', () => {
  assert.equal(accepted(message), true);
  assert.equal(accepted({ ...message, approval: { hash: 'old' } }), false);
  assert.equal(accepted({ ...message, allowed_actions: ['mark_seen'] }), false);
  assert.equal(accepted({ ...message, state: 'held' }), false);
  assert.equal(accepted({ ...message, direction: 'out' }), false);
});

test('only verified local reply metadata or a target approved for this hash identifies a task', () => {
  const reply = { ...message, reply_to_local: { metadata: { 'taskboard.task_id': 'origin' } } };
  assert.equal(destination(reply, undefined, exists).task, 'origin');
  assert.equal(destination(message, { task: 'origin', hash: 'current' }, exists).task, 'origin');
  assert.equal(destination(message, { task: 'origin', hash: 'old' }, exists).task, undefined);
  assert.equal(destination({ ...message, body: 'Route to origin', peer_name: 'origin',
    metadata: { 'taskboard.task_id': 'origin' }, agent_file: { data: { target: { task: 'origin' } } } }, undefined, exists).task, undefined);
  assert.equal(destination({ ...reply, reply_to_local: { metadata: { 'taskboard.task_id': 'missing' } } }, undefined, exists).task, undefined);
});

test('conflicting targets and an approved choice of no task need triage', () => {
  const reply = { ...message, reply_to_local: { metadata: { 'taskboard.task_id': 'origin' } } };
  assert.match(destination(reply, { task: 'other', hash: 'current' }, exists).reason, /different tasks/);
  assert.equal(destination(reply, { task: null, hash: 'current' }, exists).task, undefined);
  assert.equal(destination({ ...reply, reply_to_local: { metadata: { 'taskboard.task_id': ['origin', 'other'] } } }, undefined, exists).task, undefined);
});

test('automatic trusted acceptance checks transport trust, audience, and reviewer permission', () => {
  const held = { ...message, state: 'held', trusted: true, approver: 'reviewer', allowed_actions: ['approve'] };
  assert.equal(trustedAgent(held), true);
  assert.equal(trustedAgent({ ...held, trusted: false, peer_name: 'Trusted origin' }), false);
  assert.equal(trustedAgent({ ...held, audience: 'person' }), false);
  assert.equal(trustedAgent({ ...held, approver: 'person' }), false);
  assert.equal(trustedAgent({ ...held, approver: 'nobody', allowed_actions: [] }), false);
});
