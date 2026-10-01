// Dragging a terminal window on the Canvas page to a new position, and the keys that move the focused window.
// Kept apart from Canvas.tsx (and from api.ts, which opens a WebSocket on import) so tests/tile-order.test.ts can run it.
// The order changes use moveToSlot() and moveBy() from groupOrder.ts, where a slot is the gap between two items.
//
// Where the order is saved:
// - a group view (g:<id>): the order of the group's tasks list, with POST /api/groups/:id/order (reorderTasks() in
//   server/groups.ts). The group keeps the same tasks.
// - every other view: TASKBOARD_DIR/canvas-order.json, with POST /api/canvas/order (server/canvasOrder.ts), under the
//   key that orderKey() gives.
import { inOrder } from './groupOrder';

// The key in canvas-order.json for a view, or null for a group view. A hand-picked view (t:<id,id,...>) lists its
// tasks in the URL. Its key has the ids sorted, so the key does not change when the windows move.
export function orderKey(view: string): string | null {
  if (view.startsWith('g:')) return null;
  if (view.startsWith('t:')) return 't:' + view.slice(2).split(',').filter(Boolean).sort().join(',');
  return view;
}

// The ids of a view in the saved order: the saved ids first, then the others in their old order.
// So a new task comes after the windows that the user moved. Without a saved order the ids stay as they are.
export function withSavedOrder(ids: string[], saved: string[] | undefined): string[] {
  return saved?.length ? inOrder(ids.map(id => ({ id })), saved).map(x => x.id) : ids;
}

// The slot for a pointer at (x, y) among the windows on screen, in the order they show.
// The window under the pointer, or else the nearest one, decides: its first half is the slot before it, its second
// half the slot after it. `vertical` is true for the Rows layout, where the halves are the top and the bottom.
export function slotNear(rects: { left: number; top: number; width: number; height: number }[], x: number, y: number, vertical: boolean): number | null {
  if (!rects.length) return null;
  const gap = (r: typeof rects[number]) => Math.hypot(Math.max(r.left - x, 0, x - r.left - r.width), Math.max(r.top - y, 0, y - r.top - r.height));
  let best = 0;
  rects.forEach((r, i) => { if (gap(r) < gap(rects[best])) best = i; });
  const r = rects[best];
  const after = vertical ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
  return best + (after ? 1 : 0);
}

// The order in which the windows are put in the page. It does not depend on the order on screen: CSS `order` sets
// that. So a move changes only a style. React does not take a terminal out of the page and put it back, and the
// terminal keeps its connection, its output and its scroll position.
export function renderOrder<T extends { id: string }>(shown: T[]): { item: T; at: number }[] {
  return shown.map((item, at) => ({ item, at })).sort((a, b) => a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
}

// The text in the drag label, for example "#12 → position 2 of 5".
export function tileHint(next: string[] | null, id: string, num: number | string): string {
  return next ? `#${num} → position ${next.indexOf(id) + 1} of ${next.length}` : `#${num}: drop between two windows, or on a group tab`;
}
