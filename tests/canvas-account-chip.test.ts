import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasAccountChip } from '../web/src/components/CanvasAccountChip.tsx';

const accounts = [
  { id: 'claude-default', name: 'Main Claude' },
  { id: 'claude-second', name: 'Work Claude' },
];
const card = (account: string | undefined, names = accounts) => renderToStaticMarkup(
  createElement(CanvasAccountChip, { task: { agent: 'claude', account }, accounts: names }),
);

test('Canvas account chip follows a task move and an account list refresh', () => {
  assert.match(card('claude-default'), />Main Claude<\/span>/);
  assert.match(card('claude-second'), />Work Claude<\/span>/);
  assert.match(card('claude-second', [{ ...accounts[1], name: 'Renamed Claude' }]), />Renamed Claude<\/span>/);
});

test('Canvas account chip stays visible while account data loads', () => {
  assert.match(card('claude-second', []), />claude-second<\/span>/);
  assert.match(card(undefined, []), />claude-default<\/span>/);
});
