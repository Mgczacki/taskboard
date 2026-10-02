// Keyboard shortcuts (web/src/keys.ts): no default key runs from a key without ⌘, ⌃ or ⌥, a key the user adds by hand
// still works, and no Taskboard key runs while the focus is in the task browser except the key that leaves it.
// Also the saved browser choice of a Canvas window (web/src/browserSplit.ts), and the page handlers that read e.key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// keys.ts reads localStorage and listens for 'storage' when it loads
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
  addEventListener: () => {},
});
const keys = await import('../web/src/keys.ts');
const { parseSplit, readSplit, writeSplit, NO_SPLIT } = await import('../web/src/browserSplit.ts');

type Where = 'page' | 'field' | 'terminal' | 'browser' | 'browserField';
// a stand-in for e.target: closest() finds the selectors that the place has
const target = (where: Where) => ({
  closest: (sel: string) => {
    const has = (s: string) => sel.split(',').map(x => x.trim()).includes(s);
    if (has('[data-tb-browser]') && (where === 'browser' || where === 'browserField')) return {};
    if (has('input') && (where === 'field' || where === 'browserField')) return {};
    if (has('.xterm') && where === 'terminal') return {};
    return null;
  },
});
const ev = (combo: string, where: Where = 'page') => {
  const parts = combo.split('+'), code = parts.pop()!;
  return { type: 'keydown', code, ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: parts.includes('Meta'), target: target(where) } as unknown as KeyboardEvent;
};

test('every default key has ⌘, ⌃ or ⌥ in it', () => {
  for (const a of keys.ACTIONS) for (const k of a.keys) assert.match(k, /(^|\+)(Meta|Ctrl|Alt)\+/, `${a.id}: ${k}`);
});

test('every action has a default key', () => {
  for (const a of keys.ACTIONS) assert.ok(a.keys.length, a.id);
  assert.deepEqual(keys.keysOf('keysHelp'), ['Meta+Slash']);
  assert.equal(keys.fmtCombo('Meta+Slash'), '⌘/');
  assert.deepEqual(keys.keysOf('browserLeave'), ['Ctrl+Alt+Escape']);
});

test('the old single keys do nothing', () => {
  for (const [code, id] of [['KeyN', 'newTask'], ['KeyC', 'controller'], ['KeyT', 'triage'], ['Shift+Slash', 'keysHelp'], ['KeyJ', 'reviewNext'], ['KeyK', 'reviewPrev'], ['KeyC', 'reviewComment'], ['KeyA', 'reviewAccept'], ['KeyF', 'graphFit']])
    assert.equal(keys.hit(ev(code), id), false, `${code} ${id}`);
});

test('the new keys run their action on the page and in a terminal', () => {
  assert.equal(keys.hit(ev('Meta+KeyK'), 'controller'), true);
  assert.equal(keys.hit(ev('Meta+KeyK', 'terminal'), 'controller'), true);
  assert.equal(keys.hit(ev('Meta+Slash'), 'keysHelp'), true);
  assert.equal(keys.hit(ev('Ctrl+Alt+KeyF'), 'graphFit'), true);
  assert.equal(keys.hit(ev('Ctrl+Alt+ArrowDown'), 'reviewNext'), true);
});

test('no Taskboard key runs in the task browser, also with ⌘, ⌃ or ⌥', () => {
  for (const where of ['browser', 'browserField'] as const) {
    assert.equal(keys.hit(ev('Meta+KeyK', where), 'controller'), false);
    assert.equal(keys.hit(ev('Ctrl+Alt+KeyK', where), 'controller'), false);
    assert.equal(keys.hit(ev('Ctrl+Alt+ArrowRight', where), 'nextWindow'), false);
    assert.equal(keys.hit(ev('Meta+Slash', where), 'keysHelp'), false);
    assert.equal(keys.hitIn(ev('Ctrl+Alt+KeyG', where), 'canvas'), false);
    assert.equal(keys.hit(ev('Ctrl+Alt+Escape', where), 'browserLeave'), true, 'the key that leaves the browser');
  }
  assert.equal(keys.inBrowser(ev('KeyC', 'browser')), true);
  assert.equal(keys.inBrowser(ev('KeyC', 'page')), false);
});

test('the key that leaves the browser does nothing outside it', () => {
  assert.equal(keys.hit(ev('Ctrl+Alt+Escape'), 'browserLeave'), false);
  assert.equal(keys.hit(ev('Ctrl+Alt+Escape', 'terminal'), 'browserLeave'), false);
});

test('a single key that the user adds works outside fields, terminals and the browser', () => {
  keys.setKeys('controller', [...keys.keysOf('controller'), 'KeyC']);
  try {
    assert.equal(keys.isCustom('controller'), true);
    assert.equal(keys.hit(ev('KeyC'), 'controller'), true);
    assert.equal(keys.hit(ev('KeyC', 'field'), 'controller'), false);
    assert.equal(keys.hit(ev('KeyC', 'terminal'), 'controller'), false);
    assert.equal(keys.hit(ev('KeyC', 'browser'), 'controller'), false);
  } finally { keys.resetKeys('controller'); }
  assert.equal(keys.hit(ev('KeyC'), 'controller'), false);
});

test('the Settings page can still record a key without a modifier', () => {
  assert.equal(keys.comboOf(ev('KeyC')), 'KeyC');
  assert.equal(keys.comboOf(ev('Shift+Slash')), 'Shift+Slash');
  const settings = readFileSync(new URL('../web/src/components/Settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /const c = comboOf\(e\); if \(!c\) return;/, 'the recorder takes every combo that comboOf returns');
});

test('the browser view marks its area and handles the key that leaves it', () => {
  const src = readFileSync(new URL('../web/src/components/TaskBrowser.tsx', import.meta.url), 'utf8');
  assert.match(src, /data-tb-browser=""/);
  assert.match(src, /onKeyDownCapture=\{leave\}/);
  assert.match(src, /hit\(e\.nativeEvent, 'browserLeave'\)/);
  assert.equal(keys.BROWSER_AREA, '[data-tb-browser]');
});

test('the page handlers that read Esc, Enter or arrows leave the task browser alone', () => {
  for (const name of ['App.tsx', 'components/Canvas.tsx', 'components/Graph.tsx', 'components/Docs.tsx']) {
    const src = readFileSync(new URL(`../web/src/${name}`, import.meta.url), 'utf8');
    assert.match(src, /inBrowser\(e\)/, name);
  }
});

test('the browser choice of a Canvas window is saved for each task', () => {
  assert.deepEqual(parseSplit(null), NO_SPLIT);
  assert.deepEqual(parseSplit('not json'), NO_SPLIT);
  assert.deepEqual(parseSplit('{"open":true,"side":"left"}'), { open: true, side: 'bottom' });
  writeSplit('t1', { open: true, side: 'side' });
  assert.deepEqual(readSplit('t1'), { open: true, side: 'side' });
  assert.deepEqual(readSplit('t2'), NO_SPLIT);
});
