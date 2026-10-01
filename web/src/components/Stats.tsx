import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_NAME } from '../api';
import { AGENTS, MEASURE_LABEL, RANGES, RANGE_KEY, accountTotals, activityTip, agentTokens, calendarWeeks, heatTip, levels, parseRange, pretty, rangeDates, rangeDays, tokenText, tokenTip, totals } from '../statsRange';
import type { Account, Day, Measure, Range, Tip } from '../statsRange';
import './stats.css';

type Stats = { days: Day[]; accounts: Account[]; scannedAt?: string; scanning: boolean; scanned: number; total: number; timeZone: string };

// One tooltip for each chart. show() puts it above the middle of the hovered element, inside the chart's box.
// Near the left or right edge of the box, the tooltip aligns to that edge so it stays inside the panel.
function useTooltip() {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; side: 'left' | 'mid' | 'right'; tip: Tip } | null>(null);
  const show = (el: Element, tip: Tip) => {
    if (!box.current) return;
    const b = box.current.getBoundingClientRect(), r = el.getBoundingClientRect(), x = r.left + r.width / 2 - b.left;
    setAt({ x, y: r.top - b.top, side: x < b.width * 0.2 ? 'left' : x > b.width * 0.8 ? 'right' : 'mid', tip });
  };
  const hide = () => setAt(null);
  const view = at && <div className={`stats-tip ${at.side}`} role="tooltip" style={{ left: at.x, top: at.y }}>
    <div className="stats-tip-title">{at.tip.title}{at.tip.sub && <span>{at.tip.sub}</span>}</div>
    {at.tip.rows.map(r => <div key={r.label} className={`stats-tip-row${r.strong ? ' strong' : ''}`}>{r.swatch ? <i className={r.swatch} /> : <i className="none" />}<span>{r.label}</span><b>{r.value}</b></div>)}
  </div>;
  return { box, show, hide, view };
}

export function StatsPage() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [measure, setMeasure] = useState<Measure>('tokens');
  const [range, setRange] = useState<Range>(() => { try { return parseRange(localStorage.getItem(RANGE_KEY)); } catch { return parseRange(null); } });
  // null: the account table shows the sum of the whole range. A date: the table shows that day.
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const r = await fetch('/api/stats?timeZone=' + encodeURIComponent(timeZone)); if (!r.ok) throw new Error((await r.json()).error || r.statusText); if (live) { setData(await r.json()); setError(''); } }
      catch (e) { if (live) setError(String((e as Error).message)); }
    };
    void load(); const timer = setInterval(load, 3000); return () => { live = false; clearInterval(timer); };
  }, [timeZone]);
  const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem(RANGE_KEY, String(r)); } catch { /* private mode */ } };
  const byDate = useMemo(() => new Map(data?.days.map(d => [d.date, d]) || []), [data]);
  const dates = useMemo(() => rangeDates(today, range), [today, range]);
  useEffect(() => { if (selected && !dates.includes(selected)) setSelected(null); }, [dates, selected]);
  const days = rangeDays(byDate, dates);
  const sum = totals(days);
  const level = levels(days.map(d => d[measure]));
  const peak = Math.max(1, ...days.map(d => d.tokens));
  const maxActivity = Math.max(1, ...days.map(d => d.turns + d.started + d.archived));
  const current = data?.accounts || [];
  const chosen = selected ? days.find(d => d.date === selected) : undefined;
  const tableAccounts = chosen ? chosen.byAccount : accountTotals(days);
  const tableSum = chosen || sum;
  const pick = (d: string) => setSelected(selected === d ? null : d);
  const heat = useTooltip(), tokens = useTooltip(), activity = useTooltip();
  const longDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const rangeText = `Last ${range} days`;
  return <div className="stats-page">
    <div className="stats-intro"><div><h2>Daily use on this machine</h2><p>{rangeText}: {dates[0]} to {dates.at(-1)}. Calendar days use {timeZone}. Each step's date gets its tokens. Antigravity counts estimate visible text only. They exclude context sent again on later model calls.</p></div>
      <div className="stats-intro-side"><div className="stats-measures stats-range" role="group" aria-label="Date range">{RANGES.map(r => <button key={r} className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => pickRange(r)}>Last {r} days</button>)}</div>
        <div className="stats-scan">{data?.scanning ? `Reading files ${data.scanned} / ${data.total}` : data?.scannedAt ? `Read ${new Date(data.scannedAt).toLocaleString()}` : 'Waiting for first scan'}</div></div></div>
    {error && <div className="banner">{error}</div>}
    <div className="stats-cards">
      <div><span>Tokens</span><strong>{tokenText(sum.tokens, !!sum.estimatedTokens)}</strong><small>{rangeText}. Includes Antigravity estimates</small></div>
      <div><span>Turns</span><strong>{pretty(sum.turns)}</strong><small>{rangeText}. All three agents</small></div>
      <div><span>Tasks started</span><strong>{pretty(sum.started)}</strong><small>{rangeText}. {pretty(sum.imported)} imported</small></div>
      <div><span>Tasks archived</span><strong>{pretty(sum.archived)}</strong><small>{rangeText}. Past dates can be partial</small></div>
    </div>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Daily activity</h3><span>{rangeText}. Click a day to see its accounts.</span></div><div className="stats-measures">{(['tokens', 'turns', 'started', 'archived'] as Measure[]).map(m => <button key={m} className={measure === m ? 'on' : ''} onClick={() => setMeasure(m)}>{MEASURE_LABEL[m]}</button>)}</div></div>
      <div className="stats-tip-box stats-calendar" ref={heat.box} onMouseLeave={heat.hide}>
        <div className="stats-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => <span key={w}>{w}</span>)}</div>
        {calendarWeeks(dates).map((week, i) => <div key={i} className="stats-week">{week.map((d, j) => {
          if (!d) return <span key={j} className="stats-cell empty" />;
          const day = days.find(x => x.date === d)!, n = day[measure];
          return <button key={d} className={`stats-cell l${level(n)} ${selected === d ? 'picked' : ''}`} aria-label={`${d}: ${measure === 'tokens' ? tokenText(n, !!day.estimatedTokens) : pretty(n)} ${MEASURE_LABEL[measure].toLowerCase()}`}
            onMouseEnter={e => heat.show(e.currentTarget, heatTip(day, measure))} onFocus={e => heat.show(e.currentTarget, heatTip(day, measure))} onBlur={heat.hide} onClick={() => pick(d)}>{Number(d.slice(8))}</button>;
        })}</div>)}
        {heat.view}
      </div>
      <div className="stats-legend">Less <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> More</div>
    </section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Tokens by day</h3><span>{rangeText}. The bar colors show the agents.</span></div></div>
      <div className="stats-tip-box" ref={tokens.box} onMouseLeave={tokens.hide}><div className="stats-chart" role="img" aria-label={`Daily token totals for the last ${range} days`}>{days.map(d => <div key={d.date} className={`stats-bar-wrap ${selected === d.date ? 'picked' : ''}`} tabIndex={0} onMouseEnter={e => tokens.show(e.currentTarget.firstElementChild!, tokenTip(d, current))} onFocus={e => tokens.show(e.currentTarget.firstElementChild!, tokenTip(d, current))} onBlur={tokens.hide} onClick={() => pick(d.date)}><div className="stats-bar" style={{ height: `${Math.max(d.tokens ? 2 : 0, d.tokens / peak * 100)}%` }}>{AGENTS.map(({ agent: a }) => <span key={a} className={`agent-${a}`} style={{ height: `${d.tokens ? agentTokens(d, current, a) / d.tokens * 100 : 0}%` }} />)}</div></div>)}</div>{tokens.view}</div>
      <div className="stats-axis"><span>{dates[0]}</span><span>{dates.at(-1)}</span></div><div className="stats-series">{AGENTS.map(a => <span key={a.agent} className="stats-series-item"><span className={`agent-${a.agent}`} /> {a.label}</span>)}</div></section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Tasks and turns</h3><span>{rangeText}. Each bar stacks turns, task starts, and archives.</span></div></div>
      <div className="stats-tip-box" ref={activity.box} onMouseLeave={activity.hide}><div className="stats-chart activity" role="img" aria-label={`Daily turns, task starts and archives for the last ${range} days`}>{days.map(d => { const all = d.turns + d.started + d.archived; return <div key={d.date} className={`stats-bar-wrap ${selected === d.date ? 'picked' : ''}`} tabIndex={0} onMouseEnter={e => activity.show(e.currentTarget.firstElementChild!, activityTip(d))} onFocus={e => activity.show(e.currentTarget.firstElementChild!, activityTip(d))} onBlur={activity.hide} onClick={() => pick(d.date)}><div className="stats-bar" style={{ height: `${Math.max(all ? 2 : 0, all / maxActivity * 100)}%` }}><span className="turns" style={{ height: `${all ? d.turns / all * 100 : 0}%` }} /><span className="started" style={{ height: `${all ? d.started / all * 100 : 0}%` }} /><span className="archived" style={{ height: `${all ? d.archived / all * 100 : 0}%` }} /></div></div>; })}</div>{activity.view}</div>
      <div className="stats-axis"><span>{dates[0]}</span><span>{dates.at(-1)}</span></div><div className="stats-series"><span className="stats-series-item"><span className="turns" /> Turns</span><span className="stats-series-item"><span className="started" /> Tasks started</span><span className="stats-series-item"><span className="archived" /> Tasks archived</span></div></section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>{chosen ? longDate(chosen.date) : `${rangeText}, by account`}</h3><span>{tokenText(tableSum.tokens, !!tableSum.estimatedTokens)} tokens · {pretty(tableSum.turns)} turns · {pretty(tableSum.started)} tasks started · {pretty(tableSum.archived)} tasks archived · {pretty(tableSum.imported)} imported</span></div>{chosen && <div className="stats-measures"><button onClick={() => setSelected(null)}>Show all {range} days</button></div>}</div><div className="stats-table-wrap"><table><thead><tr><th>Agent</th><th>Account</th><th>Tokens</th><th>Taskboard sessions</th><th>Other sessions</th><th>Turns</th></tr></thead><tbody>{current.map(a => { const x = tableAccounts[a.id]; const estimated = a.agent === 'antigravity'; const cell = (n: number) => <td title={estimated && !x?.tokens ? undefined : `${estimated ? '~' : ''}${pretty(Math.round(n))}`}>{estimated && !x?.tokens ? 'Unavailable' : tokenText(n, estimated)}</td>; return <tr key={a.id}><td>{AGENT_NAME[a.agent]}</td><td>{a.name}</td>{cell(x?.tokens || 0)}{cell(x?.taskboardTokens || 0)}{cell(x?.otherTokens || 0)}<td>{pretty(x?.turns || 0)}</td></tr>; })}</tbody></table></div><p className="stats-note">An imported session stays under Other sessions before its import time. Older archive counts can miss tasks that changed status or were removed.</p></section>
  </div>;
}
