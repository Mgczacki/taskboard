// Text for the browser and process counts of tasks (TaskRuntime.tsx, GroupRuntime.tsx). No React and no API calls here,
// so tests/runtime-summary.test.ts can import it.
import type { RuntimeCount, RuntimeList } from './api';

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "1 browser · 2 processes", or '' when nothing runs
export function countText(c?: RuntimeCount) {
  if (!c) return '';
  return [c.browser ? plural(c.browser, 'browser', 'browsers') : '', c.procs ? plural(c.procs, 'process', 'processes') : ''].filter(Boolean).join(' · ');
}
// the counts of several tasks added up, for the Canvas toolbar and the group view
export function sumCounts(counts: Record<string, RuntimeCount>, ids: string[]): RuntimeCount {
  return ids.reduce((s, id) => ({ browser: s.browser + (counts[id]?.browser || 0), procs: s.procs + (counts[id]?.procs || 0) }), { browser: 0, procs: 0 });
}
export const mb = (n: number | null | undefined) => n === null || n === undefined ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
export function totalText(t: RuntimeList['total']) {
  return `${plural(t.browsers, 'browser', 'browsers')} and ${plural(t.procs, 'process', 'processes')} running · about ${mb(t.memMb)}`;
}
