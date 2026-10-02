import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftBody } from '../server/a2anotes/draft.ts';

test('a draft from sections has title lines with a colon and one link on each list line', () => {
  const body = draftBody({
    context: 'Mario asked me to send you this change.',
    ask: 'Please review the two pull requests by Friday 9 October.',
    links: 'https://github.com/example/frontend/pull/2739 https://github.com/example/backend/pull/833',
  });
  assert.equal(body, [
    'Why you are getting this:',
    'Mario asked me to send you this change.',
    '',
    'What we need from you:',
    'Please review the two pull requests by Friday 9 October.',
    '',
    'Links:',
    '- https://github.com/example/frontend/pull/2739',
    '- https://github.com/example/backend/pull/833',
  ].join('\n'));
});

test('links are split at a comma, a space, and a newline', () => {
  const body = draftBody({ context: 'Reason.', ask: 'Request.', links: 'https://a.example/1,https://b.example/2 https://c.example/3\nhttps://d.example/4' });
  assert.deepEqual(body.split('Links:\n')[1].split('\n'), ['- https://a.example/1', '- https://b.example/2', '- https://c.example/3', '- https://d.example/4']);
});

test('a link that does not use HTTPS is refused', () => {
  assert.throws(() => draftBody({ context: 'Reason.', ask: 'Request.', links: 'https://a.example/1 http://b.example/2' }), /Links must use HTTPS/);
});
