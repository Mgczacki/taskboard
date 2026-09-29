import { useEffect, useRef, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import type { DocumentLink } from '../documentLinks';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import '../mail.css';
function MailBody({ body }: { body: string }) {
  return <div className="md mail-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(body, { async: false }) as string) }} />;
}
export interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string;
  created: string; dismissedAt?: string; sendStartedAt?: string; sentAt?: string; sending?: boolean; error?: string;
  proposedBy?: { actor: 'user' | 'controller' | 'task'; task?: string; agent?: string };
  review?: { verdict: string; reason: string; at: string }; approval?: { by: string; at: string }; routes: { task: string }[];
  files?: { id: string; name: string; size: number; hash: string; review?: { verdict: string; reason: string }; routed?: { task: string } }[];
  source?: string; rejectedAt?: string; unseen?: boolean; proposedRoute?: { task: string | null }; returns?: { comment: string }[];
  // from the server's permission levels (server/mail/policy.ts): who may approve this message now
  approver?: 'user' | 'controller' | 'nobody'; trusted?: boolean;
}
interface Mailbox { messages: Message[]; contacts: { user: string; name: string; status?: string }[]; requests: { user: string; name: string }[]; staged: { id: string; name: string; size: number; hash: string }[]; identity: { user: string; name?: string; needsReconnect?: boolean } | null; trustedSenders: { user: string; name: string }[]; levels: { incoming: number; outgoing: number }; error?: string }
export function sentState(m: Message) {
  if (m.sentAt) return 'Sent';
  if (m.sending && m.error) return 'Delivery uncertain';
  if (m.sending) return 'Sending';
  if (m.rejectedAt) return 'Rejected';
  if (m.review?.verdict === 'quarantine' || (m.review && m.approver === 'nobody')) return 'Blocked';
  if (m.approval) return 'Approved';
  if (m.review) return m.approver === 'controller' ? 'Awaiting the controller' : 'Awaiting your approval';
  return m.error ? 'Review failed' : 'Awaiting review';
}
function taskLabel(id: string, tasks: Task[]) { const t = tasks.find(x => x.id === id); return t ? `#${t.num} ${t.title}` : id; }
// What happens next to an incoming message, from the server's permission levels
export function inboxState(m: Message, tasks: Task[]) {
  if (m.rejectedAt) return 'Rejected. No agent receives it.';
  if (m.approval) return `Approved by ${m.approval.by === 'user' ? 'you' : 'the controller'}.`;
  if (!m.review) return m.error ? 'The check failed. No agent receives it.' : 'Waiting for the controller check.';
  if (m.review.verdict === 'quarantine') return 'Quarantine: the check found a problem. No agent receives it.';
  if (m.approver === 'nobody') return 'Held: the message failed the safety check. No agent receives it at this level.';
  if (m.approver === 'controller') return 'The controller may approve it and route it.';
  if (m.source !== 'slack') return 'From one of your tasks.';
  if (m.proposedRoute?.task) return `Waiting for your approval. The controller proposes ${taskLabel(m.proposedRoute.task, tasks)}.`;
  if (m.proposedRoute) return 'The controller says that no task needs this message.';
  return 'Waiting for your approval. The controller has not proposed a task yet.';
}
export function date(at?: string) { return at ? new Date(at).toLocaleString() : 'Unknown'; }
export function proposer(m: Message, tasks: Task[]) {
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
        <h3>Full message</h3><MailBody body={selected.body} />
        {!!selected.files?.length && <><h3>Files</h3><ul>{selected.files.map(f => <li key={f.id}>{f.name} ({Math.ceil(f.size / 1024)} KiB). {f.review?.verdict || 'Waiting for controller review'}.</li>)}</ul></>}
        <h3>Recorded steps</h3><ol>{steps.map((step, i) => <li key={i}>{step.label}: {date(step.at)}</li>)}</ol>
        {selected.error && <p role="alert">{selected.error}</p>}
        {selected.sentAt && <p>Slack confirmed this post. Taskboard has no record that the recipient saved or read it.</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/${selected.dismissedAt ? 'restore' : 'dismiss'}`, {}))}>{selected.dismissedAt ? 'Restore' : 'Dismiss'}</button>
          {!selected.dismissedAt && !selected.review && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/review`, {}))}>Retry controller review</button>}
          {!selected.dismissedAt && selected.review && selected.approver !== 'nobody' && !selected.approval && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/approve`, { hash: selected.hash }))}>Approve</button>}
          {!selected.trusted && <button className="btn ghost" disabled={busy} onClick={() => void act(() => request('/trusted', { user: selected.to, name: contactName(selected.to), trusted: true }))}>Trust this person</button>}
          {!selected.dismissedAt && selected.approval && !selected.sentAt && <button className="btn" disabled={busy || selected.sending} onClick={() => void act(() => request(`/${selected.id}/send`, {}))}>Send approved message</button>}
        </div>
      </article>}
    </div>}
  </section>;
}
export async function request(path: string, body?: unknown) {
  const response = await fetch('/api/mail' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
export interface Person { user: string; name: string; realName: string; title: string; isBot: boolean; deleted: boolean; email?: string }
export function MemberPicker({ value, onChange, disabled, onSelect, exclude = [] }: {
  value: string; onChange: (user: string) => void; disabled: boolean; onSelect?: (person: Person) => void; exclude?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const shown = people.filter(person => !exclude.includes(person.user));
  useEffect(() => {
    if (!open || query.trim().length < 2) { setPeople([]); setHasMore(false); setLoading(false); return; }
    setPeople([]); setHasMore(false);
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      void request('/people?q=' + encodeURIComponent(query.trim())).then((result: { matches: Person[]; hasMore: boolean }) => {
        if (!cancelled) { setPeople(result.matches); setHasMore(result.hasMore); }
      }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [highlight, open]);
  const choose = (person: Person) => { onChange(person.user); onSelect?.(person); setChosen(person); setOpen(false); setQuery(''); setHighlight(0); };
  return <div className="mail-member-picker" ref={root}>
    <button className="btn mail-member-trigger" type="button" role="combobox" aria-label="To" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? 'mail-member-options' : undefined} disabled={disabled} onClick={() => setOpen(!open)}>
      {chosen && chosen.user === value ? chosen.name : <span>Choose a Slack member</span>}
      <span className="mail-member-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="mail-member-menu">
      <input className="mail-input" ref={search} type="search" aria-label="Find a workspace member" placeholder="Find a workspace member" value={query} onChange={event => { setQuery(event.target.value); setHighlight(0); }} onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); event.preventDefault(); }
        if (event.key === 'ArrowDown') { setHighlight(index => Math.min(index + 1, Math.max(0, shown.length - 1))); event.preventDefault(); }
        if (event.key === 'ArrowUp') { setHighlight(index => Math.max(index - 1, 0)); event.preventDefault(); }
        if (event.key === 'Enter' && shown[highlight] && !shown[highlight].isBot && !shown[highlight].deleted) { choose(shown[highlight]); event.preventDefault(); }
      }} />
      <div id="mail-member-options" className="mail-member-options" role="listbox" aria-label="Workspace members">
        {shown.map((person, index) => <button className="btn mail-member-option" type="button" role="option" aria-selected={person.user === value} data-highlighted={index === highlight} key={person.user} disabled={person.isBot || person.deleted} onMouseEnter={() => setHighlight(index)} onClick={() => choose(person)}>
          <span>{person.name}<small>{person.title || 'No title'} · {person.user}{person.isBot ? ' · Bot' : ''}{person.deleted ? ' · Deactivated' : ''}</small></span>
        </button>)}
        {query.trim().length < 2 && <p>Enter at least two characters.</p>}
        {loading && <p>Searching Slack members…</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && query.trim().length >= 2 && !shown.length && <p>No matching members.</p>}
        {hasMore && <p>More members match. Enter more text.</p>}
      </div>
    </div>}
  </div>;
}
export function InboxPage(props: { tasks: Task[]; open: (id: string, tab?: 'terminal' | 'log' | 'docs') => void; documentLink?: DocumentLink | null }) {
  const [tab, setTab] = useState<'inbox' | 'sent' | 'documents'>(props.documentLink ? 'documents' : 'inbox');
  useEffect(() => { if (props.documentLink) setTab('documents'); }, [props.documentLink]);
  const [dismissed, setDismissed] = useState(false);
  const [data, setData] = useState<Mailbox | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [outboxFiles, setOutboxFiles] = useState<{ task: string; taskName: string; name: string }[]>([]);
  const [outboxChoice, setOutboxChoice] = useState('');
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
        <p>{data?.identity ? `Connected as ${data.identity.name || data.identity.user}` : 'Connect your Slack account to exchange private messages.'}</p>
        {data?.identity?.needsReconnect && <p role="alert">Reconnect Slack to grant the current permissions. Disconnect Slack, then connect it again.</p>}

        <button className="btn" disabled={busy} onClick={() => act(async () => { if (data?.identity) await request('/slack/disconnect', {}); else { const r = await request('/slack/connect', {}); location.assign(r.url); } })}>{data?.identity ? 'Disconnect Slack' : 'Connect Slack'}</button>
        <p>Taskboard reads Taskboard messages in your Slack direct conversations.</p>
        <p>Incoming level {data?.levels.incoming ?? '…'}, outgoing level {data?.levels.outgoing ?? '…'}. Approval levels and trusted people are on the <a href="#settings">Settings page</a>.</p>
      </details>
      <div className="mail-tabs">
        {tab === 'inbox' && <label className="opt"><input className="mail-checkbox" type="checkbox" checked={dismissed} onChange={e => setDismissed(e.target.checked)} />Show dismissed</label>}

        <button className="btn" disabled={busy || !data?.identity} onClick={() => act(() => request('/sync', {}))}>{busy ? 'Working…' : 'Sync Slack and check messages'}</button>
      </div>
      {data?.error && <p role="alert">{data.error}</p>}
      {tab === 'sent' && <form className="mail-compose" onSubmit={e => { e.preventDefault(); void act(async () => { await request('/draft', { to: recipient, subject, body, files: selectedFiles }); setSubject(''); setBody(''); setSelectedFiles([]); }); }}>
        <h2>New message</h2>
        <div className="field">
          <div className="mail-recipient-label">To</div>
          <MemberPicker value={recipient} onChange={setRecipient} disabled={busy || !data?.identity} />
        </div>
        <div className="field"><label>Subject <input className="mail-input" value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required /></label></div>
        <div className="field"><label>Message <textarea className="mail-input" value={body} onChange={e => setBody(e.target.value)} rows={5} required /></label></div>
        <div className="field"><label>Attach files <input className="mail-input" type="file" multiple accept=".txt,.md,.pdf,.docx" onChange={e => { const files = Array.from(e.target.files || []); void act(async () => { for (const file of files) { const response = await fetch('/api/mail/files/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-mail-filename': encodeURIComponent(file.name) }, body: file }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'File upload failed'); setSelectedFiles(current => [...current, result.id]); } }); e.target.value = ''; }} /></label></div>
        <button className="btn" type="button" disabled={busy} onClick={() => act(async () => { const response = await fetch('/api/docs/all'); if (!response.ok) throw new Error('Could not read task outboxes'); const all = await response.json() as Record<string, { name: string }[]>; setOutboxFiles(Object.entries(all).flatMap(([task, files]) => files.filter(f => /\.(txt|md|pdf|docx)$/i.test(f.name)).map(f => ({ task, name: f.name, taskName: props.tasks.find(t => t.id === task)?.title || task })))); })}>List task outbox files</button>
        {!!outboxFiles.length && <div><select className="mail-input" aria-label="Task outbox file" value={outboxChoice} onChange={e => setOutboxChoice(e.target.value)}><option value="">Choose a task outbox file</option>{outboxFiles.map((f, index) => <option key={`${f.task}/${f.name}`} value={String(index)}>{f.taskName}: {f.name}</option>)}</select><button className="btn" type="button" disabled={busy || !outboxChoice} onClick={() => act(async () => { const f = outboxFiles[Number(outboxChoice)]; const result = await request('/files/stage', { task: f.task, name: f.name }); setSelectedFiles(current => [...current, result.id]); setOutboxChoice(''); })}>Attach selected file</button></div>}
        {!!data?.staged?.length && <fieldset><legend>Files for this draft</legend>{data.staged.map(f => <label key={f.id}><input className="mail-checkbox" type="checkbox" checked={selectedFiles.includes(f.id)} onChange={e => setSelectedFiles(current => e.target.checked ? [...current, f.id] : current.filter(id => id !== f.id))} />{f.name} ({Math.ceil(f.size / 1024)} KiB) <small>SHA-256: {f.hash}</small> <button className="btn" type="button" disabled={busy} onClick={() => act(async () => { await request('/files/staged/remove', { id: f.id }); setSelectedFiles(current => current.filter(id => id !== f.id)); })}>Remove</button></label>)}</fieldset>}

        <button className="btn" disabled={busy || !data?.identity || !recipient}>Save draft for approval</button>
      </form>}
      {tab === 'sent' && data && <SentHistory messages={data.messages} contacts={data.contacts} tasks={props.tasks} busy={busy} act={act} />}
      {tab === 'inbox' && data && !data.messages.some(m => m.direction === 'inbox') && <p>{dismissed ? 'No dismissed messages.' : 'Your message inbox is empty.'}</p>}
      {tab === 'inbox' && data?.messages.filter(m => m.direction === 'inbox').map(m => <article key={m.id} className="mail-item">
        <h2>{m.subject}</h2><p>From {m.from} · To {m.to}</p>
        <p>{inboxState(m, props.tasks)}</p>
        {m.review && <p>Check: {m.review.verdict}. {m.review.reason}</p>}
        {m.source === 'slack' && !m.trusted && <p>{m.from} is not a trusted sender. <button className="btn ghost" disabled={busy} onClick={() => act(() => request('/trusted', { user: m.from, name: m.from, trusted: true }))}>Trust this sender</button></p>}
        {m.unseen && <p role="alert">The controller routed this message to {m.routes.map(r => taskLabel(r.task, props.tasks)).join(', ')} without your approval. <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/seen`, {}))}>Mark as seen</button></p>}
        <details><summary>Read message</summary><MailBody body={m.body} /></details>
        {!!m.files?.length && <div><h3>Files</h3><ul>{m.files.map(f => <li key={f.id}>{f.name} ({Math.ceil(f.size / 1024)} KiB). {f.review?.verdict || 'Waiting for controller review'}.
          {m.direction === 'inbox' && f.review && f.review.verdict !== 'quarantine' && <a href={`/api/mail/${m.id}/files/${f.id}/download`}>Download</a>}
          {m.direction === 'inbox' && m.approval && f.review && f.review.verdict !== 'quarantine' && !f.routed && <><select className="mail-input" aria-label={`Task for ${f.name}`} value={destinations[f.id] || ''} onChange={e => setDestinations(current => ({ ...current, [f.id]: e.target.value }))}><option value="">Choose a task</option>{props.tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button className="btn" disabled={busy || !destinations[f.id]} onClick={() => act(() => request(`/${m.id}/files/${f.id}/route`, { task: destinations[f.id], hash: f.hash }))}>Approve file for task</button></>}
          {f.routed && ` Sent to ${f.routed.task}.`}</li>)}</ul></div>}
        {m.error && <p role="alert">{m.error}</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => act(() => request(`/${m.id}/${dismissed ? 'restore' : 'dismiss'}`, {}))}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          {!dismissed && !m.review && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/review`, {}))}>Retry controller review</button>}
          {!dismissed && m.review && m.approver !== 'nobody' && !m.approval && !m.rejectedAt && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/approve`, { hash: m.hash }))}>Approve</button>}
          {!dismissed && m.direction === 'inbox' && m.review && m.approver !== 'nobody' && !m.rejectedAt && <><select className="mail-input" aria-label={`Task for message ${m.subject}`} value={destinations[m.id] || m.proposedRoute?.task || ''} onChange={e => setDestinations(current => ({ ...current, [m.id]: e.target.value }))}><option value="">Choose a task</option>{props.tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button className="btn" disabled={busy || !(destinations[m.id] || m.proposedRoute?.task)} onClick={() => act(() => request(`/${m.id}/route-to`, { task: destinations[m.id] || m.proposedRoute?.task, hash: m.hash }))}>Approve and send to task</button></>}
          {!dismissed && m.direction === 'outbox' && m.approval && !m.sentAt && <button className="btn" disabled={busy || m.sending} onClick={() => act(() => request(`/${m.id}/send`, {}))}>Send approved message</button>}
        </div>
        {!!m.routes.length && <p>Routed to {m.routes.map(r => taskLabel(r.task, props.tasks)).join(', ')}</p>}
        {dismissed && <p>Dismissed items keep their content and approval state. Dismiss sends no feedback.</p>}
      </article>)}
    </>}
  </div>;
}
