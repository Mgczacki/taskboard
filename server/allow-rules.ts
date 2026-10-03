// Allow always rules: the user lets one task type messages into another task (tb send), or send documents to it
// (tb doc send), without an approval card. A rule covers one of these two kinds.
// The user adds a rule with the Allow always button on a "type into" card (web ApprovalCard), and revokes rules on the
// Settings page. Tasks and the controller only read the rules (tb allow list). index.ts holds the routes and checks
// that a request to add or revoke a rule comes from the dashboard; this file holds the rules and the match logic.
//
// A rule names the target task by its task id, and the sender by its task id (scope 'pair' or 'both') or not at all
// (scope 'any'). A task number can be used again after a task is removed, so a match never uses the number or the
// title. Taskboard removes the rules of a task when the task is archived or removed (index.ts).
//
// Each rule allows LIMIT_PER_HOUR deliveries in the last hour. When a rule reaches that number, the next message gets
// an approval card again, so two tasks that answer each other in a loop stop and wait for the user.
// A delivery under a rule runs only the one "type into" action. It does not approve anything else.
// Rules are saved in TB_DIR/allow-rules.json. Each change and each delivery is one line in TB_DIR/allow-rules.jsonl.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

// The action kinds that a rule can cover: text that one task types into another task (tb send), and a document from one
// task's outbox to another task's inbox (tb doc send). Starting, archiving, parking, resuming, moving, releasing and
// settings never get a rule.
export type AllowKind = 'message' | 'doc';
export const KINDS: AllowKind[] = ['message', 'doc'];
const VERB: Record<AllowKind, [string, string, string]> = {
  message: ['type messages into', 'type messages into each other', 'Messages'],
  doc: ['send documents to', 'send documents to each other', 'Documents'],
};
// pair: from the sender to the target only. both: the two tasks in both directions. any: from any task to the target.
export type AllowScope = 'pair' | 'both' | 'any';
export const SCOPES: AllowScope[] = ['pair', 'both', 'any'];
export const DEFAULT_SCOPE: AllowScope = 'pair';
export const LIMIT_PER_HOUR = 30;
const HOUR = 3_600_000;

export interface TaskRef { id: string; num: number; title: string; status: string; role?: string }
export interface AllowRule {
  id: string; kind: AllowKind; scope: AllowScope;
  from?: string; fromNum?: number; fromTitle?: string; // not set for scope 'any'
  to: string; toNum: number; toTitle: string;
  created: string; card: string; by: 'user'; // only the user adds a rule, on the dashboard
  count: number; // deliveries under this rule since it was added
  recent: string[]; // the times of the deliveries in the last hour, for the rate limit
  lastAt?: string;
}
// What the card offers before the click: the sender, the target and the plain words of each choice.
export interface AllowOffer { kind: AllowKind; from: string; to: string; choices: { scope: AllowScope; text: string }[]; limitText: string }

const name = (t: Pick<TaskRef, 'num' | 'title'>) => `#${t.num} "${t.title}"`;
// The rule in plain words, for the card, the Settings page and tb allow list.
export function ruleText(scope: AllowScope, from: Pick<TaskRef, 'num' | 'title'> | undefined, to: Pick<TaskRef, 'num' | 'title'>, kind: AllowKind = 'message'): string {
  const [one, both, plural] = VERB[kind];
  if (scope === 'any') return `Any task may ${one} task ${name(to)} without a card.`;
  if (!from) throw new Error('This rule needs a sender task.');
  if (scope === 'both') return `Tasks ${name(from)} and ${name(to)} may ${both} without a card.`;
  return `Task ${name(from)} may ${one} task ${name(to)} without a card. ${plural} in the other direction still need a card.`;
}
export const describe = (r: AllowRule) => ruleText(r.scope, r.from ? { num: r.fromNum ?? 0, title: r.fromTitle ?? '' } : undefined, { num: r.toNum, title: r.toTitle }, r.kind);
export const LIMIT_TEXT = `Each rule allows at most ${LIMIT_PER_HOUR} deliveries in one hour. After that, a card asks you again.`;

// A task that may be the sender or the target of a rule: a task that exists, is not the controller and is not archived.
const usable = (t: TaskRef | undefined): t is TaskRef => !!t && t.role !== 'controller' && t.status !== 'archived';

// The offer for a "type into" or "send a document" card, or undefined when the card cannot get a rule (the controller,
// or the same task).
export function offer(from: TaskRef | undefined, to: TaskRef | undefined, kind: AllowKind = 'message'): AllowOffer | undefined {
  if (!usable(from) || !usable(to) || from.id === to.id) return undefined;
  return { kind, from: from.id, to: to.id, choices: SCOPES.map(scope => ({ scope, text: ruleText(scope, from, to, kind) })), limitText: LIMIT_TEXT };
}

// True when the rule covers a message from `from` to `to`. Only task ids count.
export function covers(r: AllowRule, kind: AllowKind, from: string, to: string): boolean {
  if (r.kind !== kind || from === to) return false;
  if (r.scope === 'any') return r.to === to;
  if (r.scope === 'both') return (r.from === from && r.to === to) || (r.from === to && r.to === from);
  return r.from === from && r.to === to;
}

// The first rule that covers the message, or undefined. Both tasks must still be usable.
export function match(rules: AllowRule[], kind: AllowKind, from: TaskRef | undefined, to: TaskRef | undefined): AllowRule | undefined {
  if (!usable(from) || !usable(to)) return undefined;
  return rules.find(r => covers(r, kind, from.id, to.id));
}

// The delivery times of the rule in the last hour.
export const recentOf = (r: AllowRule, now = Date.now()) => r.recent.filter(at => now - Date.parse(at) < HOUR);
// undefined when the rule may deliver one more message now, or the reason why a card asks again.
export function limited(r: AllowRule, now = Date.now()): string | undefined {
  const n = recentOf(r, now).length;
  if (n < LIMIT_PER_HOUR) return undefined;
  return `The allow always rule ${r.id} already delivered ${n} ${r.kind === 'doc' ? 'documents' : 'messages'} in the last hour (the limit is ${LIMIT_PER_HOUR}). This card asks you again. Two tasks may answer each other in a loop.`;
}

// ---------- the saved rules ----------
let dir = TB_DIR;
const FILE = () => join(dir, 'allow-rules.json');
const AUDIT = () => join(dir, 'allow-rules.jsonl');
let rules: AllowRule[] = [];
// Reads the rules of a data folder. The server uses TB_DIR; the tests give a temporary folder.
export function load(d = TB_DIR) {
  dir = d; rules = [];
  try { rules = JSON.parse(readFileSync(FILE(), 'utf8')) as AllowRule[]; } catch { /* first start */ }
}
load();
const listeners = new Set<() => void>();
export const onChange = (fn: () => void) => { listeners.add(fn); };
const save = () => { try { writeFileSync(FILE(), JSON.stringify(rules, null, 2), { mode: 0o600 }); } catch (e) { console.error('could not save the allow always rules', e); } listeners.forEach(f => f()); };
export function audit(row: Record<string, unknown>) {
  try { appendFileSync(AUDIT(), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 }); } catch { /* disk full */ }
}
export function auditRows(): Record<string, unknown>[] {
  try { return readFileSync(AUDIT(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

export const all = () => rules.map(r => ({ ...r, text: describe(r), lastHour: recentOf(r).length }));
export const get = (id: string) => rules.find(r => r.id === id);

// Adds a rule for the card. index.ts calls this only for a click on the dashboard. An equal rule is not added twice.
export function add(scope: AllowScope, from: TaskRef, to: TaskRef, card: string, kind: AllowKind = 'message'): AllowRule {
  if (!SCOPES.includes(scope)) throw new Error('Choose this task only, both directions or any task.');
  if (!KINDS.includes(kind)) throw new Error('A rule covers only messages or documents.');
  if (!offer(from, to)) throw new Error('A rule needs two different tasks that are not archived. The controller cannot be part of a rule.');
  const same = rules.find(r => r.kind === kind && r.scope === scope && r.to === to.id && (scope === 'any' || r.from === from.id));
  if (same) return same;
  const r: AllowRule = { id: randomUUID().slice(0, 8), kind, scope, ...(scope === 'any' ? {} : { from: from.id, fromNum: from.num, fromTitle: from.title }),
    to: to.id, toNum: to.num, toTitle: to.title, created: new Date().toISOString(), card, by: 'user', count: 0, recent: [] };
  rules.push(r); save();
  audit({ event: 'added', rule: r.id, kind, scope, from: r.from, to: r.to, card, by: 'user', text: describe(r) });
  return r;
}
// Counts one delivery under the rule: the total, the time for the rate limit and a line in the audit file.
export function recordDelivery(id: string, d: { from: TaskRef; to: TaskRef; state: string }, now = Date.now()) {
  const r = get(id); if (!r) return;
  r.recent = [...recentOf(r, now), new Date(now).toISOString()]; r.count++; r.lastAt = new Date(now).toISOString(); save();
  audit({ event: 'delivered', rule: id, from: d.from.id, fromNum: d.from.num, to: d.to.id, toNum: d.to.num, state: d.state });
}
export function revoke(id: string, why = 'revoked by the user on the dashboard'): AllowRule | undefined {
  const r = get(id); if (!r) return undefined;
  rules = rules.filter(x => x.id !== id); save();
  audit({ event: 'removed', rule: id, why, text: describe(r) });
  return r;
}
export function revokeAll(): number {
  const n = rules.length; if (!n) return 0;
  for (const r of rules) audit({ event: 'removed', rule: r.id, why: 'Revoke all by the user on the dashboard', text: describe(r) });
  rules = []; save(); return n;
}
// The rules that name the task as the sender or the target, removed because the task was archived or removed.
export function removeForTask(taskId: string, why: string): number {
  const gone = rules.filter(r => r.from === taskId || r.to === taskId);
  if (!gone.length) return 0;
  rules = rules.filter(r => !gone.includes(r));
  for (const r of gone) audit({ event: 'removed', rule: r.id, why, text: describe(r) });
  save(); return gone.length;
}
