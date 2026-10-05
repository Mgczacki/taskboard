// Requests from agents (through `tb`) that act on other agents — start, type into, set aside, archive — wait here
// until you approve them on the dashboard. This does not depend on the agent's own permission mode.
// States: pending → running → approved | failed, or pending → denied. Deciding only works on a pending approval, so
// a second click or a late Deny cannot run the action twice or contradict it.
// A refused-command card (tool-refusal) has no decision: Taskboard cannot override the agent's own permission check.
// Dismiss closes it (pending → dismissed) and the task gets no message. Undo (undo below) reopens a card that the user
// denied less than UNDO_MS ago (denied → pending), so a click that landed on Deny by mistake can be taken back.
// Each decision, Dismiss and Undo records where it came from (DecisionOrigin) on the card and in DECISIONS_FILE. Approvals are saved to
// TB_DIR/approvals.json; after a restart, a pending one is marked expired (nothing ran) and a running one unknown.
// Message cards (mail-in, mail-out) are made again from A2A Notes after a restart (server/a2anotes/cards.ts). They can also
// be sent back with a comment (pending → returned), and close when the message is decided in the Inbox.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import type { AllowOffer } from './allow-rules.ts';

export interface Approval {
  id: string; actor: string; action: 'new' | 'send' | 'status' | 'kill' | 'move' | 'release' | 'restart' | 'git-merge' | 'git-push' | 'tool-refusal' | 'permit' | 'external' | 'plan' | 'scope' | 'mail-in' | 'mail-out'; summary: string; detail: string;
  created: string; state: 'pending' | 'running' | 'approved' | 'denied' | 'failed' | 'expired' | 'unknown' | 'returned' | 'dismissed'; result?: string; payload: unknown;
  // the card has a comment box and Send back
  returnable?: boolean;
  // a "type into" card from one task to another: the card offers Allow always with these choices (allow-rules.ts)
  allow?: AllowOffer;
  // who approved or denied the card. The controller approves only on the user's request in its chat
  // (server/controller-approve.ts); userRequest holds the user's exact message.
  decidedBy?: Decider & { at: string; origin?: DecisionOrigin; ageMs?: number };
  // a denied card: until when Undo can reopen it, or why it cannot (undoState)
  undoUntil?: string;
  noUndo?: string;
  // the user reopened the card with Undo after a denial
  reopened?: { at: string; origin?: DecisionOrigin };
  target?: string;
  version?: string;
  covers?: Record<string, string>;
  unblocks?: string[];
  validUntil?: string;
  plan?: string;
  staleFacts?: string;
  updated?: string;
  notifyMe?: boolean;
}
export interface Decider { by: 'user' | 'controller'; userRequest?: string }
// Where a decision came from, for the audit. The dashboard sends from, target, shownMs and pointerMs. The server adds
// the user agent. shownMs: how long the card showed in that place before the click. pointerMs: the time from the
// pointerdown on the button to the click.
export interface DecisionOrigin { from: 'stack' | 'waiting' | 'permits' | 'manager-board' | 'controller' | 'unknown'; target?: string; shownMs?: number; pointerMs?: number; userAgent?: string }
const FROM = ['stack', 'waiting', 'permits', 'manager-board', 'controller'];
// Only the known fields, with a limited size: the body comes from the browser.
export function cleanOrigin(o: unknown, userAgent?: string): DecisionOrigin {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const ms = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(Math.min(v, 864e5)) : undefined;
  return { from: FROM.includes(String(x.from)) ? x.from as DecisionOrigin['from'] : 'unknown', ...(typeof x.target === 'string' ? { target: x.target.slice(0, 40) } : {}),
    ...(ms(x.shownMs) !== undefined ? { shownMs: ms(x.shownMs) } : {}), ...(ms(x.pointerMs) !== undefined ? { pointerMs: ms(x.pointerMs) } : {}), ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}) };
}
// A denial less than UNDO_MS ago can be undone. A decision less than QUICK_MS after the card appeared is reported to
// the task with a line that asks it to check with the user.
export const UNDO_MS = 60_000;
export const QUICK_MS = 10_000;
export const DISMISSED_RESULT = 'Closed by the user without a decision.';
// The card kinds whose denial cannot be undone, and why
const NO_UNDO: Record<string, string> = {
  'mail-in': 'Undo is not possible for a Message card. The denial already rejected the message in the Inbox.',
  'mail-out': 'Undo is not possible for a Message card. The denial already rejected the message in the Inbox.',
};
// The action of a card. It gets who approved it, so a message to the task can say so.
export type Runner = (d: Decider) => Promise<string>;
const FILE = join(TB_DIR, 'approvals.json');
const items = new Map<string, Approval>();
const runners = new Map<string, Runner>();
// for a merge or a push card: the reason why the card no longer matches the branch, or undefined
const checkers = new Map<string, () => Promise<string | undefined>>();
const returners = new Map<string, (comment: string) => Promise<string>>();
const deniers = new Map<string, () => void>();
const reopeners = new Map<string, () => void>();
// the actions of a denied card, kept for UNDO_MS so that Undo can give them back
const held = new Map<string, { run?: Runner; back?: (comment: string) => Promise<string>; deny?: () => void; check?: () => Promise<string | undefined>; reopen?: () => void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const decisionListeners = new Set<(card: Approval) => void>();
export const onApprovalsChange = (fn: () => void) => { listeners.add(fn); };
export const onDecision = (fn: (card: Approval) => void) => { decisionListeners.add(fn); };
const decided = (card: Approval) => { for (const fn of decisionListeners) fn(card); };
const reopenListeners = new Set<(card: Approval) => void>();
export const onReopen = (fn: (card: Approval) => void) => { reopenListeners.add(fn); };
const DECISIONS_FILE = join(TB_DIR, 'approval-decisions.jsonl');
// One line for each decision, Dismiss and Undo by the user or the controller: approvals.json keeps only the last 100 closed cards.
function audit(x: Approval, event: string, origin?: DecisionOrigin, ageMs?: number) {
  try { appendFileSync(DECISIONS_FILE, JSON.stringify({ at: new Date().toISOString(), event, card: x.id, action: x.action, actor: x.actor, state: x.state, by: x.decidedBy?.by, ageMs, origin }) + '\n'); } catch { /* disk full */ }
}
// the time since the card appeared, or since the server last changed it in place
export const cardAge = (x: Pick<Approval, 'created' | 'updated' | 'reopened'>, now = Date.now()) => Math.max(0, now - Date.parse(x.reopened?.at || x.updated || x.created));
const version = (a: Pick<Approval, 'action' | 'target' | 'covers' | 'payload' | 'detail'>) =>
  createHash('sha256').update(JSON.stringify([a.action, a.target, a.covers, a.payload, a.detail])).digest('hex').slice(0, 12);
const prune = () => {
  const closed = [...items.values()].filter(x => x.state !== 'pending' && x.state !== 'running');
  for (const x of closed.slice(0, Math.max(0, closed.length - 100))) items.delete(x.id);
};
const save = () => { prune(); try { writeFileSync(FILE, JSON.stringify([...items.values()], null, 2)); } catch { /* disk full */ } };
const emit = () => { save(); listeners.forEach(f => f()); };

// load the saved approvals; their actions (closures) did not survive the restart
try {
  for (const x of JSON.parse(readFileSync(FILE, 'utf8')) as Approval[]) {
    if (x.state === 'pending') { x.state = 'expired'; x.result = 'Taskboard restarted before you decided. Nothing was run; ask again.'; }
    if (x.state === 'running') { x.state = 'unknown'; x.result = 'Taskboard restarted while this was running. It may or may not have happened; check before asking again.'; }
    items.set(x.id, x);
  }
} catch { /* first start */ }

export function request(a: Omit<Approval, 'id' | 'created' | 'state' | 'returnable' | 'decidedBy'>, run: Runner,
  more: { giveBack?: (comment: string) => Promise<string>; onDeny?: () => void; check?: () => Promise<string | undefined>; onReopen?: () => void } = {}): Approval {
  if ([...items.values()].filter(x => x.state === 'pending' || x.state === 'running').length >= 100) throw new Error('Too many open approval cards. Decide older cards first.');
  const target = a.target || a.summary;
  const old = [...items.values()].find(x => x.state === 'pending' && x.actor === a.actor && x.action === a.action && (x.target || x.summary) === target);
  const x: Approval = old || { ...a, id: randomUUID().slice(0, 8), created: new Date().toISOString(), state: 'pending' };
  Object.assign(x, a, { target, version: a.version || version(a), validUntil: a.validUntil || 'until the facts change', ...(old ? { updated: new Date().toISOString(), staleFacts: undefined } : {}), ...(more.giveBack ? { returnable: true } : {}) });
  items.set(x.id, x); runners.set(x.id, run);
  if (more.giveBack) returners.set(x.id, more.giveBack);
  if (more.onDeny) deniers.set(x.id, more.onDeny);
  if (more.check) checkers.set(x.id, more.check);
  if (more.onReopen) reopeners.set(x.id, more.onReopen);
  emit(); return x;
}
const forget = (id: string) => { runners.delete(id); returners.delete(id); deniers.delete(id); checkers.delete(id); reopeners.delete(id); };
// Keep the actions of a denied card for UNDO_MS, then forget them.
function hold(id: string) {
  clearTimeout(held.get(id)?.timer);
  const timer = setTimeout(() => held.delete(id), UNDO_MS); timer.unref?.();
  held.set(id, { run: runners.get(id), back: returners.get(id), deny: deniers.get(id), check: checkers.get(id), reopen: reopeners.get(id), timer });
}
// Why Undo cannot reopen this card now, or undefined when it can.
export function undoBlocked(x: Approval, now = Date.now()): string | undefined {
  if (x.state !== 'denied') return 'Only a denied card can be reopened.';
  if (x.decidedBy?.by !== 'user') return 'Only a denial by the user can be undone.';
  if (NO_UNDO[x.action]) return NO_UNDO[x.action];
  if (now - Date.parse(x.decidedBy.at) > UNDO_MS) return 'Undo is possible for 60 seconds after the denial. Ask the task to request it again.';
  if (!held.has(x.id)) return 'Taskboard restarted after the denial, so the card cannot be reopened. Ask the task to request it again.';
  return undefined;
}
// Why a pending card no longer matches what it would run, or undefined. Only merge and push cards have a check.
export const stale = async (id: string) => { try { return await checkers.get(id)?.(); } catch (e) { return e instanceof Error ? e.message : String(e); } };
// Send a pending card back to the agent with the user's comment.
export async function giveBack(id: string, comment: string): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  const back = returners.get(id); if (!back) throw new Error('This card cannot be sent back.');
  x.state = 'running'; forget(id); emit();
  try { x.result = await back(comment); x.state = 'returned'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); decided(x); return x;
}
// Close a pending card without running it, because the decision was made somewhere else.
export function close(id: string, state: 'approved' | 'denied' | 'expired', result: string) {
  const x = items.get(id); if (!x || x.state !== 'pending') return;
  x.state = state; x.result = result; forget(id); emit(); decided(x);
}
export function startExternal(id: string, d?: Decider) {
  const x = items.get(id); if (!x || x.state !== 'pending') return false;
  x.state = 'running'; if (d) x.decidedBy = { ...d, at: new Date().toISOString() }; forget(id); emit(); return true;
}
export function finishExternal(id: string, state: 'approved' | 'failed', result: string) {
  const x = items.get(id); if (!x || x.state !== 'running') return;
  x.state = state; x.result = result; emit(); decided(x);
}
export async function decide(id: string, approve: boolean, d: Decider = { by: 'user' }, origin?: DecisionOrigin): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  const ageMs = cardAge(x);
  const by = { ...d, at: new Date().toISOString(), ...(origin ? { origin } : {}), ageMs };
  if (!approve) {
    // a refused-command card has nothing to deny: it is dismissed (dismiss below)
    if (x.action === 'tool-refusal') return dismiss(id, origin);
    deniers.get(id)?.(); hold(id);
    x.state = 'denied'; x.result = 'Denied by the user.'; x.decidedBy = by;
    if (NO_UNDO[x.action]) x.noUndo = NO_UNDO[x.action]; else x.undoUntil = new Date(Date.now() + UNDO_MS).toISOString();
    forget(id); audit(x, 'deny', origin, ageMs); emit(); decided(x); return x;
  }
  const changed = await stale(id);
  if (changed) { x.staleFacts = changed; x.updated = new Date().toISOString(); emit(); return x; }
  const run = runners.get(id);
  if (!run) { x.state = 'expired'; x.result = 'This approval can no longer run.'; emit(); decided(x); return x; }
  x.state = 'running'; x.decidedBy = by; forget(id); audit(x, 'approve', origin, ageMs); emit(); // from here on, no second decision is accepted
  try { x.result = await run(d); x.state = 'approved'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); decided(x); return x;
}
// Close a refused-command card without a decision. The task gets no message (index.ts onDecision skips this state).
export function dismiss(id: string, origin?: DecisionOrigin): Approval | undefined {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  if (x.action !== 'tool-refusal') throw new Error('Only a refused-command card can be dismissed. Decide this card with its own buttons.');
  const ageMs = cardAge(x);
  x.state = 'dismissed'; x.result = DISMISSED_RESULT; x.decidedBy = { by: 'user', at: new Date().toISOString(), ...(origin ? { origin } : {}), ageMs };
  forget(id); audit(x, 'dismiss', origin, ageMs); emit(); decided(x); return x;
}
// Reopen a card that the user denied less than UNDO_MS ago. Nothing ran on a denial. The kind's own state (a permit or a
// push record) waits again through its onReopen action. index.ts tells the task (onReopen listeners).
export function undo(id: string, origin?: DecisionOrigin): Approval {
  const x = items.get(id); if (!x) throw new Error('No such card.');
  const blocked = undoBlocked(x); if (blocked) throw new Error(blocked);
  const h = held.get(id)!; clearTimeout(h.timer); held.delete(id);
  if (h.run) runners.set(id, h.run);
  if (h.back) returners.set(id, h.back);
  if (h.deny) deniers.set(id, h.deny);
  if (h.check) checkers.set(id, h.check);
  if (h.reopen) { reopeners.set(id, h.reopen); h.reopen(); }
  const at = new Date().toISOString();
  x.state = 'pending'; x.result = undefined; x.decidedBy = undefined; x.undoUntil = undefined; x.noUndo = undefined;
  // updated makes the dashboard show the card again as an arrival (web/src/stack.ts arrivals)
  x.reopened = { at, ...(origin ? { origin } : {}) }; x.updated = at;
  audit(x, 'undo', origin); emit();
  for (const fn of reopenListeners) fn(x);
  return x;
}
export const get = (id: string) => items.get(id);
export function setNotify(id: string, enabled: boolean) {
  const card = items.get(id); if (!card || card.state !== 'pending') return;
  card.notifyMe = enabled; emit(); return card;
}
export const count = () => items.size;
// pending first, then the last decided
export const all = () => [...items.values()].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.created.localeCompare(a.created)).slice(0, 30);
export const open = () => [...items.values()].filter(x => x.state === 'pending');
export const running = () => [...items.values()].filter(x => x.state === 'running');
export const pendingCount = () => [...items.values()].filter(x => x.state === 'pending').length;
export const pendingFor = (actor: string) => [...items.values()].filter(x => x.actor === actor && x.state === 'pending');
export const hasRefusal = (actor: string, toolId: string) => [...items.values()].some(x => x.actor === actor && x.action === 'tool-refusal' && (x.payload as any)?.id === toolId);
