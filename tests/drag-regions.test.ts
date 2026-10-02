// The window drag area of the app (web/src/dragRegions.ts, the rules in web/src/app.css). Task #196: the controls of
// the controller bar lay inside the drag area of the page header (.top) under the drawer, so a click moved the window.
// The browser check (scripts/check-drag-regions.mjs) runs here when TASKBOARD_TEST_URL names a test Taskboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dragBoxAt, type DragBox } from '../web/src/dragRegions.ts';

const box = (drag: boolean, left: number, top: number, right: number, bottom: number, what = ''): DragBox => ({ drag, left, top, right, bottom, what });

test('the drag area follows document order: a later no-drag box cuts out, a later drag box adds again', () => {
  const top = box(true, 0, 0, 1000, 50, 'header.top'), button = box(false, 900, 10, 940, 40, 'button'), drawer = box(false, 600, 0, 1000, 900, 'aside.drawer'), spacer = box(true, 700, 0, 800, 30, 'span.tabs-sp');
  assert.equal(dragBoxAt([top], 650, 15)?.what, 'header.top');
  assert.equal(dragBoxAt([top, button], 910, 20), null);
  // the case of task #196: the drawer is drawn over .top but has no app-region, so .top decides
  assert.equal(dragBoxAt([top, button], 650, 15)?.what, 'header.top');
  // the fix: the drawer is no-drag and comes after .top; only its spacer is drag again
  assert.equal(dragBoxAt([top, button, drawer], 650, 15), null);
  assert.equal(dragBoxAt([top, button, drawer, spacer], 750, 15)?.what, 'span.tabs-sp');
  assert.equal(dragBoxAt([top, button, drawer, spacer], 850, 15), null);
  // an earlier no-drag box does not cut out a later drag box: z-index does not count
  assert.equal(dragBoxAt([button, top], 910, 20)?.what, 'header.top');
  // the right and bottom edges are outside the box
  assert.equal(dragBoxAt([top], 1000, 10), null);
  assert.equal(dragBoxAt([top], 10, 50), null);
});

test('the app rules: the strip lets the pointer through, every control and the drawer are no-drag, the bar spacer is drag', () => {
  const css = readFileSync('web/src/app.css', 'utf8');
  const strip = css.match(/body\.in-app::before \{[^}]*\}/)?.[0] || '';
  assert.match(strip, /-webkit-app-region: drag/);
  assert.match(strip, /pointer-events: none/);
  const noDrag = css.match(/body\.in-app :is\((.*)\),\nbody\.in-app \.drawer \{ -webkit-app-region: no-drag; \}/);
  assert.ok(noDrag, 'one rule makes the controls and the drawer no-drag');
  for (const c of ['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', '[role="button"]', '[role="tab"]']) assert.ok(noDrag[1].split(/,\s*/).includes(c), `${c} is no-drag`);
  assert.match(css, /body\.in-app \.drawer \.dr-bar \.tabs-sp \{ -webkit-app-region: drag; \}/);
  // the spacer fills the free space of the bar, so it is a visible empty place to move the window from
  assert.match(css, /\.dr-bar \.tabs-sp \{ flex: 1 1 24px; min-width: 24px; align-self: stretch; \}/);
  // only .top, .brand, the strip and the bar spacer are drag areas
  const drags = [...css.matchAll(/([^{}]+)\{[^}]*-webkit-app-region: drag/g)].map(m => m[1].trim().split('\n').pop()!.trim());
  assert.deepEqual(drags, ['body.in-app::before', 'body.in-app .top, body.in-app .brand', 'body.in-app .drawer .dr-bar .tabs-sp']);
  for (const f of ['web/src/mockup.css', 'web/src/review.css', 'web/src/mail.css', 'web/src/links.css', 'web/src/graph.css']) assert.doesNotMatch(readFileSync(f, 'utf8'), /app-region:\s*drag/, f);
});

test('the window buttons at the top left can not overlap the drawer', () => {
  const main = readFileSync('desktop/main.cjs', 'utf8'), panel = readFileSync('web/src/components/TaskPanel.tsx', 'utf8');
  const x = Number(main.match(/trafficLightPosition: \{ x: (\d+)/)?.[1]);
  const edge = Number(panel.match(/MIN_W = \d+, EDGE = (\d+)/)?.[1]);
  // three buttons of about 14 px with 6 px between them, from x: the drawer starts at least EDGE px from the left
  assert.ok(x + 3 * 14 + 2 * 6 < edge, `buttons end at ${x + 54} px, the drawer starts at ${edge} px or more`);
  assert.match(panel, /calc\(100vw - \$\{EDGE\}px\)/);
});

test('the browser check: no control within 40 px of the top is in the drag area', { skip: !process.env.TASKBOARD_TEST_URL && 'set TASKBOARD_TEST_URL to a test Taskboard (pnpm sandbox) to run it' }, () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/check-drag-regions.mjs', process.env.TASKBOARD_TEST_URL!], { encoding: 'utf8', timeout: 300_000 });
  assert.match(out, /All \d+ states pass\./);
});
