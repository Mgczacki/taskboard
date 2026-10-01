import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCommand, commandAt, holdTimer, HOLD_MS, markdownCommand, MOVE_LIMIT, type CellRow, type HoldClock } from '../web/src/bangCommand.ts';

// A row of `cols` cells. Text inside {braces} has color 153 (Claude Code's inline code); other text has color 0.
const COLS = 70;
function row(markup: string, wrapped = false, cols = COLS): CellRow {
  const chars: string[] = [], colors: number[] = [];
  let color = 0;
  for (const ch of markup) {
    if (ch === '{') { color = 153; continue; }
    if (ch === '}') { color = 0; continue; }
    chars.push(ch); colors.push(color);
  }
  while (chars.length < cols) { chars.push(' '); colors.push(0); }
  return { chars, colors, wrapped };
}
const at = (rows: CellRow[], r: number, needle: string) => commandAt(rows, r, rows[r].chars.join('').indexOf(needle), COLS)?.command ?? null;

test('finds inline code that starts with ! inside a sentence, from its color', () => {
  const rows = [row('⏺ Please run {! gcloud auth login} and tell me when done.')];
  assert.equal(at(rows, 0, 'auth'), 'gcloud auth login');
  assert.equal(at(rows, 0, '!'), 'gcloud auth login');
  assert.equal(at(rows, 0, 'tell'), null, 'the prose after the command is not part of it');
  assert.equal(at(rows, 0, 'Please'), null);
});

test('joins inline code that Claude Code wrapped over two rows, keeping its color', () => {
  const rows = [
    row('⏺ Run {! gcloud auth application-default login --project }'),
    row('  {some-long-project-name --billing-project other-name} in the prompt.'),
  ];
  const full = 'gcloud auth application-default login --project some-long-project-name --billing-project other-name';
  assert.equal(at(rows, 0, 'gcloud'), full);
  assert.equal(at(rows, 1, 'billing'), full, 'the pointer on the second row finds the command that starts above');
  assert.equal(at(rows, 1, 'prompt'), null);
});

test('finds a row that starts with ! after a bullet, a prompt mark or a number', () => {
  for (const line of ['! gh auth status', '  ! gh auth status', '⏺ ! gh auth status', '- ! gh auth status', '2. ! gh auth status', '$ ! gh auth status', '❯ ! gh auth status'])
    assert.equal(at([row(line)], 0, 'auth'), 'gh auth status', line);
  assert.equal(at([row('- ! gh auth status')], 0, '-'), null, 'the pointer on the bullet is not on the command');
});

test('joins a code block line that the agent wrapped, and only when the next word did not fit', () => {
  const wrapped = [
    row('  ! gh auth login --hostname github.com --web --git-protocol https'),
    row('  --scopes repo,read:org'),
  ];
  assert.equal(at(wrapped, 1, 'scopes'), 'gh auth login --hostname github.com --web --git-protocol https --scopes repo,read:org');
  const separate = [row('  ! gh auth status'), row('  Then tell me the account.')];
  assert.equal(at(separate, 0, 'gh'), 'gh auth status');
  assert.equal(at(separate, 1, 'tell'), null);
});

test('joins a row that the terminal soft-wrapped', () => {
  const rows = [row('! echo ' + 'a'.repeat(63)), row('bbb', true)];
  assert.equal(at(rows, 1, 'bbb'), 'echo ' + 'a'.repeat(63) + 'bbb');
});

test('does not treat other exclamation marks as commands', () => {
  assert.equal(at([row('Done! The tests pass.')], 0, 'The'), null);
  assert.equal(at([row('Done! The tests pass.')], 0, '!'), null);
  assert.equal(at([row('if (!ready) return;')], 0, 'ready'), null);
  assert.equal(at([row('!')], 0, '!'), null, 'a ! with no command');
});

test('refuses a command with control characters, hidden characters or too much text', () => {
  assert.equal(cleanCommand('! gcloud auth login'), 'gcloud auth login');
  assert.equal(cleanCommand('!ls'), 'ls');
  assert.equal(cleanCommand('! ls\nrm -rf ~'), null);
  assert.equal(cleanCommand('! ls\u001b[2K'), null);
  assert.equal(cleanCommand('! ls \u202e fdm.txt'), null);
  assert.equal(cleanCommand('! ls\u200b'), null);
  assert.equal(cleanCommand('! ' + 'x'.repeat(1001)), null);
  assert.equal(cleanCommand('gcloud auth login'), null);
});

test('finds a command in Markdown: inline code, and a line in a block under the pointer', () => {
  assert.equal(markdownCommand('! gcloud auth login', 3, true), 'gcloud auth login');
  assert.equal(markdownCommand('gcloud auth login', 3, true), null);
  const block = 'Run these:\n! gh auth status\n- ! tb inbox wait\nok';
  assert.equal(markdownCommand(block, block.indexOf('auth'), false), 'gh auth status');
  assert.equal(markdownCommand(block, block.indexOf('inbox'), false), 'tb inbox wait');
  assert.equal(markdownCommand(block, block.indexOf('- !'), false), null, 'on the bullet');
  assert.equal(markdownCommand(block, block.indexOf('these'), false), null);
});

// A clock that the test moves forward by hand.
function fakeClock() {
  let now = 0; const fns = new Set<() => void>();
  const clock: HoldClock = { now: () => now, every: fn => { fns.add(fn); return () => fns.delete(fn); } };
  return { clock, advance(ms: number) { for (let t = 0; t < ms; t += 50) { now += 50; for (const fn of [...fns]) fn(); } }, running: () => fns.size };
}
function hold() {
  const c = fakeClock(), seen: string[] = [];
  const h = holdTimer(100, 100, { tick: () => {}, done: () => seen.push('done'), cancel: why => seen.push('cancel:' + why) }, c.clock);
  return { h, c, seen };
}

test('the hold runs once after HOLD_MS when the pointer stays still', () => {
  const { h, c, seen } = hold();
  c.advance(HOLD_MS - 50);
  assert.deepEqual(seen, []);
  h.move(100 + MOVE_LIMIT, 100); // within the limit
  c.advance(100);
  assert.deepEqual(seen, ['done']);
  assert.equal(c.running(), 0, 'the timer stops');
  h.cancel('released');
  assert.deepEqual(seen, ['done'], 'a release after the end does nothing');
});

test('a move past the limit stops the hold, so a text selection never runs a command', () => {
  const { h, c, seen } = hold();
  c.advance(1000);
  h.move(100 + MOVE_LIMIT + 1, 100);
  c.advance(HOLD_MS);
  assert.deepEqual(seen, ['cancel:moved']);
  assert.equal(h.state, 'cancelled');
});

test('a release or the Cancel button before the end stops the hold', () => {
  for (const why of ['released', 'button', 'escape']) {
    const { h, c, seen } = hold();
    c.advance(HOLD_MS / 2);
    h.cancel(why);
    c.advance(HOLD_MS);
    assert.deepEqual(seen, ['cancel:' + why]);
  }
});
