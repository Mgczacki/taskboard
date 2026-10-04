// A popup list under a button: the More menu of the Canvas toolbar and the menu of a narrow window header (Canvas.tsx).
// It is position: fixed at the button, so the toolbar or the window (overflow: hidden) does not cut it off.
// Keys: the first control gets the focus when it opens. Down and Up move between its controls, Home and End go to the
// first and the last, Tab moves as usual. Escape closes it and gives the focus back to the button. A mousedown outside
// the popup and the button closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])';

// align: 'right' (default) puts the right edge of the popup at the right edge of the button; 'left' puts its left edge
// at the left edge of the button, moved left as far as needed to stay 8 px inside the window.
export function PopMenu({ anchor, close, className = '', label, align = 'right', children }: { anchor: HTMLElement | null; close: () => void; className?: string; label: string; align?: 'left' | 'right'; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // placed on the first render, so the popup is visible when its first control takes the focus
  const where = () => {
    const r = anchor?.getBoundingClientRect(); if (!r) return null;
    const top = r.bottom + 4;
    const maxHeight = Math.max(120, innerHeight - top - 12);
    if (align === 'left') return { top, left: Math.max(8, Math.min(r.left, innerWidth - 8 - (box.current?.offsetWidth || 0))), maxHeight };
    return { top, right: Math.max(8, innerWidth - r.right), maxHeight };
  };
  const [pos, setPos] = useState(where);
  useLayoutEffect(() => {
    const place = () => setPos(where());
    place();
    addEventListener('resize', place); return () => removeEventListener('resize', place);
  }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  // close in a ref: a caller may pass a new function on each render, and the focus moves only when the popup opens
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => { box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(); }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor?.contains(t) && !(t as HTMLElement).closest?.('.rtb-pop')) closeRef.current(); };
    addEventListener('mousedown', down, true); return () => removeEventListener('mousedown', down, true);
  }, [anchor]);
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); e.stopPropagation(); list[(i + list.length) % list.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); anchor?.focus(); }
    else if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
  };
  return (
    <div ref={box} className={`pop-menu ${className}`} role="group" aria-label={label} onKeyDown={onKey}
      style={pos ? { top: pos.top, left: 'left' in pos ? pos.left : undefined, right: 'right' in pos ? pos.right : undefined, maxHeight: pos.maxHeight } : { visibility: 'hidden' }}
      // a click in the menu is not a click on the window or the header under it (focus, drag, maximize)
      onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      {children}
    </div>
  );
}
