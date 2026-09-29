// Dashboard approval cards for messages that the permission levels give to the user (server/mail/policy.ts).
// An incoming card shows the message and the task that the controller proposed (tb mail propose-route); Approve
// approves the message and routes it to that task. An outgoing card shows a draft that a task or the controller
// proposed; Approve approves and sends it. Send back returns the card with the user's comment to the controller
// (incoming) or to the agent that wrote the draft (outgoing).
// Cards are made from mail.json: sync() runs after each change and at start, so a restart does not lose a card.
import * as approvals from '../approvals.ts';
import * as tasks from '../store.ts';
import type { MailStore, Message } from './store.ts';
import { approvalValid, approverFor, combinedVerdict, isTrusted, type Levels } from './policy.ts';

export interface CardDeps {
  levels: () => Levels;
  route: (m: Message, task: string, by: 'user' | 'controller') => unknown;
  send: (id: string) => Promise<unknown>;
  notify: (task: string, name: string, text: string) => Promise<void> | void;
}
const BODY_LIMIT = 4000;

export function mailCards(store: MailStore, deps: CardDeps) {
  const open = new Map<string, { approval: string; key: string }>(); // message id → its pending card
  const name = (user: string) => { const t = store.read().trustedSenders?.find(x => x.user === user); return t ? `${t.name} (${user})` : user; };
  const taskName = (id: string) => { const t = tasks.get(id); return t ? `task #${t.num} "${t.title}"` : `task ${id}`; };

  // The card this message needs now, as a key that changes when the card must change; null for no card.
  function wanted(m: Message): string | null {
    const data = store.read();
    if (m.dismissedAt || m.rejectedAt || m.sentAt || approvalValid(m, data, deps.levels())) return null;
    if (approverFor(m, data, deps.levels()) !== 'user') return null;
    if (m.direction === 'inbox') return m.source === 'slack' && m.proposedRoute?.task ? `${m.hash}:${m.proposedRoute.task}` : null;
    return m.proposedBy?.actor === 'task' || m.proposedBy?.actor === 'controller' ? m.hash : null;
  }

  function detail(m: Message) {
    const trusted = isTrusted(m, store.read());
    const body = m.body.length > BODY_LIMIT ? `${m.body.slice(0, BODY_LIMIT)}\n… Open Inbox for the full text.` : m.body;
    return [
      `Subject: ${m.subject}`,
      `${m.direction === 'inbox' ? 'Sender' : 'Recipient'}: ${name(m.direction === 'inbox' ? m.from : m.to)}${trusted ? '' : ' — not a trusted sender'}`,
      `Check: ${combinedVerdict(m)}. ${m.review?.reason || ''}`,
      ...(m.files?.length ? [`Files: ${m.files.map(f => `${f.name} (${f.review?.verdict || 'no check'})`).join(', ')}`] : []),
      ...(m.returns?.length ? [`Your earlier comment: ${m.returns[m.returns.length - 1].comment}`] : []),
      '',
      body,
    ].join('\n');
  }

  function create(m: Message, key: string) {
    const trusted = isTrusted(m, store.read());
    const who = m.direction === 'inbox' ? 'controller' : m.proposedBy?.actor === 'task' ? m.proposedBy.task! : 'controller';
    const task = m.proposedRoute?.task || '';
    const summary = m.direction === 'inbox'
      ? `route a message from ${name(m.from)}${trusted ? '' : ' (not a trusted sender)'} to ${taskName(task)}`
      : `send a message to ${name(m.to)}${trusted ? '' : ' (not a trusted sender)'}: ${m.subject}`;
    const hash = m.hash;
    const current = () => { const x = store.get(m.id); if (x.hash !== hash) throw new Error('The message changed. Read it again in Inbox.'); return x; };
    const card = approvals.request({ actor: who, action: m.direction === 'inbox' ? 'mail-in' : 'mail-out', summary, detail: detail(m), payload: { message: m.id, hash, task } }, async () => {
      let x = current();
      const approver = approverFor(x, store.read(), deps.levels());
      if (!approvalValid(x, store.read(), deps.levels())) x = store.approve(x.id, 'user', hash, approver);
      if (x.direction === 'inbox') { deps.route(x, task, 'user'); return `Approved and routed to ${taskName(task)}.`; }
      await deps.send(x.id); return `Approved and sent to ${name(x.to)}.`;
    }, {
      onDeny: () => { try { store.update(m.id, x => { x.rejectedAt ||= new Date().toISOString(); }); } catch { /* removed */ } },
      giveBack: async comment => {
        const text = comment.trim().slice(0, 4000);
        if (!text) throw new Error('Write a comment first.');
        const x = current(), at = new Date().toISOString();
        store.update(x.id, y => { (y.returns ||= []).push({ comment: text, at }); if (y.direction === 'inbox') delete y.proposedRoute; else y.rejectedAt = at; });
        const to = x.direction === 'inbox' ? 'controller' : who;
        await deps.notify(to, `mail-${x.id}-comment-${at.replace(/\D/g, '')}.md`, x.direction === 'inbox'
          ? `# The user sent back your proposed task for message ${x.id}\n\nYou proposed ${taskName(task)}. The user's comment:\n\n${text}\n\nPropose a task again with \`tb mail propose-route ${x.id} <task>\`, or \`tb mail propose-route ${x.id} none\`.\n`
          : `# The user sent back your draft to ${x.to}\n\nSubject: ${x.subject}\n\nThe user's comment:\n\n${text}\n\nThe draft is closed. Write a new draft with \`tb mail draft\` if the comment asks for one.\n`);
        return x.direction === 'inbox' ? 'Sent back to the controller with your comment.' : `Sent back to ${who === 'controller' ? 'the controller' : taskName(who)} with your comment.`;
      },
    });
    open.set(m.id, { approval: card.id, key });
  }

  function sync() {
    for (const m of store.read().messages) {
      const entry = open.get(m.id);
      const pending = entry && approvals.get(entry.approval)?.state === 'pending' ? entry : undefined;
      const key = wanted(m);
      if (pending && pending.key === key) continue;
      if (pending) {
        const x = store.get(m.id);
        approvals.close(pending.approval, x.rejectedAt ? 'denied' : x.approval && x.approval.hash === x.hash ? 'approved' : 'expired',
          x.rejectedAt ? 'Rejected in Inbox.' : x.approval && x.approval.hash === x.hash ? `Approved in Inbox by ${x.approval.by}.` : 'The message, its proposed task, or the permission level changed.');
      }
      open.delete(m.id);
      if (key) create(m, key);
    }
  }
  return { sync };
}
