// The Hide button on a canvas window and the removeWindow shortcut (Canvas.tsx). A group view has no Hide button: a
// drag onto the Ungrouped tab or onto another group tab takes a task out of a group (groupMove.ts). In the other views
// (Ungrouped, Needs you, Live and a custom t:<ids> view) Hide takes the window off that view only. It changes no group.
// The views are computed from the tasks, so the hidden windows are kept in memory: a page reload shows them again.
// Kept apart from Canvas.tsx so tests/hide-window.test.ts can run it.

// the hidden task ids of each view, by view id
export type HiddenByView = Record<string, string[]>;

export const canHide = (view: string) => !view.startsWith('g:');

export const HIDE_TITLE = 'Hide this window in this view until you reload the page. The agent keeps running, and its groups do not change.';
export const GROUP_HINT = 'To take a task out of this group, drag its window onto the Ungrouped tab or onto another group tab.';

export function hide(h: HiddenByView, view: string, id: string): HiddenByView {
  if (!canHide(view)) return h;
  const now = h[view] || [];
  return now.includes(id) ? h : { ...h, [view]: [...now, id] };
}

// shows one window again (Add window) or, without an id, every hidden window of the view (Show hidden)
export function unhide(h: HiddenByView, view: string, id?: string): HiddenByView {
  if (!h[view]) return h;
  const rest = id === undefined ? [] : h[view].filter(x => x !== id);
  const n = { ...h };
  if (rest.length) n[view] = rest; else delete n[view];
  return n;
}

// the windows of the view that are hidden: only ids that the view would show
export const hiddenHere = (h: HiddenByView, view: string, ids: string[]) => ids.filter(id => (h[view] || []).includes(id));
