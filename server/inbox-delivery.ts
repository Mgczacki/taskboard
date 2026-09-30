// Files that the server puts in a task's Taskboard inbox for its agent: a comment from a mail card that the user sent
// back, a message or file routed to the task, a notice for the controller about a new message. Each one must reach the
// agent. Claude Code reads new inbox files at its next prompt (UserPromptSubmit hook), Antigravity at the end of a turn
// (Stop hook), and Codex only when Taskboard types a notice into its terminal.
// deliver() types the notice at once with agents.sendTaskText, which resumes a stopped or suspended task first and waits
// for its input prompt. Codex and Claude Code queue text typed during a turn. When the notice cannot be typed, the file
// stays in the inbox's .pending.json, the reason is saved in TB_DIR/inbox-deliveries.json, and Taskboard types the notice
// again when the task's status next changes to idle, unread or review (a turn ended, or the task resumed).
// A file also counts as delivered when a hook or `tb inbox wait` tells the agent about it (docs.onInboxTold).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as agents from './agents.ts';
import * as docs from './docs.ts';
import * as store from './store.ts';
import * as tmux from './tmux.ts';

export interface Delivery {
  task: string; name: string; queued: string;
  deliveredAt?: string; resumed?: boolean;
  // why the last try did not type the notice; cleared on delivery
  problem?: string; triedAt?: string;
}
const FILE = join(TB_DIR, 'inbox-deliveries.json');
const items = new Map<string, Delivery>();
const key = (task: string, name: string) => `${task}/${name}`;
try { for (const d of JSON.parse(readFileSync(FILE, 'utf8')) as Delivery[]) items.set(key(d.task, d.name), d); } catch { /* first start */ }
// keeps the undelivered entries and the last 500 delivered ones
function save() {
  const all = [...items.values()], open = all.filter(d => !d.deliveredAt), done = all.filter(d => d.deliveredAt).slice(-500);
  for (const d of all) if (d.deliveredAt && !done.includes(d)) items.delete(key(d.task, d.name));
  try { writeFileSync(FILE, JSON.stringify([...open, ...done], null, 2)); } catch { /* disk full: the entries stay in memory */ }
}
const now = () => new Date().toISOString();

export const get = (task: string, name: string) => items.get(key(task, name));

// Records a file that the agent must be told about, without trying to type the notice.
export function track(task: string, name: string, problem?: string): Delivery {
  let d = items.get(key(task, name));
  if (!d) { d = { task, name, queued: now(), ...(problem ? { problem } : {}) }; items.set(key(task, name), d); save(); }
  return d;
}

docs.onInboxTold((task, names) => {
  let changed = false;
  for (const name of names) {
    const d = items.get(key(task, name));
    if (d && !d.deliveredAt) { d.deliveredAt = now(); delete d.problem; changed = true; }
  }
  if (changed) save();
});

// One try at a time for each task: a second try waits for the first and then finds nothing left to send.
const chains = new Map<string, Promise<void>>();
function attempt(taskId: string): Promise<void> {
  const next = (chains.get(taskId) || Promise.resolve()).then(() => tryOnce(taskId));
  chains.set(taskId, next);
  return next.finally(() => { if (chains.get(taskId) === next) chains.delete(taskId); });
}
async function tryOnce(taskId: string) {
  const waiting = [...items.values()].filter(d => d.task === taskId && !d.deliveredAt);
  if (!waiting.length) return;
  const pending = docs.pendingInboxNotice(taskId);
  const names = new Set(pending?.names || []);
  // a hook or `tb inbox wait` already told the agent about these
  for (const d of waiting) if (!names.has(d.name)) { d.deliveredAt = now(); delete d.problem; }
  const open = waiting.filter(d => !d.deliveredAt);
  const fail = (problem: string) => { for (const d of open) { d.problem = problem; d.triedAt = now(); } save(); };
  if (!open.length || !pending) return save();
  const t = store.get(taskId);
  if (!t) return fail('The task no longer exists.');
  if (t.agent === 'antigravity' && t.status === 'working') return fail('The agent is working. Antigravity reads new inbox files when its turn ends.');
  try {
    if (t.role === 'controller') {
      // sendTaskText resumes a stopped task; the controller is started only by agents.startController
      const s = (await tmux.listSessions())?.find(x => x.name === t.session);
      if (!s || s.dead) throw new Error('The controller is not running. Taskboard tells it when it starts again.');
    }
    const result = await agents.sendTaskText(t, pending.notice);
    for (const d of open) d.resumed = result.resumed;
    docs.acknowledgeInboxNotice(taskId, pending.names);
    store.update(taskId, { status: 'working', ask: '', statusSource: `Inbox notice sent to the agent${result.resumed ? ' after resuming the task' : ''} at ${new Date().toLocaleTimeString()}.` });
  } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
}

// Tells the agent about a file that is already in its inbox and in .pending.json. Resolves after the try, with the result.
export async function deliver(task: string, name: string): Promise<Delivery> {
  const d = track(task, name);
  await attempt(task);
  return d;
}

// Tries again when a task's turn ends or the task resumes, and at server start for tasks that wait for input.
const retryStatuses = new Set(['idle', 'unread', 'review']);
const lastStatus = new Map<string, string>();
export function start() {
  store.onTaskRemoved(id => lastStatus.delete(id));
  store.onTaskChange(t => {
    const before = lastStatus.get(t.id); lastStatus.set(t.id, t.status);
    if (before === t.status || !retryStatuses.has(t.status)) return;
    if ([...items.values()].some(d => d.task === t.id && !d.deliveredAt)) void attempt(t.id);
  });
  const tasks = new Set([...items.values()].filter(d => !d.deliveredAt).map(d => d.task));
  for (const id of tasks) {
    const t = store.get(id); if (!t) continue;
    lastStatus.set(id, t.status);
    if (retryStatuses.has(t.status)) void attempt(id);
  }
}
