// Dashboard approval cards (server/approvals.ts, actions mail-out and mail-in) for A2A Notes messages that wait on you.
// The Waiting page and the notification stack show them as Message cards (web/src/components/MessageCard.tsx), and
// `tb pending list` shows them to the controller (list() below). A card has one stage:
//   - draft: a draft that a task or the controller wrote, with approver person. A draft with approver reviewer goes
//     to the controller and has no card. Approve and send approves the exact hash (a2anotes_approve) and sends it
//     (a2anotes_send).
//   - checking: the same draft while the checks run. A2A Notes gives it approver nobody until they finish, so the card
//     has no Approve. It offers Run the check again.
//   - held: the safety check holds the draft (verdict quarantine). Nobody can approve it. Send back tells the task.
//   - send: an approved draft that was not sent (a send failed, or Slack did not confirm). Send again calls a2anotes_send.
//   - incoming: a held incoming message with approver person, with or without the task that the controller proposed
//     (tb mail propose-route). Approve approves it and gives it to that task.
// Send back rejects the draft with your comment and puts the comment in the inbox of the task that wrote it. After
// each decision, the task that wrote the draft gets a short file in its inbox and a line in its log.
// A2A Notes keeps the state. sync() makes the cards again from it, so a restart does not lose a card, and it closes a
// card when its message changed or was decided somewhere else. A changed draft gets a new card with a new ID, so a
// click on the old card never approves text that you did not see. A card that runs now is never made a second time.
import * as approvals from '../approvals.ts';
import * as tasks from '../store.ts';
import { A2AError } from './client.ts';
import { checkSummary, explainFlag, explainSendError, type Flag } from './explain.ts';

export interface Proposal { task: string | null; at: string }
export interface CardDeps {
  // calls an A2A Notes tool as the person; undefined when A2A Notes is off
  call: (tool: string, args: Record<string, unknown>) => Promise<any> | undefined;
  proposals: () => Record<string, Proposal>;
  clearProposal: (id: string) => void;
  route: (id: string, task: string) => Promise<{ task: string; file: string }>;
  notify: (task: string, name: string, text: string) => Promise<string>;
  name: (m: any) => string;
  accepted?: (m: any, proposal?: Proposal) => Promise<{ task: string } | undefined>;
  // a line in the log of a task (store.appendLog); the default writes to the Taskboard task log
  log?: (task: string, did: string, next: string) => void;
}
export type Stage = 'draft' | 'checking' | 'held' | 'send' | 'incoming';
// A draft that waits longer than this shows a reminder on its card and on the Waiting page.
export const REMIND_AFTER_MIN = Math.max(0, Number(process.env.TASKBOARD_A2A_REMIND_MINUTES ?? 10));
const BODY_LIMIT = 4000;
const taskName = (id: string) => { const t = tasks.get(id); return t ? `task #${t.num} "${t.title}"` : `task ${id}`; };
const clock = (iso = new Date().toISOString()) => new Date(iso).toTimeString().slice(0, 5);
const stamp = () => new Date().toISOString().replace(/\D/g, '');

// The structured part of a card, for the Message card on the dashboard and for `tb pending list`.
export interface MessagePayload {
  message: string; hash: string; task: string; stage: Stage; direction: 'in' | 'out';
  peer: { name: string; address: string }; subject: string; body: string; audience: string;
  writer: { id: string; num?: number; title?: string };
  files: string[]; agentFile?: string;
  check: { verdict: string; reason: string; summary: string };
  quality: { state: string; flags: Flag[] };
  notes: ReturnType<typeof explainFlag>[];
  approver: string; since: string; remindAfterMin: number; error?: string; proposal?: { task: string | null; title?: string };
}

export function a2aCards(deps: CardDeps) {
  const open = new Map<string, { approval: string; key: string }>(); // message id -> its card
  const log = deps.log || ((task, did, next) => { if (tasks.get(task)) tasks.appendLog(task, { did, next }); });

  function writer(m: any) { const t = m.metadata?.['taskboard.task_id']; return typeof t === 'string' && tasks.get(t) ? t : 'controller'; }
  // The card this message needs now, as a key that changes when the card must change; null for no card.
  function wanted(m: any): string | null {
    if (m.direction === 'out') {
      const by = m.metadata?.['taskboard.proposed_by'];
      if (by !== 'task' && by !== 'controller') return null;
      if (m.state === 'draft') {
        // approver reviewer: the controller handles the draft (tellController), so it gets no card for you
        if (m.approver === 'person') return `draft:${m.hash}:${m.body_flags}`;
        if (m.approver === 'nobody' && !m.check && !m.failure_code) return `checking:${m.hash}`;
        if (m.approver === 'nobody' && m.check?.verdict === 'quarantine') return `held:${m.hash}`;
        return null;
      }
      // approved and not sent: the send failed or did not happen yet, or Slack did not confirm the delivery
      if ((m.state === 'approved' && m.approved_by) || m.state === 'delivery_uncertain') return `send:${m.hash}:${m.state}:${m.updated}`;
      return null;
    }
    if ((m.approver !== 'person' && !(m.audience === 'person' && m.approver === 'reviewer')) || !m.check || m.state !== 'held') return null;
    const p = deps.proposals()[m.id];
    return `incoming:${m.hash}:${p ? p.task ?? 'none' : '-'}`;
  }

  function detail(m: any, stage: Stage) {
    const body = m.body.length > BODY_LIMIT ? `${m.body.slice(0, BODY_LIMIT)}\n… Open Inbox for the full text.` : m.body;
    const flags = m.body_check?.flags || [];
    return [
      `Subject: ${m.subject}`,
      `${m.direction === 'in' ? 'Sender' : 'Recipient'}: ${deps.name(m)} (${m.direction === 'in' ? m.from : m.to})${m.trusted ? '' : ' (not a trusted sender)'}`,
      `For: ${m.audience === 'person' ? 'the reader' : m.audience === 'agent' ? "the reader's agent" : "the reader and the reader's agent"}`,
      ...(m.direction === 'out' ? [`State: ${stage === 'send' ? 'approved, not sent yet' : 'not sent yet'}`] : []),
      `Checks: ${checkSummary(m)} ${m.review?.reason || ''}`.trim(),
      ...(m.direction === 'out' && flags.length ? [`Message check: ${flags.length} item(s) for you to decide on.`] : []),
      ...(m.agent_file ? [`Agent file: ${m.agent_file.name}`] : []),
      ...(m.files?.length ? [`Files: ${m.files.map((f: any) => f.name).join(', ')}`] : []),
      ...(m.error ? [`Last send: ${m.error}`] : []),
      '',
      body,
    ].join('\n');
  }

  function payloadOf(m: any, stage: Stage, proposal?: Proposal): MessagePayload {
    const w = m.direction === 'in' ? 'controller' : writer(m), t = tasks.get(w);
    const flags: Flag[] = m.body_check?.flags || [];
    return {
      message: m.id, hash: m.hash, task: proposal?.task || '', stage, direction: m.direction,
      peer: { name: deps.name(m), address: m.direction === 'in' ? m.from : m.to }, subject: m.subject, body: m.body, audience: m.audience,
      writer: { id: w, ...(t ? { num: t.num, title: t.title } : {}) },
      files: (m.files || []).map((f: any) => f.name), ...(m.agent_file ? { agentFile: m.agent_file.name } : {}),
      check: { verdict: m.review?.verdict || m.check?.verdict || '', reason: m.review?.reason || '', summary: checkSummary(m) },
      quality: { state: m.body_check?.state || (m.body_check ? 'done' : 'checking'), flags },
      notes: m.direction === 'out' ? flags.map(explainFlag) : [],
      approver: m.direction === 'in' && m.audience === 'person' && m.approver === 'reviewer' ? 'person' : m.approver, since: m.created, remindAfterMin: REMIND_AFTER_MIN,
      ...(m.error ? { error: explainSendError(m.state === 'delivery_uncertain' ? 'delivery_uncertain' : 'send_failed', String(m.error)) } : {}),
      ...(proposal ? { proposal: { task: proposal.task, ...(proposal.task && tasks.get(proposal.task) ? { title: taskName(proposal.task) } : {}) } } : {}),
    };
  }

  // Tells the task that wrote a draft what happened to it: a file in its inbox, and a line in its log.
  async function tellWriter(m: any, what: string, text: string, next: string) {
    const to = writer(m);
    await deps.notify(to, `a2anotes-${m.id}-${what}-${stamp()}.md`, `# Your draft to ${deps.name(m)}: ${what}\n\nSubject: ${m.subject}\nMessage: ${m.id}\n\n${text}\n`).catch(() => {});
    // the log is for the user: it names the draft of this task, not "your draft"
    log(to, text.split('\n')[0].replace('your draft', 'the draft of this task'), next);
  }

  // Sends an approved draft. A failure goes to the card result and to the task, in plain words.
  async function send(m: any, hash: string, d: approvals.Decider = { by: 'user' }) {
    const who = d.by === 'controller' ? 'The controller, on the user\'s request in its chat,' : 'The user';
    try { await deps.call('a2anotes_send', { id: m.id, expected_hash: hash, request_id: `card-${m.id}-${hash.slice(0, 16)}` }); }
    catch (e) {
      const why = explainSendError(e instanceof A2AError ? e.code : 'error', (e as Error).message);
      await tellWriter(m, 'not-sent', `${who} approved your draft to ${deps.name(m)} at ${clock()}, but it was not sent. ${why}`,
        'The user can send it again from the card on the dashboard. Do not write a new draft unless the user asks.');
      throw new Error(`Approved, but not sent. ${why}`);
    }
    await tellWriter(m, 'sent', `${who} approved your draft to ${deps.name(m)}, and Taskboard sent it at ${clock()}.`, 'The draft is sent. Nothing else is needed for it.');
    return `Approved and sent to ${deps.name(m)} at ${clock()}.`;
  }

  async function create(id: string, key: string) {
    const m = await deps.call('a2anotes_get_message', { id });
    if (!m) return;
    const stage = key.slice(0, key.indexOf(':')) as Stage;
    const hash = m.hash, proposal = deps.proposals()[id];
    const actor = m.direction === 'in' ? 'controller' : writer(m);
    const summary = stage === 'incoming'
      ? proposal?.task ? `give a message from ${deps.name(m)} to ${taskName(proposal.task)}` : `accept a message from ${deps.name(m)}`
      : stage === 'send' ? `send an approved message to ${deps.name(m)}: ${m.subject}` : `send a message to ${deps.name(m)}: ${m.subject}`;
    const current = async () => { const x = await deps.call('a2anotes_get_message', { id }); if (!x || x.hash !== hash) throw new Error('The message changed. Read the new version on its card.'); return x; };
    // after a decision, sync again at once: a failed send gets its Send again card without a wait for the next check
    const later = () => { setTimeout(() => { void sync(); }, 50).unref?.(); };
    const card = approvals.request({ actor, action: m.direction === 'in' ? 'mail-in' : 'mail-out', summary, detail: detail(m, stage), payload: payloadOf(m, stage, proposal) }, d => decide(d).finally(later), {
      onDeny: () => { deny().catch(() => {}).finally(later); },
      giveBack: comment => giveBack(comment).finally(later),
    });
    open.set(id, { approval: card.id, key });

    async function decide(d: approvals.Decider) {
      const context = d.by === 'controller' ? `Approved by the controller on the user's request: "${d.userRequest || ''}"`.slice(0, 2000) : 'Approved on the dashboard card.';
      let x = await current();
      if (stage === 'checking' || stage === 'held') throw new Error(stage === 'held' ? 'The safety check holds this draft. Nobody can approve it.' : 'The checks have not finished. Run the check again, or wait.');
      if (x.direction === 'out') {
        if (x.state === 'draft') x = await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'approve', review_context: context });
        return send(x, hash, d);
      }
      if (x.state === 'held') x = await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'approve', review_context: context });
      if (deps.accepted) {
        const routed = await deps.accepted(x, proposal);
        return routed ? `Accepted and given to ${taskName(routed.task)}.` : 'Accepted. The controller can read it and check its destination.';
      }
      if (proposal?.task) { const r = await deps.route(id, proposal.task); return `Accepted and given to ${taskName(r.task)}.`; }
      return 'Accepted. The controller can read it and check its destination.';
    }
    async function deny() {
      const x = await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'reject', review_context: 'Denied on the dashboard card.' });
      if (x?.direction === 'out') await tellWriter(x, 'rejected', `The user rejected your draft to ${deps.name(x)} at ${clock()}, without a comment.`, 'The draft is closed. Ask the user before you write a new one.');
    }
    async function giveBack(comment: string) {
      const text = comment.trim().slice(0, 2000);
      if (!text) throw new Error('Write a comment first.');
      const x = await current();
      if (x.direction === 'out') {
        const to = writer(x), who = to === 'controller' ? 'the controller' : taskName(to);
        // nobody can reject a draft that the checks hold: the comment goes to the task, and the draft stays
        if (x.approver === 'nobody') {
          await tellWriter(x, 'comment', `The user sent a comment on your draft to ${deps.name(x)} at ${clock()}. The checks still hold the draft, so it stays open.\n\nThe user's comment:\n\n${text}`,
            `Revise the draft with \`tb mail revise ${id} --hash ${hash}\` if the comment asks for a change.`);
          return `Your comment went to ${who}. The draft stays open because the checks hold it.`;
        }
        await deps.call('a2anotes_approve', { id, expected_hash: hash, decision: 'reject', review_context: text });
        await tellWriter(x, 'comment', `The user sent back your draft to ${deps.name(x)} at ${clock()}.\n\nThe user's comment:\n\n${text}\n\nThe draft is closed. Write a new draft with \`tb mail draft\` if the comment asks for one.`,
          'Read the comment in your inbox. Write a new draft only if the comment asks for one.');
        return `Rejected. Your comment went to ${who}.`;
      }
      deps.clearProposal(id);
      await deps.notify('controller', `a2anotes-${id}-comment-${stamp()}.md`, `# The user sent back your proposed task for message ${id}\n\nYou proposed ${proposal?.task ? taskName(proposal.task) : 'no task'}. The user's comment:\n\n${text}\n\nPropose a task again with \`tb mail propose-route ${id} <task>\`, or \`tb mail propose-route ${id} none\`.\n`);
      return 'Sent back to the controller with your comment.';
    }
  }

  let running: Promise<void> | undefined, again = false;
  async function doSync() {
    const list = await deps.call('a2anotes_list_messages', { direction: 'all', limit: 100 });
    if (!list) return;
    const seen = new Set<string>();
    for (const m of list.messages) {
      seen.add(m.id);
      const entry = open.get(m.id);
      const state = entry ? approvals.get(entry.approval)?.state : undefined;
      // the card runs now (approve and send, or send back): its result decides what comes next
      if (state === 'running') continue;
      const pending = state === 'pending' ? entry : undefined;
      const key = wanted(m);
      if (pending && pending.key === key) continue;
      if (pending) approvals.close(pending.approval, m.state === 'rejected' ? 'denied' : m.state === 'sent' ? 'approved' : 'expired',
        m.state === 'rejected' ? 'Rejected in the Inbox.' : m.state === 'sent' ? 'Sent from the Inbox or by the controller.'
          : key && pending.key.split(':')[1] !== m.hash ? 'The task changed the draft. The new version has its own card.' : 'The message, its check, its proposed task, or the levels changed.');
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

  // The open message cards, for `tb pending list` and GET /api/pending. It has no message body: the controller reads
  // a message with `tb mail get`, where A2A Notes decides what the reviewer role may see.
  function list(now = Date.now()) {
    const out = [];
    for (const entry of open.values()) {
      const a = approvals.get(entry.approval);
      if (!a || (a.state !== 'pending' && a.state !== 'running')) continue;
      const p = a.payload as MessagePayload;
      const waitMin = Math.max(0, Math.floor((now - Date.parse(p.since)) / 60000));
      out.push({ card: a.id, state: a.state, message: p.message, stage: p.stage, direction: p.direction, to: p.peer, subject: p.direction === 'in' ? '(held for user acceptance)' : p.subject, writer: p.writer,
        check: p.check.summary, flags: p.notes.map(n => n.code), approver: p.approver, since: p.since, waitMin, reminder: p.stage !== 'incoming' && waitMin >= p.remindAfterMin, notSent: p.direction === 'out' });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }
  return { sync, list };
}
