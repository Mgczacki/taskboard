// Keyboard shortcuts: every action with a key, its default keys, and the keys the user set on the Settings page.
// A key is written as modifiers + KeyboardEvent.code, for example 'Ctrl+Alt+KeyG' or 'Shift+Meta+BracketRight'.
// e.code names the physical key, so ⌥ (which changes e.key on a Mac) does not change it.
// Saved per browser or app in localStorage 'tb-keys' (only the actions the user changed); other windows follow.
import { useSyncExternalStore } from 'react';

export type KeyCtx = 'app' | 'triage' | 'canvas' | 'review' | 'graph';
export interface KeyAction {
  id: string; ctx: KeyCtx; label: string; keys: string[];
  // false: never while the cursor is in a terminal or a text field, also with ⌘ or ⌃ (⌘↩ in a comment box saves the comment)
  inFields?: false;
}

export const CTX_NAME: Record<KeyCtx, string> = { app: 'Anywhere', triage: 'Triage', canvas: 'Canvas', review: 'Review page', graph: 'Graph page' };

export const ACTIONS: KeyAction[] = [
  { id: 'newTask', ctx: 'app', label: 'New task', keys: ['Meta+KeyT', 'KeyN'] },
  { id: 'controller', ctx: 'app', label: 'Open the controller', keys: ['Meta+KeyK', 'Ctrl+Alt+KeyK', 'KeyC'] },
  { id: 'sidebar', ctx: 'app', label: 'Hide or show the sidebar', keys: ['Meta+KeyS'] },
  { id: 'triage', ctx: 'app', label: 'Triage: everything waiting on you', keys: ['Ctrl+Alt+KeyQ', 'KeyT'] },
  { id: 'needsView', ctx: 'app', label: 'Canvas view “Needs you + unread”', keys: ['Ctrl+Alt+KeyU'] },
  { id: 'nextStyle', ctx: 'app', label: 'Next style', keys: ['Ctrl+Alt+KeyY'] },
  { id: 'keysHelp', ctx: 'app', label: 'List of keyboard shortcuts', keys: ['Shift+Slash'] },
  { id: 'triageNext', ctx: 'triage', label: 'Next task in triage', keys: ['Ctrl+Alt+ArrowDown'] },
  { id: 'triagePrev', ctx: 'triage', label: 'Previous task in triage', keys: ['Ctrl+Alt+ArrowUp'] },
  { id: 'nextView', ctx: 'canvas', label: 'Next view (group tab)', keys: ['Ctrl+Alt+KeyG', 'Ctrl+Alt+Tab', 'Shift+Meta+BracketRight'] },
  { id: 'prevView', ctx: 'canvas', label: 'Previous view (group tab)', keys: ['Ctrl+Alt+Shift+Tab', 'Shift+Meta+BracketLeft'] },
  { id: 'newGroup', ctx: 'canvas', label: 'New group', keys: ['Ctrl+Alt+Shift+KeyG'] },
  { id: 'canvasNewTask', ctx: 'canvas', label: 'New task in this canvas view', keys: ['Ctrl+Alt+KeyT'] },
  { id: 'nextWindow', ctx: 'canvas', label: 'Focus the next window', keys: ['Ctrl+Alt+ArrowRight', 'Ctrl+Alt+ArrowDown'] },
  { id: 'prevWindow', ctx: 'canvas', label: 'Focus the previous window', keys: ['Ctrl+Alt+ArrowLeft', 'Ctrl+Alt+ArrowUp'] },
  { id: 'nextNeedy', ctx: 'canvas', label: 'Next window waiting on you', keys: ['Ctrl+Alt+KeyN'] },
  { id: 'maximize', ctx: 'canvas', label: 'Maximize the focused window', keys: ['Ctrl+Alt+Enter'] },
  { id: 'layout', ctx: 'canvas', label: 'Change layout: columns, grid, rows', keys: ['Ctrl+Alt+KeyL'] },
  { id: 'focusMode', ctx: 'canvas', label: 'Focus mode', keys: ['Ctrl+Alt+KeyF'] },
  { id: 'nextPage', ctx: 'canvas', label: 'Next page (when Per page is on)', keys: ['Ctrl+Alt+PageDown', 'Ctrl+Alt+BracketRight'] },
  { id: 'prevPage', ctx: 'canvas', label: 'Previous page (when Per page is on)', keys: ['Ctrl+Alt+PageUp', 'Ctrl+Alt+BracketLeft'] },
  { id: 'fontUp', ctx: 'canvas', label: 'Larger text in the focused window', keys: ['Ctrl+Alt+Period'] },
  { id: 'fontDown', ctx: 'canvas', label: 'Smaller text in the focused window', keys: ['Ctrl+Alt+Comma'] },
  { id: 'removeWindow', ctx: 'canvas', label: 'Remove the focused window from the view', keys: ['Ctrl+Alt+KeyW'] },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: `window${n}`, ctx: 'canvas' as const, label: `Focus window ${n}`, keys: [`Ctrl+Alt+Digit${n}`] })),
  { id: 'reviewNext', ctx: 'review', label: 'Next document', keys: ['KeyJ'] },
  { id: 'reviewPrev', ctx: 'review', label: 'Previous document', keys: ['KeyK'] },
  { id: 'reviewComment', ctx: 'review', label: 'Comment on the selected text', keys: ['KeyC'] },
  { id: 'reviewAccept', ctx: 'review', label: 'Accept the document', keys: ['KeyA'] },
  { id: 'reviewSend', ctx: 'review', label: 'Send feedback to the task', keys: ['Meta+Enter', 'Ctrl+Enter'], inFields: false },
  { id: 'graphFit', ctx: 'graph', label: 'Fit the graph to the window', keys: ['KeyF'] },
];
const BY_ID = new Map(ACTIONS.map(a => [a.id, a]));

// ---------- saved keys ----------
const STORE = 'tb-keys';
const read = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; } };
let custom = read();
let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach(f => f()); };
addEventListener('storage', e => { if (e.key === STORE) { custom = read(); changed(); } });
const write = () => { try { localStorage.setItem(STORE, JSON.stringify(custom)); } catch { /* storage off */ } changed(); };

export const keysOf = (id: string): string[] => custom[id] ?? BY_ID.get(id)?.keys ?? [];
export const isCustom = (id: string) => id in custom;
export const setKeys = (id: string, keys: string[]) => {
  const def = BY_ID.get(id)?.keys || [];
  if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete custom[id]; else custom[id] = keys;
  write();
};
export const resetKeys = (id?: string) => { if (id) delete custom[id]; else custom = {}; write(); };
// re-render when the keys change (labels in buttons and titles)
export const useKeymap = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => version);

// ---------- matching ----------
const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MOD_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);
export const comboOf = (e: KeyboardEvent): string | null => {
  if (!e.code || MOD_CODES.has(e.code)) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code].filter(Boolean).join('+');
};
// ⌘ or ⌃ keys work while you type in a terminal or a text field; a key without them is typing there
export const worksInFields = (combo: string) => /(^|\+)(Ctrl|Meta)\+/.test(combo);
const inField = (e: KeyboardEvent) => !!(e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable=true],.xterm');

// the Settings page sets this while it waits for a new key, so the key does not also run an action
let recording = false;
export const setRecording = (on: boolean) => { recording = on; };

export const hit = (e: KeyboardEvent, id: string) => {
  if (recording || e.type !== 'keydown') return false;
  const c = comboOf(e); if (!c || !keysOf(id).includes(c)) return false;
  if (!inField(e)) return true;
  return BY_ID.get(id)?.inFields !== false && worksInFields(c);
};
export const hitIn = (e: KeyboardEvent, ctx: KeyCtx) => ACTIONS.some(a => a.ctx === ctx && hit(e, a.id));
// Terminal.tsx: keys that belong to Taskboard and are not sent to the agent (every ⌃⌥ key, and every ⌘ / ⌃ key set here)
export const taskboardKey = (e: KeyboardEvent) => {
  if (recording) return true;
  if (e.ctrlKey && e.altKey) return true;
  const c = comboOf(e);
  return !!c && worksInFields(c) && ACTIONS.some(a => a.inFields !== false && keysOf(a.id).includes(c));
};

// ---------- labels ----------
const NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↩', NumpadEnter: '↩', Tab: '⇥', Escape: 'Esc', Space: 'Space',
  Backspace: '⌫', Delete: '⌦', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=',
};
const SYM: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
export const fmtCombo = (combo: string) => {
  const parts = combo.split('+'), code = parts.pop()!;
  if (code === 'Slash' && parts.length === 1 && parts[0] === 'Shift') return '?';
  const key = NAMES[code] || code.replace(/^Key|^Digit|^Numpad/, '');
  return MODS.filter(m => parts.includes(m)).map(m => SYM[m]).join('') + key;
};
// the first key of an action, for a button; '' when the user removed all its keys
export const keyLabel = (id: string) => { const k = keysOf(id)[0]; return k ? fmtCombo(k) : ''; };
// every key of an action, for a title: '⌃⌥G or ⌃⌥⇥'
export const keysText = (id: string) => keysOf(id).map(fmtCombo).join(' or ') || 'no key';
