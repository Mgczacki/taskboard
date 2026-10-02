// The last screen of each terminal, kept in the page. A terminal that mounts again (a Canvas page, a group tab, the
// task panel, a reload) draws it at once, before its socket is open. The live screen from tmux replaces it when the
// first output arrives: tmux switches to the alternate screen and draws everything again (Terminal.tsx).
// The screens stay in this page's memory, and in sessionStorage over a reload of the same browser tab.

// One row as runs of cells with the same attributes. a: SGR parameters, t: the characters, w: cell width of each.
export interface Run { a: string; t: string; w: 1 | 2 }
export interface Snapshot { cols: number; rows: number; lines: Run[][]; cursor: [number, number]; at: number }

// The parts of the xterm.js buffer API that serialize() reads
interface Cell {
  getChars(): string; getWidth(): number;
  isBold(): number; isDim(): number; isItalic(): number; isUnderline(): number; isBlink(): number; isInverse(): number; isInvisible(): number; isStrikethrough(): number;
  isFgRGB(): boolean; isFgPalette(): boolean; getFgColor(): number;
  isBgRGB(): boolean; isBgPalette(): boolean; getBgColor(): number;
}
interface Line { getCell(x: number): Cell | undefined }
export interface ScreenSource { cols: number; rows: number; buffer: { active: { baseY: number; cursorX: number; cursorY: number; getLine(y: number): Line | undefined } } }

const color = (rgb: boolean, palette: boolean, value: number, base: number) =>
  rgb ? `${base + 8};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
  : palette ? (value < 8 ? `${base + value}` : value < 16 ? `${base + 60 + value - 8}` : `${base + 8};5;${value}`)
  : '';
function attributes(c: Cell) {
  const a: string[] = [];
  if (c.isBold()) a.push('1');
  if (c.isDim()) a.push('2');
  if (c.isItalic()) a.push('3');
  if (c.isUnderline()) a.push('4');
  if (c.isBlink()) a.push('5');
  if (c.isInverse()) a.push('7');
  if (c.isInvisible()) a.push('8');
  if (c.isStrikethrough()) a.push('9');
  const fg = color(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30), bg = color(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40);
  if (fg) a.push(fg);
  if (bg) a.push(bg);
  return a.join(';');
}

// The visible screen: the last `rows` rows of the active buffer (tmux draws there), not the place you scrolled to.
export function serialize(term: ScreenSource): Snapshot {
  const b = term.buffer.active, lines: Run[][] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.baseY + y), runs: Run[] = [];
    let pos = 0, used = 0; // cells so far, and up to the last cell that is not a blank without attributes
    for (let x = 0; line && x < term.cols; x++) {
      const c = line.getCell(x);
      if (!c) break;
      const w = c.getWidth();
      if (w === 0) continue; // the second half of a wide character
      const a = attributes(c), t = c.getChars() || ' ', cw = w === 2 ? 2 : 1;
      const last = runs[runs.length - 1];
      if (last && last.a === a && last.w === cw) last.t += t; else runs.push({ a, t, w: cw });
      pos += cw;
      if (t !== ' ' || a) used = pos;
    }
    lines.push(trim(runs, used));
  }
  return { cols: term.cols, rows: term.rows, lines, cursor: [b.cursorX, b.cursorY], at: Date.now() };
}
// the runs cut to `cells` cells
function trim(runs: Run[], cells: number): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (cells <= 0) break;
    const chars = [...r.t], n = Math.min(chars.length, Math.floor(cells / r.w));
    if (n > 0) out.push({ ...r, t: chars.slice(0, n).join('') });
    cells -= chars.length * r.w;
  }
  return out;
}

// The text that draws a snapshot into an empty terminal of cols x rows. It keeps the bottom rows when the terminal is
// shorter (agents draw their prompt at the bottom), cuts rows that are too wide, and moves the cursor back.
// Line wrap is off while it draws, so nothing scrolls into the history.
export function drawText(s: Snapshot, cols: number, rows: number): string {
  const skip = Math.max(0, s.lines.length - rows);
  let out = '\x1b[?7l';
  s.lines.slice(skip).forEach((runs, i) => {
    if (!runs.length) return;
    out += `\x1b[${i + 1};1H`;
    for (const r of trim(runs, cols)) out += `\x1b[0${r.a ? ';' + r.a : ''}m${r.t}`;
  });
  const cy = s.cursor[1] - skip;
  out += '\x1b[0m\x1b[?7h' + (cy >= 0 && cy < rows ? `\x1b[${cy + 1};${Math.min(s.cursor[0], cols - 1) + 1}H` : '');
  return out;
}

// The screen of the tmux pane from the server (GET /api/tasks/:id/screen): rows with their SGR sequences, as
// `tmux capture-pane -e` prints them. Drawn like a saved screen: bottom rows kept, line wrap off, cursor put back.
export interface PaneScreen { lines: string[]; cursor: [number, number]; cols: number; rows: number }
export function paneText(p: PaneScreen, rows: number): string {
  const skip = Math.max(0, p.lines.length - rows);
  let out = '\x1b[?7l';
  p.lines.slice(skip).forEach((line, i) => { if (line) out += `\x1b[${i + 1};1H\x1b[0m${line}`; });
  const cy = p.cursor[1] - skip;
  return out + '\x1b[0m\x1b[?7h' + (cy >= 0 && cy < rows ? `\x1b[${cy + 1};${p.cursor[0] + 1}H` : '');
}

// ---------- the store: the most recent screens, by terminal id (a task id, or a session for the account terminals) ----------
const MAX = 40;
const KEY = 'tb-terminal-screens';
const screens = new Map<string, Snapshot>();
try {
  const saved = JSON.parse(sessionStorage.getItem(KEY) || '[]') as [string, Snapshot][];
  for (const [id, s] of saved) if (s && Array.isArray(s.lines)) screens.set(id, s);
  sessionStorage.removeItem(KEY);
} catch { /* no storage, or an old format */ }

export const savedScreen = (id: string) => screens.get(id);
export function saveScreen(id: string, s: Snapshot) {
  screens.delete(id);
  screens.set(id, s);
  while (screens.size > MAX) screens.delete(screens.keys().next().value!);
}
// the mounted terminals give their screen when the page unloads, so a reload can draw them at once
const live = new Map<string, () => Snapshot>();
export function liveScreen(id: string, read: () => Snapshot) {
  live.set(id, read);
  return () => { if (live.get(id) === read) live.delete(id); };
}
if (typeof addEventListener === 'function') addEventListener('pagehide', () => {
  for (const [id, read] of live) { try { saveScreen(id, read()); } catch { /* disposed */ } }
  // newest first, at most about 2 million characters (sessionStorage holds about 5 million for each site)
  const keep: [string, Snapshot][] = [];
  let size = 0;
  for (const entry of [...screens].reverse()) { size += JSON.stringify(entry).length; if (size > 2_000_000) break; keep.unshift(entry); }
  try { sessionStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* full or blocked */ }
});
