import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sizeSender, type Timers } from '../web/src/terminalSize.ts';

// timers that run only when the test moves the clock
function clock() {
  let now = 0, next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = { set: (fn, ms) => { const id = next++; due.set(id, { at: now + ms, fn }); return id; }, clear: id => { due.delete(id as number); } };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, d] of [...due].sort((a, b) => a[1].at - b[1].at)) if (d.at <= now && due.has(id)) { due.delete(id); d.fn(); }
  };
  return { timers, advance };
}

function setup(open = true) {
  const sent: string[] = [], c = clock();
  const state = { open };
  const s = sizeSender((cols, rows) => { if (!state.open) return false; sent.push(`${cols}x${rows}`); return true; }, 100, c.timers);
  return { s, sent, advance: c.advance, state };
}

test('a size that changes and comes back within the delay sends nothing', () => {
  const { s, sent, advance } = setup();
  s.known(88, 17);
  s.changed(88, 16); advance(40);
  s.changed(88, 17); advance(200);
  assert.deepEqual(sent, []);
});

test('rows that alternate slower than the delay send each new size once', () => {
  const { s, sent, advance } = setup();
  s.known(88, 17);
  for (const rows of [16, 17, 16, 17]) { s.changed(88, rows); advance(150); }
  assert.deepEqual(sent, ['88x16', '88x17', '88x16', '88x17']);
});

test('a drag sends only the last size, and the same size twice sends once', () => {
  const { s, sent, advance } = setup();
  s.known(80, 24);
  for (let cols = 81; cols <= 90; cols++) { s.changed(cols, 24); advance(16); }
  advance(100);
  s.changed(90, 24); advance(150);
  assert.deepEqual(sent, ['90x24']);
});

test('a size from while the socket was closed is sent by flush when it opens', () => {
  const { s, sent, advance, state } = setup(false);
  s.known(88, 17);
  s.changed(88, 20); advance(150);
  assert.deepEqual(sent, []);
  state.open = true;
  assert.equal(s.flush(88, 20), true);
  assert.equal(s.flush(88, 20), false);
  assert.deepEqual(sent, ['88x20']);
});

test('the fit addon reads the padding of .xterm, so the terminal box has none', () => {
  const css = readFileSync(new URL('../web/src/app.css', import.meta.url), 'utf8');
  const box = css.match(/^\.xterm-box \{[^}]*\}/m)?.[0] || '';
  assert.ok(box && !/padding/.test(box), box);
  assert.match(css, /^\.xterm-box \.xterm \{[^}]*padding:/m);
});

test('the blocks above a terminal keep a fixed number of lines', () => {
  const css = readFileSync(new URL('../web/src/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.three\.fixed \.now span \{ min-height: 2\.9em; \}/);
  assert.match(css, /\.three\.fixed \.w span \{ -webkit-line-clamp: 1; \}/);
  const panel = readFileSync(new URL('../web/src/components/TaskPanel.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<ThreeLines t=\{t\} fixed \/>/);
  assert.match(app, /<ThreeLines t=\{t\} fixed \/>/);
});
