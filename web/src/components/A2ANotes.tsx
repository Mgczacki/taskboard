// The A2A Notes tab of the Inbox page: a Taskboard view of the A2A Notes service (packages/a2a-notes), through
// /api/a2anotes (server/a2anotes/routes.ts). The dashboard acts as the person. Message text shows as plain text.
import { useEffect, useState } from 'react';
import type { Task } from '../api';

interface Summary {
  id: string; message_id: string; direction: 'in' | 'out'; state: string; audience: 'person' | 'agent' | 'both'; subject: string; from: string; to: string;
  peer_name?: string; trusted: boolean; check: { verdict: string } | null; body_flags: number | null; approver: 'person' | 'reviewer' | 'nobody';
  approved_by: string | null; created: string; hash: string; allowed_actions: string[]; failure_code?: string; routes: { task: string; at: string }[];
}
interface Detail extends Summary { body: string; review: { reason: string } | null; body_check: { flags: { reason: string; text: string; code: string }[] } | null;
  agent_file: { name: string; sha256: string } | null; failure?: { code: string; reason: string }; error: string | null }
interface Status { enabled: boolean; url?: string; error?: string; identity?: { address?: string; name?: string }; connection?: { signed_in: boolean; last_scan_at: string | null; last_error: string | null; stale: boolean; missing_scopes: string[] } }

async function request(path: string, body?: unknown) {
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
  if (!status.enabled) return <section className="mail-settings">
    <p>A2A Notes is off on this Taskboard. The Messages and Sent tabs keep working as before.</p>
    <p>To turn it on, run the A2A Notes service and add its address and client tokens to a2anotes.json in the Taskboard folder. The package README lists the steps.</p>
  </section>;
  const c = status.connection;
  return <div className="a2a-notes">
    <section className="mail-settings">
      {status.error ? <p role="alert">{status.error}</p> : <p>{c?.signed_in ? `Connected as ${status.identity?.name} (${status.identity?.address}).` : 'The A2A Notes service is not connected to Slack.'} Last scan: {c?.last_scan_at ? new Date(c.last_scan_at).toLocaleString() : 'never'}{c?.stale ? '. The inbox may be out of date.' : '.'}</p>}
      {c?.last_error && <p role="alert">Last scan error: {c.last_error}</p>}
      {!!c?.missing_scopes.length && <p role="alert">Missing Slack scopes: {c.missing_scopes.join(', ')}</p>}
      <div className="mail-tabs">
        <button className="btn" disabled={busy} onClick={() => act(async () => { const link = await request('/page-link', {}); window.open(link.url, '_blank', 'noopener'); })}>Open the A2A Notes review page</button>
        <button className="btn" disabled={busy || !c?.signed_in} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Check Slack now'}</button>
      </div>
    </section>
    {error && <p role="alert">{error}</p>}
    {!messages.length && <p>No A2A Notes messages yet.</p>}
    {messages.map(m => {
      const d = open[m.id];
      const peer = m.direction === 'in' ? m.from : m.to;
      return <article key={m.id} className="mail-item" data-a2a={m.id}>
        <h3>{m.direction === 'in' ? 'From' : 'To'} {m.peer_name || peer}: {m.subject}</h3>
        <p className="mail-meta">State: {m.state.replace('_', ' ')}. For: {m.audience}. Check: {m.check?.verdict || m.failure_code || 'none'}. Approver: {m.approver === 'nobody' ? 'nobody (the checks hold it)' : m.approver === 'reviewer' ? 'the controller or you' : 'you'}. {m.trusted ? 'Trusted sender.' : 'Not a trusted sender.'}
          {m.routes.length ? ` Given to ${m.routes.map(r => tasks.find(t => t.id === r.task)?.title || r.task).join(', ')}.` : ''}</p>
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
            <select className="mail-input" aria-label={`Task for ${m.subject}`} value={destinations[m.id] || ''} onChange={e => setDestinations(x => ({ ...x, [m.id]: e.target.value }))}>
              <option value="">Choose a task</option>{tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button className="btn" disabled={busy || !destinations[m.id]} onClick={() => act(() => request(`/messages/${m.id}/route`, { task: destinations[m.id] }))}>Give to task</button>
          </>}
          {!m.failure_code && <button className="btn" disabled={busy} onClick={() => act(() => request('/trusted', { address: peer, name: m.peer_name || peer, trusted: !m.trusted }))}>{m.trusted ? 'Stop trusting sender' : 'Trust sender'}</button>}
        </div>
      </article>;
    })}
  </div>;
}
