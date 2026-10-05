// Task 271: Taskboard moves a person's draft out of the agent's input box, types a message, and puts the draft back.
// These cases check the parts that do not need tmux: how the draft is read from a screen, and how keys from the
// dashboard terminals are held during that time.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-draft-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-draft-${process.pid}`;
const { draftText, draftQuiet, DRAFT_QUIET_MS, WIDE_COLS } = await import('../server/deliver-text.ts');
const input = await import('../server/terminal-input.ts');

const rule = '─'.repeat(60);
const claude = (...box: string[]) => ['Fake agent', '', rule, ...box, rule, '  ? for shortcuts'].join('\n');
const codex = (...box: string[]) => ['OpenAI Codex', '', ...box, '', '  ? for shortcuts'].join('\n');

test('a draft on one row is read as it is, without the prompt mark', () => {
  assert.equal(draftText(claude('❯ half a sentence'), 'claude', 100), 'half a sentence');
  assert.equal(draftText(codex('› half a sentence'), 'codex', 100), 'half a sentence');
  assert.equal(draftText(claude('>   indented start'), 'antigravity', 100), '  indented start');
});

test('a draft on several rows is read again in a wide window, where each row is one line', () => {
  // in a normal window the row ends may be wraps
  assert.equal(draftText(claude('❯ first line', '  second line'), 'claude', 100), 'wrapped');
  assert.equal(draftText(codex('› first line', '  second line'), 'codex', 100), 'wrapped');
  // in the wide window they are line ends; the indent of two spaces is the agent's, more is the person's
  assert.equal(draftText(claude('❯ first line', '    indented second', '  ', '  fourth'), 'claude', WIDE_COLS), 'first line\n  indented second\n\nfourth');
  assert.equal(draftText(codex('› first line', '  second line'), 'codex', WIDE_COLS), 'first line\nsecond line');
  // a row that reaches the edge of the wide window may still be wrapped
  assert.equal(draftText(claude('❯ ' + 'x'.repeat(WIDE_COLS - 2)), 'claude', WIDE_COLS), 'wrapped');
});

test('a draft that cannot be typed back is not read: placeholders and shell mode', () => {
  assert.equal(draftText(claude('❯ see [Pasted text #1 +20 lines]'), 'claude', 100), null);
  assert.equal(draftText(codex('› [Pasted Content 2400 chars]'), 'codex', 100), null);
  assert.equal(draftText(claude('❯ look at [Image #1]'), 'claude', 100), null);
  assert.equal(draftText(claude('! ls -la'), 'claude', 100), null);
  assert.equal(draftText('no box here', 'claude', 100), null);
});

test('a draft counts as quiet only after 3 s without a change and without a dashboard key', () => {
  let now = 1_000_000, key = 0;
  const io = { now: () => now, lastKeyAt: () => key };
  const screen = claude('❯ my draft');
  assert.equal(draftQuiet('s1', screen, 'claude', io), false, 'first seen now');
  now += DRAFT_QUIET_MS;
  assert.equal(draftQuiet('s1', screen, 'claude', io), true);
  now += 100;
  assert.equal(draftQuiet('s1', claude('❯ my draft.'), 'claude', io), false, 'the draft changed');
  now += DRAFT_QUIET_MS;
  key = now - 1000;
  assert.equal(draftQuiet('s1', claude('❯ my draft.'), 'claude', io), false, 'a key 1 s ago');
  now += DRAFT_QUIET_MS;
  assert.equal(draftQuiet('s1', claude('❯ my draft.'), 'claude', io), true);
});

test('keys from the dashboard wait during a hold and arrive after it, in order', () => {
  const got: string[] = [];
  input.write('s2', () => got.push('a'));
  const release = input.hold('s2');
  input.write('s2', () => got.push('b'));
  input.write('s2', () => got.push('c'));
  assert.deepEqual(got, ['a']);
  assert.equal(input.held('s2'), true);
  release();
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.equal(input.held('s2'), false);
  release(); // a second end does nothing
  input.write('s2', () => got.push('d'));
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
});

test('a hold ends by itself after HOLD_MAX_MS', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const got: string[] = [];
  input.hold('s3');
  input.write('s3', () => got.push('late'));
  t.mock.timers.tick(input.HOLD_MAX_MS);
  assert.deepEqual(got, ['late']);
  assert.equal(input.held('s3'), false);
});
