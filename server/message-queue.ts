// Messages that Taskboard types into an agent's input box: tb send (to the controller or to a task), review feedback
// and permit results. send() types the message at once when the agent's box is empty (the agent may be working).
// When nothing can be typed now (the box holds a person's draft, a question or dialog shows, no box shows, or another
// message is being typed), the message goes to TASK_DIR/message-queue.json and the sender gets "queued" and the reason.
// The loop in start() reads the screen of each task with queued messages every 2 s, and types the first message when
// the box is empty. A message that is not typed within QUEUE_MS fails. A message that was typed only in part (Enter was
// not pressed) also fails: it may be in the box, so it is not typed again without the user (dashboard "Type again").
// Inbox notices have their own record (inbox-delivery.ts). The same loop tries them again when the box is empty.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.ts';
import type { Task } from './store.ts';
import * as tmux from './tmux.ts';
import * as agents from './agents.ts';
import * as inboxDelivery from './inbox-delivery.ts';
import { NotTyped, textError } from './deliver-text.ts';
import { boxState, type PromptAgent } from './type-command.ts';

export const QUEUE_MS = 60 * 60_000;
export const TICK_MS = 2000;
export type Kind = 'message' | 'review' | 'permit';
export interface Queued {
  id: string; text: string; kind: Kind;
  from: string; // a task id, "you" (the dashboard) or "taskboard"
  queued: string; expires: string;
  state: 'queued' | 'failed';
  reason: string; tries: number; triedAt?: string;
}
export interface SendResult { state: 'delivered' | 'queued' | 'failed'; reason?: string; warning?: string; resumed?: boolean; id?: string }

const file = (taskId: string) => join(store.taskDir(taskId), 'message-queue.json');
export function list(taskId: string): Queued[] {
  try { return JSON.parse(readFileSync(file(taskId), 'utf8')) as Queued[]; } catch { return []; }
}
const known = new Set<string>(); // tasks that may have a queue file, so the loop does not read every task folder
function write(taskId: string, items: Queued[]) {
  if (items.length) { mkdirSync(store.taskDir(taskId), { recursive: true }); writeFileSync(file(taskId), JSON.stringify(items, null, 2)); known.add(taskId); }
  else { rmSync(file(taskId), { force: true }); known.delete(taskId); }
  store.touch(taskId); // the dashboard shows the queue on the task
}
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const clock = () => new Date().toLocaleTimeString();
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const sender = (from: string) => from === 'you' ? 'you' : from === 'taskboard' ? 'Taskboard' : store.get(from) ? `#${store.get(from)!.num}` : from;

function enqueue(t: Task, text: string, from: string, kind: Kind, state: Queued['state'], reason: string): Queued {
  const q: Queued = { id: randomUUID().slice(0, 8), text, kind, from, queued: iso(), expires: iso(Date.now() + QUEUE_MS), state, reason, tries: 1, triedAt: iso() };
  write(t.id, [...list(t.id), q]);
  return q;
}

// The controller is never resumed by a message: agents.startController starts it.
async function controllerDown(t: Task) {
  if (t.role !== 'controller') return false;
  const s = (await tmux.listSessions())?.find(x => x.name === t.session);
  return !s || s.dead;
}

async function typeNow(t: Task, text: string) {
  if (await controllerDown(t)) throw new NotTyped('The controller is not running.', 'no-box');
  return agents.sendTaskText(t, text);
}

function delivered(t: Task, kind: Kind, from: string, later: boolean) {
  const what = kind === 'review' ? 'Review feedback' : kind === 'permit' ? 'Permit result' : `Message from ${sender(from)}`;
  store.update(t.id, { status: 'working', ask: '', statusSource: `${what} typed into the agent's input box${later ? ' from the queue' : ''} at ${clock()}.` });
}

// Types the text now, or queues it. Throws only for an empty or too long text.
export async function send(t: Task, text: string, opts: { from: string; kind: Kind }): Promise<SendResult> {
  const empty = textError(text); if (empty) throw new Error(empty);
  // a message does not jump ahead of the ones that wait
  const waiting = list(t.id).filter(q => q.state === 'queued').length;
  if (waiting) {
    const q = enqueue(t, text, opts.from, opts.kind, 'queued', `${waiting} earlier message${waiting > 1 ? 's' : ''} for #${t.num} ${waiting > 1 ? 'wait' : 'waits'} to be typed first.`);
    void flush(t.id);
    return { state: 'queued', reason: q.reason, id: q.id };
  }
  try {
    const r = await typeNow(t, text);
    delivered(t, opts.kind, opts.from, false);
    return { state: 'delivered', resumed: r.resumed, ...(r.warning ? { warning: r.warning } : {}) };
  } catch (e) {
    if (e instanceof NotTyped) { const q = enqueue(t, text, opts.from, opts.kind, 'queued', e.reason); return { state: 'queued', reason: q.reason, id: q.id }; }
    // the dashboard shows its own error; a message from an agent or from Taskboard stays on the task
    const q = opts.from === 'you' ? undefined : enqueue(t, text, opts.from, opts.kind, 'failed', message(e));
    return { state: 'failed', reason: message(e), ...(q ? { id: q.id } : {}) };
  }
}

// One try at a time for each task.
const chains = new Map<string, Promise<void>>();
function flush(taskId: string): Promise<void> {
  const next = (chains.get(taskId) || Promise.resolve()).then(() => flushOnce(taskId)).catch(e => console.error(`message queue of ${taskId}:`, e));
  chains.set(taskId, next);
  return next.finally(() => { if (chains.get(taskId) === next) chains.delete(taskId); });
}
const lastResume = new Map<string, number>();
async function flushOnce(taskId: string) {
  const t = store.get(taskId);
  let items = list(taskId);
  if (!t) { if (items.length) write(taskId, []); return; }
  // expired messages fail with their last reason
  let changed = false;
  for (const q of items) if (q.state === 'queued' && Date.parse(q.expires) <= Date.now()) {
    q.state = 'failed'; q.reason = `Not typed within ${QUEUE_MS / 60000} minutes. Last reason: ${q.reason}`; changed = true;
  }
  if (changed) write(taskId, items);
  const q = items.find(x => x.state === 'queued'); if (!q) return;
  const update = (patch: Partial<Queued>) => { items = list(taskId); const x = items.find(i => i.id === q.id); if (x) { Object.assign(x, patch); write(taskId, items); } };
  if (['archived', 'parked'].includes(t.status) || t.openElsewhere) {
    const reason = t.openElsewhere ? 'The task is open in another terminal.' : 'The task is archived or set aside. Resume it to receive the message.';
    if (q.reason !== reason) update({ reason });
    return;
  }
  const s = (await tmux.listSessions())?.find(x => x.name === t.session);
  if (!s || s.dead) {
    // a stopped task is resumed by sendTaskText, at most once a minute; the controller only by startController
    if (t.role === 'controller') { if (q.reason !== 'The controller is not running.') update({ reason: 'The controller is not running.' }); return; }
    if (Date.now() - (lastResume.get(taskId) || 0) < 60000) return;
    lastResume.set(taskId, Date.now());
  } else if (boxState(await tmux.captureStyled(t.session), t.agent as PromptAgent) !== 'empty') return; // the reason stays from the last try
  try {
    await typeNow(t, q.text);
    write(taskId, list(taskId).filter(x => x.id !== q.id));
    delivered(t, q.kind, q.from, true);
    // the next message, in order, if the box is still empty
    return flushOnce(taskId);
  } catch (e) {
    if (e instanceof NotTyped) update({ reason: e.reason, tries: q.tries + 1, triedAt: iso() });
    else update({ state: 'failed', reason: message(e), tries: q.tries + 1, triedAt: iso() });
  }
}

// The dashboard: type a failed message again (it waits in the queue again), or remove a message.
export function retry(taskId: string, id: string): Queued | null {
  const items = list(taskId); const q = items.find(x => x.id === id); if (!q) return null;
  Object.assign(q, { state: 'queued', reason: 'Waiting for an empty input box.', expires: iso(Date.now() + QUEUE_MS) });
  // it goes after the other waiting messages
  write(taskId, [...items.filter(x => x.id !== id), q]);
  void flush(taskId);
  return q;
}
export function remove(taskId: string, id: string): boolean {
  const items = list(taskId); if (!items.some(x => x.id === id)) return false;
  write(taskId, items.filter(x => x.id !== id));
  return true;
}

// What the dashboard shows on a task: queued and failed messages, and inbox notices that were not delivered yet.
export function forView(taskId: string) {
  const messages = known.has(taskId) ? list(taskId).map(q => ({ id: q.id, kind: q.kind, from: sender(q.from), text: q.text.length > 300 ? q.text.slice(0, 300) + '…' : q.text, state: q.state, reason: q.reason, queued: q.queued, expires: q.expires })) : [];
  const notices = inboxDelivery.openFor(taskId).map(d => ({ id: d.name, kind: 'inbox' as const, from: 'Taskboard', text: `Inbox file ${d.name}`, state: 'queued' as const, reason: d.problem || 'Waiting for the agent.', queued: d.queued }));
  return [...messages, ...notices];
}

let timer: NodeJS.Timeout | undefined;
export function start() {
  for (const t of store.all()) if (list(t.id).length) known.add(t.id);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
}
export function stop() { if (timer) clearInterval(timer); timer = undefined; }
let ticking = false;
export async function tick() {
  if (ticking) return; ticking = true;
  try {
    for (const id of [...known]) if (!chains.has(id) && list(id).some(q => q.state === 'queued')) await flush(id);
    // inbox notices that were not typed: try again when the box is empty (not only when the status changes)
    for (const id of inboxDelivery.openTasks()) {
      const t = store.get(id); if (!t || ['archived', 'parked', 'suspended', 'stopped'].includes(t.status) || t.openElsewhere) continue;
      if (t.agent === 'antigravity' && t.status === 'working') continue;
      const s = (await tmux.listSessions())?.find(x => x.name === t.session); if (!s || s.dead) continue;
      if (boxState(await tmux.captureStyled(t.session), t.agent as PromptAgent) === 'empty') await inboxDelivery.retry(id);
    }
  } finally { ticking = false; }
}
