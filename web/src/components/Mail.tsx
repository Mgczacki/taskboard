import { useEffect, useRef, useState } from 'react';
import type { Task } from '../api';
import { InboxPage as Documents } from './Review';
import { A2ANotesPanel } from './A2ANotes';
import type { DocumentLink } from '../documentLinks';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import '../mail.css';
function MailBody({ body }: { body: string }) {
  return <div className="md mail-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(body, { async: false }) as string) }} />;
}
export interface QualityView { state: string; flags: { text: string; start: number; end: number; reason: string }[]; suggestedBody: string }
export function FlaggedBody({ body, quality }: { body: string; quality?: QualityView }) {
  if (!quality?.flags.length) return <MailBody body={body} />;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const flag of quality.flags) {
    parts.push(body.slice(offset, flag.start));
    parts.push(<mark className="mail-flag" key={flag.start} title={flag.reason}>{body.slice(flag.start, flag.end)}<small>{flag.reason}</small></mark>);
    offset = flag.end;
  }
  parts.push(body.slice(offset));
  return <pre className="mail-flagged-body">{parts}</pre>;
}
export interface Message {
  id: string; direction: 'inbox' | 'outbox'; from: string; to: string; subject: string; body: string; hash: string;
  created: string; dismissedAt?: string; sendStartedAt?: string; sentAt?: string; sending?: boolean; error?: string;
  proposedBy?: { actor: 'user' | 'controller' | 'task'; task?: string; agent?: string };
  review?: { verdict: string; reason: string; at: string }; approval?: { by: string; at: string }; routes: { task: string; delivery?: Delivery }[];
  quality?: QualityView;
  files?: (FileInfo & { routed?: { task: string; delivery?: Delivery } })[];
  source?: string; rejectedAt?: string; unseen?: boolean; proposedRoute?: { task: string | null };
  // comments from Send back on the approval card, and whether the agent was told (server/inbox-delivery.ts)
  returns?: { comment: string; at: string; task: string; delivery?: Delivery }[];
  // from the server's permission levels (server/mail/policy.ts): who may approve this message now
  approver?: 'user' | 'controller' | 'nobody'; trusted?: boolean;
  // outgoing drafts: why the user cannot edit it now (null: the user can), the saved edits and the text before each one
  editBlocked?: string | null; edits?: { at: string; by: 'user' }[];
  versions?: { subject: string; body: string; files: FileInfo[]; hash: string; author: 'user' | 'controller' | 'task'; replacedAt: string; review?: { verdict: string } }[];
}
// Whether the agent of a task was told about a file that the server put in its inbox
type Delivery = { task: string; delivered: boolean; at?: string; resumed?: boolean; problem?: string };
type FileInfo = { id: string; name: string; size: number; hash: string; longBody?: boolean; review?: { verdict: string; reason: string } };
// The sizes that decide how Slack shows a message (POST /api/mail/measure, from server/mail/presentation.ts)
interface Size { subjectBytes: number; bodyBytes: number; rendered: number; limits: { subjectBytes: number; header: number; section: number; bodyBytes: number } }
const characters = (text: string) => Array.from(text).length;
export function SlackSize({ subject, body }: { subject: string; body: string }) {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => void request('/measure', { subject, body }).then(setSize).catch(() => setSize(null)), 300);
    return () => clearTimeout(timer);
  }, [subject, body]);
  const notes: { text: string; warn?: boolean }[] = [];
  notes.push({ text: `Subject: ${characters(subject)} characters${size ? ` (${size.subjectBytes} of ${size.limits.subjectBytes} bytes)` : ''}.` });
  if (size && size.subjectBytes > size.limits.subjectBytes) notes.push({ text: `The subject is over the ${size.limits.subjectBytes}-byte limit. Taskboard cannot save it.`, warn: true });
  else if (size && size.subjectBytes > size.limits.subjectBytes * 0.9) notes.push({ text: `The subject is near the ${size.limits.subjectBytes}-byte limit.`, warn: true });
  if (size && characters(subject) > size.limits.header - 1) notes.push({ text: `Slack shows only the first ${size.limits.header - 1} characters of the subject in the message header.`, warn: true });
  notes.push({ text: `Message: ${characters(body)} characters.${size ? ` Slack text section: ${size.rendered} of ${size.limits.section} characters after Slack formatting.` : ''}` });
  if (size && size.bodyBytes > size.limits.bodyBytes) notes.push({ text: `The message is over the ${size.limits.bodyBytes}-byte limit. Taskboard cannot save it.`, warn: true });
  else if (size && size.rendered > size.limits.section) notes.push({ text: `The message is over the Slack limit of ${size.limits.section} characters. Taskboard attaches the full text as message.md. Slack shows the first part only. This file uses one of the five file places.`, warn: true });
  else if (size && size.rendered > size.limits.section * 0.9) notes.push({ text: `The message is near the Slack limit of ${size.limits.section} characters. Above the limit, Slack shows the first part only and the full text goes in message.md.`, warn: true });
  return <div className="mail-size" aria-live="polite">{notes.map((note, i) => <p key={i} className={note.warn ? 'mail-size-warn' : undefined}>{note.text}</p>)}</div>;
}
// A line diff of two texts (longest common subsequence). Above 4,000,000 line pairs, it shows all old lines as removed and all new lines as added.
export function lineDiff(before: string, after: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map(text => ({ kind: 'removed' as const, text })), ...b.map(text => ({ kind: 'added' as const, text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ kind: 'removed', text: a[i++] });
    else out.push({ kind: 'added', text: b[j++] });
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}
function TextChanges({ before, after }: { before: { subject: string; body: string; files: FileInfo[] }; after: { subject: string; body: string; files: FileInfo[] } }) {
  const names = (files: FileInfo[]) => files.filter(f => !f.longBody).map(f => f.name).join(', ') || 'No files';
  return <div className="mail-diff">
    {before.subject !== after.subject && <p>Subject before: {before.subject}<br />Subject after: {after.subject}</p>}
    {names(before.files) !== names(after.files) && <p>Files before: {names(before.files)}<br />Files after: {names(after.files)}</p>}
    <pre aria-label="Changes to the message">{lineDiff(before.body, after.body).map((line, i) => <span key={i} className={`mail-diff-${line.kind}`}>{line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}{line.text}{'\n'}</span>)}</pre>
  </div>;
}
interface EditState { subject: string; body: string; files: string[] }
function DraftEditor({ m, start, busy, act, close }: { m: Message; start: EditState; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; close: () => void }) {
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [files, setFiles] = useState(start.files);
  // the attachments of this draft and of its earlier versions; Taskboard makes message.md again from the text
  const known = [...(m.files || []), ...(m.versions || []).flatMap(v => v.files)].filter((f, i, all) => !f.longBody && all.findIndex(x => x.id === f.id) === i);
  return <form className="mail-editor" onSubmit={e => { e.preventDefault(); void act(async () => { await request(`/${m.id}/edit`, { subject, body, files, hash: m.hash }); close(); }); }}>
    <h3>Edit this draft</h3>
    <p>Saving removes the current approval. The controller checks the new text again before anyone can approve it.</p>
    <div className="field"><label>Subject <input className="mail-input" value={subject} onChange={e => setSubject(e.target.value)} required /></label></div>
    <div className="field"><label>Message (Markdown) <textarea className="mail-input" value={body} onChange={e => setBody(e.target.value)} rows={14} required /></label></div>
    <SlackSize subject={subject} body={body} />
    {!!known.length && <fieldset><legend>Files</legend>{known.map(f => <label key={f.id}><input className="mail-checkbox" type="checkbox" checked={files.includes(f.id)} onChange={e => setFiles(current => e.target.checked ? [...current, f.id] : current.filter(id => id !== f.id))} />Send {f.name} ({Math.ceil(f.size / 1024)} KiB){m.files?.some(x => x.id === f.id) ? '' : ' (from an earlier version)'}</label>)}</fieldset>}
    <div className="mail-tabs">
      <button className="btn" disabled={busy}>Save</button>
      <button className="btn ghost" type="button" disabled={busy} onClick={close}>Cancel</button>
    </div>
  </form>;
}
const author = (who: 'user' | 'controller' | 'task', m: Message, tasks: Task[]) => who === 'user' ? 'you' : who === 'controller' ? 'the controller' : proposer(m, tasks);
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
function taskNumber(id: string, tasks: Task[]) { if (id === 'controller') return 'the controller'; const t = tasks.find(x => x.id === id); return t ? `#${t.num}` : id; }
// what: "Comment" or "Message"
export function deliveryNote(what: string, d: Delivery | undefined, tasks: Task[]) {
  if (!d) return '';
  if (d.delivered) return `${what} delivered to ${taskNumber(d.task, tasks)}${d.at ? ` at ${date(d.at)}` : ''}.${d.resumed ? ' The task was resumed first.' : ''}`;
  return `Not delivered to ${taskNumber(d.task, tasks)} yet${d.problem ? `: ${d.problem}` : '.'} Taskboard tries again when the task next waits for input.`;
}
function Comments({ m, tasks }: { m: Message; tasks: Task[] }) {
  if (!m.returns?.length) return null;
  return <><h3>Your comments</h3><ul>{m.returns.map(r => <li key={r.at}>
    <p>{date(r.at)}: {r.comment}</p><p role={r.delivery && !r.delivery.delivered ? 'alert' : undefined}>{deliveryNote('Comment', r.delivery, tasks)}</p>
  </li>)}</ul></>;
}
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
  const [editing, setEditing] = useState<(EditState & { id: string; key: number }) | null>(null);
  const outgoing = messages.filter(m => m.direction === 'outbox').sort((a, b) => b.created.localeCompare(a.created));
  const filtered = outgoing.filter(m => (!recipientFilter || m.to === recipientFilter) && (!proposerFilter || (m.proposedBy?.task || m.proposedBy?.actor || 'unknown') === proposerFilter) && (!stateFilter || sentState(m) === stateFilter));
  const selected = filtered.find(m => m.id === selectedId) || filtered[0];
  const contactName = (id: string) => contacts.find(c => c.user === id)?.name || id;
  const edit = (m: Message, from: { subject: string; body: string; files: FileInfo[] }) => setEditing({ id: m.id, key: Date.now(), subject: from.subject, body: from.body, files: from.files.filter(f => !f.longBody).map(f => f.id) });
  const steps = selected ? [
    { label: 'Draft created', at: selected.created },
    ...(selected.edits || []).map(e => ({ label: 'Edited by you', at: e.at })),
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
        <p>Proposed by: {proposer(selected, tasks)}</p>
        {!!selected.edits?.length && <p>Edited by you at {date(selected.edits[selected.edits.length - 1].at)}.</p>}
        <p>Approved by: {selected.approval?.by || 'No approval recorded'}</p>
        <p>State: {sentState(selected)}{selected.dismissedAt ? ' · Dismissed' : ''}</p><p>Sent: {date(selected.sentAt)}</p>
        <p>Safety check: {selected.review ? `${selected.review.verdict}. ${selected.review.reason}` : selected.error ? 'Failed.' : 'The controller checks this text now.'}</p>
        {selected.quality?.flags.length ? <p role="alert">Message check: {selected.quality.flags.length} sentence(s) may contain private working notes. The user must decide whether to send the original.</p> : selected.quality?.state === 'failed' ? <p role="alert">The message check failed. The user must review this draft.</p> : null}
        {selected.editBlocked && selected.direction === 'outbox' && !selected.dismissedAt && <p>{selected.editBlocked}</p>}
        {editing?.id === selected.id
          ? <DraftEditor key={editing.key} m={selected} start={editing} busy={busy} act={act} close={() => setEditing(null)} />
          : <><h3>Full message</h3><FlaggedBody body={selected.body} quality={selected.quality} /></>}
        {!!selected.files?.length && <><h3>Files</h3><ul>{selected.files.map(f => <li key={f.id}>{f.name} ({Math.ceil(f.size / 1024)} KiB). {f.review?.verdict || 'Waiting for controller review'}.</li>)}</ul></>}
        <Comments m={selected} tasks={tasks} />
        <h3>Recorded steps</h3><ol>{steps.map((step, i) => <li key={i}>{step.label}: {date(step.at)}</li>)}</ol>
        {!!selected.versions?.length && <><h3>Earlier versions</h3>
          <p>Taskboard keeps the text before each of your last 10 edits. Slack receives only the current text.</p>
          {selected.versions.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => <details key={v.hash + v.replacedAt} className="mail-version">
            <summary>Text by {author(v.author, selected, tasks)}, replaced at {date(v.replacedAt)}</summary>
            <TextChanges before={v} after={selected.versions![i + 1] || { subject: selected.subject, body: selected.body, files: selected.files || [] }} />
            {!selected.editBlocked && <button className="btn ghost" disabled={busy} onClick={() => edit(selected, v)}>Restore this text in the editor</button>}
          </details>)}
        </>}
        {selected.error && <p role="alert">{selected.error}</p>}
        {selected.sentAt && <p>Slack confirmed this post. Taskboard has no record that the recipient saved or read it.</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/${selected.dismissedAt ? 'restore' : 'dismiss'}`, {}))}>{selected.dismissedAt ? 'Restore' : 'Dismiss'}</button>
          {!selected.dismissedAt && !selected.review && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/review`, {}))}>Retry controller review</button>}
          {!selected.editBlocked && editing?.id !== selected.id && <button className="btn" disabled={busy} onClick={() => edit(selected, { subject: selected.subject, body: selected.body, files: selected.files || [] })}>Edit</button>}
          {!selected.editBlocked && selected.quality?.flags.length && editing?.id !== selected.id && <button className="btn" disabled={busy || !selected.quality.suggestedBody} onClick={() => void act(() => request(`/${selected.id}/edit`, { subject: selected.subject, body: selected.quality!.suggestedBody, files: (selected.files || []).filter(f => !f.longBody).map(f => f.id), hash: selected.hash }))}>Remove flagged text</button>}
          {!selected.editBlocked && selected.review && selected.approver !== 'nobody' && !selected.approval && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/approve`, { hash: selected.hash }))}>Approve</button>}
          {!selected.editBlocked && selected.review && selected.approver !== 'nobody' && editing?.id !== selected.id && <button className="btn" disabled={busy} onClick={() => void act(() => request(`/${selected.id}/approve-send`, { hash: selected.hash }))}>Approve and send</button>}
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
  const [tab, setTab] = useState<'inbox' | 'sent' | 'documents' | 'a2anotes'>(props.documentLink ? 'documents' : 'inbox');
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
      <button className="btn" onClick={() => setTab('a2anotes')} aria-pressed={tab === 'a2anotes'}>A2A Notes</button>

    </nav>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {tab === 'a2anotes' ? <A2ANotesPanel tasks={props.tasks} /> : tab === 'documents' ? <Documents {...props} /> : <>
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
        {(subject || body) && <SlackSize subject={subject} body={body} />}
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
          {f.routed && ` Sent to ${taskLabel(f.routed.task, props.tasks)}. ${deliveryNote('File', f.routed.delivery, props.tasks)}`}</li>)}</ul></div>}
        {m.error && <p role="alert">{m.error}</p>}
        <div className="mail-tabs">
          <button className="btn ghost" disabled={busy} onClick={() => act(() => request(`/${m.id}/${dismissed ? 'restore' : 'dismiss'}`, {}))}>{dismissed ? 'Restore' : 'Dismiss'}</button>
          {!dismissed && !m.review && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/review`, {}))}>Retry controller review</button>}
          {!dismissed && m.review && m.approver !== 'nobody' && !m.approval && !m.rejectedAt && <button className="btn" disabled={busy} onClick={() => act(() => request(`/${m.id}/approve`, { hash: m.hash }))}>Approve</button>}
          {!dismissed && m.direction === 'inbox' && m.review && m.approver !== 'nobody' && !m.rejectedAt && <><select className="mail-input" aria-label={`Task for message ${m.subject}`} value={destinations[m.id] || m.proposedRoute?.task || ''} onChange={e => setDestinations(current => ({ ...current, [m.id]: e.target.value }))}><option value="">Choose a task</option>{props.tasks.filter(t => t.id !== 'controller').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><button className="btn" disabled={busy || !(destinations[m.id] || m.proposedRoute?.task)} onClick={() => act(() => request(`/${m.id}/route-to`, { task: destinations[m.id] || m.proposedRoute?.task, hash: m.hash }))}>Approve and send to task</button></>}
          {!dismissed && m.direction === 'outbox' && m.approval && !m.sentAt && <button className="btn" disabled={busy || m.sending} onClick={() => act(() => request(`/${m.id}/send`, {}))}>Send approved message</button>}
        </div>
        {!!m.routes.length && <ul>{m.routes.map(r => <li key={r.task}>Routed to {taskLabel(r.task, props.tasks)}. {deliveryNote('Message', r.delivery, props.tasks)}</li>)}</ul>}
        <Comments m={m} tasks={props.tasks} />
        {dismissed && <p>Dismissed items keep their content and approval state. Dismiss sends no feedback.</p>}
      </article>)}
    </>}
  </div>;
}
