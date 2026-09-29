import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import '../mail.css';
interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string;
  dismissedAt?: string; sentAt?: string; sending?: boolean; error?: string;
  review?: { verdict: string; reason: string }; approval?: { by: string }; routes: { task: string }[];
}
interface Mailbox { messages: Message[]; contacts: { user: string; name: string }[]; identity: { user: string } | null; controllerApproval: boolean; error?: string }
async function request(path: string, body?: unknown) {
  const response = await fetch('/api/mail' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
export function InboxPage(props: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void }) {
  const [tab, setTab] = useState<'inbox' | 'outbox' | 'documents'>('inbox');
  const [dismissed, setDismissed] = useState(false);
  const [data, setData] = useState<Mailbox | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const load = () => request(dismissed ? '?dismissed=1' : '').then(data => { setData(data); setLoadError(''); }).catch(e => setLoadError(e.message));
  useEffect(() => { void load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [dismissed]);
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="account-mail">
    <nav className="mail-tabs" aria-label="Inbox sections">
      <button className="btn" onClick={() => setTab('inbox')} aria-pressed={tab === 'inbox'}>Messages</button>
      <button className="btn" onClick={() => setTab('documents')} aria-pressed={tab === 'documents'}>Documents to review</button>
      <button className="btn" onClick={() => setTab('outbox')} aria-pressed={tab === 'outbox'}>Outbox</button>
    </nav>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {tab === 'documents' ? <Documents {...props} /> : <>
      <details className="mail-settings"><summary>Slack connection and approval settings</summary>
        <p>{data?.identity ? `Connected as ${data.identity.user}` : 'Connect your Slack account to exchange private messages.'}</p>
        <button className="btn" disabled={busy} onClick={() => act(async () => { if (data?.identity) await request('/slack/disconnect', {}); else { const r = await request('/slack/connect', {}); location.assign(r.url); } })}>{data?.identity ? 'Disconnect Slack' : 'Connect Slack'}</button>
        <p>Slack grants access to your direct messages. Taskboard reads only contacts you add here.</p>
        <label className="opt"><input className="mail-checkbox" type="checkbox" checked={!!data?.controllerApproval} disabled={busy} onChange={e => act(() => request('/policy', { enabled: e.target.checked }))} />Allow my controller to approve ordinary communication</label>
        <p>Requests to act need your approval. Suspicious messages stay blocked. Approval never routes a message.</p>
        <form onSubmit={e => { e.preventDefault(); void act(async () => { await request('/contacts', { user: contact }); setContact(''); }); }}>
          <div className="field"><label>Slack member ID <input className="mail-input" type="text" value={contact} onChange={e => setContact(e.target.value)} placeholder="U…" required /></label></div>
          <button className="btn" disabled={busy || !data?.identity}>Add contact</button>
        </form>
        <p>New contacts start receiving messages from the time you add them.</p>
        <ul>{data?.contacts.map(c => <li key={c.user}>{c.name} ({c.user}) <button className="btn ghost" disabled={busy} onClick={() => act(() => request('/contacts/remove', { user: c.user }))}>Remove contact</button></li>)}</ul>
      </details>
      <div className="mail-tabs">
        <label className="opt"><input className="mail-checkbox" type="checkbox" checked={dismissed} onChange={e => setDismissed(e.target.checked)} />Show dismissed</label>
        <button className="btn" disabled={busy || !data?.identity} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Sync Slack and check messages'}</button>
      </div>
      {data?.error && <p role="alert">{data.error}</p>}
      {tab === 'outbox' && !dismissed && <form className="mail-compose" onSubmit={e => { e.preventDefault(); void act(async () => { await request('/draft', { to: recipient, subject, body }); setSubject(''); setBody(''); }); }}>
        <h2>New message</h2>
        <div className="field"><label>To <select className="mail-input" value={recipient} onChange={e => setRecipient(e.target.value)} required><option value="">Choose a contact</option>{data?.contacts.map(c => <option key={c.user} value={c.user}>{c.name}</option>)}</select></label></div>
        <div className="field"><label>Subject <input className="mail-input" type="text" value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required /></label></div>
        <div className="field"><label>Message <textarea className="mail-input" value={body} onChange={e => setBody(e.target.value)} rows={5} required /></label></div>
        <button className="btn" disabled={busy || !data?.identity}>Save draft for approval</button>
      </form>}
      {data && !data.messages.some(m => m.direction === tab) && <p>{dismissed ? 'No dismissed messages.' : tab === 'inbox' ? 'Your message inbox is empty.' : 'Your outbox is empty.'}</p>}
      {data?.messages.filter(m => m.direction === tab).map(m => <article key={m.id} className="mail-item">
        <h2>{m.subject}</h2><p>From {m.from} · To {m.to}</p>
        <p>{m.sentAt ? 'Sent' : m.approval ? `Approved by ${m.approval.by}` : m.review ? m.review.verdict : 'Waiting for controller review'}</p>
        {m.review && <p>{m.review.reason}</p>}
        <details><summary>Read message</summary><pre>{m.body}</pre></details>
        {m.error && <p role="alert">{m.error}</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => act(() => request(`/${m.id}/${dismissed ? 'restore' : 'dismiss'}`, {}))}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          {!dismissed && !m.review && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/review`, {}))}>Retry controller review</button>}
          {!dismissed && m.review && m.review.verdict !== 'quarantine' && !m.approval && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/approve`, { hash: m.hash }))}>Approve</button>}
          {!dismissed && m.direction === 'outbox' && m.approval && !m.sentAt && <button className="btn" disabled={busy || m.sending} onClick={() => act(() => request(`/${m.id}/send`, {}))}>Send approved message</button>}
        </div>
        {m.direction === 'inbox' && m.approval && <p>Ask your controller to route message {m.id} to a local task.</p>}
        {!!m.routes.length && <p>Routed to {m.routes.map(r => r.task).join(', ')}</p>}
        {dismissed && <p>Dismissed items keep their content and approval state. Dismiss sends no feedback.</p>}
      </article>)}
    </>}
  </div>;
}
