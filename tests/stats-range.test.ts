import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RANGE, accountTotals, activityTip, calendarWeeks, heatTip, levels, parseRange, rangeDates, rangeDays, tokenTip, totals, zero } from '../web/src/statsRange.ts';
import type { Account, Day } from '../web/src/statsRange.ts';

const n = (x: number) => new Intl.NumberFormat().format(x);
const accounts: Account[] = [
  { id: 'c1', name: 'Work', agent: 'claude' },
  { id: 'c2', name: 'Home', agent: 'claude' },
  { id: 'x1', name: 'Codex', agent: 'codex' },
  { id: 'g1', name: 'Antigravity', agent: 'antigravity' },
];
const day = (date: string, tokens: Record<string, number>, rest: Partial<Day> = {}): Day => {
  const byAccount = Object.fromEntries(Object.entries(tokens).map(([id, t]) => [id, { tokens: t, turns: 1, taskboardTokens: t, otherTokens: 0 }]));
  return { ...zero(date), tokens: Object.values(tokens).reduce((a, b) => a + b, 0), turns: Object.keys(tokens).length, byAccount, ...rest };
};

test('the saved range is kept, and a missing or unknown value uses the 28-day default', () => {
  assert.equal(parseRange('7'), 7);
  assert.equal(parseRange('28'), 28);
  assert.equal(DEFAULT_RANGE, 28);
  assert.equal(parseRange(null), 28);
  assert.equal(parseRange('90'), 28);
});

test('the range has 7 or 28 dates that end today, across a month end', () => {
  const week = rangeDates('2026-10-01', 7);
  assert.deepEqual(week, ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  const four = rangeDates('2026-10-01', 28);
  assert.equal(four.length, 28);
  assert.equal(four[0], '2026-09-04');
  assert.equal(four.at(-1), '2026-10-01');
});

test('totals and account sums count only the days in the selected range', () => {
  const byDate = new Map([
    ['2026-09-01', day('2026-09-01', { c1: 5000 }, { started: 4, archived: 2 })],
    ['2026-09-26', day('2026-09-26', { c1: 100, x1: 50 }, { started: 1 })],
    ['2026-10-01', day('2026-10-01', { c1: 20, g1: 8 }, { archived: 3, imported: 1, estimatedTokens: 8 })],
  ]);
  const week = rangeDays(byDate, rangeDates('2026-10-01', 7));
  assert.equal(week.length, 7);
  assert.deepEqual(totals(week), { tokens: 178, estimatedTokens: 8, turns: 4, started: 1, imported: 1, archived: 3 });
  assert.deepEqual(accountTotals(week).c1, { tokens: 120, turns: 2, taskboardTokens: 120, otherTokens: 0 });
  assert.equal(accountTotals(week).x1.tokens, 50);
  const month = rangeDays(byDate, rangeDates('2026-10-01', 28));
  assert.equal(totals(month).tokens, 178);
  // 2026-09-01 is 30 days before 2026-10-01, so the 28-day range leaves it out too
  assert.equal(totals(month).started, 1);
});

test('the calendar puts each date under its weekday, Monday first', () => {
  const weeks = calendarWeeks(rangeDates('2026-10-01', 7));
  // 2026-09-25 is a Friday and 2026-10-01 is a Thursday
  assert.deepEqual(weeks, [
    [null, null, null, null, '2026-09-25', '2026-09-26', '2026-09-27'],
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', null, null, null],
  ]);
  assert.equal(calendarWeeks(rangeDates('2026-10-01', 28)).flat().filter(Boolean).length, 28);
});

test('the color levels use the values of the range only', () => {
  const level = levels([0, 1, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map(level), [0, 1, 2, 3, 4]);
});

test('the token bar tooltip shows the date, the exact total and each agent', () => {
  const tip = tokenTip(day('2026-09-30', { c1: 1_234_567, c2: 1000, x1: 2500, g1: 41.6 }, { estimatedTokens: 41.6 }), accounts);
  assert.equal(tip.title, '2026-09-30');
  assert.deepEqual(tip.rows.map(r => [r.label, r.value]), [
    ['Total tokens', `~${n(1_238_109)}`],
    ['Claude Code', n(1_235_567)],
    ['Codex', n(2500)],
    ['Antigravity estimate', '~42'],
  ]);
});

test('the activity bar tooltip shows turns, task starts, archives and their total', () => {
  const tip = activityTip({ ...zero('2026-09-29'), turns: 1204, started: 3, archived: 2 });
  assert.equal(tip.title, '2026-09-29');
  assert.deepEqual(tip.rows.map(r => [r.label, r.value]), [['Turns', n(1204)], ['Tasks started', '3'], ['Tasks archived', '2'], ['Total', n(1209)]]);
});

test('the calendar tooltip puts the selected measure first and shows all four values', () => {
  const d = { ...zero('2026-09-28'), tokens: 98765, turns: 12, started: 4, archived: 1 };
  const tip = heatTip(d, 'turns');
  assert.equal(tip.title, '2026-09-28');
  assert.deepEqual(tip.rows.map(r => [r.label, r.value, !!r.strong]), [
    ['Turns', '12', true], ['Tokens', n(98765), false], ['Tasks started', '4', false], ['Tasks archived', '1', false],
  ]);
});
