import { useEffect, useMemo, useState } from 'react';
import { AGENT_NAME } from '../api';
import type { Agent } from '../api';
import './stats.css';

type Account = { id: string; name: string; agent: Agent };
type AccountDay = { tokens: number; turns: number; taskboardTokens: number; otherTokens: number };
type Day = { date: string; tokens: number; turns: number; started: number; imported: number; archived: number; byAccount: Record<string, AccountDay> };
type Stats = { days: Day[]; accounts: Account[]; scannedAt?: string; scanning: boolean; scanned: number; total: number; timeZone: string };
type Measure = 'tokens' | 'turns' | 'started' | 'archived';
const zero = (date: string): Day => ({ date, tokens: 0, turns: 0, started: 0, imported: 0, archived: 0, byAccount: {} });
const addDays = (day: string, n: number) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const pretty = (n: number) => new Intl.NumberFormat().format(n);

export function StatsPage() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [measure, setMeasure] = useState<Measure>('tokens');
  const [selected, setSelected] = useState(today);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const r = await fetch('/api/stats?timeZone=' + encodeURIComponent(timeZone)); if (!r.ok) throw new Error((await r.json()).error || r.statusText); if (live) { setData(await r.json()); setError(''); } }
      catch (e) { if (live) setError(String((e as Error).message)); }
    };
    void load(); const timer = setInterval(load, 3000); return () => { live = false; clearInterval(timer); };
  }, [timeZone]);
  const byDate = useMemo(() => new Map(data?.days.map(d => [d.date, d]) || []), [data]);
  const dates = useMemo(() => Array.from({ length: 371 }, (_, i) => addDays(today, i - 370)), [today]);
  const values = dates.map(d => byDate.get(d)?.[measure] || 0).filter(x => x > 0).sort((a, b) => a - b);
  const limits = [0.25, 0.5, 0.75].map(x => values[Math.floor((values.length - 1) * x)] || 0);
  const level = (n: number) => !n ? 0 : n <= limits[0] ? 1 : n <= limits[1] ? 2 : n <= limits[2] ? 3 : 4;
  const chosen = byDate.get(selected) || zero(selected);
  const recent = dates.slice(-90).map(d => byDate.get(d) || zero(d));
  const peak = Math.max(1, ...recent.map(d => d.tokens));
  const maxActivity = Math.max(1, ...recent.slice(-30).map(d => d.turns + d.started + d.archived));
  const current = data?.accounts || [];
  const agentTokens = (d: Day, agent: Agent) => current.filter(a => a.agent === agent).reduce((sum, a) => sum + (d.byAccount[a.id]?.tokens || 0), 0);
  return <div className="stats-page">
    <div className="stats-intro"><div><h2>Daily use on this machine</h2><p>Calendar days use {timeZone}. Each response's date gets its tokens. Antigravity does not record token totals here.</p></div><div className="stats-scan">{data?.scanning ? `Reading files ${data.scanned} / ${data.total}` : data?.scannedAt ? `Read ${new Date(data.scannedAt).toLocaleString()}` : 'Waiting for first scan'}</div></div>
    {error && <div className="banner">{error}</div>}
    <div className="stats-cards">
      <div><span>Tokens today</span><strong>{pretty(byDate.get(today)?.tokens || 0)}</strong><small>Claude Code and Codex</small></div>
      <div><span>Turns today</span><strong>{pretty(byDate.get(today)?.turns || 0)}</strong><small>All three agents</small></div>
      <div><span>Tasks started today</span><strong>{pretty(byDate.get(today)?.started || 0)}</strong><small>{pretty(byDate.get(today)?.imported || 0)} imported</small></div>
      <div><span>Tasks archived today</span><strong>{pretty(byDate.get(today)?.archived || 0)}</strong><small>Past dates can be partial</small></div>
    </div>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Daily activity</h3><span>Click a day to see its accounts.</span></div><div className="stats-measures">{(['tokens', 'turns', 'started', 'archived'] as Measure[]).map(m => <button key={m} className={measure === m ? 'on' : ''} onClick={() => setMeasure(m)}>{m === 'started' ? 'Tasks started' : m === 'archived' ? 'Tasks archived' : m[0].toUpperCase() + m.slice(1)}</button>)}</div></div>
      <div className="stats-heat-scroll"><div className="stats-months">{dates.filter((d, i) => i % 7 === 0).map((d, i) => <span key={d} style={{ gridColumn: i + 1 }}>{d.slice(8) <= '07' ? new Date(d + 'T12:00:00Z').toLocaleString(undefined, { month: 'short', timeZone: 'UTC' }) : ''}</span>)}</div><div className="stats-heat">{dates.map(d => { const n = byDate.get(d)?.[measure] || 0; return <button key={d} className={`stats-cell l${level(n)} ${selected === d ? 'picked' : ''}`} title={`${d}: ${pretty(n)} ${measure}`} aria-label={`${d}: ${pretty(n)} ${measure}`} onClick={() => setSelected(d)} />; })}</div></div>
      <div className="stats-legend">Less <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> More</div>
    </section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Tokens by day</h3><span>Last 90 days. The bar colors show the agents.</span></div></div><div className="stats-chart" role="img" aria-label="Daily token totals for the last 90 days">{recent.map(d => <div key={d.date} className="stats-bar-wrap" title={`${d.date}: ${pretty(d.tokens)} tokens`} onClick={() => setSelected(d.date)}><div className="stats-bar" style={{ height: `${Math.max(d.tokens ? 2 : 0, d.tokens / peak * 100)}%` }}>{(['claude', 'codex'] as Agent[]).map(a => <span key={a} className={`agent-${a}`} style={{ height: `${d.tokens ? agentTokens(d, a) / d.tokens * 100 : 0}%` }} />)}</div></div>)}</div><div className="stats-axis"><span>{recent[0]?.date}</span><span>{recent.at(-1)?.date}</span></div><div className="stats-series"><span className="agent-claude" /> Claude Code <span className="agent-codex" /> Codex <span className="agent-antigravity" /> Antigravity tokens unavailable</div></section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>Tasks and turns</h3><span>Last 30 days. Each bar stacks turns, task starts, and archives.</span></div></div><div className="stats-chart activity">{recent.slice(-30).map(d => <div key={d.date} className="stats-bar-wrap" title={`${d.date}: ${d.turns} turns, ${d.started} started, ${d.archived} archived`} onClick={() => setSelected(d.date)}><div className="stats-bar" style={{ height: `${(d.turns + d.started + d.archived) / maxActivity * 100}%` }}><span className="turns" style={{ height: `${(d.turns + d.started + d.archived) ? d.turns / (d.turns + d.started + d.archived) * 100 : 0}%` }} /><span className="started" style={{ height: `${(d.turns + d.started + d.archived) ? d.started / (d.turns + d.started + d.archived) * 100 : 0}%` }} /><span className="archived" style={{ height: `${(d.turns + d.started + d.archived) ? d.archived / (d.turns + d.started + d.archived) * 100 : 0}%` }} /></div></div>)}</div><div className="stats-series"><span className="turns" /> Turns <span className="started" /> Tasks started <span className="archived" /> Tasks archived</div></section>
    <section className="stats-panel"><div className="stats-heading"><div><h3>{new Date(selected + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</h3><span>{pretty(chosen.tokens)} tokens · {pretty(chosen.turns)} turns · {chosen.started} tasks started · {chosen.archived} tasks archived · {chosen.imported} imported</span></div></div><div className="stats-table-wrap"><table><thead><tr><th>Agent</th><th>Account</th><th>Tokens</th><th>Taskboard sessions</th><th>Other sessions</th><th>Turns</th></tr></thead><tbody>{current.map(a => { const x = chosen.byAccount[a.id]; return <tr key={a.id}><td>{AGENT_NAME[a.agent]}</td><td>{a.name}</td><td>{a.agent === 'antigravity' ? 'Unavailable' : pretty(x?.tokens || 0)}</td><td>{a.agent === 'antigravity' ? 'Unavailable' : pretty(x?.taskboardTokens || 0)}</td><td>{a.agent === 'antigravity' ? 'Unavailable' : pretty(x?.otherTokens || 0)}</td><td>{pretty(x?.turns || 0)}</td></tr>; })}</tbody></table></div><p className="stats-note">An imported session stays under Other sessions before its import time. Older archive counts can miss tasks that changed status or were removed.</p></section>
  </div>;
}
