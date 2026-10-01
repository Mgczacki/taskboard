// Dashboard approval cards for A2A Notes messages that the levels give to you (approver person).
// An outgoing card shows a draft that a task or the controller wrote: Approve approves and sends it, Send back rejects
// it with your comment and puts the comment in the inbox of the task that wrote it. An incoming card shows a message
// that the controller proposed for a task (tb mail propose-route): Approve approves it and gives it to that task, Send
// back returns your comment to the controller. A2A Notes keeps the state; sync() makes the cards again from it, so a
// restart does not lose a card, and it closes a card when its message changed or was decided somewhere else.
import * as approvals from '../approvals.ts';
import * as tasks from '../store.ts';

export interface Proposal { task: string | null; at: string }
export interface CardDeps {
  // calls an A2A Notes tool as the person; undefined when A2A Notes is off
  call: (tool: string, args: Record<string, unknown>) => Promise<any> | undefined;
  proposals: () => Record<string, Proposal>;
  clearProposal: (id: string) => void;
  route: (id: string, task: string) => Promise<{ task: string; file: string }>;
  notify: (task: string, name: string, text: string) => Promise<string>;
  name: (m: any) => string;
}
const BODY_LIMIT = 4000;
const taskName = (id: string) => { const t = tasks.get(id); return t ? `task #${t.num} "${t.title}"` : `task ${id}`; };

export function a2aCards(deps: CardDeps) {
  const open = new Map<string, { approval: string; key: string }>(); // message id -> its pending card

  // The card this message needs now, as a key that changes when the card must change; null for no card.
  function wanted(m: any): string | null {
    if (m.approver !== 'person' || !m.check) return null;
    const by = m.metadata?.['taskboard.proposed_by'];
    if (m.direction === 'out') return m.state === 'draft' && (by === 'task' || by === 'controller') ? `${m.hash}:${m.body_flags}` : null;
    const p = deps.proposals()[m.id];
    return m.state === 'held' && p ? `${m.hash}:${p.task ?? 'none'}` : null;
  }
  function writer(m: any) { const t = m.metadata?.['taskboard.task_id']; return typeof t === 'string' && tasks.get(t) ? t : 'controller'; }

  function detail(m: any) {
    const body = m.body.length > BODY_LIMIT ? `${m.body.slice(0, BODY_LIMIT)}\n… Open Inbox for the full text.` : m.body;
    const flags = m.body_check?.flags || [];
    return [
      `Subject: ${m.subject}`,
      `${m.direction === 'in' ? 'Sender' : 'Recipient'}: ${deps.name(m)}${m.trusted ? '' : ' (not a trusted sender)'}`,
      `For: ${m.audience === 'person' ? 'the reader' : m.audience === 'agent' ? "the reader's agent" : "the reader and the reader's agent"}`,
      `Safety check: ${m.review?.verdict || 'none'}. ${m.review?.reason || ''}`,
      ...(m.direction === 'out' && flags.length ? [`Message check: ${flags.length} item(s) for you to decide on.`] : []),
      ...(m.agent_file ? [`Agent file: ${m.agent_file.name}`] : []),
      ...(m.files?.length ? [`Files: ${m.files.map((f: any) => f.name).join(', ')}`] : []),
      '',
      body,
    ].join('\n');
  }

  async function create(id: string, key: string) {
    const m = await deps.call('a2anotes_get_message', { id });
    if (!m) return;
    const hash = m.hash, proposal = deps.proposals()[id];
    const actor = m.direction === 'in' ? 'controller' : writer(m);
    const summary = m.direction === 'in'
      ? proposal?.task ? `give a message from ${deps.name(m)} to ${taskName(proposal.task)}` : `accept a message from ${deps.name(m)}`
      : `send a message to ${deps.name(m)}: ${m.subject}`;
    const current = async () => { const x = await deps.call('a2anotes_get_message', { id }); if (!x || x.hash !== hash) throw new Error('The message changed. Read it again in Inbox.'); return x; };
    const card = approvals.request({ actor, action: m.direction === 'in' ? 'mail-in' : 'mail-out', summary, detail: detail(m),
      payload: { message: id, hash, task: proposal?.task || '', ...(m.direction === 'out' ? { body: m.body, quality: { state: m.body_check?.state || 'done', flags: m.body_check?.flags || [] } } : {}) } }, async () => {
      let x = await current();
      if (x.state === 'held' || x.state === 'draft') x = await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'approve', review_context: 'Approved on the dashboard card.' });
      if (x.direction === 'out') { await deps.call('a2anotes_send', { id, expected_hash: hash, request_id: `card-${id}-${hash.slice(0, 16)}` }); return `Approved and sent to ${deps.name(x)}.`; }
      if (proposal?.task && x.audience !== 'person') { const r = await deps.route(id, proposal.task); return `Approved and given to ${taskName(r.task)}.`; }
      return x.audience === 'person' && proposal?.task ? 'Approved. A message for a person does not go to a task.' : 'Approved.';
    }, {
      onDeny: () => { void Promise.resolve(deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'reject', review_context: 'Denied on the dashboard card.' })).catch(() => {}); },
      giveBack: async comment => {
        const text = comment.trim().slice(0, 2000);
        if (!text) throw new Error('Write a comment first.');
        const x = await current(), at = new Date().toISOString().replace(/\D/g, '');
        if (x.direction === 'out') {
          await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'reject', review_context: text });
          const to = writer(x);
          await deps.notify(to, `a2anotes-${id}-comment-${at}.md`, `# The user sent back your draft to ${deps.name(x)}\n\nSubject: ${x.subject}\n\nThe user's comment:\n\n${text}\n\nThe draft is closed. Write a new draft with \`tb mail draft\` if the comment asks for one.\n`);
          return `Sent back to ${to === 'controller' ? 'the controller' : taskName(to)} with your comment.`;
        }
        deps.clearProposal(id);
        await deps.notify('controller', `a2anotes-${id}-comment-${at}.md`, `# The user sent back your proposed task for message ${id}\n\nYou proposed ${proposal?.task ? taskName(proposal.task) : 'no task'}. The user's comment:\n\n${text}\n\nPropose a task again with \`tb mail propose-route ${id} <task>\`, or \`tb mail propose-route ${id} none\`.\n`);
        return 'Sent back to the controller with your comment.';
      },
    });
    open.set(id, { approval: card.id, key });
  }

  let running: Promise<void> | undefined, again = false;
  async function doSync() {
    const list = await deps.call('a2anotes_list_messages', { direction: 'all', limit: 100 });
    if (!list) return;
    const seen = new Set<string>();
    for (const m of list.messages) {
      seen.add(m.id);
      const entry = open.get(m.id);
      const pending = entry && approvals.get(entry.approval)?.state === 'pending' ? entry : undefined;
      const key = wanted(m);
      if (pending && pending.key === key) continue;
      if (pending) approvals.close(pending.approval, m.state === 'rejected' ? 'denied' : m.approved_by ? 'approved' : 'expired',
        m.state === 'rejected' ? 'Rejected in Inbox.' : m.approved_by ? `Approved in Inbox by ${m.approved_by}.` : 'The message, its proposed task, or the levels changed.');
      open.delete(m.id);
      if (key) await create(m.id, key).catch(() => {});
    }
    for (const [id, entry] of open) if (!seen.has(id) && approvals.get(entry.approval)?.state !== 'pending') open.delete(id);
  }
  // One sync at a time. A request during a sync runs one more sync after it, so a message that arrived during the
  // first sync still gets its card.
  const sync = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = doSync().catch(() => {}).finally(() => { running = undefined; if (again) { again = false; void sync(); } });
    return running;
  };
  return { sync };
}
