import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import '../mail.css';
interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string;
  dismissedAt?: string; sentAt?: string; sending?: boolean; error?: string;
  review?: { verdict: string; reason: string }; approval?: { by: string }; routes: { task: string }[];
  files?: { id: string; name: string; size: number; hash: string; review?: { verdict: string; reason: string }; routed?: { task: string } }[];
}
interface Mailbox { messages: Message[]; contacts: { user: string; name: string; status?: string }[]; requests: { user: string; name: string }[]; staged: { id: string; name: string; size: number; hash: string }[]; identity: { user: string; name?: string; needsReconnect?: boolean } | null; controllerApproval: boolean; error?: string }
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
  const [people, setPeople] = useState<{ user: string; name: string; image?: string }[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [outboxFiles, setOutboxFiles] = useState<{ task: string; taskName: string; name: string }[]>([]);
  const [outboxChoice, setOutboxChoice] = useState('');
  const load = () => request(dismissed ? '?dismissed=1' : '').then(data => { setData(data); setLoadError(''); }).catch(e => setLoadError(e.message));
  useEffect(() => { void load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [dismissed]);
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className="account-mail">
    <nav className="mail-tabs" aria-label="Inbox sections">
      <button onClick={() => setTab('inbox')} aria-pressed={tab === 'inbox'}>Messages</button>
      <button onClick={() => setTab('documents')} aria-pressed={tab === 'documents'}>Documents to review</button>
      <button onClick={() => setTab('outbox')} aria-pressed={tab === 'outbox'}>Outbox</button>
    </nav>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {tab === 'documents' ? <Documents {...props} /> : <>
      <details className="mail-settings"><summary>Slack connection and approval settings</summary>
        <p>{data?.identity ? `Connected as ${data.identity.name || data.identity.user} (${data.identity.user})` : 'Connect your Slack account to exchange private messages.'}</p>
        {data?.identity?.needsReconnect && <p role="alert">Reconnect Slack to grant file access. Disconnect Slack, then connect it again.</p>}
        <button disabled={busy} onClick={() => act(async () => { if (data?.identity) await request('/slack/disconnect', {}); else { const r = await request('/slack/connect', {}); location.assign(r.url); } })}>{data?.identity ? 'Disconnect Slack' : 'Connect Slack'}</button>
        <p>Slack grants access to your direct messages. Taskboard reads only contacts you add here.</p>
        <label><input type="checkbox" checked={!!data?.controllerApproval} disabled={busy} onChange={e => act(() => request('/policy', { enabled: e.target.checked }))} />Allow my controller to approve ordinary communication</label>
        <p>Requests to act need your approval. Suspicious messages stay blocked. Approval never routes a message.</p>
        <form onSubmit={e => { e.preventDefault(); void act(async () => { const results = await request('/people?q=' + encodeURIComponent(contact)); setPeople(results); }); }}>
          <label>Find a person by name <input value={contact} onChange={e => setContact(e.target.value)} minLength={2} required /></label>
          <button disabled={busy || !data?.identity}>Search people</button>
        </form>
        <ul>{people.map(p => <li key={p.user}>{p.image && <img src={p.image} alt="" width={24} height={24} />} {p.name} <button disabled={busy} onClick={() => act(async () => { await request('/contacts', { user: p.user }); setPeople([]); setContact(''); })}>Send contact request</button></li>)}</ul>
        {!!data?.requests?.length && <><h3>Contact requests</h3><ul>{data.requests.map(r => <li key={r.user}>{r.name} <button disabled={busy} onClick={() => act(() => request('/contacts/respond', { user: r.user, accept: true }))}>Accept</button> <button disabled={busy} onClick={() => act(() => request('/contacts/respond', { user: r.user, accept: false }))}>Decline</button></li>)}</ul></>}
        <h3>Contacts</h3>
        <ul>{data?.contacts.map(c => <li key={c.user}>{c.name} ({c.status === 'active' ? 'Active' : c.status === 'requested' ? 'Request sent' : 'Needs request'}) {c.status === 'needs-request' || !c.status ? <button disabled={busy} onClick={() => act(() => request('/contacts', { user: c.user }))}>Send request</button> : null} <button disabled={busy} onClick={() => act(() => request('/contacts/remove', { user: c.user }))}>Remove contact</button></li>)}</ul>
      </details>
      <div className="mail-tabs">
        <label><input type="checkbox" checked={dismissed} onChange={e => setDismissed(e.target.checked)} />Show dismissed</label>
        <button disabled={busy || !data?.identity} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Sync Slack and check messages'}</button>
      </div>
      {data?.error && <p role="alert">{data.error}</p>}
      {tab === 'outbox' && !dismissed && <form className="mail-compose" onSubmit={e => { e.preventDefault(); void act(async () => { await request('/draft', { to: recipient, subject, body, files: selectedFiles }); setSubject(''); setBody(''); setSelectedFiles([]); }); }}>
        <h2>New message</h2>
        <label>To <select value={recipient} onChange={e => setRecipient(e.target.value)} required><option value="">Choose a contact</option>{data?.contacts.filter(c => c.status === 'active').map(c => <option key={c.user} value={c.user}>{c.name}</option>)}</select></label>
        <label>Subject <input value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required /></label>
        <label>Message <textarea value={body} onChange={e => setBody(e.target.value)} rows={5} required /></label>
        <label>Attach files <input type="file" multiple accept=".txt,.md,.pdf,.docx" onChange={e => { const files = Array.from(e.target.files || []); void act(async () => { for (const file of files) { const response = await fetch('/api/mail/files/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-mail-filename': encodeURIComponent(file.name) }, body: file }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'File upload failed'); setSelectedFiles(current => [...current, result.id]); } }); e.target.value = ''; }} /></label>
        <button type="button" disabled={busy} onClick={() => act(async () => { const response = await fetch('/api/docs/all'); if (!response.ok) throw new Error('Could not read task outboxes'); const all = await response.json() as Record<string, { name: string }[]>; setOutboxFiles(Object.entries(all).flatMap(([task, files]) => files.filter(f => /\.(txt|md|pdf|docx)$/i.test(f.name)).map(f => ({ task, name: f.name, taskName: props.tasks.find(t => t.id === task)?.title || task })))); })}>List task outbox files</button>
        {!!outboxFiles.length && <div><select aria-label="Task outbox file" value={outboxChoice} onChange={e => setOutboxChoice(e.target.value)}><option value="">Choose a task outbox file</option>{outboxFiles.map((f, index) => <option key={`${f.task}/${f.name}`} value={String(index)}>{f.taskName}: {f.name}</option>)}</select><button type="button" disabled={busy || !outboxChoice} onClick={() => act(async () => { const f = outboxFiles[Number(outboxChoice)]; const result = await request('/files/stage', { task: f.task, name: f.name }); setSelectedFiles(current => [...current, result.id]); setOutboxChoice(''); })}>Attach selected file</button></div>}
        {!!data?.staged?.length && <fieldset><legend>Files for this draft</legend>{data.staged.map(f => <label key={f.id}><input type="checkbox" checked={selectedFiles.includes(f.id)} onChange={e => setSelectedFiles(current => e.target.checked ? [...current, f.id] : current.filter(id => id !== f.id))} />{f.name} ({Math.ceil(f.size / 1024)} KiB) <small>SHA-256: {f.hash}</small> <button type="button" disabled={busy} onClick={() => act(async () => { await request('/files/staged/remove', { id: f.id }); setSelectedFiles(current => current.filter(id => id !== f.id)); })}>Remove</button></label>)}</fieldset>}
        <button disabled={busy || !data?.identity}>Save draft for approval</button>
      </form>}
      {data && !data.messages.some(m => m.direction === tab) && <p>{dismissed ? 'No dismissed messages.' : tab === 'inbox' ? 'Your message inbox is empty.' : 'Your outbox is empty.'}</p>}
      {data?.messages.filter(m => m.direction === tab).map(m => <article key={m.id} className="mail-item">
        <h2>{m.subject}</h2><p>From {m.from} · To {m.to}</p>
        <p>{m.sentAt ? 'Sent' : m.approval ? `Approved by ${m.approval.by}` : m.review ? m.review.verdict : 'Waiting for controller review'}</p>
        {m.review && <p>{m.review.reason}</p>}
        <details><summary>Read message</summary><pre>{m.body}</pre></details>
        {!!m.files?.length && <div><h3>Files</h3><ul>{m.files.map(f => <li key={f.id}>{f.name} ({Math.ceil(f.size / 1024)} KiB). {f.review?.verdict || 'Waiting for controller review'}.
          {m.direction === 'inbox' && f.review && f.review.verdict !== 'quarantine' && <a href={`/api/mail/${m.id}/files/${f.id}/download`}>Download</a>}
          {m.direction === 'inbox' && m.approval && f.review && f.review.verdict !== 'quarantine' && !f.routed && <><select aria-label={`Task for ${f.name}`} value={destinations[f.id] || ''} onChange={e => setDestinations(current => ({ ...current, [f.id]: e.target.value }))}><option value="">Choose a task</option>{props.tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button disabled={busy || !destinations[f.id]} onClick={() => act(() => request(`/${m.id}/files/${f.id}/route`, { task: destinations[f.id], hash: f.hash }))}>Approve file for task</button></>}
          {f.routed && ` Sent to ${f.routed.task}.`}</li>)}</ul></div>}
        {m.error && <p role="alert">{m.error}</p>}
        <div className="mail-tabs">
          <button disabled={busy} onClick={() => act(() => request(`/${m.id}/${dismissed ? 'restore' : 'dismiss'}`, {}))}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          {!dismissed && !m.review && <button disabled={busy} onClick={() => act(() => request(`/${m.id}/review`, {}))}>Retry controller review</button>}
          {!dismissed && m.review && m.review.verdict !== 'quarantine' && !m.approval && <button disabled={busy} onClick={() => act(() => request(`/${m.id}/approve`, { hash: m.hash }))}>Approve</button>}
          {!dismissed && m.direction === 'outbox' && m.approval && !m.sentAt && <button disabled={busy || m.sending} onClick={() => act(() => request(`/${m.id}/send`, {}))}>Send approved message</button>}
        </div>
        {m.direction === 'inbox' && m.approval && <p>Ask your controller to route message {m.id} to a local task.</p>}
        {!!m.routes.length && <p>Routed to {m.routes.map(r => r.task).join(', ')}</p>}
        {dismissed && <p>Dismissed items keep their content and approval state. Dismiss sends no feedback.</p>}
      </article>)}
    </>}
  </div>;
}
