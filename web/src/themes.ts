// Style themes (from the mockups). Each non-default theme is a stylesheet in web/public/themes/<id>.css
// that overrides the colour tokens and restyles the same class names.
export const THEMES = [
  { id: 'default', name: 'Current', group: 'Dark', desc: 'The first design: neutral dark grey, system font.', c: ['#0d0f12', '#171a1f', '#e4e7ec', '#7aa2ff', '#f5a524'] },
  { id: 'macos-dark', name: 'macOS Dark', group: 'Dark', desc: 'Native Mac look in dark mode: vibrant sidebar, system controls.', c: ['#1e1e1e', '#2c2c2e', '#dfdfe1', '#0a84ff', '#ff9f0a'] },
  { id: 'lacquer', name: 'Lacquer', group: 'Dark', desc: 'Warm brown-black, bone text, serif titles, cinnabar for “needs you”.', c: ['#15100d', '#1d1612', '#f0e7d7', '#d6b36a', '#ff5a3c'] },
  { id: 'nightstrips', name: 'Night strips', group: 'Dark', desc: 'Air-traffic flight strips on charcoal; big task numbers, status bands.', c: ['#13171a', '#1b2124', '#e6ecee', '#6cc4ff', '#ffb000'] },
  { id: 'instrument', name: 'Instrument', group: 'Dark', desc: 'Hardware panel: graphite, engraved labels, LED status lights.', c: ['#0f1011', '#1c1d20', '#e7eaec', '#3fe08a', '#ffa21a'] },
  { id: 'moss', name: 'Moss', group: 'Dark', desc: 'Calm green-black with sage text; ochre for “needs you”.', c: ['#0a130e', '#12211a', '#e1e7d8', '#d9c48c', '#f2a93b'] },
  { id: 'phosphor', name: 'Phosphor', group: 'Dark', desc: 'Amber console: monospace everywhere, status as glyphs.', c: ['#110c05', '#1a1309', '#ffb84d', '#6fe0ff', '#ffe08a'] },
  { id: 'blueprint', name: 'Blueprint', group: 'Dark', desc: 'Engineering drawing: blue ground, white line work.', c: ['#0f3563', '#10396b', '#eef7ff', '#7fe3ff', '#ff8a5c'] },
  { id: 'strips', name: 'Flight strips', group: 'Light', desc: 'Paper flight strips in a grey strip bay.', c: ['#c3cac7', '#eceeea', '#16201d', '#1d5fa8', '#d9480f'] },
  { id: 'swiss', name: 'Swiss', group: 'Light', desc: 'White, thick black rules, flat signal colours.', c: ['#ffffff', '#f1f1f1', '#000000', '#0038ff', '#ff4a00'] },
  { id: 'macos', name: 'macOS Light', group: 'Light', desc: 'Native Mac look: translucent sidebar, system controls.', c: ['#ececec', '#ffffff', '#1d1d1f', '#007aff', '#ff9500'] },
];

export type Theme = (typeof THEMES)[number];
const KEY = 'tb-theme';
let current = (() => { try { return localStorage.getItem(KEY) || 'default'; } catch { return 'default'; } })();

// Swap the theme stylesheet in place. keep=false is a hover preview and is not saved.
export function applyTheme(id: string, keep = true) {
  let link = document.getElementById('tb-theme-css') as HTMLLinkElement | null;
  // terminals read their colours from the theme (terminalTheme.ts); tell them to read again once the stylesheet applies
  const changed = () => window.dispatchEvent(new Event('tb-theme'));
  let wait = false;
  if (id === 'default') link?.remove();
  else {
    if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.id = 'tb-theme-css'; document.head.appendChild(link); }
    const href = `/themes/${id}.css`;
    if (link.getAttribute('href') !== href) { link.onload = link.onerror = changed; link.setAttribute('href', href); wait = true; }
  }
  document.documentElement.dataset.theme = id;
  if (!wait) requestAnimationFrame(changed);
  if (keep) { current = id; try { localStorage.setItem(KEY, id); } catch { /* private mode */ } }
}
export const currentTheme = () => current;
if (typeof document !== 'undefined') applyTheme(current);
