// Urgent mode approves eligible new cards for one task. It also removes request limits and allows local Git writes.
// The mandatory manual types in permission-policy.ts remain manual. The shell guard retains protected operations.
// Only the user or the controller with a user message can switch urgent mode. A task cannot change it.
// The server and guard read TB_DIR/urgent/<task id>.json. Changes and completed approvals go to urgent-mode.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import type { Approval } from './approvals.ts';
import { cardNeedsManual } from '../shared/permission-policy.ts';

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
  'github-pr': 'Only the user approves opening a pull request.',
  'github-pr-merge': 'Only the user approves merging a pull request.',
  release: 'A release needs a user decision in every mode.',
  restart: 'A restart needs a user decision in every mode.',
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
export function autoApprove(card: Pick<Approval, 'id' | 'actor' | 'action' | 'summary'> & { payload?: unknown }): boolean {
  return active(card.actor) && !KEPT[card.action] && !cardNeedsManual(card);
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
  'Taskboard approves eligible new cards for this task:',
  '- Command permits, including supervised runs.',
  '- Scope requests.',
  '- Local merges and ordinary pushes. Use `tb git push-request` for pushes.',
  '- Messages and documents to other tasks.',
  '- Local Git writes can run through the shell guard.',
  '- The limits on pending permits, permit rates, and scope requests are off.', '',
  'These stay the same:',
  '- Opening or merging pull requests needs the user.',
  '- Force pushes need a user decision.',
  '- Releases need a user decision.',
  '- Rollbacks and Taskboard restarts need the user.',
  '- Mail uses Settings > Permissions. Urgent mode alone does not approve mail.',
  '- Your coding agent\'s own permission checks and the permissions of external services do not change.',
  '- Only the user or the controller turns urgent mode off. You cannot change it.', '',
  'Other tasks and the user depend on the Taskboard server. Do not stop it.', '',
].join('\n');
export const offText = (by: string, reason: string) => [
  '# Urgent mode is off', '',
  `${by === 'user' ? 'The user' : by === 'controller' ? 'The controller' : 'Taskboard'} turned off urgent mode for this task at ${new Date().toISOString()}.${reason ? ` Reason: ${reason}` : ''}`,
  'The Taskboard restrictions apply again. Use the `tb git` commands, permits, and scope requests as before.', '',
].join('\n');
