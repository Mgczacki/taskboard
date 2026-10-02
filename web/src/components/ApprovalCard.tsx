// One approval card (server/approvals.ts): permit, push, refused tool call, message (MessageCard.tsx), or any other
// approval with Approve / Deny.
// The notification stack and the Waiting page show it.
import { useState } from 'react';
import type { Approval, Task } from '../api';
import { api } from '../api';
import { FlaggedBody, request as messageRequest } from './messages';
import { PermitDetails } from './Permits';
import { MessageCard } from './MessageCard';
import { isMessage } from '../messageCard';

export function ApprovalCard({ a, allTasks, setOpenId, openController, toast }: { a: Approval; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void }) {
  const [cardComments, setCardComments] = useState<Record<string, string>>({});
  // A2A Notes drafts and incoming messages (server/a2anotes/cards.ts) have their own card
  if (isMessage(a)) return <MessageCard a={a} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} />;
  return (
        <div className={`approval${a.action === 'git-push' ? ' push-card' : ''}`}>
          {a.action === 'permit' && a.payload?.permitId ? <PermitDetails id={a.payload.permitId} decision openTask={setOpenId} /> : a.action === 'git-push' && a.payload?.pushId ? <><div className="ap-h"><span className="dot needs-you" /><b>Task #{allTasks.find(t => t.id === a.actor)?.num || a.actor} asks to push</b><span className="sub">Expires {new Date(Date.parse(a.created) + 600000).toLocaleTimeString()}</span></div><pre className="ap-d">{a.detail}</pre><textarea className="routing-rule" rows={2} aria-label="Push decision comment" placeholder="Comment for the task" value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} /><div className="ap-a"><button className="btn primary" onClick={() => void api.decidePush(a.payload!.pushId!, true, cardComments[a.id] || '').catch(e => toast(String(e.message || e)))}>{a.payload?.state?.forcePush ? 'Approve force push' : 'Approve push'}</button><button className="btn" onClick={() => void api.decidePush(a.payload!.pushId!, false, cardComments[a.id] || '').catch(e => toast(String(e.message || e)))}>Deny</button><button className="btn ghost" onClick={() => setOpenId(a.actor)}>Open task</button></div></> : a.action === 'tool-refusal' ? <><div className="ap-h"><span className="dot needs-you" /><b>Task #{allTasks.find(t => t.id === a.actor)?.num || a.actor} had a tool call refused</b></div><pre className="ap-d">{a.detail}</pre><div className="ap-a">{a.payload?.canPermit && <button className="btn primary" onClick={() => void api.permitRefusal(a.id).catch(e => toast(String(e.message || e)))}>Allow this once</button>}<button className="btn" onClick={() => void api.decide(a.id, false)}>Deny</button><button className="btn ghost" onClick={() => setOpenId(a.actor)}>Open task</button></div></> : <>
          <div className="ap-h"><span className="dot needs-you" /><b>{a.actor === 'controller' ? 'The controller' : `Task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`} wants to {a.summary}</b>{a.action === 'scope' && <span className="sub">Scope request {a.id}</span>}</div>
          {a.detail && (a.action === 'mail-out' && a.payload?.body
            ? <><pre className="ap-d">{a.detail.slice(0, a.detail.lastIndexOf(a.payload.body))}</pre><FlaggedBody body={a.payload.body} quality={a.payload.quality} /></>
            : <pre className="ap-d">{a.detail}</pre>)}
          {a.returnable && <textarea className="routing-rule" rows={2} aria-label="Comment for Send back" placeholder={a.action === 'mail-in' ? 'What is wrong with the message or the task? The controller receives this comment.' : 'What should change in the draft? The agent that wrote it receives this comment.'} value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} />}
          <div className="ap-a"><button className="btn primary" onClick={() => void api.decide(a.id, true).then(r => { if (a.returnable && r.result) toast(r.result); }).catch(e => toast((e as Error).message))}>Approve</button>
            {a.action === 'mail-out' && a.payload?.quality?.flags.length && <button className="btn" onClick={() => void (async () => {
              await messageRequest(`/messages/${a.payload!.message}/remove-flagged`, { hash: a.payload!.hash });
              toast('Flagged text was removed. Taskboard checks the edited draft again.');
            })().catch(e => toast((e as Error).message))}>Remove flagged text</button>}
            {/* the result says where the comment went (server/a2anotes/cards.ts giveBack) */}
            {a.returnable && <button className="btn" disabled={!cardComments[a.id]?.trim()} onClick={() => void api.giveBack(a.id, cardComments[a.id]).then(r => { if (r.result) toast(r.result); }).catch(e => toast((e as Error).message))}>Send back</button>}
            <button className="btn" onClick={() => api.decide(a.id, false)}>Deny</button><button className="btn ghost" onClick={() => a.actor === 'controller' ? openController() : setOpenId(a.actor)}>{a.actor === 'controller' ? 'Open controller' : 'Open task'}</button></div></>}
        </div>
  );
}
