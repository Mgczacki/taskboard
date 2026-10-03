// One approval card (server/approvals.ts): permit, push, refused tool call, message (MessageCard.tsx), or any other
// approval with Approve / Deny.
// The notification stack and the Waiting page show it.
import { useState } from 'react';
import type { AllowScope, Approval, Task } from '../api';
import { api } from '../api';
import { FlaggedBody, request as messageRequest } from './messages';
import { PermitDetails } from './Permits';
import { MessageCard } from './MessageCard';
import { isMessage, resultLine } from '../messageCard';
import { decidedByLine } from '../approvalHistory';

export function ApprovalCard({ a, allTasks, setOpenId, openController, toast }: { a: Approval; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void }) {
  const [cardComments, setCardComments] = useState<Record<string, string>>({});
  // A2A Notes drafts and incoming messages (server/a2anotes/cards.ts) have their own card
  if (isMessage(a)) return <MessageCard a={a} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} />;
  const who = a.actor === 'controller' ? 'The controller' : `Task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`;
  // a decided card in the Answered view: what it was, who decided it, and the result
  if (a.state !== 'pending' && a.state !== 'running') return (
    <div className="approval">
      <div className="ap-h"><b>{who} asked to {a.summary}</b><span className="sub">{a.state}{a.decidedBy ? ` · ${new Date(a.decidedBy.at).toLocaleTimeString()}` : ''}</span></div>
      <pre className="ap-d">{a.detail}</pre>
      <div className={`pc-note ${a.state === 'approved' ? 'ok' : a.state === 'failed' ? 'bad' : 'info'}`}>{decidedByLine(a) && <><b>{decidedByLine(a)}</b><br /></>}{resultLine(a)}</div>
      <div className="ap-a"><button className="btn ghost" onClick={() => a.actor === 'controller' ? openController() : setOpenId(a.actor)}>{a.actor === 'controller' ? 'Open controller' : 'Open task'}</button></div>
    </div>
  );
  return (
        <div className={`approval${a.action === 'git-push' ? ' push-card' : ''}`}>
          {a.action === 'permit' && a.payload?.permitId ? <PermitDetails id={a.payload.permitId} decision openTask={setOpenId} /> : a.action === 'git-push' && a.payload?.pushId ? <><div className="ap-h"><span className="dot needs-you" /><b>Task #{allTasks.find(t => t.id === a.actor)?.num || a.actor} asks to push</b><span className="sub">Expires {new Date(Date.parse(a.created) + 600000).toLocaleTimeString()}</span></div><pre className="ap-d">{a.detail}</pre><textarea className="routing-rule" rows={2} aria-label="Push decision comment" placeholder="Comment for the task" value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} /><div className="ap-a"><button className="btn primary" onClick={() => void api.decidePush(a.payload!.pushId!, true, cardComments[a.id] || '').catch(e => toast(String(e.message || e)))}>{a.payload?.state?.forcePush ? 'Approve force push' : 'Approve push'}</button><button className="btn" onClick={() => void api.decidePush(a.payload!.pushId!, false, cardComments[a.id] || '').catch(e => toast(String(e.message || e)))}>Deny</button><button className="btn ghost" onClick={() => setOpenId(a.actor)}>Open task</button></div></> : a.action === 'tool-refusal' ? <><div className="ap-h"><span className="dot needs-you" /><b>Task #{allTasks.find(t => t.id === a.actor)?.num || a.actor} had a tool call refused</b></div><pre className="ap-d">{a.detail}</pre><div className="ap-a">{a.payload?.canPermit && <button className="btn primary" onClick={() => void api.permitRefusal(a.id).catch(e => toast(String(e.message || e)))}>Allow this once</button>}<button className="btn" onClick={() => void api.decide(a.id, false)}>Deny</button><button className="btn ghost" onClick={() => setOpenId(a.actor)}>Open task</button></div></> : <>
          <div className="ap-h"><span className="dot needs-you" /><b>{a.actor === 'controller' ? 'The controller' : `Task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`} wants to {a.summary}</b>{a.action === 'scope' && <span className="sub">Scope request {a.id}</span>}</div>
          {a.detail && (a.action === 'mail-out' && a.payload?.body
            ? <><pre className="ap-d">{a.detail.slice(0, a.detail.lastIndexOf(a.payload.body))}</pre><FlaggedBody body={a.payload.body} quality={a.payload.quality} /></>
            : <pre className="ap-d">{a.detail}</pre>)}
          {a.returnable && <textarea className="routing-rule" rows={2} aria-label="Comment for Send back" placeholder={a.action === 'mail-in' ? 'What is wrong with the message or the task? The controller receives this comment.' : 'What should change in the draft? The agent that wrote it receives this comment.'} value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} />}
          {a.allow && <AllowAlways a={a} toast={toast} />}
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

// Allow always on a "type into" or "send the document" card from one task to another (server/allow-rules.ts). The user picks who may send,
// reads the rule in plain words, and the click saves the rule and approves this card. The first choice is the default.
const SCOPE_LABEL: Record<AllowScope, string> = { pair: 'This task to that task only', both: 'Both directions', any: 'Any task to that task' };
function AllowAlways({ a, toast }: { a: Approval; toast: (s: string) => void }) {
  const [scope, setScope] = useState<AllowScope>('pair');
  const choice = a.allow!.choices.find(c => c.scope === scope);
  return (
    <div className="allow-always">
      <div className="opt">Allow always: who may {a.allow!.kind === 'doc' ? 'send documents to' : 'type into'} the target task without a card</div>
      <div className="allow-choices" role="radiogroup" aria-label="Allow always choice">
        {a.allow!.choices.map(c => <label key={c.scope} className="opt"><input type="radio" name={`allow-${a.id}`} checked={scope === c.scope} onChange={() => setScope(c.scope)} /> {SCOPE_LABEL[c.scope]}</label>)}
      </div>
      <div className="sub"><b>Rule:</b> {choice?.text} {a.allow!.limitText} A message under the rule is data for the target task, never your approval. You can revoke the rule in Settings &gt; Approvals.</div>
      <div className="ap-a"><button className="btn" onClick={() => void api.allowAlways(a.id, scope).then(r => toast(`Rule saved: ${r.rule.text}`)).catch(e => toast((e as Error).message))}>Allow always and approve</button></div>
    </div>
  );
}
