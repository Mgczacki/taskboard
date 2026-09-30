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

// The result of telling an agent about a file in its Taskboard inbox (server/inbox-delivery.ts).
export interface Told { name: string; delivered: boolean; resumed?: boolean; problem?: string }
export interface CardDeps {
  levels: () => Levels;
  route: (m: Message, task: string, by: 'user' | 'controller') => { task: string; path: string };
  send: (id: string) => Promise<unknown>;
  // puts a file with this text in the task's inbox and tells the agent; tell: only tells, for a file already there
  notify: (task: string, name: string, text: string) => Promise<Told>;
  tell: (task: string, name: string) => Promise<Told>;
}
const BODY_LIMIT = 4000;

// The task that receives a comment the user sent back, and the name of the comment file in its inbox. Comments saved
// before the file name was recorded use the name that giveBack gave them.
export function returnTarget(m: Message, r: NonNullable<Message['returns']>[number]) {
  const task = r.task || (m.direction === 'inbox' ? 'controller' : m.proposedBy?.actor === 'task' && m.proposedBy.task ? m.proposedBy.task : 'controller');
  return { task, file: r.file || `mail-${m.id}-comment-${r.at.replace(/\D/g, '')}.md` };
}
// The text for the card result. It says "Sent back" only when the agent was told.
const notToldYet = (told: Told) => `the agent was not told yet: ${(told.problem || 'unknown reason').replace(/\.?$/, '.')} Taskboard tries again when the task next waits for input.`;

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
    return m.proposedBy?.actor === 'task' || m.proposedBy?.actor === 'controller' ? `${m.hash}:${m.quality?.at || ''}:${m.quality?.state || ''}` : null;
  }

  function detail(m: Message) {
    const trusted = isTrusted(m, store.read());
    const body = m.body.length > BODY_LIMIT ? `${m.body.slice(0, BODY_LIMIT)}\n… Open Inbox for the full text.` : m.body;
    return [
      `Subject: ${m.subject}`,
      `${m.direction === 'inbox' ? 'Sender' : 'Recipient'}: ${name(m.direction === 'inbox' ? m.from : m.to)}${trusted ? '' : ' — not a trusted sender'}`,
      `Safety check: ${combinedVerdict(m)}. ${m.review?.reason || ''}`,
      ...(m.direction === 'outbox' && m.quality?.flags.length ? [`Message check: ${m.quality.flags.length} sentence(s) may contain private working notes. The user must decide whether to send them.`] : []),
      ...(m.direction === 'outbox' && m.quality?.state === 'failed' ? ['Message check failed. The user must review this draft.'] : []),
      ...(m.direction === 'outbox' && !m.quality ? ['Message check has not run. The user must review this draft.'] : []),
      ...(m.files?.length ? [`Files: ${m.files.map(f => `${f.name} (${f.review?.verdict || 'no check'})`).join(', ')}`] : []),
      ...(m.returns?.length ? [`Your earlier comment: ${m.returns[m.returns.length - 1].comment}`] : []),
      ...(m.edits?.length ? [`Edited by you at ${new Date(m.edits[m.edits.length - 1].at).toLocaleString()}. Inbox shows the earlier text.`] : []),
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
    const card = approvals.request({ actor: who, action: m.direction === 'inbox' ? 'mail-in' : 'mail-out', summary, detail: detail(m), payload: { message: m.id, hash, task,
      ...(m.direction === 'outbox' ? { body: m.body, quality: m.quality, files: m.files?.filter(f => !f.longBody).map(f => f.id) || [] } : {}) } }, async () => {
      let x = current();
      const approver = approverFor(x, store.read(), deps.levels());
      if (!approvalValid(x, store.read(), deps.levels())) x = store.approve(x.id, 'user', hash, approver);
      if (x.direction === 'inbox') {
        const route = deps.route(x, task, 'user');
        const told = await deps.tell(route.task, route.path.split('/').pop()!);
        return told.delivered ? `Approved and routed to ${taskName(task)}. The agent was told${told.resumed ? ' after the task was resumed' : ''}.`
          : `Approved and routed to ${taskName(task)}, but ${notToldYet(told)}`;
      }
      await deps.send(x.id); return `Approved and sent to ${name(x.to)}.`;
    }, {
      onDeny: () => { try { store.update(m.id, x => { x.rejectedAt ||= new Date().toISOString(); }); } catch { /* removed */ } },
      giveBack: async comment => {
        const text = comment.trim().slice(0, 4000);
        if (!text) throw new Error('Write a comment first.');
        const x = current(), at = new Date().toISOString();
        const to = x.direction === 'inbox' ? 'controller' : who;
        const file = `mail-${x.id}-comment-${at.replace(/\D/g, '')}.md`;
        store.update(x.id, y => { (y.returns ||= []).push({ comment: text, at, task: to, file }); if (y.direction === 'inbox') delete y.proposedRoute; else y.rejectedAt = at; });
        const told = await deps.notify(to, file, x.direction === 'inbox'
          ? `# The user sent back your proposed task for message ${x.id}\n\nYou proposed ${taskName(task)}. The user's comment:\n\n${text}\n\nPropose a task again with \`tb mail propose-route ${x.id} <task>\`, or \`tb mail propose-route ${x.id} none\`.\n`
          : `# The user sent back your draft to ${x.to}\n\nSubject: ${x.subject}\n\nThe user's comment:\n\n${text}\n\nThe draft is closed. Write a new draft with \`tb mail draft\` if the comment asks for one.\n`);
        // docs.upload adds a number to the name when a file with that name is already in the inbox
        if (told.name !== file) store.update(x.id, y => { const r = y.returns?.find(r => r.at === at); if (r) r.file = told.name; });
        const label = to === 'controller' ? 'the controller' : taskName(to);
        return told.delivered ? `Sent back to ${label} with your comment.${told.resumed ? ' The task was resumed.' : ''}`
          : `Your comment is in the inbox of ${label}, but ${notToldYet(told)}`;
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
        const edited = x.edits?.some(e => e.hash === x.hash) && !pending.key.startsWith(x.hash);
        approvals.close(pending.approval, x.rejectedAt ? 'denied' : x.approval && x.approval.hash === x.hash ? 'approved' : 'expired',
          x.rejectedAt ? 'Rejected in Inbox.' : x.approval && x.approval.hash === x.hash ? `Approved in Inbox by ${x.approval.by}.`
            : edited ? 'You edited the message in Inbox. The check runs again on the new text.' : 'The message, its proposed task, or the permission level changed.');
      }
      open.delete(m.id);
      if (key) create(m, key);
    }
  }
  return { sync };
}
