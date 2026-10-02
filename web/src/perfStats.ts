// Counters for the performance monitor (components/PerfMonitor.tsx). It is off by default and saved for this app or
// browser in localStorage 'tb-perf' ('on' or 'off'); the Settings page and the ✕ of the monitor change it.
// While it is on, the sockets of the page (api.ts events, terminals, task browsers) count their messages here, and a
// PerformanceObserver keeps the long tasks of the main thread (50 ms or longer) of the last minute.
const KEY = 'tb-perf', EVENT = 'tb-perf';
export const perfOn = () => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } };
export function setPerfOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage off */ }
  dispatchEvent(new Event(EVENT));
}
export const onPerfChange = (f: () => void) => {
  const storage = (e: StorageEvent) => { if (e.key === KEY) f(); };
  addEventListener(EVENT, f); addEventListener('storage', storage);
  return () => { removeEventListener(EVENT, f); removeEventListener('storage', storage); };
};

let counting = false, messages = 0, bytes = 0;
// a socket message: a string, a Blob (task browser frames) or an ArrayBuffer
export function countMessage(data: unknown) {
  if (!counting) return;
  messages++;
  bytes += typeof data === 'string' ? data.length : data instanceof Blob ? data.size : data instanceof ArrayBuffer ? data.byteLength : 0;
}
export const readMessages = () => ({ messages, bytes });

const longTasks: { at: number; ms: number }[] = [];
let observer: PerformanceObserver | null = null;
export function startCounting() {
  counting = true;
  if (observer || typeof PerformanceObserver === 'undefined') return;
  try {
    observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push({ at: Date.now(), ms: Math.round(e.duration) }); });
    observer.observe({ type: 'longtask' });
  } catch { observer = null; }
}
export function stopCounting() { counting = false; observer?.disconnect(); observer = null; longTasks.length = 0; }
// the long tasks of the last minute: how many, and the longest
export function lastMinute() {
  const since = Date.now() - 60000;
  while (longTasks.length && longTasks[0].at < since) longTasks.shift();
  return { count: longTasks.length, longest: longTasks.reduce((m, x) => Math.max(m, x.ms), 0) };
}
