import { useLayoutEffect, type RefObject } from 'react';

type Position = { left: number; top: number };
const positions = new Map<string, Position>();
const prefix = 'tb-scroll:';

function read(key: string): Position {
  const cached = positions.get(key);
  if (cached) return cached;
  try {
    const value = JSON.parse(sessionStorage.getItem(prefix + key) || 'null');
    if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) {
      const position = { left: Math.max(0, value.left), top: Math.max(0, value.top) };
      positions.set(key, position);
      return position;
    }
  } catch { /* storage is optional */ }
  return { left: 0, top: 0 };
}

function write(key: string, position: Position) {
  positions.set(key, position);
  try { sessionStorage.setItem(prefix + key, JSON.stringify(position)); } catch { /* storage is optional */ }
}

// Keep an offset until content loaded after the view mounted. A user scroll ends that wait.
export function useScrollPosition(ref: RefObject<HTMLElement | null>, key: string, ready = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const wanted = read(key);
    let pending = true;
    let frame = 0;
    const restore = () => {
      if (!pending) return;
      el.scrollLeft = Math.min(wanted.left, Math.max(0, el.scrollWidth - el.clientWidth));
      el.scrollTop = Math.min(wanted.top, Math.max(0, el.scrollHeight - el.clientHeight));
      if (Math.abs(el.scrollLeft - wanted.left) < 1 && Math.abs(el.scrollTop - wanted.top) < 1) {
        frame = requestAnimationFrame(() => { pending = false; });
      }
    };
    const save = () => {
      if (!pending) write(key, { left: el.scrollLeft, top: el.scrollTop });
    };
    const userScroll = () => { pending = false; save(); };
    el.addEventListener('scroll', save);
    el.addEventListener('wheel', userScroll, { passive: true });
    el.addEventListener('touchstart', userScroll, { passive: true });
    const resize = new ResizeObserver(restore);
    resize.observe(el);
    const content = new MutationObserver(() => {
      for (const child of el.children) resize.observe(child);
      restore();
    });
    content.observe(el, { childList: true });
    for (const child of el.children) resize.observe(child);
    restore();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', save);
      el.removeEventListener('wheel', userScroll);
      el.removeEventListener('touchstart', userScroll);
      resize.disconnect();
      content.disconnect();
    };
  }, [ref, key, ready]);
}
