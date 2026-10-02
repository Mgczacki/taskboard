import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clickThroughHeld } from '../web/src/controllerView.ts';

// The CSS rules that decide which element gets a click next to and inside the task panel (the drawer). The browser
// check of the same points with document.elementFromPoint is in the report of task 189; this repo has no browser runner.
const css = readFileSync('web/src/app.css', 'utf8') + readFileSync('web/src/mockup.css', 'utf8');
const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] || '';

test('the resize handle stays inside the drawn box of the drawer', () => {
  const r = rule('.drawer-resize');
  assert.match(r, /position: absolute; left: 0;/, 'a negative left would cover the page next to the drawer');
  const w = Number(r.match(/width: (\d+)px/)?.[1]);
  assert.ok(w > 0 && w <= 6, `handle width ${w}px`);
  assert.match(css, /\.drawer-resize:hover, \.drawer-resize\.on \{ background: var\(--accent\)/, 'the handle shows on hover');
});

test('the drawer has no layer wider than its box that takes the pointer', () => {
  const d = rule('.drawer');
  assert.match(d, /position: fixed; top: 0; right: 0; bottom: 0;/);
  assert.doesNotMatch(d, /left: 0|inset: 0|width: 100v/);
  // the drop outline is drawn inside the box
  assert.match(rule('.drawer.dropping'), /outline-offset: -6px/);
});

test('Alt held alone turns on the click-through; shortcuts with Ctrl or Cmd do not', () => {
  const k = (altKey: boolean, ctrlKey = false, metaKey = false) => clickThroughHeld({ altKey, ctrlKey, metaKey });
  assert.equal(k(true), true);
  assert.equal(k(false), false, 'keyup of Alt has altKey false');
  assert.equal(k(true, true), false, 'Ctrl+Alt shortcuts (keys.ts)');
  assert.equal(k(true, false, true), false);
});

test('with the click-through on, only the terminal lets the pointer through; the bar and the handle keep it', () => {
  assert.match(rule('.drawer.glass.through'), /pointer-events: none/);
  assert.match(css, /\.drawer\.glass\.through \.dr-head, \.drawer\.glass\.through \.drawer-resize \{ pointer-events: auto; \}/);
  const panel = readFileSync('web/src/components/TaskPanel.tsx', 'utf8');
  // only with the see-through terminal, and the class goes away when the step goes back to Off
  assert.match(panel, /\$\{see && through \? 'through' : ''\}/);
  assert.match(panel, /if \(!see\) \{ setThrough\(false\); return; \}/);
  // window listeners only read the key: no preventDefault, so the terminal keeps its keys and focus (task 162)
  const effect = panel.slice(panel.indexOf('const [through, setThrough]'), panel.indexOf('}, [!!see]);'));
  assert.doesNotMatch(effect, /preventDefault|stopPropagation|focus\(/);
  assert.match(effect, /addEventListener\('blur', off\)/, 'Alt released in another window does not stay on');
  assert.match(panel, /className="dr-bar-hint"[^>]*>hold ⌥ to click behind</);
});

// A mousedown on a Canvas window sets it as focused, and the toolbar label adds "typing into #N". With the width of
// its text, the label wrapped the toolbar to a second line between mousedown and mouseup. The windows moved down,
// mouseup landed on the toolbar, and the click on the window's button was lost.
test('the Canvas toolbar label can not wrap the toolbar', () => {
  assert.match(rule('.canvas .ctool .ctool-count'), /flex: 1 1 0; min-width: 0; overflow: hidden;/);
  const canvas = readFileSync('web/src/components/Canvas.tsx', 'utf8');
  assert.match(canvas, /<span className="lbl ctool-count">\{per && pageCount > 1 \? '' : `\$\{wins\.length\} windows`\}\{focusedTask \?/);
});
