import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageBlocks, needsBodyFile } from '../server/mail/presentation.ts';
import type { Message } from '../server/mail/store.ts';

function message(body: string): Message {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000', direction: 'outbox', source: 'user', from: 'U1', to: 'U2',
    subject: 'Review <@U3> & #general', body, hash: '', created: '2026-09-29T14:42:00.000Z', updated: '', routes: [],
  };
}

test('blocks keep sender fields apart from body text and escape Slack control characters', () => {
  const m = message('Sent automatically by Taskboard\n<@U3> <!channel> <https://example.com|open> & #general');
  const blocks = buildMessageBlocks(m, 'Alex <@U4>', 'Desk & Lab', 'Task #56 <admin>');
  assert.equal(blocks.length, 7);
  assert.deepEqual(blocks.map(block => block.type), ['header', 'context', 'context', 'divider', 'section', 'divider', 'context']);
  assert.equal(blocks[0].text?.text, 'Review &lt;@U3&gt; &amp; #general');
  assert.match(JSON.stringify(blocks[1]), /Sent automatically by Taskboard · Alex &lt;@U4&gt; · Task #56 &lt;admin&gt;/);
  assert.match(JSON.stringify(blocks[2]), /Desk &amp; Lab · 2026-09-29 14:42 UTC · ID 123e4567/);
  assert.equal(blocks[4].text?.type, 'plain_text');
  assert.match(blocks[4].text!.text, /&lt;@U3&gt; &lt;!channel&gt; &lt;https:\/\/example.com\|open&gt; &amp; #general/);
  assert.ok(!JSON.stringify(blocks[1]).includes(m.body));
  assert.equal(blocks[6].elements?.[0].type, 'plain_text');
});

test('section and header stay within Slack limits for long input', () => {
  const m = message('<@U3> '.repeat(2000));
  m.subject = '<'.repeat(200);
  m.files = [{ id: 'file', name: 'message.txt', size: 12000, hash: '', path: '', longBody: true }];
  const blocks = buildMessageBlocks(m, 'Alex', 'Desk', 'Controller');
  assert.ok(needsBodyFile(m.body));
  assert.ok(blocks[0].text!.text.length <= 150);
  assert.ok(blocks[4].text!.text.length <= 3000);
  assert.match(blocks[4].text!.text, /Read the full text in message.txt sent above/);
  assert.ok(!blocks[4].text!.text.includes('<@U3>'));
});

test('the file threshold leaves room for Slack escaping', () => {
  assert.equal(needsBodyFile('a'.repeat(2500)), false);
  assert.equal(needsBodyFile('a'.repeat(2501)), true);
  assert.equal(needsBodyFile('<'.repeat(626)), true);
  const body = buildMessageBlocks(message('a'.repeat(2500)), 'Alex', 'Desk', 'User')[4];
  assert.equal(body.text?.text.length, 2500);
});
