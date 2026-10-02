#!/usr/bin/env node
// A terminal program that prints a lot of colored output and redraws its screen on each resize, like an agent with a
// long session. scripts/terminal-timing.mjs starts tasks with it to measure how fast terminals show in the page.
// - CHATTY_LINES lines of history at start (default 4000), then one new line every CHATTY_EVERY ms (default 2000, 0: none).
// - An input box at the bottom, drawn again below each new line.
// - On SIGWINCH it clears the screen and draws the last screenful again, as Claude Code does after a resize.
//   TASK_DIR/redraws.txt gets one line for each redraw, so a test can count them.
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.TASK_DIR || process.cwd();
// Taskboard asks `claude auth status` before it starts a task
if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: true, email: 'fake@example.invalid' })); return; }
const LINES = Number(process.env.CHATTY_LINES ?? 4000), EVERY = Number(process.env.CHATTY_EVERY ?? 2000);
const out = process.stdout;
const history = [];
const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
const words = 'tool call read file edit server pty tmux xterm socket render replay attach resize screen buffer output'.split(' ');
let n = 0;
const line = () => {
  n++;
  const c = colors[n % colors.length];
  const text = Array.from({ length: 14 }, (_, i) => words[(n * 7 + i * 3) % words.length]).join(' ');
  return `\x1b[${c}m●\x1b[0m \x1b[1mstep ${String(n).padStart(5)}\x1b[0m ${text} \x1b[2m(${n % 97} ms)\x1b[0m`;
};
const box = () => {
  const w = Math.min(out.columns || 80, 200);
  return `\x1b[2m${'─'.repeat(w)}\x1b[0m\r\n❯ \r\n\x1b[2m${'─'.repeat(w)}\x1b[0m\r\n  ? for shortcuts`;
};
const BOX_ROWS = 4;
const eraseBox = () => out.write(`\r\x1b[${BOX_ROWS - 1}A\x1b[J`);
function print(l) { history.push(l); if (history.length > 2000) history.shift(); }
function redraw() {
  const rows = (out.rows || 24) - BOX_ROWS;
  out.write('\x1b[2J\x1b[3J\x1b[H' + history.slice(-rows).join('\r\n') + '\r\n' + box());
  try { fs.appendFileSync(path.join(dir, 'redraws.txt'), `${Date.now()} ${out.columns}x${out.rows}\n`); } catch { /* no folder */ }
}

// the start: a long history, written in chunks as an agent does
let chunk = '';
for (let i = 0; i < LINES; i++) { const l = line(); print(l); chunk += l + '\r\n'; if (chunk.length > 32768) { out.write(chunk); chunk = ''; } }
out.write(chunk + box());
process.on('SIGWINCH', redraw);
if (EVERY > 0) setInterval(() => { const l = line(); print(l); eraseBox(); out.write(l + '\r\n' + box()); }, EVERY);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', d => { if (d.includes(3)) process.exit(0); });
