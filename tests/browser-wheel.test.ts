// The wheel of the task browser view (web/src/browserWheel.ts): deltas in lines and pages become pixels, Shift turns a
// vertical wheel sideways, and the events of one animation frame go out as one message with their sum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINE_PX, wheelBatch, wheelPixels, type WheelMessage } from '../web/src/browserWheel.ts';

const page = { w: 1000, h: 700 };
const ev = (deltaY: number, more: Partial<{ deltaX: number; deltaMode: number; shiftKey: boolean }> = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ...more });

test('pixels stay as they are, fractions and sign included', () => {
  assert.deepEqual(wheelPixels(ev(2.5, { deltaX: -0.75 }), page), { dx: -0.75, dy: 2.5, sideways: false });
  assert.deepEqual(wheelPixels(ev(-120), page), { dx: 0, dy: -120, sideways: false });
});

test('lines are 40 px and pages are the size of the page', () => {
  assert.deepEqual(wheelPixels(ev(3, { deltaMode: 1 }), page), { dx: 0, dy: 3 * LINE_PX, sideways: false });
  assert.deepEqual(wheelPixels(ev(-1, { deltaMode: 1, deltaX: 2 }), page), { dx: 80, dy: -40, sideways: false });
  assert.deepEqual(wheelPixels(ev(1, { deltaMode: 2 }), page), { dx: 0, dy: 700, sideways: false });
  assert.deepEqual(wheelPixels(ev(0, { deltaMode: 2, deltaX: -1 }), page), { dx: -1000, dy: 0, sideways: false });
});

test('Shift turns a vertical wheel sideways; a wheel that is already sideways stays', () => {
  assert.deepEqual(wheelPixels(ev(100, { shiftKey: true }), page), { dx: 100, dy: 0, sideways: true });
  assert.deepEqual(wheelPixels(ev(2, { shiftKey: true, deltaMode: 1 }), page), { dx: 80, dy: 0, sideways: true });
  // macOS turns Shift + mouse wheel into deltaX itself
  assert.deepEqual(wheelPixels(ev(0, { shiftKey: true, deltaX: 100 }), page), { dx: 100, dy: 0, sideways: false });
});

test('a delta that is not a number counts as 0', () => {
  assert.deepEqual(wheelPixels(ev(NaN, { deltaX: Infinity }), page), { dx: 0, dy: 0, sideways: false });
});

// a frame clock for the tests: run() is the next animation frame
function clock() {
  let next = 1; const waiting = new Map<number, () => void>();
  return {
    schedule: (f: () => void) => { const h = next++; waiting.set(h, f); return h; },
    cancel: (h: number) => { waiting.delete(h); },
    run: () => { const fs = [...waiting.values()]; waiting.clear(); fs.forEach(f => f()); },
    get pending() { return waiting.size; },
  };
}

test('the events of one frame go out as one message with the sum and the newest point', () => {
  const c = clock(), sent: WheelMessage[] = [];
  const b = wheelBatch(m => sent.push(m), c.schedule, c.cancel);
  for (let i = 0; i < 8; i++) b.add(ev(1.5, { deltaX: -0.5 }), { x: 100 + i, y: 200 }, 0, page);
  assert.equal(sent.length, 0);
  assert.equal(c.pending, 1);
  c.run();
  assert.deepEqual(sent, [{ type: 'mouse', event: 'mouseWheel', x: 107, y: 200, dx: -4, dy: 12, modifiers: 0 }]);
  // the next frame starts a new sum
  b.add(ev(-3, { deltaMode: 1 }), { x: 5, y: 6 }, 0, page);
  c.run();
  assert.deepEqual(sent[1], { type: 'mouse', event: 'mouseWheel', x: 5, y: 6, dx: 0, dy: -120, modifiers: 0 });
  c.run();
  assert.equal(sent.length, 2);
});

test('other modifiers send the sum so far first; Shift sideways leaves the Shift bit out', () => {
  const c = clock(), sent: WheelMessage[] = [];
  const b = wheelBatch(m => sent.push(m), c.schedule, c.cancel);
  b.add(ev(10), { x: 1, y: 1 }, 0, page);
  b.add(ev(-4), { x: 1, y: 1 }, 2, page); // Ctrl: a pinch on a trackpad
  assert.deepEqual(sent.map(m => [m.dy, m.modifiers]), [[10, 0]]);
  b.add(ev(30, { shiftKey: true }), { x: 1, y: 1 }, 8 | 1, page);
  c.run();
  assert.deepEqual(sent.map(m => [m.dx, m.dy, m.modifiers]), [[0, 10, 0], [0, -4, 2], [30, 0, 1]]);
});

test('flush sends at once, a sum of 0 sends nothing, stop drops the waiting sum', () => {
  const c = clock(), sent: WheelMessage[] = [];
  const b = wheelBatch(m => sent.push(m), c.schedule, c.cancel);
  b.add(ev(5), { x: 1, y: 1 }, 0, page);
  b.flush();
  assert.equal(sent.length, 1);
  assert.equal(c.pending, 0);
  b.add(ev(5), { x: 1, y: 1 }, 0, page); b.add(ev(-5), { x: 1, y: 1 }, 0, page);
  c.run();
  assert.equal(sent.length, 1);
  b.add(ev(5), { x: 1, y: 1 }, 0, page);
  b.stop(); c.run();
  assert.equal(sent.length, 1);
});

// The listener must follow the element: a callback ref attaches it to each bw-screen that React creates. The old
// effect ran only when `running` changed. Canvas leaves a wheel over a browser view to that view.
test('the view attaches the wheel listener with a callback ref, and Canvas leaves the wheel to a browser view', () => {
  const view = readFileSync(new URL('../web/src/components/TaskBrowser.tsx', import.meta.url), 'utf8');
  assert.match(view, /ref=\{screenRef\}/);
  assert.match(view, /el\?\.addEventListener\('wheel', wheelListener, \{ passive: false \}\)/);
  assert.doesNotMatch(view, /addEventListener\('wheel'[^\n]*\n[^\n]*\n\s*\}, \[running\]\)/);
  const canvas = readFileSync(new URL('../web/src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.match(canvas, /onWheel\.current = e => \{\n\s*if \(inBrowser\(e\)\) return;/);
});
