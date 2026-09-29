import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPaths, joinRows, type Row } from '../web/src/terminalPaths.ts';

const P = 'AgentVault/tasks/graph-show-people-and-messages-63/outbox/graph-people-design.html';
const rows = (...lines: (string | [string, boolean])[]): Row[] => lines.map(l => typeof l === 'string' ? { text: l, wrapped: false } : { text: l[0], wrapped: l[1] });
const paths = (...lines: (string | [string, boolean])[]) => findPaths(joinRows(rows(...lines))).map(m => m.candidates.map(c => c.text));
const first = (line: string) => paths(line).map(c => c[0]);

test('finds a path without a leading / or ~ and drops the full stop after it', () => {
  assert.deepEqual(first(`The design is at ${P}.`), [P]);
  assert.deepEqual(first('See tasks/graph-show-people-and-messages-63/outbox/graph-people-design.html, then reply.'), ['tasks/graph-show-people-and-messages-63/outbox/graph-people-design.html']);
  assert.deepEqual(first('Wrote outbox/design.md; next step.'), ['outbox/design.md']);
  assert.deepEqual(first('./inbox/notes.md:12'), ['./inbox/notes.md:12']);
});

test('finds paths in quotes, parentheses and Markdown links', () => {
  assert.deepEqual(first(`(~/${P})`), [`~/${P}`]);
  assert.deepEqual(first(`"~/${P}"`), [`~/${P}`]);
  assert.deepEqual(first(`'/Users/me/${P}'`), [`/Users/me/${P}`]);
  assert.deepEqual(first(`[mockup](~/${P})`), [`~/${P}`]);
  assert.deepEqual(first('[outbox/a.html](outbox/a.html)'), ['outbox/a.html', 'outbox/a.html']);
  assert.deepEqual(first('"outbox/design notes (v2).md"'), ['outbox/design notes (v2).md']);
  assert.deepEqual(first(`path:${P}`), [P]);
});

test('finds a file:// URL and a heading fragment', () => {
  assert.deepEqual(first(`file:///Users/me/${P}`), [`file:///Users/me/${P}`]);
  assert.deepEqual(first('file:///Users/me/AgentVault/tasks/t-1/outbox/my%20design.html.'), ['file:///Users/me/AgentVault/tasks/t-1/outbox/my%20design.html']);
  assert.deepEqual(first('outbox/design.md#next-steps'), ['outbox/design.md#next-steps']);
});

test('ignores text that is not a task document path', () => {
  assert.deepEqual(first('Run pnpm build in web/src/components.'), []);
  assert.deepEqual(first('The outbox/ folder is empty.'), []);
  assert.deepEqual(first('https://example.com/outbox'), []);
  assert.deepEqual(first('https://example.com/tasks/t-1/outbox/a.html'), []);
});

test('joins a path that Claude Code broke over two rows with an indent', () => {
  // observed in task #63's terminal: the path on its own row, cut at the terminal width
  const found = findPaths(joinRows(rows('⏺ The design is at', `  ${P.slice(0, 50)}`, `  ${P.slice(50)}.`, '', 'What the design proposes:')));
  assert.equal(found.length, 1);
  assert.equal(found[0].candidates[0].text, P);
  assert.equal(found[0].candidates.length, 1);
  // when the first row already ends in a document name, the first row alone is the second candidate
  const cut = findPaths(joinRows(rows(`  ${P.slice(0, 70)}`, `  ${P.slice(70)}.`)));
  assert.deepEqual(cut[0].candidates.map(c => c.text), [P, P.slice(0, 70)]);
});

test('joins rows that xterm marks as soft-wrapped and rows that tmux redrew', () => {
  assert.deepEqual(paths(`A9 ~/${P.slice(0, 40)}`, [P.slice(40) + '.', true]), [[`~/${P}`]]);
  assert.deepEqual(paths(`A9 ~/${P.slice(0, 40)}`, P.slice(40) + '.'), [[`~/${P}`]]);
});

test('keeps a complete path when the next row starts with other text', () => {
  assert.deepEqual(paths('Saved outbox/design.md', 'and then stopped.'), [['outbox/design.mdand', 'outbox/design.md']]);
  assert.deepEqual(paths('Saved outbox/design.html', 'next-steps.md is new.'), [['outbox/design.htmlnext-steps.md', 'outbox/design.html']]);
});

test('maps each character back to its terminal cell', () => {
  const joined = joinRows(rows('at', `  ${P.slice(0, 30)}`, `    ${P.slice(30)}.`));
  const match = findPaths(joined)[0];
  const end = match.candidates[0].end;
  assert.deepEqual(joined.cells[match.start], { row: 1, col: 2 });
  assert.deepEqual(joined.cells[end - 1], { row: 2, col: 4 + P.length - 30 - 1 });
});
