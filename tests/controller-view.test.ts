import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANSI_NAMES, buildTerminalTheme, contrast, parseHex, type RGBA } from '../web/src/terminalTheme.ts';
import { THEMES } from '../web/src/themes.ts';
import { GLASS_STEPS, glassStep, headerCollapsed, onGlassChange, setGlassStep, setHeaderCollapsed, setTaskThinBar, taskThinBar, worstContrast } from '../web/src/controllerView.ts';

// a localStorage and an event target for the browser functions of controllerView.ts
function withBrowser(run: (store: Map<string, string>) => void) {
  const g = globalThis as Record<string, unknown>, store = new Map<string, string>(), target = new EventTarget();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
  try { run(store); } finally { for (const k of ['localStorage', 'addEventListener', 'removeEventListener', 'dispatchEvent']) delete g[k]; }
}

test('the controller header starts collapsed, and the choice is saved for the next panel', () => withBrowser(store => {
  assert.equal(headerCollapsed('controller'), true);
  setHeaderCollapsed('controller', false);
  assert.equal(store.get('tb-ctl-header'), 'open');
  assert.equal(headerCollapsed('controller'), false);
  setHeaderCollapsed('controller', true);
  assert.equal(headerCollapsed('controller'), true);
  // the task header has its own saved choice
  setHeaderCollapsed('task', false);
  assert.equal(headerCollapsed('controller'), true);
}));

test('the thin bar for normal tasks is off until the user turns it on', () => withBrowser(() => {
  assert.equal(taskThinBar(), false);
  setTaskThinBar(true);
  assert.equal(taskThinBar(), true);
  setTaskThinBar(false);
  assert.equal(taskThinBar(), false);
}));

test('without storage the header still collapses and transparency is off', () => {
  // no localStorage at all, as in some private windows
  assert.equal(headerCollapsed('controller'), true);
  assert.equal(glassStep().id, 'off');
});

test('the transparency steps go from opaque to strong, and a change reaches open panels', () => withBrowser(store => {
  assert.deepEqual(GLASS_STEPS.map(s => s.id), ['off', 'light', 'medium', 'strong']);
  assert.equal(GLASS_STEPS[0].alpha, 1);
  assert.equal(GLASS_STEPS[0].blur, 0);
  for (let i = 1; i < GLASS_STEPS.length; i++) {
    assert.ok(GLASS_STEPS[i].alpha < GLASS_STEPS[i - 1].alpha, `${GLASS_STEPS[i].id} is more see-through`);
    assert.ok(GLASS_STEPS[i].blur > GLASS_STEPS[i - 1].blur, `${GLASS_STEPS[i].id} blurs more`);
  }
  assert.equal(glassStep().id, 'off');
  assert.equal(glassStep('nonsense').id, 'off');
  let heard = 0;
  const stop = onGlassChange(() => heard++);
  setGlassStep('medium');
  assert.equal(store.get('tb-ctl-glass'), 'medium');
  assert.equal(glassStep().id, 'medium');
  assert.equal(heard, 1);
  stop();
  setGlassStep('strong');
  assert.equal(heard, 1);
}));

test('a see-through step puts the alpha in the terminal background and keeps the cursor text opaque', () => {
  const t = buildTerminalTheme(n => (n === '--term-bg' ? parseHex('#0a0c0f') : null), 0.8);
  assert.equal(t.theme.background, '#0a0c0fcc');
  assert.equal(t.theme.cursorAccent, '#0a0c0f');
  assert.equal(buildTerminalTheme(n => (n === '--term-bg' ? parseHex('#ffffff') : null)).theme.background, '#ffffff');
});

// The colour tokens of one theme, as in terminal-theme.test.ts
const tokens = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const root = tokens(readFileSync('web/src/mockup.css', 'utf8').split('}')[0]);
function themeVars(id: string) {
  const own = id === 'default' ? {} : tokens(readFileSync(`web/public/themes/${id}.css`, 'utf8').split('\n  & ')[0]);
  const all: Record<string, string> = { ...root, ...own };
  const resolve = (v: string): string => { const m = v.match(/^var\(--([\w-]+)\)$/); return m ? resolve(all[m[1]]) : v; };
  return (name: string): RGBA | null => { const v = all[name.slice(2)] && resolve(all[name.slice(2)]); return v && /^#[0-9a-f]{6}$/i.test(v) ? parseHex(v) : null; };
}

test('in each theme and each step the terminal text stays readable over the page behind it', () => {
  for (const th of THEMES) {
    const read = themeVars(th.id), t = buildTerminalTheme(read);
    const bg = parseHex(t.theme.background!), fg = parseHex(t.theme.foreground!);
    const page = ['--bg', '--bg2', '--panel'].map(read).filter(Boolean) as RGBA[];
    // the worst case: the page text colour fills the whole area behind a letter (the blur makes this rarer)
    const pageAndText = [...page, read('--text')!];
    for (const s of GLASS_STEPS) {
      const c = worstContrast(fg, bg, pageAndText, s.alpha);
      assert.ok(c >= 4.5, `${th.id} ${s.id}: text contrast ${c.toFixed(2)}`);
      assert.ok(worstContrast(parseHex(t.theme.cursor!), bg, page, s.alpha) >= 3, `${th.id} ${s.id}: cursor`);
      // Over the page colours, an ANSI colour (bold and bright text) keeps 4.5:1, or 90% of its opaque contrast. On a
      // light terminal xterm.js first darkens a colour to minimumContrastRatio against the opaque background. For dark
      // text, the contrast changes by the same factor for every colour: the luminance ratio of the two backgrounds.
      const { minimumContrastRatio: min } = buildTerminalTheme(read, s.alpha);
      for (const n of ANSI_NAMES) {
        const ansi = parseHex(t.theme[n] as string), opaque = contrast(ansi, bg);
        let seen = worstContrast(ansi, bg, page, s.alpha);
        if (t.light && opaque < min) seen *= min / opaque;
        assert.ok(seen >= Math.min(4.5, opaque * 0.9), `${th.id} ${s.id}: ${n} ${opaque.toFixed(2)} -> ${seen.toFixed(2)}`);
      }
      // the selection stays different from the background
      const sel = parseHex(t.theme.selectionBackground!);
      assert.ok(contrast(sel, bg) > 1.1 || sel[3] < 255, `${th.id}: selection`);
    }
  }
});

// The black terminal of task 140 came from a new WebGL renderer for each mount. Folding the header or changing the
// step must not mount the terminal again: the ResizeObserver in Terminal.tsx refits it and sends the size to tmux.
test('folding the header and changing the step keep the same terminal, with the DOM renderer', () => {
  const panel = readFileSync('web/src/components/TaskPanel.tsx', 'utf8'), term = readFileSync('web/src/components/Terminal.tsx', 'utf8');
  const tag = panel.match(/<Terminal taskId=\{t\.id\}[^>]*\/>/)?.[0] || '';
  assert.ok(tag.includes('glass='), 'the panel passes the step to the terminal');
  assert.ok(!/key=/.test(tag), 'the terminal has no key that changes with the layout');
  assert.match(term, /const renderer = 'dom'/);
  assert.doesNotMatch(term, /addon-webgl|addon-canvas/);
  assert.match(term, /const refit = \(\) => \{ if \(!el\.clientWidth \|\| !el\.clientHeight\) return; try \{ fit\.fit\(\)/);
  assert.match(term, /new ResizeObserver\(refit\)/);
  assert.match(term, /term\.onResize\(\(\{ cols, rows \}\) => \{[^\n]*sizes\.changed\(cols, rows\)/);
  // the step is not a dependency of the effect that opens the terminal
  assert.match(term, /\}, \[taskId, session\]\);/);
  assert.match(term, /useEffect\(\(\) => \{ const t = termRef\.current; if \(t\) t\.options\.theme = readTerminalTheme\(glass\)\.theme; \}, \[glass\]\);/);
});
