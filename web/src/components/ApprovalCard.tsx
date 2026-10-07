// One approval card (server/approvals.ts): permit, push, refused tool call, message (MessageCard.tsx), or any other
// approval with Approve / Deny.
// The notification stack and the Waiting page show it. Its buttons follow the click rules of clickGuard.ts: off for a
// moment after the card shows, a click counts only when it started on the button, and Deny on a new card needs a
// second click. A refused-command card has no decision: Taskboard cannot override the agent's own permission check, so
// it has Dismiss (close without telling the task) instead of Deny. A card that you denied less than a minute ago shows
// Undo in the Answered view and in the stack (NoticeStack.tsx RecentDenials).
// A merge card whose branch head or master head moved (staleCard.ts) has Ask task to refresh in place of Approve.
import { useState } from 'react';
import type { AllowScope, Approval, DecisionOrigin, Task } from '../api';
import { api } from '../api';
import { FlaggedBody, request as messageRequest } from './messages';
import { PermitDetails } from './Permits';
import { MessageCard } from './MessageCard';
import { isMessage, resultLine } from '../messageCard';
import { decidedByLine } from '../approvalHistory';
import { cardTime, needsConfirm, useCardGuard, type CardGuard } from '../clickGuard';
import { refusalText } from '../refusalText';
import { deliveryText, isStaleMerge, REFRESH_LABEL, STALE_HELP } from '../staleCard';

export function ApprovalCard({ a, allTasks, setOpenId, openController, toast, from = 'waiting' }: { a: Approval; allTasks: Task[]; setOpenId: (id: string) => void; openController: () => void; toast: (s: string) => void; from?: DecisionOrigin['from'] }) {
  const [cardComments, setCardComments] = useState<Record<string, string>>({});
  // a new key starts the guard again: a new card, a card that the server changed in place, or a reopened card
  const guard = useCardGuard(`${a.id}|${cardTime(a)}`, from);
  // A2A Notes drafts and incoming messages (server/a2anotes/cards.ts) have their own card
  if (isMessage(a)) return <MessageCard a={a} allTasks={allTasks} setOpenId={setOpenId} openController={openController} toast={toast} />;
  const who = a.actor === 'controller' ? 'The controller' : `Task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`;
  const fail = (e: unknown) => toast(String((e as Error).message || e));
  const newCard = () => needsConfirm(cardTime(a));
  const denyLabel = (target = 'deny') => guard.confirming === target ? 'Confirm deny' : 'Deny';
  const staleMerge = isStaleMerge(a);
  // a decided card in the Answered view: what it was, who decided it, and the result
  if (a.state !== 'pending' && a.state !== 'running') return (
    <div className="approval">
      <div className="ap-h"><b>{a.action === 'tool-refusal' ? `${who} had a tool call refused` : `${who} asked to ${a.summary}`}</b><span className="sub">{a.state === 'stale' ? 'stale, not denied' : a.state}{a.decidedBy ? ` · ${new Date(a.decidedBy.at).toLocaleTimeString()}` : ''}</span></div>
      <pre className="ap-d">{a.detail}</pre>
      <div className={`pc-note ${a.state === 'approved' ? 'ok' : a.state === 'failed' ? 'bad' : 'info'}`}>{decidedByLine(a) && <><b>{decidedByLine(a)}</b><br /></>}{resultLine(a)}</div>
      {a.state === 'stale' && <div className="sub">{a.delivery || 'Taskboard sends the message to the task now.'}</div>}
      <UndoLine a={a} toast={toast} from={from} />
      <div className="ap-a">{a.action === 'tool-refusal' && <CopyCommand a={a} toast={toast} />}<button className="btn ghost" onClick={() => a.actor === 'controller' ? openController() : setOpenId(a.actor)}>{a.actor === 'controller' ? 'Open controller' : 'Open task'}</button></div>
    </div>
  );
  return (
        <div className={`approval${a.action === 'git-push' ? ' push-card' : ''}`}>
          {guard.bar}
          {(a.action === 'permit' || a.action === 'external') && a.payload?.permitId ? <PermitDetails id={a.payload.permitId} decision openTask={setOpenId} guard={guard} newCard={newCard} /> : a.action === 'git-push' && a.payload?.pushId ? <><div className="ap-h"><span className="dot needs-you" /><b>Task #{allTasks.find(t => t.id === a.actor)?.num || a.actor} asks to push</b><span className="sub">Valid until the facts change</span></div><pre className="ap-d">{a.detail}</pre><textarea className="routing-rule" rows={2} aria-label="Push decision comment" placeholder="Comment for the task" value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} /><div className="ap-a"><button {...guard.button('approve', o => void api.decidePush(a.payload!.pushId!, true, cardComments[a.id] || '', o).catch(fail), { className: 'btn primary' })}>{a.payload?.state?.forcePush ? 'Approve force push' : 'Approve push'}</button><button {...guard.button('deny', o => void api.decidePush(a.payload!.pushId!, false, cardComments[a.id] || '', o).catch(fail), { confirm: newCard })}>{denyLabel()}</button><button {...guard.button('open', () => setOpenId(a.actor), { className: 'btn ghost' })}>Open task</button></div></> : a.action === 'tool-refusal' ? <RefusalCard a={a} task={allTasks.find(t => t.id === a.actor)} guard={guard} setOpenId={setOpenId} toast={toast} /> : <>
          <div className="ap-h"><span className="dot needs-you" /><b>{a.actor === 'controller' ? 'The controller' : `Task #${allTasks.find(t => t.id === a.actor)?.num || a.actor}`} wants to {a.summary}</b>{a.action === 'scope' && <span className="sub">Scope request {a.id}</span>}{staleMerge && <span className="chip warn">stale</span>}</div>
          {a.detail && (a.action === 'mail-out' && a.payload?.body
            ? <><pre className="ap-d">{a.detail.slice(0, a.detail.lastIndexOf(a.payload.body))}</pre><FlaggedBody body={a.payload.body} quality={a.payload.quality} /></>
            : <pre className="ap-d">{a.detail}</pre>)}
          {a.returnable && <textarea className="routing-rule" rows={2} aria-label="Comment for Send back" placeholder={a.action === 'mail-in' ? 'What is wrong with the message or the task? The controller receives this comment.' : 'What should change in the draft? The agent that wrote it receives this comment.'} value={cardComments[a.id] || ''} onChange={e => setCardComments(c => ({ ...c, [a.id]: e.target.value }))} />}
          {a.allow && <AllowChoices a={a} allTasks={allTasks} />}
          {staleMerge && <div className="pc-note warn"><b>This card is stale. {a.staleFacts}</b>{STALE_HELP.map(line => <span key={line}><br />{line}</span>)}<br />{deliveryText(allTasks.find(t => t.id === a.actor))}</div>}
          <div className="ap-a">{staleMerge
            ? <button {...guard.button('refresh', o => void api.refreshCard(a.id, o).then(r => toast(r.state === 'stale' ? 'The card closed as stale, not denied. The task was asked for a new merge request.' : 'The card changed. Read it again.')).catch(fail), { className: 'btn primary' })} title="Close this card as stale, not denied, and ask the task to run tb git merge-request again. Nothing is merged.">{REFRESH_LABEL}</button>
            : <button {...guard.button('approve', o => void api.decide(a.id, true, o).then(r => { if (a.returnable && r.result) toast(r.result); }).catch(fail), { className: 'btn primary' })}>{a.allow ? 'Approve once' : 'Approve'}</button>}
            {a.allow?.choices.map(c => { const target = `allow-${c.scope}`; return <button key={c.scope} title={c.text} {...guard.button(target, o => void api.allowAlways(a.id, c.scope, o).then(r => toast(r.approval?.state === 'failed' ? `Rule saved: ${r.rule.text} This message was not delivered: ${r.approval.result}` : `Rule saved: ${r.rule.text}`)).catch(fail), { confirm: () => true })}>{guard.confirming === target ? 'Confirm: ' : ''}{allowLabel(a, c.scope, allTasks)}</button>; })}
            {a.action === 'mail-out' && a.payload?.quality?.flags.length && <button className="btn" onClick={() => void (async () => {
              await messageRequest(`/messages/${a.payload!.message}/remove-flagged`, { hash: a.payload!.hash });
              toast('Flagged text was removed. Taskboard checks the edited draft again.');
            })().catch(e => toast((e as Error).message))}>Remove flagged text</button>}
            {/* the result says where the comment went (server/a2anotes/cards.ts giveBack) */}
            {a.returnable && <button className="btn" disabled={!cardComments[a.id]?.trim()} onClick={() => void api.giveBack(a.id, cardComments[a.id]).then(r => { if (r.result) toast(r.result); }).catch(e => toast((e as Error).message))}>Send back</button>}
            <button {...guard.button('deny', o => void api.decide(a.id, false, o).catch(fail), { confirm: newCard })}>{denyLabel()}</button><button {...guard.button('open', () => a.actor === 'controller' ? openController() : setOpenId(a.actor), { className: 'btn ghost' })}>{a.actor === 'controller' ? 'Open controller' : 'Open task'}</button></div></>}
          {guard.confirming === 'deny' && <div className="pc-note warn">This card appeared a few seconds ago. Click Confirm deny to deny it.</div>}
          {a.allow?.choices.filter(c => guard.confirming === `allow-${c.scope}`).map(c => <div key={c.scope} className="pc-note warn">Click Confirm to save this rule and send this message: {c.text}</div>)}
          {a.staleFacts && !staleMerge && <div className="pc-note warn">Facts changed: {a.staleFacts}</div>}
          {a.reopened && <div className="pc-note info">You reopened this card with Undo at {new Date(a.reopened.at).toLocaleTimeString()}. The task was told.</div>}
          <label className="opt"><input type="checkbox" checked={!!a.notifyMe} onChange={e => void fetch(`/api/approvals/${a.id}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }).catch(err => toast(String(err)))} /> Notify me on my phone</label>
        </div>
  );
}

// A refused tool call: the command and the reason, which check refused it and where its rules are set, and what the
// user can do. Allow this once only when a shell permit can run the command (server/permits.ts canPermitRefusal).
// Dismiss closes the card without a decision. The task is not told (server/approvals.ts dismiss).
function RefusalCard({ a, task, guard, setOpenId, toast }: { a: Approval; task?: Task; guard: CardGuard; setOpenId: (id: string) => void; toast: (s: string) => void }) {
  const r = refusalText(a, task?.agent);
  const fail = (e: unknown) => toast(String((e as Error).message || e));
  return <>
    <div className="ap-h"><span className="dot needs-you" /><b>Task #{task?.num || a.actor} had a tool call refused</b></div>
    <pre className="ap-d">{a.detail}</pre>
    <div className="pc-note info refusal-help"><b>{r.who}</b><br />{r.todo}<br /><span className="sub">{r.where}</span></div>
    <div className="ap-a">
      {a.payload?.canPermit && <button {...guard.button('permit', () => void api.permitRefusal(a.id).catch(fail), { className: 'btn primary' })}>Allow this once</button>}
      <button {...guard.button('copy', () => void navigator.clipboard.writeText(r.command).then(() => toast('Command copied.'), fail))}>Copy command</button>
      <button {...guard.button('open', () => setOpenId(a.actor))}>Go to task</button>
      <button {...guard.button('dismiss', o => void api.dismissCard(a.id, o).catch(fail), { className: 'btn ghost' })} title="Close this card without a decision. The task is not told.">Dismiss</button>
    </div>
  </>;
}

function CopyCommand({ a, toast }: { a: Approval; toast: (s: string) => void }) {
  const command = refusalText(a).command;
  return <button className="btn" onClick={() => void navigator.clipboard.writeText(command).then(() => toast('Command copied.'), e => toast(String(e)))}>Copy command</button>;
}

// Undo on a card that you denied less than a minute ago (server/approvals.ts undo), or why it is not possible
export function UndoLine({ a, toast, from }: { a: Approval; toast: (s: string) => void; from: DecisionOrigin['from'] }) {
  if (a.state === 'dismissed') return <div className="sub">You closed this card without a decision. The task was not told, so there is nothing to undo.</div>;
  if (a.state !== 'denied' || a.decidedBy?.by !== 'user') return null;
  if (a.noUndo) return <div className="sub">{a.noUndo}</div>;
  if (!a.undoUntil || Date.parse(a.undoUntil) < Date.now()) return null;
  return <div className="ap-a"><button className="btn" onClick={() => void api.undoCard(a.id, { from, target: 'undo' }).then(() => toast('The card waits again. The task was told.'), e => toast(String((e as Error).message || e)))}>Undo the denial</button><span className="sub">Until {new Date(a.undoUntil).toLocaleTimeString()}. Nothing ran.</span></div>;
}

// Allow always on a card where one task asks to type into another task or to send it a document (server/allow-rules.ts).
// The buttons are in the row of Approve once: one button for each choice of the card, with the two task numbers and the
// direction. The first click on a button asks for a second click. The second click saves the rule and approves this
// card, so this message is sent one time. AllowChoices shows each rule in plain words above the buttons.
const numbers = (a: Approval, allTasks: Task[]) => {
  const num = (id: string, n?: number) => `#${n ?? allTasks.find(t => t.id === id)?.num ?? id}`;
  return { from: num(a.allow!.from, a.allow!.fromNum), to: num(a.allow!.to, a.allow!.toNum) };
};
// one way: "#12 → #15". both ways: "#12 ↔ #15". any sender: "any task → #15".
const direction = (a: Approval, scope: AllowScope, allTasks: Task[]) => {
  const { from, to } = numbers(a, allTasks);
  return scope === 'pair' ? `${from} → ${to}` : scope === 'both' ? `${from} ↔ ${to}` : `any task → ${to}`;
};
const allowLabel = (a: Approval, scope: AllowScope, allTasks: Task[]) => `Always allow ${a.allow!.kind === 'doc' ? 'documents ' : ''}${direction(a, scope, allTasks)}`;
const SCOPE_NAME: Record<AllowScope, string> = { pair: 'one way', both: 'both ways', any: 'any sender' };
function AllowChoices({ a, allTasks }: { a: Approval; allTasks: Task[] }) {
  const thing = a.allow!.kind === 'doc' ? 'document' : 'message';
  return (
    <div className="allow-always">
      <div className="opt"><b>Approve once</b> sends only this {thing}. An <b>Always allow</b> button saves a rule and sends this {thing}. Later {thing}s that match the rule need no card.</div>
      <ul className="allow-choices">
        {a.allow!.choices.map(c => <li key={c.scope}><b>{direction(a, c.scope, allTasks)}</b> ({SCOPE_NAME[c.scope]}): {c.text}</li>)}
      </ul>
      <div className="sub">{a.allow!.limitText} A {thing} under a rule is data for the target task, never your approval. You can revoke a rule in Settings &gt; Approvals.</div>
    </div>
  );
}
