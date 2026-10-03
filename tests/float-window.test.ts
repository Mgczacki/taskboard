// The floating windows inside the page (web/src/floatWindow.ts): clampFloat keeps at least KEEP px of the title bar
// on the screen, so a window moved far to a side or down can always be moved back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEEP, clampFloat } from '../web/src/floatWindow.ts';

const vw = 1600, vh = 1000, w = 980, bar = 40;

test('a position inside the viewport stays as it is', () => {
  assert.deepEqual(clampFloat(300, 200, w, bar, vw, vh), { left: 300, top: 200 });
  assert.deepEqual(clampFloat(0, 0, w, bar, vw, vh), { left: 0, top: 0 });
});

test('left and right: at least KEEP px of the title bar stay on the screen', () => {
  assert.equal(KEEP, 80);
  assert.equal(clampFloat(-5000, 100, w, bar, vw, vh).left, KEEP - w);
  assert.equal(clampFloat(5000, 100, w, bar, vw, vh).left, vw - KEEP);
  // the window may go partly off the screen while KEEP px stay
  assert.equal(clampFloat(-800, 100, w, bar, vw, vh).left, -800);
  assert.equal(clampFloat(1500, 100, w, bar, vw, vh).left, 1500);
});

test('the buttons at the right end of the title bar do not count: KEEP px of the bar besides them stay', () => {
  // two 28 px buttons with gaps and padding: 72 px
  assert.equal(clampFloat(-5000, 100, w, bar, vw, vh, 72).left, KEEP + 72 - w);
  // off the right edge the left end of the bar (the title) shows, so the buttons change nothing
  assert.equal(clampFloat(5000, 100, w, bar, vw, vh, 72).left, vw - KEEP);
  // a window narrower than KEEP + buttons stays fully inside on the left
  assert.equal(clampFloat(-100, 100, 120, bar, vw, vh, 72).left, 0);
});

test('top and bottom: the title bar stays fully on the screen', () => {
  assert.equal(clampFloat(100, -300, w, bar, vw, vh).top, 0);
  assert.equal(clampFloat(100, 5000, w, bar, vw, vh).top, vh - bar);
  assert.equal(clampFloat(100, vh - bar, w, bar, vw, vh).top, vh - bar);
});

test('small windows and small viewports', () => {
  // a window narrower than KEEP stays fully inside
  assert.deepEqual(clampFloat(-100, 0, 50, bar, vw, vh), { left: 0, top: 0 });
  assert.deepEqual(clampFloat(-100, 0, KEEP, bar, vw, vh), { left: 0, top: 0 });
  assert.deepEqual(clampFloat(5000, 0, 50, bar, vw, vh), { left: vw - 50, top: 0 });
  // a viewport lower than the title bar: the title bar starts at the top edge
  assert.equal(clampFloat(100, 300, w, bar, vw, 20).top, 0);
  // a viewport narrower than KEEP: the title bar covers the whole width
  assert.equal(clampFloat(500, 0, w, bar, 60, vh).left, 60 - KEEP);
  assert.equal(clampFloat(-5000, 0, w, bar, 60, vh).left, KEEP - w);
  // fractions become whole pixels
  assert.deepEqual(clampFloat(10.6, 20.4, w, bar, vw, vh), { left: 11, top: 20 });
});

test('both floating windows use the shared title bar code', () => {
  for (const f of ['web/src/components/TaskBrowser.tsx', 'web/src/components/Docs.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /onPointerDown=\{e => startFloatDrag\(e, host\)\}/, f);
    assert.match(src, /addEventListener\('resize', fit\)/, f);
    assert.doesNotMatch(src, /Math\.max\(0, t \+ ev\.clientY - sy\)/, `${f} has its own drag code`);
  }
  const css = readFileSync('web/src/app.css', 'utf8');
  assert.match(css, /\.fw-h \{[^}]*touch-action: none;/);
  assert.match(css, /\.floatwin\.moving \{ user-select: none; \}/);
  assert.match(css, /\.floatwin\.moving iframe, \.floatwin\.moving \.fw-b \{ pointer-events: none; \}/);
});
