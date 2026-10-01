// Date range and tooltip values for the Stats page (components/Stats.tsx). The page shows only the days in the
// selected range. The functions here have no React or DOM code, so tests/stats-range.test.ts can check them.
import { formatTokens } from './formatTokens';

export type Agent = 'claude' | 'codex' | 'antigravity';
export type Account = { id: string; name: string; agent: Agent };
export type AccountDay = { tokens: number; turns: number; taskboardTokens: number; otherTokens: number };
export type Day = { date: string; tokens: number; estimatedTokens: number; turns: number; started: number; imported: number; archived: number; byAccount: Record<string, AccountDay> };
export type Measure = 'tokens' | 'turns' | 'started' | 'archived';
export type TipRow = { label: string; value: string; swatch?: string; strong?: boolean };
export type Tip = { title: string; sub?: string; rows: TipRow[] };

export const RANGES = [7, 28] as const;
export type Range = (typeof RANGES)[number];
// Before the range selector, the page showed a 30-day activity chart. 28 days is the nearest choice.
export const DEFAULT_RANGE: Range = 28;
export const RANGE_KEY = 'tb-stats-range';
export const AGENTS: { agent: Agent; label: string }[] = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
  { agent: 'antigravity', label: 'Antigravity estimate' },
];
export const MEASURE_LABEL: Record<Measure, string> = { tokens: 'Tokens', turns: 'Turns', started: 'Tasks started', archived: 'Tasks archived' };

export const parseRange = (saved: string | null | undefined): Range => RANGES.find(r => String(r) === saved) ?? DEFAULT_RANGE;
export const zero = (date: string): Day => ({ date, tokens: 0, estimatedTokens: 0, turns: 0, started: 0, imported: 0, archived: 0, byAccount: {} });
export const addDays = (day: string, n: number) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const pretty = (n: number) => new Intl.NumberFormat().format(n);
export const tokenText = (n: number, estimated = false) => `${estimated ? '~' : ''}${formatTokens(Math.round(n))}`;
// Tooltips show the exact count, not the rounded "1.2 million" form.
const exactTokens = (n: number, estimated = false) => `${estimated ? '~' : ''}${pretty(Math.round(n))}`;
const weekday = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });

// The dates of the range, oldest first. The last date is today.
export const rangeDates = (today: string, days: Range) => Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
export const rangeDays = (byDate: Map<string, Day>, dates: string[]) => dates.map(d => byDate.get(d) || zero(d));

export function totals(days: Day[]) {
  const t = { tokens: 0, estimatedTokens: 0, turns: 0, started: 0, imported: 0, archived: 0 };
  for (const d of days) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += d[k];
  return t;
}

// Account rows for the table: the sum over the given days.
export function accountTotals(days: Day[]): Record<string, AccountDay> {
  const out: Record<string, AccountDay> = {};
  for (const d of days) for (const [id, a] of Object.entries(d.byAccount)) {
    const o = out[id] ||= { tokens: 0, turns: 0, taskboardTokens: 0, otherTokens: 0 };
    o.tokens += a.tokens; o.turns += a.turns; o.taskboardTokens += a.taskboardTokens; o.otherTokens += a.otherTokens;
  }
  return out;
}

export const agentTokens = (d: Day, accounts: Account[], agent: Agent) => accounts.filter(a => a.agent === agent).reduce((sum, a) => sum + (d.byAccount[a.id]?.tokens || 0), 0);

// Color levels 1 to 4 for the calendar cells: the quartiles of the nonzero values in the range.
export function levels(values: number[]) {
  const sorted = values.filter(x => x > 0).sort((a, b) => a - b);
  const limits = [0.25, 0.5, 0.75].map(x => sorted[Math.floor((sorted.length - 1) * x)] || 0);
  return (n: number) => !n ? 0 : n <= limits[0] ? 1 : n <= limits[1] ? 2 : n <= limits[2] ? 3 : 4;
}

// Calendar rows for the range: one row for each week, Monday first. null fills the days before the first date
// and after the last date.
export function calendarWeeks(dates: string[]): (string | null)[][] {
  if (!dates.length) return [];
  const lead = (new Date(dates[0] + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...dates];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

export function tokenTip(d: Day, accounts: Account[]): Tip {
  return { title: d.date, sub: weekday(d.date), rows: [
    { label: 'Total tokens', value: exactTokens(d.tokens, !!d.estimatedTokens), strong: true },
    ...AGENTS.map(a => ({ label: a.label, value: exactTokens(agentTokens(d, accounts, a.agent), a.agent === 'antigravity'), swatch: `agent-${a.agent}` })),
  ] };
}

export function activityTip(d: Day): Tip {
  return { title: d.date, sub: weekday(d.date), rows: [
    { label: 'Turns', value: pretty(d.turns), swatch: 'turns' },
    { label: 'Tasks started', value: pretty(d.started), swatch: 'started' },
    { label: 'Tasks archived', value: pretty(d.archived), swatch: 'archived' },
    { label: 'Total', value: pretty(d.turns + d.started + d.archived), strong: true },
  ] };
}

// The calendar cell shows all four measures. The measure that sets the cell color comes first.
export function heatTip(d: Day, measure: Measure): Tip {
  const value = (m: Measure) => m === 'tokens' ? exactTokens(d.tokens, !!d.estimatedTokens) : pretty(d[m]);
  const order = [measure, ...(['tokens', 'turns', 'started', 'archived'] as Measure[]).filter(m => m !== measure)];
  return { title: d.date, sub: weekday(d.date), rows: order.map(m => ({ label: MEASURE_LABEL[m], value: value(m), strong: m === measure })) };
}
