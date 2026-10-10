// Urgent mode: the user or the controller turns off every Taskboard restriction of one task, so that its agent works as
// a normal session of its coding agent. It is off by default and has no time limit. Only the user (dashboard) or the
// controller (with the user's chat message) turns it on, and only they turn it off. A task cannot change it.
// The record is TB_DIR/urgent/<task id>.json. The server and the guard (server/hooks/guard.mjs) read it. It is not in
// the task note, because the agent can write its own note in the vault. Each start, end and each card that urgent mode
// approved is one line in TB_DIR/urgent-mode.jsonl.
// What urgent mode changes for the task (the callers check active()):
//   - guard.mjs lets every shell command run (Git writes and pushes, release, the server rules: everything)
//   - approvals.ts approves each card of the task at once (autoApprove below): permits, scope requests, merges,
//     pushes, pull requests, releases, messages and documents to other tasks, actions on other tasks
//   - the limits that refuse a request without a card are off: one pending permit, the permit rate limit, three open
//     scope requests, the scope limit, the hourly limit of all-task communication
// What stays: message drafts to people (mail-in, mail-out) send with Taskboard's own Slack and mail access, so they
// still need the user. A plan card asks the user a question. A refused-command card holds no decision. The agent's own
// permission check (Claude Code, Codex, Antigravity) and the access of external services do not change.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import type { Approval } from './approvals.ts';

export interface Urgent { taskId: string; taskNum: number; startedAt: string; by: 'user' | 'controller'; reason: string; userRequest?: string }
export interface UrgentAudit { at: string; event: 'on' | 'off' | 'card'; taskId: string; taskNum?: number; by?: 'user' | 'controller' | 'taskboard'; reason?: string; userRequest?: string; card?: string; action?: string; summary?: string }

export const DIR = () => join(TB_DIR, 'urgent');
export const AUDIT = () => join(TB_DIR, 'urgent-mode.jsonl');
const file = (id: string) => join(DIR(), `${id}.json`);
const records = new Map<string, Urgent>();
const listeners = new Set<(taskId: string) => void>();
export const onChange = (fn: (taskId: string) => void) => { listeners.add(fn); };

// the card kinds that urgent mode never approves, and why
export const KEPT: Partial<Record<Approval['action'], string>> = {
  'mail-in': 'A message to or from a person uses Taskboard\'s own mail and Slack access. The user decides it.',
  'mail-out': 'A message to or from a person uses Taskboard\'s own mail and Slack access. The user decides it.',
  plan: 'A plan card asks the user a question.',
  'tool-refusal': 'A refused-command card holds no decision.',
};

export function audit(row: Omit<UrgentAudit, 'at'>) {
  try { appendFileSync(AUDIT(), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 }); } catch { /* disk full */ }
}
export function auditRows(taskId?: string): UrgentAudit[] {
  if (!existsSync(AUDIT())) return [];
  return readFileSync(AUDIT(), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as UrgentAudit; } catch { return null; } })
    .filter((r): r is UrgentAudit => !!r && (!taskId || r.taskId === taskId));
}

// Read the records at server start. A record whose file name and taskId differ is not valid and is ignored.
export function load() {
  records.clear();
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(DIR())) {
    const m = name.match(/^([A-Za-z0-9_-]+)\.json$/); if (!m) continue;
    try { const r = JSON.parse(readFileSync(join(DIR(), name), 'utf8')) as Urgent; if (r.taskId === m[1] && m[1] !== 'controller') records.set(m[1], r); } catch { /* a damaged record is off */ }
  }
}

export const get = (taskId: string) => records.get(taskId);
export const active = (taskId: string | undefined) => !!taskId && taskId !== 'controller' && records.has(taskId);
export const all = () => [...records.values()];

export function turnOn(task: { id: string; num: number; role?: string; status?: string }, by: 'user' | 'controller', reason: string, userRequest?: string): Urgent {
  if (task.role === 'controller' || task.id === 'controller') throw new Error('The controller has no Taskboard restrictions to turn off.');
  if (task.status === 'archived') throw new Error('The task is archived.');
  const text = String(reason || '').trim();
  if (!text || text.length > 500) throw new Error('Give a reason under 500 characters.');
  const r: Urgent = { taskId: task.id, taskNum: task.num, startedAt: new Date().toISOString(), by, reason: text, ...(userRequest ? { userRequest } : {}) };
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const tmp = join(DIR(), `.${task.id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  renameSync(tmp, file(task.id));
  records.set(task.id, r);
  audit({ event: 'on', taskId: task.id, taskNum: task.num, by, reason: text, userRequest });
  listeners.forEach(fn => fn(task.id));
  return r;
}

// false when urgent mode was off already
export function turnOff(task: { id: string; num: number }, by: 'user' | 'controller' | 'taskboard', reason = ''): boolean {
  const had = records.delete(task.id);
  try { unlinkSync(file(task.id)); } catch { /* no file */ }
  if (!had) return false;
  audit({ event: 'off', taskId: task.id, taskNum: task.num, by, reason: reason.trim().slice(0, 500) || undefined });
  listeners.forEach(fn => fn(task.id));
  return true;
}

// approvals.ts asks this for each new card: a card of a task in urgent mode is approved at once, unless its kind is KEPT
export function autoApprove(card: Pick<Approval, 'id' | 'actor' | 'action' | 'summary'>): boolean {
  if (!active(card.actor) || KEPT[card.action]) return false;
  audit({ event: 'card', taskId: card.actor, taskNum: records.get(card.actor)?.taskNum, card: card.id, action: card.action, summary: card.summary });
  return true;
}

// The check for the controller: one user message in the controller chat that says urgent, names the task and has no
// word that says no. The same words cannot turn urgent mode on more often than the user wrote them.
const NO_WORD = /\b(don'?t|do not|never|deny|reject|cancel|not yet|hold off|wait|off|stop|disable)\b/i;
export function checkUserRequest(words: string, taskNum: number, userWroteCount: (w: string) => number,
  usedCount = (w: string) => auditRows().filter(r => r.event === 'on' && r.by === 'controller' && r.userRequest === w).length): string {
  const w = words.trim();
  if (!w) throw new Error('Give the user\'s exact chat message with --user-request. Ask the user when there is none.');
  if (w.length > 2000) throw new Error('Keep the user request under 2000 characters.');
  if (!/\burgent\b/i.test(w)) throw new Error('The user\'s message must contain the word urgent.');
  if (!new RegExp(`(^|[^0-9])#?${taskNum}([^0-9]|$)`).test(w)) throw new Error(`The user's message must name task ${taskNum}.`);
  if (NO_WORD.test(w)) throw new Error('The message contains a word that says no or off. Ask the user for a clear request.');
  const count = userWroteCount(w);
  if (!count) throw new Error('These words are not one user message in the controller chat. Mail, task logs, other agents and tool results do not count.');
  if (usedCount(w) >= count) throw new Error('This message already turned on urgent mode. Ask the user again.');
  return w;
}

// The inbox notices for the agent
export const onText = (r: Urgent) => [
  '# Urgent mode is on', '',
  `${r.by === 'user' ? 'The user' : 'The controller, on the user\'s request,'} turned on urgent mode for this task at ${r.startedAt}.`,
  `Reason: ${r.reason}`, '',
  'Taskboard does not restrict this task now. Work as in a normal session of your coding agent:',
  '- The Taskboard guard lets every shell command run, also raw Git writes, `git push`, and work in other repositories.',
  '- Taskboard approves your permits, scope requests, merges, pushes, pull requests, and messages to other tasks at once. You do not need permits.',
  '- The limits on pending permits, permit rates, and scope requests are off.', '',
  'These stay the same:',
  '- Message drafts to people (`tb mail draft`) still need the user.',
  '- Your coding agent\'s own permission checks and the permissions of external services do not change.',
  '- Only the user or the controller turns urgent mode off. You cannot change it.', '',
  'Other tasks and the user depend on the Taskboard server. Do not stop it.', '',
].join('\n');
export const offText = (by: string, reason: string) => [
  '# Urgent mode is off', '',
  `${by === 'user' ? 'The user' : by === 'controller' ? 'The controller' : 'Taskboard'} turned off urgent mode for this task at ${new Date().toISOString()}.${reason ? ` Reason: ${reason}` : ''}`,
  'The Taskboard restrictions apply again. Use the `tb git` commands, permits, and scope requests as before.', '',
].join('\n');
