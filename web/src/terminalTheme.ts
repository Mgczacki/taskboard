// Terminal colours from the page theme. Each theme sets --term-bg, --term-fg, --term-cursor and --term-selection
// (mockup.css has the defaults, web/public/themes/<id>.css the overrides). A theme can also set any of the 16 ANSI
// colours as --term-<name> (for example --term-bright-blue). Without them, a dark background gets the xterm.js
// default palette and a light background gets LIGHT_ANSI, which is dark enough to read on white.
import type { ITheme } from '@xterm/xterm';

export type RGBA = [number, number, number, number]; // 0-255 each, alpha too

export const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
type AnsiName = (typeof ANSI_NAMES)[number];

// xterm.js 6 defaults, so dark themes look as they did before themes set terminal colours
export const DARK_ANSI: Record<AnsiName, string> = {
  black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
  brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
};
// For a light background: every colour except white and bright white has at least 4.5:1 contrast on #ffffff
export const LIGHT_ANSI: Record<AnsiName, string> = {
  black: '#1f2328', red: '#b3261e', green: '#116329', yellow: '#7d4e00', blue: '#0550ae', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#0969da', brightMagenta: '#6f42c1', brightCyan: '#0e7490', brightWhite: '#8c959f',
};

const cssName = (n: string) => '--term-' + n.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const hex = ([r, g, b, a]: RGBA) => '#' + [r, g, b, ...(a < 255 ? [a] : [])].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: RGBA) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGBA, b: RGBA) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// a over b, with a at the given alpha (0-1)
export const blend = (a: RGBA, b: RGBA, alpha: number): RGBA => [0, 1, 2].map(i => a[i] * alpha + b[i] * (1 - alpha)).concat(255) as RGBA;
export const parseHex = (s: string): RGBA => {
  const h = s.replace('#', ''), p = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [p(0), p(2), p(4), h.length >= 8 ? p(6) : 255];
};

// read(name) gives a CSS custom property as a colour, or null when the theme does not set it. alpha below 1 makes the
// background see-through (the controller view, controllerView.ts). The DOM renderer paints theme.background as the CSS
// background of the viewport, so an alpha colour works there. Cursor text and inverted text keep the opaque colour.
export function buildTerminalTheme(read: (name: string) => RGBA | null, alpha = 1): { theme: ITheme; minimumContrastRatio: number; light: boolean } {
  const bg = read('--term-bg') || [10, 12, 15, 255];
  const light = luminance(bg) > 0.4;
  const pick = (name: string, fallback: string) => { const c = read(name); return c ? hex(c) : fallback; };
  const palette = light ? LIGHT_ANSI : DARK_ANSI;
  const theme: ITheme = {
    background: hex([bg[0], bg[1], bg[2], Math.round(Math.min(1, Math.max(0, alpha)) * 255)]),
    foreground: pick('--term-fg', light ? '#1f2328' : '#d6dae0'),
    cursor: pick('--term-cursor', light ? '#1f2328' : '#e6edf3'),
    cursorAccent: hex([bg[0], bg[1], bg[2], 255]),
    selectionBackground: pick('--term-selection', light ? '#b6d3ff' : '#3a4a6a'),
  };
  for (const n of ANSI_NAMES) theme[n] = pick(cssName(n), palette[n]);
  // Agents choose colours for a dark background (white text, light grey hints). On a light background xterm.js
  // darkens any text colour that has less than 4.5:1 contrast with the cell behind it (WCAG AA for text).
  // xterm.js compares with the opaque background. A see-through light terminal over a darker page (the grey bay of
  // Flight strips) shows a darker background, so ask for more contrast: 5.4:1 at alpha 0.7.
  return { theme, minimumContrastRatio: light ? 4.5 + 3 * (1 - Math.min(1, alpha)) : 1, light };
}

// Resolve a custom property to RGBA through a hidden element and a 1-pixel canvas, so color-mix() and named colours work.
let probe: HTMLElement | null = null, ctx: CanvasRenderingContext2D | null = null;
function readColor(name: string): RGBA | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return null;
  if (!probe) { probe = document.createElement('span'); probe.style.display = 'none'; document.body.appendChild(probe); }
  if (!ctx) { const c = document.createElement('canvas'); c.width = c.height = 1; ctx = c.getContext('2d', { willReadFrequently: true }); }
  if (!ctx) return null;
  probe.style.color = ''; probe.style.color = `var(${name})`;
  ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(probe).color; ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
export const readTerminalTheme = (alpha = 1) => buildTerminalTheme(readColor, alpha);
