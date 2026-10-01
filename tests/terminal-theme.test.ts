import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANSI_NAMES, DARK_ANSI, LIGHT_ANSI, buildTerminalTheme, contrast, parseHex, type RGBA } from '../web/src/terminalTheme.ts';
import { THEMES, applyTheme } from '../web/src/themes.ts';

// The colour tokens of one theme: the :root block of mockup.css, then the theme's own block, with var() resolved.
const tokens = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const root = tokens(readFileSync('web/src/mockup.css', 'utf8').split('}')[0]);
function themeVars(id: string) {
  const own = id === 'default' ? {} : tokens(readFileSync(`web/public/themes/${id}.css`, 'utf8').split('\n  & ')[0]);
  const all: Record<string, string> = { ...root, ...own };
  const resolve = (v: string): string => { const m = v.match(/^var\(--([\w-]+)\)$/); return m ? resolve(all[m[1]]) : v; };
  return (name: string): RGBA | null => { const v = all[name.slice(2)] && resolve(all[name.slice(2)]); return v && /^#[0-9a-f]{6}$/i.test(v) ? parseHex(v) : null; };
}

test('a dark terminal background keeps the xterm.js palette and does not change text colours', () => {
  const t = buildTerminalTheme(n => ({ '--term-bg': parseHex('#0a0c0f'), '--term-fg': parseHex('#d6dae0') } as Record<string, RGBA>)[n] || null);
  assert.equal(t.light, false);
  assert.equal(t.minimumContrastRatio, 1);
  assert.equal(t.theme.background, '#0a0c0f');
  assert.equal(t.theme.foreground, '#d6dae0');
  for (const n of ANSI_NAMES) assert.equal(t.theme[n], DARK_ANSI[n]);
});

test('a light terminal background gets the light palette and a 4.5:1 minimum contrast for agent text', () => {
  const t = buildTerminalTheme(n => (n === '--term-bg' ? parseHex('#ffffff') : null));
  assert.equal(t.light, true);
  assert.equal(t.minimumContrastRatio, 4.5);
  assert.equal(t.theme.background, '#ffffff');
  for (const n of ANSI_NAMES) assert.equal(t.theme[n], LIGHT_ANSI[n]);
  for (const n of ANSI_NAMES.filter(n => n !== 'white' && n !== 'brightWhite')) assert.ok(contrast(parseHex(LIGHT_ANSI[n]), parseHex('#ffffff')) >= 4.5, `${n} ${LIGHT_ANSI[n]} on white`);
});

test('a theme can set any ANSI colour and the selection colour, with transparency', () => {
  const vars: Record<string, RGBA> = { '--term-bg': parseHex('#101010'), '--term-bright-blue': parseHex('#123456'), '--term-selection': [255, 0, 0, 128] };
  const t = buildTerminalTheme(n => vars[n] || null);
  assert.equal(t.theme.brightBlue, '#123456');
  assert.equal(t.theme.selectionBackground, '#ff000080');
  assert.equal(t.theme.blue, DARK_ANSI.blue);
});

test('each theme gives its terminal light or dark colours to match the page, with readable text and cursor', () => {
  const backgrounds = new Set<string>();
  for (const th of THEMES) {
    const t = buildTerminalTheme(themeVars(th.id));
    assert.equal(t.light, th.group === 'Light', `${th.id}: terminal should be ${th.group.toLowerCase()}`);
    const bg = parseHex(t.theme.background!), fg = parseHex(t.theme.foreground!), cursor = parseHex(t.theme.cursor!);
    assert.ok(contrast(fg, bg) >= 7, `${th.id}: text contrast ${contrast(fg, bg).toFixed(2)}`);
    assert.ok(contrast(cursor, bg) >= 3, `${th.id}: cursor contrast ${contrast(cursor, bg).toFixed(2)}`);
    backgrounds.add(t.theme.background!);
  }
  assert.ok(backgrounds.size > 2, 'themes should not share one terminal background');
});

test('switching the page theme tells open terminals to read their colours again after the stylesheet loads', () => {
  const events: string[] = [];
  let link: { id: string; rel: string; href?: string; onload?: () => void; onerror?: () => void; setAttribute(k: string, v: string): void; getAttribute(k: string): string | undefined; remove(): void } | null = null;
  const frames: (() => void)[] = [];
  const g = globalThis as Record<string, unknown>;
  g.document = {
    getElementById: () => link,
    createElement: () => ({ setAttribute(this: { href?: string }, _k: string, v: string) { this.href = v; }, getAttribute(this: { href?: string }) { return this.href; }, remove() { link = null; } }),
    head: { appendChild: (l: typeof link) => { link = l; } },
    documentElement: { dataset: {} as Record<string, string> },
  };
  g.window = { dispatchEvent: (e: Event) => events.push(e.type) };
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  try {
    applyTheme('swiss', false);
    assert.equal(link!.href, '/themes/swiss.css');
    assert.deepEqual(events, [], 'no event before the stylesheet has loaded');
    link!.onload!();
    assert.deepEqual(events, ['tb-theme']);
    applyTheme('swiss', false); // same stylesheet: nothing to wait for
    frames.shift()!();
    assert.deepEqual(events, ['tb-theme', 'tb-theme']);
    applyTheme('default', false);
    assert.equal(link, null);
    frames.shift()!();
    assert.deepEqual(events, ['tb-theme', 'tb-theme', 'tb-theme']);
  } finally { delete g.document; delete g.window; delete g.requestAnimationFrame; }
});
