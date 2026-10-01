import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardControls, loadOrder, messageCardsKey } from '../web/src/a2aCard.ts';

const draft = { state: 'draft', direction: 'out' as const, allowed_actions: ['approve', 'reject', 'revise'], body_flags: 1 };

test('a card before approval shows the approve and reject buttons', () => {
  const c = cardControls(draft);
  assert.equal(c.label, 'Draft');
  assert.equal(c.approve, true);
  assert.equal(c.reject, true);
  assert.equal(c.removeFlagged, true);
  assert.equal(c.send, false);
});

test('a sent draft with no allowed actions shows Sent and no action buttons', () => {
  // the values that A2A Notes returned for draft 789f870a-3a2d-4cbb-9d57-9e9277c6ddf9 after its approval
  const c = cardControls({ ...draft, state: 'sent', allowed_actions: [] });
  assert.equal(c.label, 'Sent');
  assert.deepEqual([c.approve, c.reject, c.removeFlagged, c.send, c.route], [false, false, false, false, false]);
});

test('a held incoming message shows Waiting for approval only with its allowed actions', () => {
  const held = { state: 'held', direction: 'in' as const, allowed_actions: ['approve', 'reject', 'mark_seen'], body_flags: null };
  assert.equal(cardControls(held).label, 'Waiting for approval');
  assert.equal(cardControls(held).reject, true);
  // an agent sees the same held message with mark_seen only
  assert.equal(cardControls({ ...held, allowed_actions: ['mark_seen'] }).reject, false);
});

test('an older list response that arrives last is not kept', () => {
  const order = loadOrder();
  const poll = order.start(), afterApproval = order.start();
  assert.equal(order.latest(afterApproval), true);
  assert.equal(order.latest(poll), false);
});

test('the key changes when a message approval card closes', () => {
  const pending = [{ id: 'a1', action: 'mail-out', state: 'pending' }, { id: 'p1', action: 'permit', state: 'pending' }];
  const approved = [{ id: 'a1', action: 'mail-out', state: 'approved' }, { id: 'p1', action: 'permit', state: 'pending' }];
  assert.notEqual(messageCardsKey(pending), messageCardsKey(approved));
  assert.equal(messageCardsKey(pending), messageCardsKey([pending[0], { ...pending[1], state: 'approved' }]));
});

test('the Inbox card takes its buttons from cardControls only', () => {
  const source = readFileSync(new URL('../web/src/components/A2ANotes.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('allowed_actions.includes'), false);
  assert.match(source, /cardControls\(m\)/);
  assert.match(source, /messageCardsKey\(/);
});
