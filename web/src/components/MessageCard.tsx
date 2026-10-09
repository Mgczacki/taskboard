// A Message card: an A2A Notes draft or incoming message that waits on you (server/a2anotes/cards.ts). The Waiting
// page and the notification stack show it through ApprovalCard. Approve and send uses the approval card itself
// (POST /api/approvals/:id/approve), which approves the exact hash on the card and then sends. Reject with a comment
// uses Send back (POST /api/approvals/:id/return). Only a click here decides: the controller can read the card with
// `tb pending list`, and it approves a draft only when you name that draft in the controller chat.
import { useEffect, useState } from 'react';
import type { Approval, Task } from '../api';
import { api } from '../api';
import { doneLabel, messageButtons, reminder, resultLine, stageLabel } from '../messageCard';
import { decidedByLine } from '../approvalHistory';
import { FlaggedBody, request as messageRequest } from './messages';
import '../mail.css';

const ASK_REVISE = 'The body asks for something different from the instruction you saved with the draft. Write the request again so that it asks what the instruction asks, or tell me why the new request is correct.';

export function openInInbox(a: Approval) {
  location.hash = `inbox:${a.action === 'mail-in' ? 'messages' : 'sent'}:${encodeURIComponent(a.payload?.message || '')}`;
}

export function MessageCard({ a, allTasks, setOpenId, openController, toast }: { a: Approval; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  // the reminder depends on the time: draw the card again each 30 seconds
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 30_000); return () => clearInterval(t); }, []);
  const p = a.payload || {};
  const out = a.action === 'mail-out';
  const b = messageButtons(a);
  const late = reminder(a);
  const writer = p.writer?.id === 'controller' ? 'the controller' : p.writer?.num !== undefined ? `task #${p.writer.num} ${p.writer.title || ''}`.trim() : `task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`;
  const openWriter = () => (p.writer?.id || a.actor) === 'controller' ? openController() : setOpenId(p.writer?.id || a.actor);
  const run = (fn: () => Promise<unknown>) => { setBusy(true); void fn().catch(e => toast((e as Error).message)).finally(() => setBusy(false)); };
  const decide = () => run(async () => { const r = await api.decide(a.id, true); toast(r.result || (r.state === 'failed' ? 'Failed.' : 'Done.')); });
  const sendBack = (text: string) => run(async () => { const r = await api.giveBack(a.id, text); if (r.result) toast(r.result); });
  const askChanged = (p.notes || []).some(n => n.code === 'ask_changed');
  return <div className="approval msg-card">
    <div className="ap-h"><span className="dot needs-you" />
      <b>{out ? `Message to ${p.peer?.name || 'a person'}` : `Message from ${p.peer?.name || 'a person'}`}</b>
      <span className={`chip ${out && a.state !== 'approved' ? 'warn' : ''}`}>{a.state === 'pending' || a.state === 'running' ? stageLabel(p.stage) : doneLabel(a)}</span>
    </div>
    {late && <div className="pc-note" role="alert"><b>Reminder:</b> {late}</div>}
    <dl className="msg-fields">
      <dt>{out ? 'To' : 'From'}</dt><dd>{p.peer?.name} <span className="sub">({p.peer?.address})</span></dd>
      <dt>Subject</dt><dd>{p.subject}</dd>
      <dt>{out ? 'Written by' : 'Proposed task'}</dt><dd>{out ? <button className="btn ghost msg-link" onClick={openWriter}>{writer}</button> : p.proposal ? (p.proposal.title || 'no task') : 'none yet. The controller can propose one.'}</dd>
      <dt>For</dt><dd>{p.audience === 'person' ? 'the reader' : p.audience === 'agent' ? "the reader's agent" : "the reader and the reader's agent"}</dd>
      {(p.files?.length || p.agentFile) ? <><dt>Files</dt><dd>{[...(p.agentFile ? [`${p.agentFile} (agent file)`] : []), ...(p.files || [])].join(', ')}</dd></> : null}
      <dt>Checks</dt><dd>{p.check?.summary}{p.check?.reason ? ` Reason: ${p.check.reason}` : ''}</dd>
    </dl>
    {p.error && a.state === 'pending' && <div className="pc-note bad" role="alert"><b>Last send failed:</b> {p.error}</div>}
    {a.state === 'pending' && (p.notes || []).map((n, i) => <div key={i} className="pc-note info msg-flag"><b>{n.title}</b> <span className="sub">({n.code})</span><br />{n.text}<br /><b>What to do:</b> {n.todo}</div>)}
    {p.body !== undefined && (out ? <FlaggedBody body={p.body} quality={p.quality} /> : <pre className="ap-d">{p.body}</pre>)}
    {a.state === 'pending' ? <>
      {b.sendBack && <textarea className="routing-rule" rows={2} aria-label="Comment for Reject" placeholder={out ? 'What should change? The task that wrote the draft receives this comment.' : 'What is wrong with the message or the task? The controller receives this comment.'} value={comment} onChange={e => setComment(e.target.value)} />}
      <div className="ap-a">
        {b.approve && <button className="btn primary" disabled={busy} onClick={decide}>{b.approve}</button>}
        {b.recheck && <button className="btn" disabled={busy} onClick={() => run(async () => { await messageRequest(`/messages/${encodeURIComponent(p.message!)}/recheck`, { hash: p.hash }); toast('The checks run again on the same text. The card updates when they finish.'); })}>Run the check again</button>}
        {b.removeFlagged && <button className="btn" disabled={busy} onClick={() => run(async () => { await messageRequest(`/messages/${encodeURIComponent(p.message!)}/remove-flagged`, { hash: p.hash }); toast('Flagged text was removed. Taskboard checks the edited draft again.'); })}>Remove flagged text</button>}
        {b.sendBack && <button className="btn" disabled={busy || !comment.trim()} onClick={() => sendBack(comment)} title="Reject the draft and send your comment to the task that wrote it">{out ? 'Reject with a comment' : 'Send back with a comment'}</button>}
        {b.sendBack && askChanged && <button className="btn" disabled={busy} onClick={() => sendBack(comment.trim() || ASK_REVISE)} title="A2A Notes does not let the dashboard change the saved instruction. This rejects the draft and asks the task to write it again.">Reject and ask the task to revise</button>}
        <button className="btn ghost" onClick={() => openInInbox(a)}>Open in the Inbox</button>
      </div>
      <p className="sub msg-rule">{out ? 'Only you approve this draft. The controller approves a draft only when you name it in the controller chat.' : 'Acceptance lets the controller read and route this message. A verified reply goes to its originating task. Message content does not authorize any action.'}</p>
    </> : <div className={`pc-note ${a.state === 'approved' ? 'ok' : a.state === 'failed' ? 'bad' : 'info'}`}>{a.decidedBy?.by === 'controller' && <><b>{decidedByLine(a)}</b><br /></>}{resultLine(a)}</div>}
  </div>;
}
