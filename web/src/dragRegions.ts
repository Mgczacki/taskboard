// The window drag area of the app, computed the way Electron computes it, to check that no control is inside it.
// Electron reads -webkit-app-region from every element in document order. It adds the box of each drag element and
// cuts out the box of each later no-drag element. z-index, pointer-events and visibility do not count. A click inside
// the result moves the window instead of reaching the page (the controller bar bug of task #196).
// Both functions below are self-contained: scripts/check-drag-regions.mjs runs them in a page with Function.toString.

export type DragBox = { drag: boolean; left: number; top: number; right: number; bottom: number; what: string };

// The box that decides the point: the last box in document order that contains it. The point is in the drag area
// when that box is a drag box. null: no box contains it, so a click reaches the page.
export function dragBoxAt(boxes: DragBox[], x: number, y: number): DragBox | null {
  let last: DragBox | null = null;
  for (const b of boxes) if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) last = b;
  return last && last.drag ? last : null;
}

export type DragProblem = { what: string; rect: [number, number, number, number]; region: string; problem: string };
export type DragReport = { boxes: number; controls: number; problems: DragProblem[] };

// Lists each visible control whose top edge is within `px` of the top of the page and reports a problem when:
// - its computed -webkit-app-region is not no-drag, or
// - a point of it (center, or a corner 2 px inside) that it would get a click at is in the drag area that dragBoxAt
//   computes, or is covered by a pseudo-element of body.
export function dragRegionReport(boxAt: typeof dragBoxAt, px = 40): DragReport {
  const label = (el: Element) => {
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}${t ? ` "${t}"` : ''}`;
  };
  const region = (s: CSSStyleDeclaration) => s.getPropertyValue('-webkit-app-region') || (s as unknown as { webkitAppRegion?: string }).webkitAppRegion || 'none';
  const px2 = (v: string) => (v.endsWith('px') ? parseFloat(v) : NaN);
  const boxes: DragBox[] = [];
  const add = (r: string, left: number, top: number, right: number, bottom: number, what: string) => {
    if ((r === 'drag' || r === 'no-drag') && right > left && bottom > top) boxes.push({ drag: r === 'drag', left, top, right, bottom, what });
  };
  // a ::before or ::after with an app-region: only position fixed is measured (the strip at the top edge is one)
  const pseudo = (el: Element, which: '::before' | '::after') => {
    const s = getComputedStyle(el, which);
    if (s.content === 'none' || s.content === 'normal' || region(s) === 'none') return;
    if (s.position !== 'fixed') throw new Error(`${label(el)}${which} has an app-region and is not position: fixed; the check can not measure it`);
    const l = px2(s.left), t = px2(s.top), w = px2(s.width), h = px2(s.height);
    const left = isNaN(l) ? 0 : l, top = isNaN(t) ? 0 : t;
    add(region(s), left, top, isNaN(w) ? innerWidth - left : left + w, isNaN(h) ? innerHeight - top : top + h, label(el) + which);
  };
  const walk = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === 'none') return;
    if (s.display !== 'contents') { const r = el.getBoundingClientRect(); add(region(s), r.left, r.top, r.right, r.bottom, label(el)); }
    pseudo(el, '::before');
    for (const c of el.children) walk(c);
    pseudo(el, '::after');
  };
  walk(document.body);

  const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, label, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const problems: DragProblem[] = [];
  let controls = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (!el.matches(CONTROLS) && s.cursor !== 'pointer') continue;
    // a pointer cursor inherited from a control (its text, its icon) is part of that control
    if (!el.matches(CONTROLS) && el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.top >= px || r.bottom <= 0 || s.visibility === 'hidden' || !el.getClientRects().length) continue;
    controls++;
    const rect: DragProblem['rect'] = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
    const own = region(s);
    if (own !== 'no-drag') problems.push({ what: label(el), rect, region: own, problem: 'its -webkit-app-region is not no-drag' });
    const i = Math.min(2, r.width / 2, r.height / 2);
    const pts: [number, number][] = [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + i, r.top + i], [r.right - i, r.top + i], [r.left + i, r.bottom - i], [r.right - i, r.bottom - i]];
    for (const [x, y] of pts) {
      if (y < 0 || y >= innerHeight || x < 0 || x >= innerWidth) continue;
      // another element in front (a page control under the drawer) gets this point, so it is not this control's click.
      // body or html in front means a ::before or ::after on them covers the control and takes the click.
      const front = document.elementFromPoint(x, y);
      if (front === document.body || front === document.documentElement) { problems.push({ what: label(el), rect, region: own, problem: `the point ${Math.round(x)},${Math.round(y)} is covered by a pseudo-element of ${front.tagName.toLowerCase()}` }); break; }
      if (front && !el.contains(front)) continue;
      const b = boxAt(boxes, x, y);
      if (b) { problems.push({ what: label(el), rect, region: own, problem: `the point ${Math.round(x)},${Math.round(y)} is in the drag area of ${b.what}` }); break; }
    }
  }
  return { boxes: boxes.length, controls, problems };
}
