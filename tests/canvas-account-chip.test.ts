import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasAccountChip, CanvasFailureChip, canvasAccountSymbol } from '../web/src/components/CanvasAccountChip.tsx';

const accounts = [
  { id: 'claude-default', name: 'Main Claude' },
  { id: 'claude-second', name: 'Work Claude' },
];
const card = (account: string | undefined, names = accounts) => renderToStaticMarkup(
  createElement(CanvasAccountChip, { task: { agent: 'claude', account }, accounts: names }),
);

test('Canvas account chip follows a task move and an account list refresh', () => {
  assert.match(card('claude-default'), /aria-label="Account: Main Claude" data-name="Main Claude" tabindex="0">/);
  assert.match(card('claude-second'), /aria-label="Account: Work Claude" data-name="Work Claude" tabindex="0">/);
  assert.match(card('claude-second', [{ ...accounts[1], name: 'Renamed Claude' }]), /aria-label="Account: Renamed Claude" data-name="Renamed Claude" tabindex="0">/);
  assert.equal(canvasAccountSymbol('claude-second'), canvasAccountSymbol('claude-second'));
  assert.notEqual(canvasAccountSymbol('claude-default'), canvasAccountSymbol('claude-second'));
});

test('Canvas account chip stays visible while account data loads', () => {
  assert.match(card('claude-second', []), /aria-label="Account: claude-second"/);
  assert.match(card(undefined, []), /aria-label="Account: claude-default"/);
});

test('Canvas shows the failure account after a move and a card refresh', () => {
  const task = { agent: 'codex' as const, account: 'codex-default', lastFailure: { account: 'claude-second', name: 'NYU Claude', agent: 'claude' as const, reason: 'Sign-in problem', at: '2026-10-06T01:55:00Z' } };
  const render = (names = accounts) => renderToStaticMarkup(createElement(CanvasFailureChip, { task, accounts: names }));
  assert.match(render(), />Failed on NYU Claude<\/span>/);
  assert.match(render([]), />Failed on NYU Claude<\/span>/);
  assert.equal(renderToStaticMarkup(createElement(CanvasFailureChip, { task: { ...task, account: 'claude-second' }, accounts })), '');
});
