// The Canvas toolbar never lies under the window grid (task 208). Two causes were observed:
// - the Swiss theme gave the toolbar height: 46px, so a second row of buttons was drawn under the window grid;
// - in focus mode the toolbar went away when the pointer was more than 110 px from the top, so the lower rows of a
//   toolbar that wrapped went away while the pointer moved to them.
// The toolbar now keeps one row: items that do not fit move into its More menu (web/src/toolbarFit.ts).
// The browser check (scripts/check-toolbar-cover.mjs) runs here when TASKBOARD_TEST_URL names a test Taskboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fitToolbar, sameFit, type FitItem } from '../web/src/toolbarFit.ts';

const items: FitItem[] = [
  { k: 'new', keep: 0, w: 120 }, { k: 'window', keep: 1, w: 110 }, { k: 'add', keep: 7, w: 108 }, { k: 'layout', keep: 0, w: 170 },
  { k: 'perpage', keep: 6, w: 238 }, { k: 'runtime', keep: 4, w: 150 }, { k: 'focus', keep: 2, w: 130 },
];
const total = items.reduce((s, i) => s + i.w, 0) + 8 * items.length; // the items, the count text and the gaps

test('everything fits: nothing moves', () => {
  assert.deepEqual(fitToolbar(items, total, 8, 70), { overflow: [], tight: false });
  assert.deepEqual(fitToolbar(items, total + 300, 8, 70), { overflow: [], tight: false });
});

test('the lowest keep moves first, and the menu lists its items in toolbar order', () => {
  // one px short: New window (keep 1) moves; its 110 px and gap make room for the More button (70 px and a gap)
  assert.deepEqual(fitToolbar(items, total - 1, 8, 70).overflow, ['window']);
  // with a wider More button Focus mode (keep 2) moves as well
  assert.deepEqual(fitToolbar(items, total - 1, 8, 120).overflow, ['window', 'focus']);
  const narrow = fitToolbar(items, 700, 8, 70);
  assert.equal(narrow.tight, false);
  assert.deepEqual(narrow.overflow, ['window', 'perpage', 'runtime', 'focus']);
  // the items that stay fit with the More button
  const stay = items.filter(i => !narrow.overflow.includes(i.k));
  assert.ok(stay.reduce((s, i) => s + i.w, 0) + 70 + 8 * (stay.length + 1) <= 700);
});

test('items with keep 0 never move; when they do not fit with the More button the toolbar is tight', () => {
  const fit = fitToolbar(items, 330, 8, 70);
  assert.equal(fit.tight, true);
  assert.deepEqual(fit.overflow, ['window', 'add', 'perpage', 'runtime', 'focus']);
  for (const w of [200, 330, 500, 700, 900, 1200]) for (const k of ['new', 'layout']) assert.ok(!fitToolbar(items, w, 8, 70).overflow.includes(k), `${k} at ${w}`);
});

test('the same input gives the same answer, so the toolbar does not go back and forth', () => {
  for (let w = 250; w < 1200; w += 7) assert.ok(sameFit(fitToolbar(items, w, 8, 70), fitToolbar(items, w, 8, 70)));
  // a wider toolbar never has more items in the menu
  let last = Infinity;
  for (let w = 250; w < 1200; w += 7) { const n = fitToolbar(items, w, 8, 70).overflow.length; assert.ok(n <= last, `${w}px`); last = n; }
});

const css = readFileSync('web/src/app.css', 'utf8');
const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] || '';

test('the toolbar is a flex: none row with its own height, and the window grid is the flex: 1 child', () => {
  const tool = rule('.canvas .ctool');
  assert.match(tool, /flex: none;/);
  assert.doesNotMatch(tool, /(^|[ ;])height:/, 'no fixed height');
  assert.match(rule('.stage-grid'), /flex: 1; min-height: 0;/);
  assert.match(rule('.canvas'), /display: flex; flex-direction: column;/);
  assert.match(rule('.canvas .gtabs-wrap'), /flex: none;/);
});

test('no theme gives a bar of the Canvas page a fixed height', () => {
  for (const f of readdirSync('web/public/themes').filter(f => f.endsWith('.css'))) {
    const src = readFileSync(`web/public/themes/${f}`, 'utf8');
    for (const m of src.matchAll(/&\s*\.(ctool|gtabs-wrap|canvas)\s*\{([^}]*)\}/g)) assert.doesNotMatch(m[2], /(^|[ ;])(max-)?height:/, `${f}: .${m[1]}`);
  }
});

test('focus mode hides the bars below the measured toolbar, not below a fixed line', () => {
  const canvas = readFileSync('web/src/components/Canvas.tsx', 'utf8');
  assert.doesNotMatch(canvas, /clientY > 110/);
  assert.match(canvas, /const bottom = toolRef\.current\?\.getBoundingClientRect\(\)\.bottom/);
  assert.match(canvas, /if \(menu \|\| moreOpen\) return;/, 'an open menu keeps the bars');
});

test('the browser check: no toolbar control is covered at 1440 to 600 px, and the More menu holds the moved items', { skip: !process.env.TASKBOARD_TEST_URL && 'set TASKBOARD_TEST_URL to a test Taskboard (pnpm sandbox) to run it' }, () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/check-toolbar-cover.mjs', process.env.TASKBOARD_TEST_URL!, '--themes', 'default,swiss'], { encoding: 'utf8', timeout: 1_200_000 });
  assert.match(out, /All \d+ states pass\./);
});
