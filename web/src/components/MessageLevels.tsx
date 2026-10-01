// Settings: who approves messages with other people, in each direction, and the people you trust. The levels live in
// A2A Notes (a2anotes://policy), and A2A Notes enforces them. A change to less human control asks first on this page.
import { useEffect, useState } from 'react';
import type { MessageLevel } from '../api';
import { request } from './messages';
import { SettingGroup, SettingItem } from './SettingsLayout';

type Direction = 'incoming' | 'outgoing';
const LEVELS: Record<Direction, { label: string; options: [MessageLevel, string, string][]; risk: string }> = {
  incoming: {
    label: 'Who lets an incoming message reach your agents',
    options: [
      [1, 'You approve every message.', 'The controller proposes the task for each message. No other agent reads the message until you approve the message and the task on the dashboard.'],
      [2, 'The controller checks, you decide when it is unsure.', 'The controller routes messages that pass the safety check. It asks you when it finds a problem or is not sure.'],
      [3, 'The controller decides.', 'The controller routes messages on its own and you see them afterwards. A message that fails the safety check stays in quarantine.'],
    ],
    risk: 'With this level, the controller can pass a message from another person to your agents without asking you. The safety check uses a model. A model can miss a harmful message. An agent that receives such a message can then act on it with your permissions.',
  },
  outgoing: {
    label: 'Who approves a message that your agents send',
    options: [
      [1, 'You approve every message.', 'Each draft waits for your approval card before Taskboard sends it.'],
      [2, 'The controller approves ordinary messages, you approve the rest.', 'The controller sends drafts that pass the check. It asks you when it finds a problem or is not sure.'],
      [3, 'The controller decides.', 'The controller approves and sends drafts with no step for you. Drafts that fail the safety check still wait for you.'],
    ],
    risk: 'With this level, the controller can send a message in your name without asking you. The safety check can miss private data or secrets in a draft. A sent Slack message cannot be taken back.',
  },
};

interface Policy { incoming: MessageLevel; outgoing: MessageLevel; checkBody: boolean; version: number; trusted: { address: string; name: string }[] }
export function MessageLevels() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [asking, setAsking] = useState<{ direction: Direction; level: MessageLevel } | null>(null);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<{ address: string; name: string; title: string; active: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => request('/policy').then(setPolicy).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (query.trim().length < 2) { setPeople([]); return; }
    const t = setTimeout(() => { request(`/people?q=${encodeURIComponent(query.trim())}`).then(r => setPeople(r.people.filter((p: { active: boolean }) => p.active))).catch(() => setPeople([])); }, 300);
    return () => clearTimeout(t);
  }, [query]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const save = (p: Record<string, unknown>) => act(() => request('/policy', p));
  const choose = (direction: Direction, level: MessageLevel) => {
    if (!policy || level === policy[direction]) return;
    // a higher level gives the controller more control: explain the risk before saving
    if (level > policy[direction]) { setAsking({ direction, level }); return; }
    setAsking(null);
    void save({ [direction]: level });
  };
  const confirm = async () => { if (!asking) return; await save({ [asking.direction]: asking.level, confirmLowerControl: true }); setAsking(null); };
  return <SettingGroup section="messages" id="levels" title="Messages from other people" help="Messages through A2A Notes. A2A Notes enforces these levels. Agents and the controller cannot change them." bare>
    {!policy ? <div className="ctl-box"><div className="sub">{error ? `The levels are not available: ${error}` : 'Loading…'} Set up A2A Notes under Integrations above.</div></div> : <>
      {(['incoming', 'outgoing'] as Direction[]).map(direction => <SettingItem key={direction} id={direction === 'incoming' ? 'messageIncoming' : 'messageOutgoing'}><div className="ctl-box" role="radiogroup" aria-label={LEVELS[direction].label}>
        <b>{LEVELS[direction].label}</b>
        {LEVELS[direction].options.map(([level, title, text]) => <label className="opt" key={level}>
          <input type="radio" name={`message-${direction}`} disabled={busy} checked={(asking?.direction === direction ? asking.level : policy[direction]) === level} onChange={() => choose(direction, level)} />
          {' '}<b>{title}</b>{level === 2 && ' (default)'} <span className="sub">{text}</span>
        </label>)}
        {asking?.direction === direction && <div className="banner" role="alert">
          <p>{LEVELS[direction].risk}</p>
          <div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => void confirm()}>Change level</button><button className="btn" disabled={busy} onClick={() => setAsking(null)}>Cancel</button></div>
        </div>}
      </div></SettingItem>)}
      <SettingItem id="checkBody"><div className="ctl-box"><label className="opt"><input type="checkbox" disabled={busy} checked={policy.checkBody} onChange={e => void save({ checkBody: e.target.checked })} /> Check drafts for private working notes and internal terms</label><div className="sub">When this is on, a draft with flagged text always needs your approval.</div></div></SettingItem>
      <SettingItem id="trustedPeople"><div className="ctl-box">
        <b>Trusted people</b>
        <div className="sub">A message from or to a person who is not on this list always needs your approval, at every level.</div>
        {error && <div className="banner">{error}</div>}
        {policy.trusted.length === 0 && <div className="sub">No trusted people yet.</div>}
        {policy.trusted.map(t => <div className="opt" key={t.address}>{t.name} <span className="sub">({t.address})</span> <button className="btn ghost" disabled={busy} onClick={() => void act(() => request('/trusted', { address: t.address, name: t.name, trusted: false }))}>Remove</button></div>)}
        <div className="opt">
          <input className="routing-rule" aria-label="Find a person to trust" placeholder="Find a person by name or email" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {people.filter(p => !policy.trusted.some(t => t.address === p.address)).slice(0, 8).map(p => <div className="opt" key={p.address}>{p.name}{p.title ? <span className="sub"> · {p.title}</span> : null}
          <button className="btn" disabled={busy} onClick={() => void act(async () => { await request('/trusted', { address: p.address, name: p.name, trusted: true }); setQuery(''); })}>Trust this person</button></div>)}
      </div></SettingItem>
    </>}
  </SettingGroup>;
}
