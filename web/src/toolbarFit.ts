// Which items of the Canvas toolbar move into its More menu, so the toolbar stays one row.
// The toolbar (Canvas.tsx) measures the width of each item while it shows in the toolbar and keeps that width, so an
// item in the menu still has a width here. The window count text is not an item: its width starts at 0 and it shrinks
// with an ellipsis, so it gives its space first. It still has one gap on each side.
//
// keep 0: the item never moves (New task, the layout buttons, the pager). A lower keep moves first. Between two items
// with the same keep, the later one in the toolbar moves first. The menu lists its items in toolbar order.
export interface FitItem { k: string; keep: number; w: number }
export interface Fit { overflow: string[]; tight: boolean }

const need = (items: FitItem[], gap: number, more: number) => {
  // the items, the count text (width 0) and the More button when there is one, with a gap between two of them
  const n = items.length + 1 + (more ? 1 : 0);
  return items.reduce((s, i) => s + i.w, 0) + more + gap * (n - 1);
};

// avail: the inner width of the toolbar. moreW: the width of the More button.
// tight: the items that never move do not fit with the More button, so every other item moves and the toolbar uses
// the short texts (Canvas.tsx). If even those do not fit, the toolbar wraps to a second row as the last choice.
export function fitToolbar(items: FitItem[], avail: number, gap: number, moreW: number): Fit {
  if (!(avail > 0) || need(items, gap, 0) <= avail) return { overflow: [], tight: false };
  const fixed = items.filter(i => i.keep === 0);
  if (need(fixed, gap, moreW) > avail) return { overflow: items.filter(i => i.keep > 0).map(i => i.k), tight: true };
  const order = items.map((i, at) => ({ i, at })).filter(x => x.i.keep > 0).sort((a, b) => a.i.keep - b.i.keep || b.at - a.at);
  const out = new Set<string>();
  let shown = items;
  for (const { i } of order) {
    if (need(shown, gap, moreW) <= avail) break;
    out.add(i.k); shown = shown.filter(x => x !== i);
  }
  return { overflow: items.filter(i => out.has(i.k)).map(i => i.k), tight: false };
}

export const sameFit = (a: Fit, b: Fit) => a.tight === b.tight && a.overflow.join() === b.overflow.join();
