// The A2A Notes tab of the Inbox page: a Taskboard view of the A2A Notes service (github.com/Mgczacki/a2a-notes), through
// /api/a2anotes (server/a2anotes/routes.ts). The dashboard acts as the person. Message text shows as plain text.
// Setup and Slack sign-in are on the Settings page (web/src/components/Integrations.tsx).
import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { Face } from './GraphMail';
import '../graph.css';

interface Summary {
  id: string; message_id: string; direction: 'in' | 'out'; state: string; audience: 'person' | 'agent' | 'both'; subject: string; from: string; to: string;
  peer_name?: string; trusted: boolean; check: { verdict: string } | null; body_flags: number | null; approver: 'person' | 'reviewer' | 'nobody';
  approved_by: string | null; created: string; hash: string; allowed_actions: string[]; failure_code?: string; routes: { task: string; at: string }[];
  suggested_task?: { id: string; num: number; title: string; reason: string };
  // the other person: Slack name and picture from the Graph's store (server/a2anotes/routes.ts peerOf)
  peer: { address: string; user: string; name: string; picture: string };
}
interface Detail extends Summary { body: string; review: { reason: string } | null; body_check: { flags: { reason: string; text: string; code: string }[] } | null;
  agent_file: { name: string; sha256: string } | null; failure?: { code: string; reason: string }; error: string | null }
export interface Setup { installed: boolean; version?: string; configured: boolean; running: boolean; serviceVersion?: string; linked: boolean; updateAvailable: boolean; folder: string; port: number }
export interface Status { enabled: boolean; url?: string; error?: string; setup?: Setup; identity?: { address?: string; name?: string }; connection?: { signed_in: boolean; last_scan_at: string | null; last_error: string | null; stale: boolean; missing_scopes: string[] } }

export async function request(path: string, body?: unknown) {
  const response = await fetch('/api/a2anotes' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error([data.error || 'Request failed', data.next].filter(Boolean).join(' '));
  return data;
}

export function A2ANotesPanel({ tasks }: { tasks: Task[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Summary[]>([]);
  const [open, setOpen] = useState<Record<string, Detail>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    const s: Status = await request('/status');
    setStatus(s);
    if (s.enabled && !s.error) setMessages((await request('/messages?direction=all')).messages);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => { void load().catch(() => {}); }, 10_000); return () => clearInterval(timer); }, []);
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const show = (id: string) => act(async () => { const d = await request(`/messages/${encodeURIComponent(id)}`); setOpen(o => ({ ...o, [id]: d })); });

  if (!status) return <p>Loading A2A Notes…</p>;
  const c = status.connection;
  // without a running and connected service there is nothing to show here: setup and sign-in are on Settings
  if (!status.enabled || status.error || !c?.signed_in) return <section className="mail-settings">
    <p>{!status.enabled ? 'A2A Notes is not set up on this Taskboard.' : status.error ? `A2A Notes is not reachable: ${status.error}` : 'A2A Notes is not connected to Slack.'} Set it up and connect Slack on the <a href="#settings">Settings page</a>, under Integrations.</p>
    <p>A2A Notes sends messages between people and their agents over Slack. The Messages and Sent tabs keep working as before.</p>
  </section>;
  return <div className="a2a-notes">
    <section className="mail-settings">
      <p>Connected as {status.identity?.name}. Last scan: {c.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}{c.stale ? '. The inbox may be out of date.' : '.'} Connection settings are on the <a href="#settings">Settings page</a>.</p>
      {c.last_error && <p role="alert">Last scan error: {c.last_error}</p>}
      <div className="mail-tabs">
        <button className="btn" disabled={busy} onClick={() => act(async () => { const link = await request('/page-link', {}); window.open(link.url, '_blank', 'noopener'); })}>Open the A2A Notes review page</button>
        <button className="btn" disabled={busy} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Check Slack now'}</button>
      </div>
    </section>
    {error && <p role="alert">{error}</p>}
    {!messages.length && <p>No A2A Notes messages yet.</p>}
    {messages.map(m => {
      const d = open[m.id];
      const peer = m.peer.address;
      return <article key={m.id} className="mail-item" data-a2a={m.id}>
        <div className="a2a-head">
          <Face person={{ user: m.peer.user, name: m.peer.name, picture: m.peer.picture }} size={32} />
          <div><div className="a2a-who" title={peer}>{m.direction === 'in' ? 'From' : 'To'} {m.peer.name}</div><h3>{m.subject}</h3></div>
        </div>
        <p className="mail-meta">State: {m.state.replace('_', ' ')}. For: {m.audience}. Check: {m.check?.verdict || m.failure_code || 'none'}. Approver: {m.approver === 'nobody' ? 'nobody (the checks hold it)' : m.approver === 'reviewer' ? 'the controller or you' : 'you'}. {m.trusted ? 'Trusted sender.' : 'Not a trusted sender.'}
          {m.routes.length ? ` Given to ${m.routes.map(r => tasks.find(t => t.id === r.task)?.title || r.task).join(', ')}.` : ''}
          {m.suggested_task && !m.routes.length ? ` ${m.suggested_task.reason}: ${m.suggested_task.title}.` : ''}</p>
        {d && <>
          {d.body && <p className="mail-body" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</p>}
          {d.review && <p className="mail-meta">Check reason: {d.review.reason}</p>}
          {!!d.body_check?.flags.length && <ul>{d.body_check.flags.map((f, i) => <li key={i}>{f.reason}{f.text && f.code !== 'ask_changed' ? ` Text: “${f.text}”` : ''}</li>)}</ul>}
          {d.agent_file && <p className="mail-meta">Agent file: {d.agent_file.name} (SHA-256 {d.agent_file.sha256.slice(0, 12)}…)</p>}
          {d.failure && <p role="alert">{d.failure.code}: {d.failure.reason}</p>}
          {d.error && <p className="mail-meta">{d.error}</p>}
        </>}
        <div className="mail-tabs">
          <button className="btn" disabled={busy} onClick={() => show(m.id)}>{d ? 'Refresh' : 'Show message'}</button>
          {m.allowed_actions.includes('approve') && <button className="btn" disabled={busy || !d} title={d ? '' : 'Show the message first'} onClick={() => act(() => request(`/messages/${m.id}/approve`, { hash: m.hash, decision: 'approve' }))}>Approve this version</button>}
          {m.allowed_actions.includes('reject') && <button className="btn" disabled={busy} onClick={() => act(() => request(`/messages/${m.id}/approve`, { hash: m.hash, decision: 'reject' }))}>Reject</button>}
          {m.allowed_actions.includes('send') && <button className="btn" disabled={busy} onClick={() => act(() => request(`/messages/${m.id}/send`, { hash: m.hash }))}>{m.state === 'delivery_uncertain' ? 'Check and send' : 'Send'}</button>}
          {m.allowed_actions.includes('release_to_agent') && <>
            <select className="mail-input" aria-label={`Task for ${m.subject}`} value={destinations[m.id] || m.suggested_task?.id || ''} onChange={e => setDestinations(x => ({ ...x, [m.id]: e.target.value }))}>
              <option value="">Choose a task</option>{tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button className="btn" disabled={busy || !(destinations[m.id] || m.suggested_task?.id)} onClick={() => act(() => request(`/messages/${m.id}/route`, { task: destinations[m.id] || m.suggested_task?.id }))}>Give to task</button>
          </>}
          {!m.failure_code && <button className="btn" disabled={busy} onClick={() => act(() => request('/trusted', { address: peer, name: m.peer.name, trusted: !m.trusted }))}>{m.trusted ? 'Stop trusting sender' : 'Trust sender'}</button>}
        </div>
      </article>;
    })}
  </div>;
}
