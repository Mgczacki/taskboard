// Which renderer the terminals use: WebGL (the GPU draws the text, @xterm/addon-webgl) or xterm's DOM renderer.
// Saved for this app or browser in localStorage 'tb-term-webgl' ('on' or 'off'), on by default. Settings changes it, and
// open terminals switch at once (Terminal.tsx). The DOM renderer used most of the page CPU under load (task 190); WebGL
// was turned off in task 140 because a new context for each terminal mount could leave a terminal blank.
const KEY = 'tb-term-webgl', EVENT = 'tb-term-renderer';
export const webglOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function setWebglOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage off */ }
  dispatchEvent(new Event(EVENT));
}
export const onRendererChange = (f: () => void) => {
  const storage = (e: StorageEvent) => { if (e.key === KEY) f(); };
  addEventListener(EVENT, f); addEventListener('storage', storage);
  return () => { removeEventListener(EVENT, f); removeEventListener('storage', storage); };
};
