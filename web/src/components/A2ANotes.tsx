// The message lists of the Inbox page, through /api/a2anotes (server/a2anotes/routes.ts) and A2A Notes
// (github.com/Mgczacki/a2a-notes). The dashboard acts as the person. Message text shows as plain text.
// Setup and Slack sign-in are on the Settings page (web/src/components/Integrations.tsx).
import { useEffect, useRef, useState } from 'react';
import { useStore, type Task } from '../api';
import { cardControls, loadOrder, messageCardsKey, versionLines } from '../a2aCard';
import { Face } from './GraphMail';
import { FlaggedBody, date, proposer, request } from './messages';
import '../graph.css';

interface Summary {
  id: string; message_id: string; direction: 'in' | 'out'; state: string; audience: 'person' | 'agent' | 'both'; subject: string; from: string; to: string;
  trusted: boolean; check: { verdict: string } | null; body_flags: number | null; approver: 'person' | 'reviewer' | 'nobody';
  approved_by: string | null; created: string; updated: string; hash: string; allowed_actions: string[]; failure_code?: string; routes: { task: string; at: string }[];
  metadata: Record<string, string | number | boolean | null> | null;
  suggested_task?: { id: string; num: number; title: string; reason: string };
  proposed_route?: { task: string | null };
  triage?: string; route_person?: boolean;
  // the other person: Slack name and picture (server/a2anotes/routes.ts peerOf)
  peer: { address: string; user: string; name: string; picture: string };
}
interface Detail extends Summary { body: string; review: { reason: string } | null; body_check: { state?: string; flags: { reason: string; text: string; code: string; start: number; end: number }[] } | null;
  agent_file: { name: string; sha256: string } | null; files: { name: string; size: number }[]; failure?: { code: string; reason: string }; error: string | null; rejected: { comment?: string } | null }
export interface Setup { installed: boolean; version?: string; configured: boolean; running: boolean; serviceVersion?: string; linked: boolean; updateAvailable: boolean; restartStep: string; folder: string; port: number; checks: 'model' | 'rules'; checksOutdated: boolean;
  slack?: SlackAppInfo; slackApp: SlackAppInfo & { source: 'settings' | 'environment' | 'default' }; slackAppDiffers: boolean; signInHelp: string[] }
// a Slack app as server/a2anotes/setup.ts SetupState reports it
export interface SlackAppInfo { clientId: string; teamId: string; redirectUri: string; name?: string }
export interface Status { enabled: boolean; url?: string; error?: string; setup?: Setup; identity?: { address?: string; name?: string }; connection?: { signed_in: boolean; last_scan_at: string | null; last_error: string | null; stale: boolean; missing_scopes: string[] } }
export { request };

const approverLabel = (a: Summary['approver']) => a === 'nobody' ? 'nobody (the checks hold it)' : a === 'reviewer' ? 'the controller or you' : 'you';

// The connection line above a list. Without a running and connected service, it points to Settings.
function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { const load = () => request('/status').then(setStatus).catch(() => {}); void load(); const timer = setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  return status;
}
// The running and installed versions, and a warning with the restart step when the running service is older.
export function ServiceVersion({ setup }: { setup?: Setup }) {
  if (!setup) return null;
  const v = versionLines(setup);
  return <>
    <div className="sub">{v.line}</div>
    {v.warning && <div role="alert">{v.warning}</div>}
    {v.step && <div className="sub">{v.step}</div>}
  </>;
}
const connected = (s: Status | null) => !!(s?.enabled && !s.error && s.connection?.signed_in);
function NotConnected({ status }: { status: Status }) {
  return <section className="mail-settings">
    <p>{!status.enabled ? 'Messages with other people need A2A Notes, which is not set up on this Taskboard.' : status.error ? `A2A Notes is not reachable: ${status.error}` : 'A2A Notes is not connected to Slack.'} Set it up and connect Slack on the <a href="#settings">Settings page</a>, under Integrations.</p>
  </section>;
}

export function MessageList({ tasks, direction, focus }: { tasks: Task[]; direction: 'incoming' | 'outgoing'; focus?: string }) {
  const status = useStatus();
  const [messages, setMessages] = useState<Summary[]>([]);
  const [open, setOpen] = useState<Record<string, Detail>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = connected(status);
  // an approval on a dashboard card changes a message without this page; the list loads again when a card closes
  const cards = messageCardsKey(useStore().approvals);
  const order = useRef(loadOrder()).current;
  const load = async () => {
    if (!ok) return;
    const n = order.start();
    const list = (await request(`/messages?direction=${direction}`)).messages;
    if (order.latest(n)) setMessages(list);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => { void load().catch(() => {}); }, 10_000); return () => clearInterval(timer); }, [ok, direction]);
  useEffect(() => { void load().catch(() => {}); }, [cards]);
  // after an action on a message, an open message text loads again too
  async function act(fn: () => Promise<unknown>, id?: string) {
    setBusy(true); setError('');
    try { await fn(); await load(); if (id && open[id]) setOpen({ ...open, [id]: await request(`/messages/${encodeURIComponent(id)}`) }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const show = (id: string) => act(async () => { const d = await request(`/messages/${encodeURIComponent(id)}`); setOpen(o => ({ ...o, [id]: d })); });
  // a message that a Message card opened (focus): show its text and scroll to it once it is in the list
  const focused = useRef('');
  useEffect(() => {
    if (!focus || focused.current === focus || !messages.some(m => m.id === focus)) return;
    focused.current = focus;
    void show(focus).then(() => document.querySelector(`[data-a2a="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [focus, messages]);

  if (!status) return <p>Loading messages…</p>;
  if (!ok) return <NotConnected status={status} />;
  const c = status.connection!;
  return <div className="a2a-notes">
    <section className="mail-settings">
      <p>Connected as {status.identity?.name}. Last scan: {c.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}{c.stale ? '. The inbox may be out of date.' : '.'} Connection settings are on the <a href="#settings">Settings page</a>.</p>
      {c.last_error && <p role="alert">Last scan error: {c.last_error}</p>}
      <ServiceVersion setup={status.setup} />
      {status.setup?.updateAvailable && <p className="sub">The Restart A2A Notes button is on the <a href="#settings">Settings page</a>, under Integrations.</p>}
      <div className="mail-tabs">
        <button className="btn" disabled={busy} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Check Slack now'}</button>
        <button className="btn" disabled={busy} onClick={() => act(async () => { const link = await request('/page-link', {}); window.open(link.url, '_blank', 'noopener'); })}>Open the A2A Notes review page</button>
      </div>
    </section>
    {direction === 'outgoing' && <Compose busy={busy} act={act} />}
    {error && <p role="alert">{error}</p>}
    {!messages.length && <p>{direction === 'incoming' ? 'No messages yet.' : 'No sent messages or drafts yet.'}</p>}
    {messages.map(m => {
      const d = open[m.id];
      const by = m.metadata?.['taskboard.proposed_by'];
      const controls = cardControls(m);
      const approver = m.direction === 'in' && m.audience === 'person' && m.approver === 'reviewer' ? 'person' : m.approver;
      return <article key={m.id} className="mail-item" data-a2a={m.id}>
        <div className="a2a-head">
          <Face person={{ user: m.peer.user, name: m.peer.name, picture: m.peer.picture }} size={32} />
          <div><div className="a2a-who" title={m.peer.address}>{m.direction === 'in' ? 'From' : 'To'} {m.peer.name}</div><h3>{m.subject}</h3></div>
        </div>
        <p className="mail-meta">{controls.label}. For: {m.audience === 'person' ? 'the reader' : m.audience === 'agent' ? "the reader's agent" : 'the reader and the agent'}. Check: {m.check?.verdict || m.failure_code || 'running'}. Approver: {approverLabel(approver)}. {m.trusted ? 'Trusted.' : 'Not trusted.'}
          {m.direction === 'out' && by ? ` Written by ${proposer({ proposedBy: { actor: by === 'user' ? 'user' : by as 'task' | 'controller', task: String(m.metadata?.['taskboard.task_id'] || '') } }, tasks)}.` : ''}
          {m.direction === 'out' && m.body_flags ? ` The message check flagged ${m.body_flags} item(s).` : ''}
          {' '}{date(m.created)}.
          {m.routes.length ? ` Given to ${m.routes.map(r => tasks.find(t => t.id === r.task)?.title || r.task).join(', ')}.` : ''}
          {m.proposed_route ? ` The controller proposes ${m.proposed_route.task ? tasks.find(t => t.id === m.proposed_route!.task)?.title || m.proposed_route.task : 'no task'}.` : ''}
          {m.suggested_task && !m.routes.length ? ` ${m.suggested_task.reason}: ${m.suggested_task.title}.` : ''}</p>
        {m.triage && <p className="mail-meta">Controller triage: {m.triage}</p>}
        {m.direction === 'in' && controls.approve && <p className="mail-meta">Acceptance lets the controller read this message. A verified reply goes to its originating task. Other messages wait for a destination.</p>}
        {d && <>
          {d.body && (d.direction === 'out' ? <FlaggedBody body={d.body} quality={d.body_check ? { state: d.body_check.state || 'done', flags: d.body_check.flags } : undefined} /> : <p className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</p>)}
          {d.review && <p className="mail-meta">Check reason: {d.review.reason}</p>}
          {d.body_check?.flags.filter(f => f.end <= f.start).map((f, i) => <p key={i} className="mail-meta" role="alert">{f.reason}</p>)}
          {d.agent_file && <p className="mail-meta">Agent file: {d.agent_file.name} (SHA-256 {d.agent_file.sha256.slice(0, 12)}…)</p>}
          {!!d.files?.length && <p className="mail-meta">Files: {d.files.map(f => f.name).join(', ')}</p>}
          {d.rejected?.comment && <p className="mail-meta">Sent back with the comment: {d.rejected.comment}</p>}
          {d.failure && <p role="alert">{d.failure.code}: {d.failure.reason}</p>}
          {d.error && <p className="mail-meta">{d.error}</p>}
        </>}
        <div className="mail-tabs">
          <button className="btn" disabled={busy} onClick={() => show(m.id)}>{d ? 'Refresh' : 'Show message'}</button>
          {controls.approve && <button className="btn" disabled={busy || !d} title={d ? '' : 'Show the message first'} onClick={() => act(() => request(`/messages/${m.id}/approve`, { hash: m.hash, decision: 'approve' }), m.id)}>{m.direction === 'in' ? 'Accept this version' : 'Approve this version'}</button>}
          {controls.reject && <button className="btn" disabled={busy} onClick={() => act(() => request(`/messages/${m.id}/approve`, { hash: m.hash, decision: 'reject' }), m.id)}>Reject</button>}
          {controls.removeFlagged && d && <button className="btn" disabled={busy} onClick={() => act(() => request(`/messages/${m.id}/remove-flagged`, { hash: m.hash }), m.id)}>Remove flagged text</button>}
          {controls.send && <button className="btn" disabled={busy} onClick={() => act(() => request(`/messages/${m.id}/send`, { hash: m.hash }), m.id)}>{controls.sendLabel}</button>}
          {controls.route && <>
            <select className="mail-input" aria-label={`Task for ${m.subject}`} value={destinations[m.id] || m.proposed_route?.task || m.suggested_task?.id || ''} onChange={e => setDestinations(x => ({ ...x, [m.id]: e.target.value }))}>
              <option value="">Choose a task</option>{tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button className="btn" disabled={busy || !(destinations[m.id] || m.proposed_route?.task || m.suggested_task?.id)} onClick={() => act(() => request(`/messages/${m.id}/route`, { task: destinations[m.id] || m.proposed_route?.task || m.suggested_task?.id }), m.id)}>Give to task</button>
          </>}
          {!m.failure_code && <button className="btn" disabled={busy} onClick={() => act(() => request('/trusted', { address: m.peer.address, name: m.peer.name, trusted: !m.trusted }))}>{m.trusted ? 'Stop trusting' : 'Trust this person'}</button>}
        </div>
      </article>;
    })}
  </div>;
}

// A message from you. Taskboard checks it like any draft; you approve and send it in the list below.
function Compose({ busy, act }: { busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<{ address: string; name: string; real_name: string; title: string; active: boolean }[]>([]);
  const [to, setTo] = useState<{ address: string; name: string } | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (to || query.trim().length < 2) { setPeople([]); return; }
    const t = setTimeout(() => { request(`/people?q=${encodeURIComponent(query.trim())}`).then(r => setPeople(r.people.filter((p: { active: boolean }) => p.active))).catch(() => setPeople([])); }, 300);
    return () => clearTimeout(t);
  }, [query, to]);
  return <form className="mail-compose" onSubmit={e => { e.preventDefault(); if (to) void act(async () => { await request('/drafts', { to: to.address, subject, body, audience: 'person' }); setSubject(''); setBody(''); setTo(null); setQuery(''); }); }}>
    {to ? <p>To {to.name} <button type="button" className="btn" onClick={() => { setTo(null); setQuery(''); }}>Change</button></p>
      : <><input className="mail-input" aria-label="To" placeholder="To: a name or an email" value={query} onChange={e => setQuery(e.target.value)} />
        {!!people.length && <ul className="mail-people">{people.slice(0, 8).map(p => <li key={p.address}><button type="button" className="btn" onClick={() => setTo({ address: p.address, name: p.name })}>{p.name}{p.title ? ` · ${p.title}` : ''}</button></li>)}</ul>}</>}
    <input className="mail-input" aria-label="Subject" placeholder="Subject" value={subject} onChange={e => setSubject(e.target.value)} />
    <textarea className="mail-input" aria-label="Message" placeholder="One or two sentences for the reader: what this is about, what you ask, and by when" rows={4} value={body} onChange={e => setBody(e.target.value)} />
    <button className="btn" disabled={busy || !to || !subject.trim() || !body.trim()}>Create draft</button>
  </form>;
}

interface TaskNote { id: string; task: string; subject: string; body: string; created: string; seen?: string }
// Notes from your tasks (tb mail submit). They never leave this computer.
export function TaskNotesList({ tasks }: { tasks: Task[] }) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [error, setError] = useState('');
  const load = () => fetch('/api/notes').then(r => r.json()).then(d => { if (Array.isArray(d)) setNotes(d); }).catch(e => setError(e.message));
  useEffect(() => { void load(); const timer = setInterval(load, 10_000); return () => clearInterval(timer); }, []);
  const post = (path: string) => fetch(`/api/notes/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(load);
  if (!notes.length) return null;
  return <section className="a2a-notes">
    <h3 className="set-h">From your tasks</h3>
    {error && <p role="alert">{error}</p>}
    {notes.map(n => { const t = tasks.find(x => x.id === n.task); return <article key={n.id} className="mail-item">
      <h3>{n.subject}</h3>
      <p className="mail-meta">From {n.task === 'controller' ? 'the controller' : t ? `#${t.num} ${t.title}` : n.task}. {date(n.created)}.{n.seen ? '' : ' Unread.'}</p>
      <p className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
      <div className="mail-tabs">
        {!n.seen && <button className="btn" onClick={() => void post(`${n.id}/seen`)}>Mark as read</button>}
        <button className="btn" onClick={() => void post(`${n.id}/dismiss`)}>Dismiss</button>
      </div>
    </article>; })}
  </section>;
}
