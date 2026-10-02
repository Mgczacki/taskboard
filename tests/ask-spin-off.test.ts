import assert from 'node:assert/strict';
import test from 'node:test';
import { spinOffPrompt } from '../server/ask-spin-off.ts';

test('a new task receives the source number, question, and answer', () => {
  const prompt = spinOffPrompt({ sourceNum: 42, question: 'What failed?', answer: 'The build failed at typecheck.' });
  assert.match(prompt, /task #42/);
  assert.match(prompt, /Read task #42's log/);
  assert.match(prompt, /Question:\nWhat failed\?/);
  assert.match(prompt, /Answer:\nThe build failed at typecheck\./);
});

test('a spin off requires a completed exchange and a valid source number', () => {
  assert.throws(() => spinOffPrompt({ sourceNum: 0, question: 'What next?', answer: 'Fix it.' }), /source task number/);
  assert.throws(() => spinOffPrompt({ sourceNum: 42, question: '', answer: 'Fix it.' }), /completed BTW question/);
  assert.throws(() => spinOffPrompt({ sourceNum: 42, question: 'What next?', answer: '' }), /completed BTW answer/);
});
