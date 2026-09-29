import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import '../mail.css';
interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string;
  created: string; dismissedAt?: string; sendStartedAt?: string; sentAt?: string; sending?: boolean; error?: string;
  proposedBy?: { actor: 'user' | 'controller' | 'task'; task?: string; agent?: string };
  review?: { verdict: string; reason: string; at: string }; approval?: { by: string; at: string }; routes: { task: string }[];
}
interface Mailbox { messages: Message[]; contacts: { user: string; name: string }[]; identity: { user: string } | null; controllerApproval: boolean; error?: string }
function sentState(m: Message) {
  if (m.sentAt) return 'Sent';
  if (m.sending && m.error) return 'Delivery uncertain';
  if (m.sending) return 'Sending';
  if (m.review?.verdict === 'quarantine') return 'Blocked';
  if (m.approval) return 'Approved';
  if (m.review) return 'Awaiting approval';
  return m.error ? 'Review failed' : 'Awaiting review';
}
function date(at?: string) { return at ? new Date(at).toLocaleString() : 'Unknown'; }
function proposer(m: Message, tasks: Task[]) {
  if (!m.proposedBy) return 'Unknown';
  if (m.proposedBy.actor !== 'task') return m.proposedBy.actor === 'user' ? 'User' : 'Controller';
  const task = tasks.find(t => t.id === m.proposedBy?.task);
  return `${task ? `#${task.num} ${task.title}` : m.proposedBy.task || 'Unknown task'} (${m.proposedBy.agent || 'Unknown agent'})`;
}
function SentHistory({ messages, contacts, tasks, busy, act }: {
  messages: Message[]; contacts: Mailbox['contacts']; tasks: Task[]; busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [recipientFilter, setRecipientFilter] = useState('');
  const [proposerFilter, setProposerFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const outgoing = messages.filter(m => m.direction === 'outbox').sort((a, b) => b.created.localeCompare(a.created));
  const filtered = outgoing.filter(m => (!recipientFilter || m.to === recipientFilter) && (!proposerFilter || (m.proposedBy?.task || m.proposedBy?.actor || 'unknown') === proposerFilter) && (!stateFilter || sentState(m) === stateFilter));
  const selected = filtered.find(m => m.id === selectedId) || filtered[0];
  const contactName = (id: string) => contacts.find(c => c.user === id)?.name || id;
  const steps = selected ? [
    { label: 'Draft created', at: selected.created },
    { label: selected.review ? `Controller review: ${selected.review.verdict}` : 'Controller review pending', at: selected.review?.at },
    { label: selected.approval ? `Approved by ${selected.approval.by}` : 'Approval pending', at: selected.approval?.at },
    ...(selected.sendStartedAt ? [{ label: 'Slack post started', at: selected.sendStartedAt }] : []),
    ...(selected.sentAt ? [{ label: 'Slack confirmed the post', at: selected.sentAt }] : []),
  ] : [];
  return <section className="mail-history" aria-label="Sent messages">
    <div className="mail-filters">
      <div className="field"><label>Recipient <select className="mail-input" value={recipientFilter} onChange={e => setRecipientFilter(e.target.value)}><option value="">All recipients</option>{[...new Set(outgoing.map(m => m.to))].map(id => <option key={id} value={id}>{contactName(id)}</option>)}</select></label></div>
      <div className="field"><label>Task or proposer <select className="mail-input" value={proposerFilter} onChange={e => setProposerFilter(e.target.value)}><option value="">All proposers</option>{[...new Set(outgoing.map(m => m.proposedBy?.task || m.proposedBy?.actor || 'unknown'))].map(id => <option key={id} value={id}>{id === 'unknown' ? 'Unknown' : proposer(outgoing.find(m => (m.proposedBy?.task || m.proposedBy?.actor || 'unknown') === id)!, tasks)}</option>)}</select></label></div>
      <div className="field"><label>State <select className="mail-input" value={stateFilter} onChange={e => setStateFilter(e.target.value)}><option value="">All states</option>{[...new Set(outgoing.map(sentState))].map(state => <option key={state} value={state}>{state}</option>)}</select></label></div>
    </div>
    {!filtered.length && <p>{outgoing.length ? 'No messages match these filters.' : 'Your sent message history is empty.'}</p>}
    {!!filtered.length && <div className="mail-history-grid">
      <div className="mail-history-list" aria-label="Outgoing messages">{filtered.map(m => <button className="btn mail-history-row" key={m.id} aria-pressed={selected?.id === m.id} onClick={() => setSelectedId(m.id)}>
        <strong>{m.subject}</strong><span>{contactName(m.to)} · {sentState(m)}</span><span>{date(m.sentAt || m.created)}</span>
      </button>)}</div>
      {selected && <article className="mail-item mail-history-detail">
        <h2>{selected.subject}</h2>
        <p>Sender: {selected.from}</p><p>Recipient: {contactName(selected.to)} ({selected.to})</p>
        <p>Proposed by: {proposer(selected, tasks)}</p><p>Approved by: {selected.approval?.by || 'No approval recorded'}</p>
        <p>State: {sentState(selected)}{selected.dismissedAt ? ' · Dismissed' : ''}</p><p>Sent: {date(selected.sentAt)}</p>
        <h3>Full message</h3><pre>{selected.body}</pre>
        <h3>Recorded steps</h3><ol>{steps.map((step, i) => <li key={i}>{step.label}: {date(step.at)}</li>)}</ol>
        {selected.error && <p role="alert">{selected.error}</p>}
        {selected.sentAt && <p>Slack confirmed this post. Taskboard has no record that the recipient saved or read it.</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/${selected.dismissedAt ? 'restore' : 'dismiss'}`, {}))}>{selected.dismissedAt ? 'Restore' : 'Dismiss'}</button>
          {!selected.dismissedAt && !selected.review && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/review`, {}))}>Retry controller review</button>}
          {!selected.dismissedAt && selected.review && selected.review.verdict !== 'quarantine' && !selected.approval && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/approve`, { hash: selected.hash }))}>Approve</button>}
          {!selected.dismissedAt && selected.approval && !selected.sentAt && <button className="btn" disabled={busy || selected.sending} onClick={() => void act(() => request(`/${selected.id}/send`, {}))}>Send approved message</button>}
        </div>
      </article>}
    </div>}
  </section>;
}
async function request(path: string, body?: unknown) {
  const response = await fetch('/api/mail' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
export function InboxPage(props: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void }) {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'documents'>('inbox');
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
      <button className="btn" onClick={() => setTab('sent')} aria-pressed={tab === 'sent'}>Sent</button>
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
        {tab === 'inbox' && <label className="opt"><input className="mail-checkbox" type="checkbox" checked={dismissed} onChange={e => setDismissed(e.target.checked)} />Show dismissed</label>}
        <button className="btn" disabled={busy || !data?.identity} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Sync Slack and check messages'}</button>
      </div>
      {data?.error && <p role="alert">{data.error}</p>}
      {tab === 'sent' && <form className="mail-compose" onSubmit={e => { e.preventDefault(); void act(async () => { await request('/draft', { to: recipient, subject, body }); setSubject(''); setBody(''); }); }}>
        <h2>New message</h2>
        <div className="field"><label>To <select className="mail-input" value={recipient} onChange={e => setRecipient(e.target.value)} required><option value="">Choose a contact</option>{data?.contacts.map(c => <option key={c.user} value={c.user}>{c.name}</option>)}</select></label></div>
        <div className="field"><label>Subject <input className="mail-input" type="text" value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required /></label></div>
        <div className="field"><label>Message <textarea className="mail-input" value={body} onChange={e => setBody(e.target.value)} rows={5} required /></label></div>
        <button className="btn" disabled={busy || !data?.identity}>Save draft for approval</button>
      </form>}
      {tab === 'sent' && data && <SentHistory messages={data.messages} contacts={data.contacts} tasks={props.tasks} busy={busy} act={act} />}
      {tab === 'inbox' && data && !data.messages.some(m => m.direction === 'inbox') && <p>{dismissed ? 'No dismissed messages.' : 'Your message inbox is empty.'}</p>}
      {tab === 'inbox' && data?.messages.filter(m => m.direction === 'inbox').map(m => <article key={m.id} className="mail-item">
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
