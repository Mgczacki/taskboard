// The controller view (task #0 in the task panel): a header that folds to a thin bar, and an optional see-through
// terminal. Both choices are saved in this browser. Normal tasks can use the same thin bar (a setting, off at first).
import { blend, contrast, type RGBA } from './terminalTheme';

// The see-through terminal. see is the share of the page that shows through the terminal background, in percent
// (0 is the opaque terminal, 100 shows only the text). The bar keeps at least BAR_ALPHA of its colour, so it stays clear.
export type TextStrength = 'auto' | 'normal' | 'shadow' | 'bold' | 'outline';
export type Tint = 'panel' | 'page';
export type Glass = { see: number; blur: number; text: TextStrength; tint: Tint; last: number };
export const GLASS_STEP = 5, BLUR_MAX = 30, BAR_ALPHA = 0.85;
export const GLASS_DEFAULT: Glass = { see: 0, blur: 0, text: 'auto', tint: 'panel', last: 30 };

// A preset sets the see-through value and the blur. Light, Medium and Strong are the four steps of task #173.
export const GLASS_PRESETS = [
  { id: 'off', label: 'Off', see: 0, blur: 0 },
  { id: 'light', label: 'Light', see: 10, blur: 4 },
  { id: 'medium', label: 'Medium', see: 20, blur: 8 },
  { id: 'strong', label: 'Strong', see: 30, blur: 12 },
  { id: 'glass', label: 'Glass', see: 85, blur: 4 },
  { id: 'ghost', label: 'Ghost', see: 95, blur: 0 },
] as const;
export type PresetId = (typeof GLASS_PRESETS)[number]['id'];
export const presetOf = (g: Glass) => GLASS_PRESETS.find(p => p.see === g.see && (p.see === 0 || p.blur === g.blur)) || null;

export const TEXT_STRENGTHS: { id: TextStrength; label: string }[] = [
  { id: 'auto', label: 'Auto' }, { id: 'normal', label: 'Normal' }, { id: 'shadow', label: 'Soft shadow' }, { id: 'bold', label: 'Bold' }, { id: 'outline', label: 'Outline' },
];
export const TINTS: { id: Tint; label: string }[] = [{ id: 'panel', label: 'Panel color' }, { id: 'page', label: 'Page color' }];

const GLASS_KEY = 'tb-ctl-see', OLD_KEY = 'tb-ctl-glass', GLASS_EVENT = 'tb-ctl-glass';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };

const clamp = (v: unknown, lo: number, hi: number, step = 1) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n / step) * step)) : lo; };
export function cleanGlass(raw: Partial<Glass> | null | undefined): Glass {
  const g = { ...GLASS_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    see: clamp(g.see, 0, 100, GLASS_STEP), blur: clamp(g.blur, 0, BLUR_MAX),
    text: TEXT_STRENGTHS.some(t => t.id === g.text) ? g.text : 'auto', tint: g.tint === 'page' ? 'page' : 'panel',
    last: clamp(g.last, GLASS_STEP, 100, GLASS_STEP) || GLASS_DEFAULT.last,
  };
}
// The saved setting. A browser that saved one of the old steps (off, light, medium, strong) gets the same values.
export function glassSetting(): Glass {
  const raw = read(GLASS_KEY);
  if (raw) { try { return cleanGlass(JSON.parse(raw)); } catch { /* broken: the default */ } }
  const old = GLASS_PRESETS.find(p => p.id === read(OLD_KEY));
  return old ? cleanGlass({ see: old.see, blur: old.blur, last: old.see || GLASS_DEFAULT.last }) : { ...GLASS_DEFAULT };
}
// The Settings page, the bar controls and the keys all change it; open panels follow through the event
export function setGlass(patch: Partial<Glass>) {
  const g = cleanGlass({ ...glassSetting(), ...patch });
  if (g.see > 0) g.last = g.see;
  write(GLASS_KEY, JSON.stringify(g));
  if (typeof dispatchEvent === 'function') dispatchEvent(new Event(GLASS_EVENT));
  return g;
}
export const setPreset = (id: PresetId) => { const p = GLASS_PRESETS.find(x => x.id === id)!; return setGlass({ see: p.see, blur: p.blur }); };
// one step more (+1) or less (-1) see-through; from Off, the first step up keeps the saved blur
export const stepGlass = (dir: 1 | -1) => setGlass({ see: glassSetting().see + dir * GLASS_STEP });
// switches between the saved value and Off
export const toggleGlass = () => { const g = glassSetting(); return setGlass({ see: g.see > 0 ? 0 : g.last }); };
export const onGlassChange = (f: () => void) => {
  const storage = (e: StorageEvent) => { if (e.key === GLASS_KEY) f(); };
  addEventListener(GLASS_EVENT, f); addEventListener('storage', storage);
  return () => { removeEventListener(GLASS_EVENT, f); removeEventListener('storage', storage); };
};
export const glassAlpha = (g: Glass) => 1 - g.see / 100;

// With the see-through terminal on, the page behind can be clicked while Alt (Option) is held alone. Ctrl+Alt and
// Cmd+Alt are keyboard shortcuts (keys.ts), so they do not count. The panel reads it on each keydown and keyup.
export const clickThroughHeld = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => e.altKey && !e.ctrlKey && !e.metaKey;

// The header of the controller starts folded. The header of a normal task folds only when the setting below is on.
const HEAD_KEY = { controller: 'tb-ctl-header', task: 'tb-task-header' } as const;
const THIN_KEY = 'tb-task-thin-bar';
export type HeadKind = keyof typeof HEAD_KEY;
export const headerCollapsed = (kind: HeadKind) => (read(HEAD_KEY[kind]) ?? 'collapsed') === 'collapsed';
export const setHeaderCollapsed = (kind: HeadKind, collapsed: boolean) => write(HEAD_KEY[kind], collapsed ? 'collapsed' : 'open');
export const taskThinBar = () => read(THIN_KEY) === 'on';
export const setTaskThinBar = (on: boolean) => write(THIN_KEY, on ? 'on' : 'off');

// The colour that the text is drawn on: the tint colour over the blurred page, at the given alpha.
export const seenBackground = (termBg: RGBA, behind: RGBA, alpha: number) => blend(termBg, behind, alpha);
// The lowest contrast of the text over each page colour that can be behind the panel
export const worstContrast = (fg: RGBA, termBg: RGBA, behind: RGBA[], alpha: number) =>
  Math.min(...behind.map(b => contrast(fg, seenBackground(termBg, b, alpha))));

// The text strengths in the order of their effect. Each one draws a glow or an outline in the tint colour around each
// letter, so only a part of the page shows right next to it: HALO is that part. Bold adds weight to the soft glow.
export const TEXT_LEVELS = ['normal', 'shadow', 'bold', 'outline'] as const;
export type TextLevel = (typeof TEXT_LEVELS)[number];
const HALO: Record<TextLevel, number> = { normal: 1, shadow: 0.55, bold: 0.45, outline: 0.25 };
export const MIN_TEXT_CONTRAST = 4.5; // WCAG AA for text
export const textContrast = (fg: RGBA, tint: RGBA, behind: RGBA[], alpha: number, level: TextLevel) =>
  worstContrast(fg, tint, behind, 1 - (1 - alpha) * HALO[level]);

// The contrast guard. It computes the text contrast over the worst page colour behind the panel and picks the text
// strength: the chosen one, or a stronger one when the chosen one is below MIN_TEXT_CONTRAST. Auto starts at Normal.
// raised: the guard chose a stronger level than the user. enough: false when even Outline stays below the minimum.
export function readableText(fg: RGBA, tint: RGBA, behind: RGBA[], alpha: number, chosen: TextStrength) {
  const start = chosen === 'auto' ? 0 : TEXT_LEVELS.indexOf(chosen);
  const at = (l: TextLevel) => textContrast(fg, tint, behind, alpha, l);
  for (let i = start; i < TEXT_LEVELS.length; i++) {
    const level = TEXT_LEVELS[i], c = at(level);
    if (c >= MIN_TEXT_CONTRAST) return { level, contrast: c, chosenContrast: at(TEXT_LEVELS[start]), raised: chosen !== 'auto' && i > start, enough: true };
  }
  return { level: 'outline' as TextLevel, contrast: at('outline'), chosenContrast: at(TEXT_LEVELS[start]), raised: chosen !== 'auto' && start < TEXT_LEVELS.length - 1, enough: false };
}
export type Readable = ReturnType<typeof readableText>;
const LEVEL_LABEL: Record<TextLevel, string> = { normal: 'Normal', shadow: 'Soft shadow', bold: 'Bold', outline: 'Outline' };
// The line under the text control. It says what the guard chose and why.
export function readableNote(r: Readable, chosen: TextStrength, see: number) {
  if (see === 0) return '';
  const ratio = (c: number) => `${c.toFixed(1)}:1`;
  if (!r.enough) return `The text contrast is ${ratio(r.contrast)} with Outline, below ${MIN_TEXT_CONTRAST}:1. Use less see-through or more blur.`;
  if (r.raised) return `Raised to ${LEVEL_LABEL[r.level]}: ${LEVEL_LABEL[chosen as TextLevel]} gives ${ratio(r.chosenContrast)} over the page, below ${MIN_TEXT_CONTRAST}:1.`;
  if (chosen === 'auto') return `${LEVEL_LABEL[r.level]} (auto): the text contrast is ${ratio(r.contrast)} or more over the page.`;
  return `The text contrast is ${ratio(r.contrast)} or more over the page.`;
}

// Window see-through (the app only, Settings): while the controller view is open, the whole window is drawn at this
// opacity, so the desktop shows behind it. Off at first. Only shown when the app says that its system supports it.
export type WindowSee = { on: boolean; opacity: number };
const WIN_KEY = 'tb-win-see', WIN_EVENT = 'tb-win-see';
export const windowSee = (): WindowSee => { try { const v = JSON.parse(read(WIN_KEY) || '{}'); return { on: v.on === true, opacity: clamp(v.opacity ?? 85, 40, 95, GLASS_STEP) }; } catch { return { on: false, opacity: 85 }; } };
export const setWindowSee = (patch: Partial<WindowSee>) => { write(WIN_KEY, JSON.stringify({ ...windowSee(), ...patch })); if (typeof dispatchEvent === 'function') dispatchEvent(new Event(WIN_EVENT)); };
export const onWindowSeeChange = (f: () => void) => { addEventListener(WIN_EVENT, f); return () => removeEventListener(WIN_EVENT, f); };
type AppBridge = { windowOpacity?: boolean; setWindowOpacity?: (v: number) => void };
const bridge = () => (typeof window === 'undefined' ? undefined : (window as unknown as { taskboardApp?: AppBridge }).taskboardApp);
export const windowSeeSupported = () => !!bridge()?.windowOpacity && typeof bridge()?.setWindowOpacity === 'function';
export const applyWindowOpacity = (v: number) => { if (windowSeeSupported()) bridge()!.setWindowOpacity!(Math.min(1, Math.max(0.4, v))); };
