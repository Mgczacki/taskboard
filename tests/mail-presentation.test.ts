import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageBlocks, needsBodyFile, renderSlackMarkdown } from '../server/mail/presentation.ts';
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
  assert.deepEqual(blocks.map(block => block.type), ['header', 'context', 'context', 'divider', 'markdown', 'divider', 'context']);
  assert.equal(blocks[0].text?.text, 'Review &lt;@U3&gt; &amp; #general');
  assert.match(JSON.stringify(blocks[1]), /Sent automatically by Taskboard · Alex &lt;@U4&gt; · Task #56 &lt;admin&gt;/);
  assert.match(JSON.stringify(blocks[2]), /Desk &amp; Lab · 2026-09-29 14:42 UTC · ID 123e4567/);
  assert.match(blocks[4].text!, /&lt;@​U3&gt;/);
  assert.ok(!blocks[4].text!.includes('<!channel>'));
  assert.ok(!blocks[4].text!.includes('<https://example.com|open>'));
  assert.ok(!JSON.stringify(blocks[1]).includes(m.body));
  assert.equal(blocks[6].elements?.[0].type, 'plain_text');
});

test('body and header stay within Slack limits for long input', () => {
  const m = message('<@U3> '.repeat(2000));
  m.subject = '<'.repeat(200);
  m.files = [{ id: 'file', name: 'message.txt', size: 12000, hash: '', path: '', longBody: true }];
  const blocks = buildMessageBlocks(m, 'Alex', 'Desk', 'Controller');
  assert.ok(needsBodyFile(m.body));
  assert.ok(blocks[0].text!.text.length <= 150);
  assert.ok(blocks[4].text!.length <= 2500);
  assert.match(blocks[4].text!, /Read the full text in message.txt sent above/);
  assert.ok(!blocks[4].text!.includes('<@U3>'));
});

test('the file threshold leaves room for Slack escaping', () => {
  assert.equal(needsBodyFile('a'.repeat(2500)), false);
  assert.equal(needsBodyFile('a'.repeat(2501)), true);
  assert.equal(needsBodyFile('<'.repeat(626)), true);
  const body = buildMessageBlocks(message('a'.repeat(2500)), 'Alex', 'Desk', 'User')[4];
  assert.equal(body.text?.length, 2500);
});

test('Markdown keeps headings, emphasis, lists, code, quotes, and tables', () => {
  const body = '# Title\n\n**bold** and *italic* with `code`\n\n- first\n- second\n\n1. one\n2. two\n\n> quote\n\n```js\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |\n| x | y |';
  const rendered = renderSlackMarkdown(body);
  for (const part of ['# Title', '**bold**', '*italic*', '`code`', '- first', '1. one', '> quote', '```js', '| A | B |']) {
    assert.ok(rendered.includes(part), part);
  }
});

test('Markdown links show their host and reject unsafe targets', () => {
  const rendered = renderSlackMarkdown('[Read](https://example.com/path) [Run](javascript:alert(1)) [Mail](mailto:user@example.com)');
  assert.match(rendered, /\[Read \(example\\\.com\)\]\(https:\/\/example.com\/path\)/);
  assert.ok(!rendered.includes('javascript:'));
  assert.ok(!rendered.includes('mailto:'));
  assert.ok(rendered.includes('Run'));
});

test('table cells show line breaks as separators and escape other HTML', () => {
  const rendered = renderSlackMarkdown('| Name | Values |\n| --- | --- |\n| A | one<br>two<script>bad</script> |');
  assert.ok(rendered.includes('one, two'));
  assert.ok(!rendered.includes('<script>'));
});

test('Markdown body cannot create Slack control sequences', () => {
  const rendered = renderSlackMarkdown('<!channel> <!here> <@U123> <#C123> @here @channel <https://evil.test|forged> &');
  for (const sequence of ['<!channel>', '<!here>', '<@U123>', '<#C123>', '<https://evil.test|forged>', '@here', '@channel']) {
    assert.ok(!rendered.includes(sequence), sequence);
  }
  assert.ok(rendered.includes('&lt;'));
  assert.ok(rendered.includes('&gt;'));
  assert.ok(rendered.includes('&amp;'));
});

test('long Markdown preview ends before a table and names the attached file', () => {
  const m = message('# Title\n\nShort *intro*.\n\n| A | B |\n| --- | --- |\n' + Array.from({ length: 100 }, (_, i) => `| ${i} | ${'x'.repeat(40)} |`).join('\n'));
  m.files = [{ id: 'file', name: 'message.md', size: 8000, hash: '', path: '', longBody: true }];
  const body = buildMessageBlocks(m, 'Alex', 'Desk', 'User')[4].text!;
  assert.ok(body.startsWith('# Title\n\nShort *intro*'));
  assert.ok(!body.includes('| A | B |'));
  assert.match(body, /Read the full text in message.md sent above\./);
  assert.ok(body.length <= 2500);
});
