import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANSI_NAMES, buildTerminalTheme, contrast, parseHex, type RGBA } from '../web/src/terminalTheme.ts';
import { THEMES } from '../web/src/themes.ts';
import { GLASS_DEFAULT, GLASS_PRESETS, MIN_TEXT_CONTRAST, TEXT_LEVELS, cleanGlass, glassAlpha, glassSetting, headerCollapsed, onGlassChange, presetOf, readableNote, readableText, setGlass, setHeaderCollapsed, setPreset, setTaskThinBar, setWindowSee, stepGlass, taskThinBar, textContrast, toggleGlass, windowSee, windowSeeSupported, worstContrast } from '../web/src/controllerView.ts';

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

test('without storage the header still collapses and the terminal is opaque', () => {
  // no localStorage at all, as in some private windows
  assert.equal(headerCollapsed('controller'), true);
  assert.deepEqual(glassSetting(), GLASS_DEFAULT);
  assert.equal(glassSetting().see, 0);
});

test('the slider goes from 0 to 100 in steps of 5, and blur from 0 to 30 px', () => {
  assert.equal(cleanGlass({ see: 33 }).see, 35);
  assert.equal(cleanGlass({ see: 31 }).see, 30);
  assert.equal(cleanGlass({ see: -10 }).see, 0);
  assert.equal(cleanGlass({ see: 140 }).see, 100);
  assert.equal(cleanGlass({ blur: 45 }).blur, 30);
  assert.equal(cleanGlass({ see: 'x' as unknown as number }).see, 0);
  assert.equal(cleanGlass({ text: 'loud' as never }).text, 'auto');
  assert.equal(cleanGlass({ tint: 'red' as never }).tint, 'panel');
  assert.equal(glassAlpha(cleanGlass({ see: 85 })), 0.15000000000000002);
});

test('the presets set the slider: Off to Ghost, Glass about 85% and Ghost about 95% see-through', () => withBrowser(store => {
  assert.deepEqual(GLASS_PRESETS.map(p => p.id), ['off', 'light', 'medium', 'strong', 'glass', 'ghost']);
  for (let i = 1; i < GLASS_PRESETS.length; i++) assert.ok(GLASS_PRESETS[i].see > GLASS_PRESETS[i - 1].see, `${GLASS_PRESETS[i].id} is more see-through`);
  assert.equal(GLASS_PRESETS.find(p => p.id === 'glass')!.see, 85);
  assert.equal(GLASS_PRESETS.find(p => p.id === 'ghost')!.see, 95);
  for (const p of GLASS_PRESETS) {
    const g = setPreset(p.id);
    assert.equal(g.see, p.see); assert.equal(g.blur, p.blur);
    assert.equal(presetOf(g)?.id, p.id);
    assert.equal(JSON.parse(store.get('tb-ctl-see')!).see, p.see);
  }
  // a value between presets is Custom
  assert.equal(presetOf(setGlass({ see: 45 })), null);
  // the text strength and tint stay when a preset changes the slider
  setGlass({ text: 'outline', tint: 'page' });
  const g = setPreset('medium');
  assert.equal(g.text, 'outline'); assert.equal(g.tint, 'page');
}));

test('the setting is saved in this browser, and a change reaches open panels and other windows', () => withBrowser(store => {
  let heard = 0;
  const stop = onGlassChange(() => heard++);
  setGlass({ see: 40, blur: 10, text: 'bold', tint: 'page' });
  assert.deepEqual(JSON.parse(store.get('tb-ctl-see')!), { see: 40, blur: 10, text: 'bold', tint: 'page', last: 40 });
  assert.deepEqual(glassSetting(), { see: 40, blur: 10, text: 'bold', tint: 'page', last: 40 });
  assert.equal(heard, 1);
  // another window saved a new value: the storage event of this window reaches the panel
  dispatchEvent(Object.assign(new Event('storage'), { key: 'tb-ctl-see' }));
  assert.equal(heard, 2);
  stop();
  setGlass({ see: 50 });
  assert.equal(heard, 2);
  // a broken value gives the default
  store.set('tb-ctl-see', '{nope');
  assert.deepEqual(glassSetting(), GLASS_DEFAULT);
}));

test('a step saved by the four-step control of task 173 keeps its values', () => withBrowser(store => {
  store.set('tb-ctl-glass', 'strong');
  assert.deepEqual([glassSetting().see, glassSetting().blur], [30, 12]);
  store.set('tb-ctl-glass', 'off');
  assert.equal(glassSetting().see, 0);
  // the new key wins over the old one
  setGlass({ see: 60 });
  assert.equal(glassSetting().see, 60);
}));

test('one step more or less, and the switch between the saved value and Off', () => withBrowser(() => {
  assert.equal(stepGlass(1).see, 5);
  assert.equal(stepGlass(1).see, 10);
  assert.equal(stepGlass(-1).see, 5);
  assert.equal(stepGlass(-1).see, 0);
  assert.equal(stepGlass(-1).see, 0);
  setGlass({ see: 100 });
  assert.equal(stepGlass(1).see, 100);
  setPreset('glass');
  assert.equal(toggleGlass().see, 0);
  assert.equal(glassSetting().last, 85);
  assert.equal(toggleGlass().see, 85);
  // from a fresh start the switch turns on the default value
  setGlass({ see: 0, last: 30 });
  assert.equal(toggleGlass().see, 30);
}));

test('the keys: ⌃⌥= more, ⌃⌥− less, ⌃⌥O on or off, anywhere and also in the terminal', async () => {
  // keys.ts listens for 'storage' when it loads
  const g = globalThis as Record<string, unknown>;
  g.addEventListener = () => {};
  const { ACTIONS, comboOf, hit, taskboardKey } = await import('../web/src/keys.ts');
  delete g.addEventListener;
  const ev = (code: string) => ({ type: 'keydown', code, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, target: { closest: (q: string) => (q.includes('.xterm') ? {} : null) } }) as unknown as KeyboardEvent;
  for (const [id, code] of [['glassMore', 'Equal'], ['glassLess', 'Minus'], ['glassToggle', 'KeyO']]) {
    const a = ACTIONS.find(x => x.id === id)!;
    assert.equal(a.ctx, 'app');
    assert.equal(comboOf(ev(code)), `Ctrl+Alt+${code}`);
    assert.ok(hit(ev(code), id), `${id} runs while the focus is in a terminal`);
    assert.ok(taskboardKey(ev(code)), `${id} is not sent to the agent`);
    // no other action of a context that is active with the app keys uses the same key
    assert.deepEqual(ACTIONS.filter(x => x.id !== id && x.keys.includes(`Ctrl+Alt+${code}`)).map(x => x.id), []);
  }
  const app = readFileSync('web/src/App.tsx', 'utf8');
  assert.match(app, /hit\(e, 'glassMore'\)\) return act\(\(\) => stepGlass\(1\)\)/);
  assert.match(app, /hit\(e, 'glassLess'\)\) return act\(\(\) => stepGlass\(-1\)\)/);
  assert.match(app, /hit\(e, 'glassToggle'\)\) return act\(\(\) => toggleGlass\(\)\)/);
});

test('the contrast guard raises the text strength when the text falls below 4.5:1, and says so', () => {
  const fg = parseHex('#d6dae0'), tint = parseHex('#0a0c0f'), behind = [parseHex('#ffffff'), parseHex('#0d1117')];
  // opaque: no change
  const off = readableText(fg, tint, behind, 1, 'normal');
  assert.equal(off.level, 'normal'); assert.equal(off.raised, false); assert.ok(off.enough);
  // each level of strength gives the same or more contrast
  for (const a of [0.7, 0.3, 0.15, 0.05]) {
    const cs = TEXT_LEVELS.map(l => textContrast(fg, tint, behind, a, l));
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i] >= cs[i - 1], `alpha ${a}: ${TEXT_LEVELS[i]} is stronger`);
  }
  // Glass over a white page: Normal is too weak, so the guard picks a stronger level
  const glass = readableText(fg, tint, behind, 0.15, 'normal');
  assert.ok(textContrast(fg, tint, behind, 0.15, 'normal') < MIN_TEXT_CONTRAST);
  assert.equal(glass.raised, true);
  assert.notEqual(glass.level, 'normal');
  assert.ok(glass.contrast >= MIN_TEXT_CONTRAST || !glass.enough);
  assert.match(readableNote(glass, 'normal', 85), /^Raised to (Soft shadow|Bold|Outline): Normal gives \d+\.\d:1 over the page, below 4\.5:1\.$/);
  // Auto picks the lowest level that is enough, and the note says that it was automatic
  const auto = readableText(fg, tint, behind, 0.15, 'auto');
  assert.equal(auto.level, glass.level); assert.equal(auto.raised, false);
  assert.match(readableNote(auto, 'auto', 85), /\(auto\)/);
  // a chosen level that is enough stays
  const strong = readableText(fg, tint, behind, 0.7, 'outline');
  assert.equal(strong.level, 'outline'); assert.equal(strong.raised, false);
  // when even Outline is not enough, the note asks for less see-through
  const none = readableText(parseHex('#909090'), parseHex('#808080'), [parseHex('#999999')], 0.05, 'normal');
  assert.equal(none.enough, false);
  assert.match(readableNote(none, 'normal', 100), /below 4\.5:1\. Use less see-through or more blur\./);
  assert.equal(readableNote(off, 'normal', 0), '');
});

test('window see-through is off at first, saved, and hidden when the app does not support it', () => withBrowser(store => {
  assert.deepEqual(windowSee(), { on: false, opacity: 85 });
  setWindowSee({ on: true, opacity: 63 });
  assert.deepEqual(windowSee(), { on: true, opacity: 65 });
  assert.equal(JSON.parse(store.get('tb-win-see')!).on, true);
  // a normal browser tab: no app bridge, so the option is not shown
  assert.equal(windowSeeSupported(), false);
  const panel = readFileSync('web/src/components/Settings.tsx', 'utf8');
  assert.match(panel, /\{windowSeeSupported\(\) && <SettingItem id="windowSee">/);
}));

// The colour tokens of one theme, as in terminal-theme.test.ts
const tokens = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const root = tokens(readFileSync('web/src/mockup.css', 'utf8').split('}')[0]);
function themeVars(id: string) {
  const own = id === 'default' ? {} : tokens(readFileSync(`web/public/themes/${id}.css`, 'utf8').split('\n  & ')[0]);
  const all: Record<string, string> = { ...root, ...own };
  const resolve = (v: string): string => { const m = v.match(/^var\(--([\w-]+)\)$/); return m ? resolve(all[m[1]]) : v; };
  return (name: string): RGBA | null => { const v = all[name.slice(2)] && resolve(all[name.slice(2)]); return v && /^#[0-9a-f]{6}$/i.test(v) ? parseHex(v) : null; };
}

test('a see-through value puts the alpha in the terminal background and keeps the cursor text opaque', () => {
  const t = buildTerminalTheme(n => (n === '--term-bg' ? parseHex('#0a0c0f') : null), 0.8);
  assert.equal(t.theme.background, '#0a0c0fcc');
  assert.equal(t.theme.cursorAccent, '#0a0c0f');
  assert.equal(buildTerminalTheme(n => (n === '--term-bg' ? parseHex('#ffffff') : null)).theme.background, '#ffffff');
  // the page tint draws the terminal in the page colours
  const colours: Record<string, string> = { '--term-bg': '#0a0c0f', '--term-fg': '#d6dae0', '--bg': '#ffffff', '--text': '#1f2328' };
  const page = buildTerminalTheme(n => (colours[n] ? parseHex(colours[n]) : null), 0.5, 'page');
  assert.equal(page.theme.background, '#ffffff80');
  assert.equal(page.theme.foreground, '#1f2328');
  assert.equal(page.light, true);
  // xterm.js asks for more contrast on a light see-through terminal, up to 7:1
  assert.equal(buildTerminalTheme(n => (colours[n] ? parseHex(colours[n]) : null), 0.05, 'page').minimumContrastRatio, 7);
});

test('in each theme and each preset the guard keeps the terminal text readable over the page behind it', () => {
  for (const th of THEMES) {
    for (const tint of ['panel', 'page'] as const) {
      const read = themeVars(th.id), t = buildTerminalTheme(read, 1, tint);
      const bg = parseHex(t.theme.background!), fg = parseHex(t.theme.foreground!);
      const page = ['--bg', '--bg2', '--panel'].map(read).filter(Boolean) as RGBA[];
      // the worst case: the page text colour fills the whole area behind a letter (the blur makes this rarer)
      const pageAndText = [...page, read('--text')!];
      for (const p of GLASS_PRESETS) {
        const alpha = 1 - p.see / 100;
        // the four steps of task 173 keep 4.5:1 without any help
        if (p.see <= 30 && tint === 'panel') assert.ok(worstContrast(fg, bg, pageAndText, alpha) >= 4.5, `${th.id} ${p.id}: text contrast`);
        // every preset: the text strength that the guard picks reaches 4.5:1, or the note says that it does not
        const r = readableText(fg, bg, pageAndText, alpha, 'auto');
        assert.ok(r.enough ? r.contrast >= MIN_TEXT_CONTRAST : /below 4\.5:1/.test(readableNote(r, 'auto', p.see)), `${th.id} ${tint} ${p.id}: ${r.level} ${r.contrast.toFixed(2)}`);
        if (p.see > 30) continue;
        assert.ok(worstContrast(parseHex(t.theme.cursor!), bg, page, alpha) >= 3, `${th.id} ${tint} ${p.id}: cursor`);
        // Over the page colours, an ANSI colour (bold and bright text) keeps 4.5:1, or 90% of its opaque contrast. On a
        // light terminal xterm.js first darkens a colour to minimumContrastRatio against the opaque background. For dark
        // text, the contrast changes by the same factor for every colour: the luminance ratio of the two backgrounds.
        const { minimumContrastRatio: min } = buildTerminalTheme(read, alpha, tint);
        if (tint === 'panel') for (const n of ANSI_NAMES) {
          const ansi = parseHex(t.theme[n] as string), opaque = contrast(ansi, bg);
          let seen = worstContrast(ansi, bg, page, alpha);
          if (t.light && opaque < min) seen *= min / opaque;
          assert.ok(seen >= Math.min(4.5, opaque * 0.9), `${th.id} ${p.id}: ${n} ${opaque.toFixed(2)} -> ${seen.toFixed(2)}`);
        }
        // the selection stays different from the background
        const sel = parseHex(t.theme.selectionBackground!);
        assert.ok(contrast(sel, bg) > 1.1 || sel[3] < 255, `${th.id} ${tint}: selection`);
      }
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
  assert.match(term, /useEffect\(\(\) => \{ const t = termRef\.current; if \(!t\) return; const \{ theme, minimumContrastRatio \} = readTerminalTheme\(glass, tint\); t\.options\.theme = theme; t\.options\.minimumContrastRatio = minimumContrastRatio; \}, \[glass, tint\]\);/);
  // the text strength is a class and CSS on the drawer, not an option that opens the terminal again
  assert.match(panel, /glass txt-\$\{readable\.level\}/);
});
