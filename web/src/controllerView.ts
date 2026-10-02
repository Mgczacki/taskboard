// The controller view (task #0 in the task panel): a header that folds to a thin bar, and an optional see-through
// terminal. Both choices are saved in this browser. Normal tasks can use the same thin bar (a setting, off at first).
import { blend, contrast, type RGBA } from './terminalTheme';

// Each step gives the share of the theme colour in the background (alpha) and the blur of the page behind the panel.
// alpha 1 is the opaque terminal of today. The test in tests/controller-view.test.ts checks the contrast of each step.
export const GLASS_STEPS = [
  { id: 'off', label: 'Off', alpha: 1, blur: 0 },
  { id: 'light', label: 'Light', alpha: 0.9, blur: 4 },
  { id: 'medium', label: 'Medium', alpha: 0.8, blur: 8 },
  { id: 'strong', label: 'Strong', alpha: 0.7, blur: 12 },
] as const;
export type GlassId = (typeof GLASS_STEPS)[number]['id'];
export type Glass = (typeof GLASS_STEPS)[number];

const GLASS_KEY = 'tb-ctl-glass', GLASS_EVENT = 'tb-ctl-glass';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };

export const glassStep = (id: string | null = read(GLASS_KEY)): Glass => GLASS_STEPS.find(s => s.id === id) || GLASS_STEPS[0];
// the Settings page and the control on the controller bar both change it; open panels follow through the event
export function setGlassStep(id: GlassId) {
  write(GLASS_KEY, id);
  if (typeof dispatchEvent === 'function') dispatchEvent(new Event(GLASS_EVENT));
}
export const onGlassChange = (f: () => void) => { addEventListener(GLASS_EVENT, f); return () => removeEventListener(GLASS_EVENT, f); };

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

// The colour that the text is drawn on: the theme colour over the blurred page, at the step's alpha.
export const seenBackground = (termBg: RGBA, behind: RGBA, alpha: number) => blend(termBg, behind, alpha);
// The lowest contrast of the text for one step, over each page colour that can be behind the panel
export const worstContrast = (fg: RGBA, termBg: RGBA, behind: RGBA[], alpha: number) =>
  Math.min(...behind.map(b => contrast(fg, seenBackground(termBg, b, alpha))));
