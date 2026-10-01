// Finds a "! <command>" that an agent printed for the user, under the pointer, and times the hold that runs it.
// Agents ask the user to type such a command into the agent prompt. Claude Code, Codex and Antigravity run it as a
// shell command.
// Holding the mouse button on one for HOLD_MS types it into that task's terminal (holdRun.ts, server/type-command.ts).
//
// In a terminal, a command is found in two forms:
// - a run of cells in one color that starts with "!" and has a different color from the cell before it. Claude Code,
//   Codex and Antigravity print inline code (`! gcloud auth login`) this way, without the backticks. Claude Code
//   keeps the color when it wraps the code onto the next row.
// - a row whose text starts with "!" after optional spaces and one list or prompt mark ("⏺", "-", "1.", "$", "❯").
//   The command runs to the end of the row. A following row continues it when it is indented to the "!" column and
//   its first word would not have fit on the row above (so the agent wrapped the line there).
// In rendered Markdown, a command is the text of an inline <code> that starts with "!", or a line that starts with
// "!" in a code block, paragraph or list item.

export const HOLD_MS = 3000;   // how long the button must stay down
export const SHOW_MS = 250;    // the card shows after this much of the hold, so a short click or a selection shows nothing
export const MOVE_LIMIT = 4;   // pixels; a larger move means the user selects text, and the hold stops
export const MAX_LENGTH = 1000;

// Control characters, and characters that hide or reorder text on the screen (zero-width, bidirectional controls).
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const LINE_START = /^(\s*(?:(?:[⏺●•◦*+\-–>❯›$#]|\d{1,3}[.)])\s+)?)!(?=\s*\S)/;

// The command without its "!", or null when it cannot be typed safely.
export function cleanCommand(text: string): string | null {
  const m = /^\s*!\s*([\s\S]*?)\s*$/.exec(text);
  if (!m || !m[1] || m[1].length > MAX_LENGTH || HIDDEN.test(m[1])) return null;
  return m[1];
}

// One terminal row: the character in each cell ('' for the right half of a wide character) and each cell's color.
export interface CellRow { chars: string[]; colors: (number | string)[]; wrapped: boolean }
export interface CommandSpan { command: string; start: { row: number; col: number }; end: { row: number; col: number } }

const lastText = (r: CellRow) => { let i = r.chars.length - 1; while (i >= 0 && !r.chars[i].trim()) i--; return i; };
const firstText = (r: CellRow) => r.chars.findIndex(c => c.trim() !== '');
const text = (r: CellRow, from: number, to: number) => r.chars.slice(from, to + 1).join('');

// The command whose text covers the cell (row, col), or null. rows[row] is the row under the pointer.
export function commandAt(rows: CellRow[], row: number, col: number, cols: number): CommandSpan | null {
  for (let top = row; top >= 0 && row - top < 30; top--) {
    for (const span of commandsFrom(rows, top, cols)) {
      if (span.start.row !== top) continue;
      const after = (p: { row: number; col: number }) => row > p.row || (row === p.row && col >= p.col);
      if (after(span.start) && !after({ row: span.end.row, col: span.end.col + 1 })) return span;
    }
    // a command that covers the pointer row starts on this row or above; stop at a blank row
    if (firstText(rows[top]) < 0 && top !== row) break;
  }
  return null;
}

// Every command that starts on rows[r].
export function commandsFrom(rows: CellRow[], r: number, cols: number): CommandSpan[] {
  const out: CommandSpan[] = [];
  const row = rows[r];
  if (!row) return out;
  const plain = row.chars.join('');
  const lead = LINE_START.exec(plain);
  const startCol = lead ? cellOf(row, lead[1].length) : -1;
  // A row that starts with "!" in one color and ends in another starts with inline code: the color form finds it.
  const lineForm = startCol >= 0 && row.colors[startCol] === row.colors[lastText(row)];
  if (lineForm) {
    // the line form: to the end of the row, and onto the rows it wrapped into
    let end = { row: r, col: lastText(row) };
    let command = text(row, startCol, end.col);
    for (let n = r + 1; n < rows.length && n - r < 30; n++) {
      const next = rows[n], first = firstText(next);
      if (first < 0) break;
      const word = next.chars.slice(first).join('').split(/\s/)[0].length;
      const wrapped = next.wrapped || (first === startCol && end.col + 2 + word > cols - 1);
      if (!wrapped) break;
      command += (next.wrapped ? '' : ' ') + text(next, next.wrapped ? 0 : first, lastText(next));
      end = { row: n, col: lastText(next) };
    }
    const clean = cleanCommand(command);
    if (clean) out.push({ command: clean, start: { row: r, col: startCol }, end });
  }
  // the color form: a run in one color that starts with "!"
  for (let c = 0; c < row.chars.length; c++) {
    if (row.chars[c] !== '!' || (lineForm && c === startCol)) continue;
    const before = previousText(row, c);
    if (before >= 0 ? row.colors[before] === row.colors[c] : c !== startCol) continue;
    const color = row.colors[c];
    let end = { row: r, col: c }, command = '';
    let n = r, from = c;
    for (;;) {
      const cur = rows[n];
      let to = from;
      while (to + 1 < cur.chars.length && cur.colors[to + 1] === color) to++;
      command += text(cur, from, to);
      let last = to; while (last > from && !cur.chars[last].trim()) last--;
      end = { row: n, col: last };
      // the run reaches the row's last text and the next row starts in the same color: Claude Code wrapped it
      const next = rows[n + 1];
      if (to < lastText(cur) || !next || n - r >= 30) break;
      const first = firstText(next);
      if (first < 0 || next.colors[first] !== color) break;
      command = next.wrapped ? command : command.trimEnd() + ' ';
      n++; from = next.wrapped ? 0 : first;
    }
    const clean = cleanCommand(command.trimEnd());
    if (clean) out.push({ command: clean, start: { row: r, col: c }, end: { row: end.row, col: Math.max(end.col, c) } });
  }
  return out;
}

// the cell that holds the character at this offset of the row's joined text
function cellOf(row: CellRow, offset: number): number {
  let seen = 0;
  for (let c = 0; c < row.chars.length; c++) { if (seen === offset) return c; seen += row.chars[c].length; }
  return -1;
}
// the last cell with text before cell c, or -1 when the "!" is the first text on its row
function previousText(row: CellRow, c: number): number {
  for (let i = c - 1; i >= 0; i--) if (row.chars[i].trim()) return i;
  return -1;
}

// The command in one line of Markdown text (a code block line, a paragraph line, a list item line).
export function lineCommand(line: string): string | null {
  const lead = LINE_START.exec(line);
  return lead ? cleanCommand(line.slice(lead[1].length)) : null;
}
// The command for a pointer at `offset` in the text of a Markdown element; `inline` is true for inline <code>.
export function markdownCommand(content: string, offset: number, inline: boolean): string | null {
  if (inline) return content.trimStart().startsWith('!') ? cleanCommand(content) : null;
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const stop = content.indexOf('\n', offset);
  const line = content.slice(start, stop < 0 ? content.length : stop);
  const lead = LINE_START.exec(line);
  // the pointer must be on the command, not on the list mark before it
  if (!lead || offset - start < lead[1].length || offset - start >= line.trimEnd().length) return null;
  return lineCommand(line);
}

// The hold: the button stays down and the pointer stays within MOVE_LIMIT pixels for HOLD_MS. Any move past the
// limit, a release, Escape or the Cancel button stops it. Only the end of a whole hold calls done().
export type HoldState = 'holding' | 'cancelled' | 'done';
export interface HoldClock { now: () => number; every: (fn: () => void, ms: number) => () => void }
export const realClock: HoldClock = {
  now: () => Date.now(),
  every: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
};
export function holdTimer(x: number, y: number, on: { tick: (elapsed: number) => void; done: () => void; cancel: (why: string) => void }, clock: HoldClock = realClock) {
  const started = clock.now();
  let state: HoldState = 'holding';
  const finish = (next: HoldState) => { if (state !== 'holding') return false; state = next; stop(); return true; };
  const stop = clock.every(() => {
    const elapsed = clock.now() - started;
    if (elapsed >= HOLD_MS) { if (finish('done')) on.done(); }
    else on.tick(elapsed);
  }, 50);
  return {
    get state() { return state; },
    move(px: number, py: number) { if (Math.hypot(px - x, py - y) > MOVE_LIMIT && finish('cancelled')) on.cancel('moved'); },
    cancel(why: string) { if (finish('cancelled')) on.cancel(why); },
  };
}
