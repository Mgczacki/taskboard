import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(globalThis, {
  location: new URL('http://127.0.0.1/'),
  WebSocket: class { close() {} send() {} },
});
const { MoveAccountForm } = await import('../web/src/components/MoveAccountForm.tsx');
type Account = import('../web/src/components/Accounts.tsx').Account;

const account = (running: number): Account => ({
  id: 'codex-default', name: 'Codex default', agent: 'codex', dir: '/fixture', maxParallel: 20,
  running, status: { signedIn: true },
});
const form = (running: number, error = '') => renderToStaticMarkup(createElement(MoveAccountForm, {
  accounts: [account(running)], current: 'claude-work', target: 'codex-default', moving: false, error,
  status: 'parked', openElsewhere: false, select: () => {}, move: () => {}, cancel: () => {},
}));

test('Move shows a full account and the server refusal beside the button', () => {
  const html = form(20, 'Account codex-default is at its limit of 20 tasks (raise it on the Accounts page).');
  assert.match(html, /20\/20 tasks · usage unknown · at its limit of 20 tasks/);
  assert.match(html, /role="status">Account codex-default is at its limit of 20 tasks/);
  assert.match(html, /role="alert">Account codex-default is at its limit of 20 tasks/);
  assert.match(html, /disabled=""[^>]*>Move and continue/);
});

test('Move allows an account with one task slot left', () => {
  const html = form(19);
  assert.match(html, /19\/20 tasks/);
  assert.doesNotMatch(html, /at its limit/);
  assert.match(html, /class="btn primary">Move and continue/);
});
