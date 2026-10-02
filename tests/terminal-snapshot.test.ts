// web/src/terminalSnapshot.ts: the saved screen that a terminal draws before its socket is open.
import assert from 'node:assert/strict';
import test from 'node:test';
import { drawText, paneText, savedScreen, saveScreen, serialize, type ScreenSource, type Snapshot } from '../web/src/terminalSnapshot.ts';

// a fake xterm.js screen: each cell is [chars, width, sgr] where sgr is 'b' (bold), 'r' (palette red), 'g' (RGB green)
type FakeCell = [string, number, string?];
function screen(rows: FakeCell[][], cols: number, cursor: [number, number] = [0, 0], baseY = 0): ScreenSource {
  const cell = ([chars, width, sgr = '']: FakeCell) => ({
    getChars: () => chars, getWidth: () => width,
    isBold: () => sgr.includes('b') ? 1 : 0, isDim: () => 0, isItalic: () => 0, isUnderline: () => 0, isBlink: () => 0, isInverse: () => 0, isInvisible: () => 0, isStrikethrough: () => 0,
    isFgRGB: () => sgr.includes('g'), isFgPalette: () => sgr.includes('r'), getFgColor: () => sgr.includes('g') ? 0x00ff00 : sgr.includes('r') ? 1 : 0,
    isBgRGB: () => false, isBgPalette: () => false, getBgColor: () => 0,
  });
  const pad = (r: FakeCell[]) => [...r, ...Array.from({ length: cols - r.length }, (): FakeCell => ['', 1])];
  const lines = [...Array.from({ length: baseY }, () => [] as FakeCell[]), ...rows].map(r => ({ getCell: (x: number) => x < cols ? cell(pad(r)[x]) : undefined }));
  return { cols, rows: rows.length, buffer: { active: { baseY, cursorX: cursor[0], cursorY: cursor[1], getLine: (y: number) => lines[y] } } };
}
const text = (s: string, sgr = ''): FakeCell[] => [...s].map(c => [c, 1, sgr]);

test('serialize keeps text and colors, joins equal cells into runs and drops trailing blanks', () => {
  const s = serialize(screen([[...text('ab', 'b'), ...text('c', 'r'), ...text('d', 'g')], text('  x'), []], 10, [3, 1]));
  assert.deepEqual(s.lines[0], [{ a: '1', t: 'ab', w: 1 }, { a: '31', t: 'c', w: 1 }, { a: '38;2;0;255;0', t: 'd', w: 1 }]);
  assert.deepEqual(s.lines[1], [{ a: '', t: '  x', w: 1 }]);
  assert.deepEqual(s.lines[2], []);
  assert.deepEqual(s.cursor, [3, 1]);
  assert.equal(s.cols, 10);
});

test('serialize reads the screen at the bottom of the buffer, not the history above it', () => {
  const s = serialize(screen([text('top'), text('bottom')], 10, [0, 0], 5));
  assert.equal(s.lines[0][0].t, 'top');
  assert.equal(s.lines[1][0].t, 'bottom');
});

test('a wide character takes two cells and its second half is skipped', () => {
  const s = serialize(screen([[['界', 2], ['', 0], ['a', 1]]], 6));
  assert.deepEqual(s.lines[0], [{ a: '', t: '界', w: 2 }, { a: '', t: 'a', w: 1 }]);
});

const snap = (lines: Snapshot['lines'], cursor: [number, number] = [0, 0]): Snapshot => ({ cols: 10, rows: lines.length, lines, cursor, at: 0 });

test('drawText places each row, turns line wrap off while it draws and puts the cursor back', () => {
  const out = drawText(snap([[{ a: '1', t: 'hi', w: 1 }], [], [{ a: '', t: 'x', w: 1 }]], [2, 2]), 10, 3);
  assert.equal(out, '\x1b[?7l\x1b[1;1H\x1b[0;1mhi\x1b[3;1H\x1b[0mx\x1b[0m\x1b[?7h\x1b[3;3H');
});

test('drawText keeps the bottom rows in a shorter terminal and cuts rows in a narrower one', () => {
  const rows = [[{ a: '', t: 'one', w: 1 as const }], [{ a: '', t: 'two', w: 1 as const }], [{ a: '', t: 'abcdef', w: 1 as const }, { a: '', t: '界', w: 2 as const }]];
  const out = drawText(snap(rows, [1, 2]), 7, 2);
  assert.ok(!out.includes('one'));
  assert.ok(out.includes('\x1b[1;1H\x1b[0mtwo'));
  assert.ok(out.includes('\x1b[2;1H\x1b[0mabcdef\x1b[0m\x1b[?7h')); // the wide character does not fit in 7 cells
  assert.ok(out.endsWith('\x1b[2;2H'));
});

test('the store keeps the 40 most recent screens', () => {
  for (let i = 0; i < 45; i++) saveScreen(`t${i}`, snap([]));
  assert.equal(savedScreen('t0'), undefined);
  assert.equal(savedScreen('t4'), undefined);
  assert.ok(savedScreen('t5'));
  assert.ok(savedScreen('t44'));
  saveScreen('t5', snap([])); // saved again: now the most recent
  saveScreen('t45', snap([]));
  assert.ok(savedScreen('t5'));
  assert.equal(savedScreen('t6'), undefined);
});

test('paneText draws the rows of tmux capture-pane -e, keeps the bottom ones and puts the cursor back', () => {
  const p = { lines: ['first', '\x1b[31mred\x1b[39m', '', 'last'], cursor: [2, 3] as [number, number], cols: 20, rows: 4 };
  assert.equal(paneText(p, 4), '\x1b[?7l\x1b[1;1H\x1b[0mfirst\x1b[2;1H\x1b[0m\x1b[31mred\x1b[39m\x1b[4;1H\x1b[0mlast\x1b[0m\x1b[?7h\x1b[4;3H');
  const short = paneText(p, 2);
  assert.ok(!short.includes('first') && !short.includes('red'));
  assert.ok(short.includes('\x1b[2;1H\x1b[0mlast') && short.endsWith('\x1b[2;3H'));
});
