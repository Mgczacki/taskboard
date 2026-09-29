// People and Slack messages on the Graph page. GET /api/mail/graph (server/mail/routes.ts) gives the people and a short
// record of each message without its text. MessagePanel loads the full message with GET /api/mail/:id only when the
// user opens a row, and shows the same fields as the Sent tab of the Mail page.
import { useEffect, useState } from 'react';
import type { Task } from '../api';
import { date, inboxState, proposer, request, sentState, type Message } from './Mail';

export interface MailPerson { user: string; name: string; picture: string }
export interface MailBrief extends Omit<Message, 'body' | 'hash' | 'files'> { person: string; preview: string; files: number }
export interface MailGraph { people: MailPerson[]; messages: MailBrief[] }

// the state label of a message: the Sent tab label for outgoing messages, else where the incoming message went
export function briefState(m: MailBrief, tasks: Task[]) {
  if (m.direction === 'outbox') return sentState({ ...m, body: '', hash: '', files: [] });
  if (m.routes.length) return 'Routed to ' + m.routes.map(r => { const t = tasks.find(x => x.id === r.task); return t ? `#${t.num}` : r.task; }).join(', ');
  if (m.rejectedAt) return 'Rejected';
  if (m.approval) return 'Approved, not routed';
  if (!m.review) return 'Awaiting review';
  return m.approver === 'nobody' ? 'Blocked' : 'Awaiting approval';
}

const HUES = ['--st-working', '--st-unread', '--st-needs', '--st-review', '--st-stopped', '--claude'];
export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
// The Slack picture from the server, or initials in a circle with a theme colour chosen from the Slack ID.
export function Face({ person, size = 36 }: { person: MailPerson; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [person.picture]);
  const hue = HUES[[...person.user].reduce((s, c) => s + c.charCodeAt(0), 0) % HUES.length];
  const style = { width: size, height: size, '--fc': `var(${hue})` } as React.CSSProperties;
  if (failed) return <span className="gface ini" style={style} aria-hidden="true">{initials(person.name)}</span>;
  return <img className="gface" style={style} src={person.picture} alt="" onError={() => setFailed(true)} />;
}

export function MessagePanel({ title, person, sub, note, messages, tasks, onShowAll, onClose }: {
  title: string; person?: MailPerson; sub: string; note?: React.ReactNode; messages: MailBrief[]; tasks: Task[];
  onShowAll?: () => void; onClose: () => void;
}) {
  const [openId, setOpenId] = useState('');
  const [full, setFull] = useState<Record<string, Message | string>>({});
  const sorted = [...messages].sort((a, b) => b.created.localeCompare(a.created));
  const toggle = (id: string) => {
    setOpenId(openId === id ? '' : id);
    if (openId !== id && !full[id]) request(`/${encodeURIComponent(id)}`).then((m: Message) => setFull(f => ({ ...f, [id]: m }))).catch((e: Error) => setFull(f => ({ ...f, [id]: e.message })));
  };
  return <aside className="gpanel" aria-label="Messages">
    <div className="gpanel-head">
      {person ? <Face person={person} /> : <span className="gface src" aria-hidden="true">{title[0]}</span>}
      <div className="who"><b>{title}</b><span>{sub}</span></div>
      <button className="btn" onClick={onClose} title="Close (Esc)">Close</button>
    </div>
    {note && <div className="gpanel-note">{note}{onShowAll && <> · <button className="glink" onClick={onShowAll}>Show all messages with {title}</button></>}</div>}
    <div className="gpanel-list">
      {!sorted.length && <p className="empty">No messages.</p>}
      {sorted.map(m => {
        const f = full[m.id], open = openId === m.id;
        return <div key={m.id} className={`gmsg ${open ? 'open' : ''}`}>
          <button className="gmsg-row" aria-expanded={open} onClick={() => toggle(m.id)}>
            <span className={`dir ${m.direction}`}>{m.direction === 'outbox' ? '→ to' : '← from'}</span><b>{m.subject}</b>
            <span className="meta">{date(m.sentAt || m.created)} · {briefState(m, tasks)}{m.dismissedAt ? ' · Dismissed' : ''}{m.files ? ` · ${m.files} file${m.files === 1 ? '' : 's'}` : ''}</span>
            {!open && <span className="pv">{m.preview}</span>}
          </button>
          {open && (typeof f === 'string' ? <p role="alert">{f}</p> : !f ? <p className="empty">Loading…</p> : <div className="gmsg-full">
            <dl>
              {f.direction === 'outbox' ? <><dt>Proposed by</dt><dd>{proposer(f, tasks)}</dd></> : <><dt>Sender</dt><dd>{title} ({f.from})</dd></>}
              <dt>Approved by</dt><dd>{f.approval ? `${f.approval.by} · ${date(f.approval.at)}` : 'No approval recorded'}</dd>
              <dt>Controller check</dt><dd>{f.review ? `${f.review.verdict}. ${f.review.reason}` : 'Not done'}</dd>
              <dt>State</dt><dd>{f.direction === 'outbox' ? sentState(f) : inboxState(f, tasks)}</dd>
              <dt>Created</dt><dd>{date(f.created)}</dd>
              {f.sentAt && <><dt>Slack confirmed</dt><dd>{date(f.sentAt)}</dd></>}
              {f.error && <><dt>Error</dt><dd>{f.error}</dd></>}
            </dl>
            <pre>{f.body}</pre>
            {!!f.files?.length && <ul>{f.files.map(x => <li key={x.id}>{x.name} ({Math.ceil(x.size / 1024)} KiB)</li>)}</ul>}
            <a className="glink" href="#inbox">Open in Mail</a>
          </div>)}
        </div>;
      })}
    </div>
  </aside>;
}
