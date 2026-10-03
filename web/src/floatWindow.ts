// The floating windows inside the page (.floatwin: the task browser when the browser blocks its pop-out window, and
// the document preview in Docs.tsx). Their title bar (.fw-h) moves them with the mouse, a pen or a finger.
// clampFloat keeps at least KEEP px of the title bar (not counting its buttons) on the screen, so the window can always
// be moved back.
import type { PointerEvent as ReactPointerEvent } from 'react';

export const KEEP = 80;

// The position that is nearest to (left, top) and keeps the title bar reachable in a viewport of vw x vh:
// - at least `keep` px of the bar that is not a button stays between the left and right edges. The buttons are at the
//   right end of the bar (`buttons` px wide), so a window moved off the left edge keeps keep + buttons px on the screen.
// - the title bar is fully below the top edge and above the bottom edge
// A window narrower than that must stay fully inside the viewport horizontally.
export function clampFloat(left: number, top: number, width: number, barHeight: number, vw: number, vh: number, buttons = 0, keep = KEEP): { left: number; top: number } {
  const k = Math.min(keep, width);
  const minL = Math.min(0, k + buttons - width), maxL = Math.max(minL, vw - k);
  const maxT = Math.max(0, vh - barHeight);
  return { left: Math.round(Math.min(maxL, Math.max(minL, left))), top: Math.round(Math.min(maxT, Math.max(0, top))) };
}

// The title bar of a floating window, its height and the width of the buttons at its right end.
function bar(host: HTMLElement) {
  const h = host.querySelector('.fw-h') as HTMLElement | null;
  const first = h?.querySelector('button');
  return { height: h?.offsetHeight || 40, buttons: h && first ? Math.max(0, h.getBoundingClientRect().right - first.getBoundingClientRect().left) : 0 };
}

// Puts the window back where clampFloat allows (after the viewport became smaller).
export function keepOnScreen(host: HTMLElement) {
  if (host.classList.contains('big')) return;
  const b = bar(host);
  const p = clampFloat(host.offsetLeft, host.offsetTop, host.offsetWidth, b.height, innerWidth, innerHeight, b.buttons);
  if (p.left !== host.offsetLeft) host.style.left = p.left + 'px';
  if (p.top !== host.offsetTop) host.style.top = p.top + 'px';
}

// onPointerDown of the title bar. A press on a button starts no move, and only the main button (or a touch) moves.
// The title bar captures the pointer, so the moves reach it even over the screencast or an iframe and while another
// element has the focus. The title bar has touch-action: none, so a finger moves the window and does not scroll the
// page. During the move, the host has the class 'moving' (no text selection, no pointer events in its body: app.css).
export function startFloatDrag(e: ReactPointerEvent<HTMLElement>, host: HTMLElement) {
  if ((e.target as HTMLElement).closest('button, a, input, select, textarea') || e.button !== 0 || host.classList.contains('big')) return;
  const h = e.currentTarget, id = e.pointerId;
  const sx = e.clientX, sy = e.clientY, l = host.offsetLeft, t = host.offsetTop, w = host.offsetWidth, b = bar(host);
  try { h.setPointerCapture(id); } catch { /* the pointer is gone already */ }
  host.classList.add('moving');
  const mv = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const p = clampFloat(l + ev.clientX - sx, t + ev.clientY - sy, w, b.height, innerWidth, innerHeight, b.buttons);
    host.style.left = p.left + 'px'; host.style.top = p.top + 'px';
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
    host.classList.remove('moving');
  };
  h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
}
