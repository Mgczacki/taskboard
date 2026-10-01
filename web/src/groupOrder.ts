// Dragging a group tab on the Canvas page to a new position, and the keys that move the current tab left or right.
// Kept apart from Canvas.tsx (and from api.ts, which opens a WebSocket on import) so tests/group-order.test.ts can run it.
//
// A slot is a gap between two group tabs: slot 0 is before the first tab, slot n is after the last of n tabs.
// The server saves the new order with POST /api/groups/order (reorder() in server/groups.ts).

// The slot for a pointer at `x`: the number of tabs whose middle is to the left of `x`.
// `tabs` are the left edge and width of each group tab, in the order they show.
export function slotAt(tabs: { left: number; width: number }[], x: number): number {
  return tabs.filter(t => t.left + t.width / 2 < x).length;
}

// The ids after `id` moves to `slot`. Returns null when the order does not change
// (the slot is just before or just after the tab itself), so no request is sent.
export function moveToSlot(ids: string[], id: string, slot: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const s = Math.max(0, Math.min(ids.length, slot));
  if (s === from || s === from + 1) return null;
  const rest = ids.filter(x => x !== id);
  rest.splice(s > from ? s - 1 : s, 0, id);
  return rest;
}

// The ids after `id` moves `by` places (-1 is one place to the left). Returns null at either end.
export function moveBy(ids: string[], id: string, by: number): string[] | null {
  const from = ids.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  return moveToSlot(ids, id, by > 0 ? to + 1 : to);
}

// The groups in the order of `ids` while the server has not yet sent the saved order back.
// A group that is not in `ids` goes at the end. An id without a group is left out.
export function inOrder<G extends { id: string }>(groups: G[], ids: string[] | null): G[] {
  if (!ids) return groups;
  const at = new Map(ids.map((id, i) => [id, i]));
  return [...groups].sort((a, b) => (at.get(a.id) ?? ids.length) - (at.get(b.id) ?? ids.length));
}

// The text in the drag label, for example "Auth → position 2 of 4".
export function slotHint(ids: string[], id: string, name: string, slot: number | null): string {
  const next = slot === null ? null : moveToSlot(ids, id, slot);
  return next ? `${name} → position ${next.indexOf(id) + 1} of ${ids.length}` : `${name}: drop between two group tabs`;
}
