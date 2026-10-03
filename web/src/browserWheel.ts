// Wheel input of the task browser view (TaskBrowser.tsx). The view sends each scroll to the page as a 'mouse' message
// with event 'mouseWheel', and server/task-browser.ts dispatches it with Input.dispatchMouseEvent. That call takes
// CSS pixels, so a wheel event in lines or pages is converted first.
// - deltaMode 0 (pixels): a Mac trackpad and Chrome's own mouse wheel. The deltas go as they are, fractions included,
//   so the scroll keeps the speed and the momentum (inertia) of the trackpad. macOS already applied natural scrolling
//   to the sign, so the sign is kept.
// - deltaMode 1 (lines): a mouse wheel in Firefox. One line is 40 px, the step that Chrome scrolls for one line.
// - deltaMode 2 (pages): one page is the width or the height of the page in the view, as in Chrome.
// Shift with a vertical wheel scrolls sideways. macOS does that itself for a mouse wheel (deltaX arrives), but a
// browser on another system, and headless Chrome, do not. The Shift bit is taken out of the modifiers of such an
// event, so Chrome does not turn it a second time.
// A trackpad sends up to 120 wheel events a second. The view adds them up and sends one message for each animation
// frame, with the position and the modifiers of the newest event. An event with other modifiers (Ctrl from a pinch)
// first sends the sum so far, so two kinds of scroll never mix in one message.

export const LINE_PX = 40;
export const SHIFT = 8; // the modifier bits of the view: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift

export interface WheelInput { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }
export interface WheelMessage { type: 'mouse'; event: 'mouseWheel'; x: number; y: number; dx: number; dy: number; modifiers: number }

// The deltas of one wheel event in CSS pixels of the page. page: the size of the page's viewport in CSS pixels.
export function wheelPixels(e: WheelInput, page: { w: number; h: number }): { dx: number; dy: number; sideways: boolean } {
  const ux = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? page.w : 1;
  const uy = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? page.h : 1;
  const dx = (Number.isFinite(e.deltaX) ? e.deltaX : 0) * ux, dy = (Number.isFinite(e.deltaY) ? e.deltaY : 0) * uy;
  if (e.shiftKey && dx === 0 && dy !== 0) return { dx: dy, dy: 0, sideways: true };
  return { dx, dy, sideways: false };
}

// Adds up wheel events and sends one message for each frame. schedule and cancel are requestAnimationFrame and
// cancelAnimationFrame in the page; the tests pass their own.
export function wheelBatch(send: (m: WheelMessage) => void, schedule: (f: () => void) => number = f => requestAnimationFrame(f), cancel: (h: number) => void = h => cancelAnimationFrame(h)) {
  let sum: WheelMessage | null = null, handle = 0;
  const flush = () => {
    if (handle) { cancel(handle); handle = 0; }
    const m = sum; sum = null;
    if (m && (m.dx || m.dy)) send(m);
  };
  // e: the wheel event; at: its point in the page; modifiers: the modifier bits of the event
  const add = (e: WheelInput, at: { x: number; y: number }, modifiers: number, page: { w: number; h: number }) => {
    const p = wheelPixels(e, page);
    const mod = p.sideways ? modifiers & ~SHIFT : modifiers;
    if (sum && sum.modifiers !== mod) flush();
    if (!sum) sum = { type: 'mouse', event: 'mouseWheel', x: at.x, y: at.y, dx: 0, dy: 0, modifiers: mod };
    sum.x = at.x; sum.y = at.y; sum.dx += p.dx; sum.dy += p.dy;
    if (!handle) handle = schedule(() => { handle = 0; flush(); });
  };
  // the next frame does not come: drop the waiting sum (the view closes)
  const stop = () => { if (handle) cancel(handle); handle = 0; sum = null; };
  return { add, flush, stop };
}
