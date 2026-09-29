// Settings: who approves messages between Taskboard users, in each direction, and the people you trust.
// The server enforces the levels (server/mail/policy.ts). A change to less human control asks first on this page.
import { useEffect, useState } from 'react';
import type { MachineInfo, MessageLevel } from '../api';
import { MemberPicker, request, type Person } from './Mail';

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
    risk: 'With this level, the controller can send a message in your name without asking you. The safety check can miss private data or secrets in a draft. Taskboard cannot take back a sent Slack message.',
  },
};

export function MessageLevels({ info, busy, save }: {
  info: MachineInfo; busy: boolean;
  save: (p: { messageIncoming?: MessageLevel; messageOutgoing?: MessageLevel; confirmLowerControl?: boolean }) => Promise<void>;
}) {
  const levels = info.settings.messages;
  const [asking, setAsking] = useState<{ direction: Direction; level: MessageLevel } | null>(null);
  const [trusted, setTrusted] = useState<{ user: string; name: string }[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    request('').then(d => setTrusted(d.trustedSenders || [])).catch(e => setError(e.message));
    request('/people').then(setPeople).catch(() => { /* Slack is not connected: the list can only be read */ });
  }, []);
  const choose = (direction: Direction, level: MessageLevel) => {
    if (level === levels[direction]) return;
    // a higher level gives the controller more control: explain the risk before saving
    if (level > levels[direction]) { setAsking({ direction, level }); return; }
    setAsking(null);
    void save(direction === 'incoming' ? { messageIncoming: level } : { messageOutgoing: level });
  };
  const confirm = async () => {
    if (!asking) return;
    await save({ ...(asking.direction === 'incoming' ? { messageIncoming: asking.level } : { messageOutgoing: asking.level }), confirmLowerControl: true });
    setAsking(null);
  };
  const setTrust = async (user: string, name: string, value: boolean) => {
    setError('');
    try { setTrusted((await request('/trusted', { user, name, trusted: value })).trustedSenders || []); setAdding(''); } catch (e) { setError((e as Error).message); }
  };
  return <>
    <h3 className="set-h">Messages from other people</h3>
    <p className="sub">Slack messages between Taskboard users. The Taskboard server enforces these levels. Agents and the controller cannot change them.</p>
    {(['incoming', 'outgoing'] as Direction[]).map(direction => <div className="ctl-box" key={direction} role="radiogroup" aria-label={LEVELS[direction].label}>
      <b>{LEVELS[direction].label}</b>
      {LEVELS[direction].options.map(([level, title, text]) => <label className="opt" key={level}>
        <input type="radio" name={`message-${direction}`} disabled={busy} checked={(asking?.direction === direction ? asking.level : levels[direction]) === level} onChange={() => choose(direction, level)} />
        {' '}<b>{title}</b>{level === 2 && ' (default)'} <span className="sub">{text}</span>
      </label>)}
      {asking?.direction === direction && <div className="banner" role="alert">
        <p>{LEVELS[direction].risk}</p>
        <div className="ap-a"><button className="btn primary" disabled={busy} onClick={() => void confirm()}>Change level</button><button className="btn" disabled={busy} onClick={() => setAsking(null)}>Cancel</button></div>
      </div>}
    </div>)}
    <div className="ctl-box">
      <b>Trusted people</b>
      <div className="sub">A message from or to a person who is not on this list always needs your approval, at every level.</div>
      {error && <div className="banner">{error}</div>}
      {trusted?.length === 0 && <div className="sub">No trusted people yet.</div>}
      {trusted?.map(t => <div className="opt" key={t.user}>{t.name} <span className="sub">({t.user})</span> <button className="btn ghost" onClick={() => void setTrust(t.user, t.name, false)}>Remove</button></div>)}
      {!!people.length && <div className="opt">
        <MemberPicker people={people.filter(p => !trusted?.some(t => t.user === p.user))} value={adding} onChange={setAdding} disabled={busy} />
        <button className="btn" disabled={!adding} onClick={() => { const p = people.find(x => x.user === adding); if (p) void setTrust(p.user, p.name, true); }}>Trust this person</button>
      </div>}
    </div>
  </>;
}
