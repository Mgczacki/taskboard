// Requests from agents (through `tb`) that act on other agents — start, type into, set aside, archive — wait here
// until you approve them on the dashboard. This does not depend on the agent's own permission mode.
// States: pending → running → approved | failed, or pending → denied. Deciding only works on a pending approval, so
// a second click or a late Deny cannot run the action twice or contradict it. Approvals are saved to
// TB_DIR/approvals.json; after a restart, a pending one is marked expired (nothing ran) and a running one unknown.
// Message cards (mail-in, mail-out) are made again from A2A Notes after a restart (server/a2anotes/cards.ts). They can also
// be sent back with a comment (pending → returned), and close when the message is decided in the Inbox.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import type { AllowOffer } from './allow-rules.ts';

export interface Approval {
  id: string; actor: string; action: 'new' | 'send' | 'status' | 'kill' | 'move' | 'release' | 'restart' | 'git-merge' | 'git-push' | 'tool-refusal' | 'permit' | 'scope' | 'mail-in' | 'mail-out'; summary: string; detail: string;
  created: string; state: 'pending' | 'running' | 'approved' | 'denied' | 'failed' | 'expired' | 'unknown' | 'returned'; result?: string; payload: unknown;
  // the card has a comment box and Send back
  returnable?: boolean;
  // a "type into" card from one task to another: the card offers Allow always with these choices (allow-rules.ts)
  allow?: AllowOffer;
  // who approved or denied the card. The controller approves only on the user's request in its chat
  // (server/controller-approve.ts); userRequest holds the user's exact message.
  decidedBy?: Decider & { at: string };
}
export interface Decider { by: 'user' | 'controller'; userRequest?: string }
// The action of a card. It gets who approved it, so a message to the task can say so.
export type Runner = (d: Decider) => Promise<string>;
const FILE = join(TB_DIR, 'approvals.json');
const items = new Map<string, Approval>();
const runners = new Map<string, Runner>();
// for a merge or a push card: the reason why the card no longer matches the branch, or undefined
const checkers = new Map<string, () => Promise<string | undefined>>();
const returners = new Map<string, (comment: string) => Promise<string>>();
const deniers = new Map<string, () => void>();
const listeners = new Set<() => void>();
export const onApprovalsChange = (fn: () => void) => { listeners.add(fn); };
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
  more: { giveBack?: (comment: string) => Promise<string>; onDeny?: () => void; check?: () => Promise<string | undefined> } = {}): Approval {
  if ([...items.values()].filter(x => x.state === 'pending' || x.state === 'running').length >= 100) throw new Error('Too many open approval cards. Decide older cards first.');
  const x: Approval = { ...a, id: randomUUID().slice(0, 8), created: new Date().toISOString(), state: 'pending', ...(more.giveBack ? { returnable: true } : {}) };
  items.set(x.id, x); runners.set(x.id, run);
  if (more.giveBack) returners.set(x.id, more.giveBack);
  if (more.onDeny) deniers.set(x.id, more.onDeny);
  if (more.check) checkers.set(x.id, more.check);
  emit(); return x;
}
const forget = (id: string) => { runners.delete(id); returners.delete(id); deniers.delete(id); checkers.delete(id); };
// Why a pending card no longer matches what it would run, or undefined. Only merge and push cards have a check.
export const stale = async (id: string) => { try { return await checkers.get(id)?.(); } catch (e) { return e instanceof Error ? e.message : String(e); } };
// Send a pending card back to the agent with the user's comment.
export async function giveBack(id: string, comment: string): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  const back = returners.get(id); if (!back) throw new Error('This card cannot be sent back.');
  x.state = 'running'; forget(id); emit();
  try { x.result = await back(comment); x.state = 'returned'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); return x;
}
// Close a pending card without running it, because the decision was made somewhere else.
export function close(id: string, state: 'approved' | 'denied' | 'expired', result: string) {
  const x = items.get(id); if (!x || x.state !== 'pending') return;
  x.state = state; x.result = result; forget(id); emit();
}
export function startExternal(id: string, d?: Decider) {
  const x = items.get(id); if (!x || x.state !== 'pending') return false;
  x.state = 'running'; if (d) x.decidedBy = { ...d, at: new Date().toISOString() }; forget(id); emit(); return true;
}
export function finishExternal(id: string, state: 'approved' | 'failed', result: string) {
  const x = items.get(id); if (!x || x.state !== 'running') return;
  x.state = state; x.result = result; emit();
}
export async function decide(id: string, approve: boolean, d: Decider = { by: 'user' }): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  if (!approve) { deniers.get(id)?.(); x.state = 'denied'; x.result = 'Denied by the user.'; x.decidedBy = { by: 'user', at: new Date().toISOString() }; forget(id); emit(); return x; }
  const run = runners.get(id);
  if (!run) { x.state = 'expired'; x.result = 'This approval can no longer run.'; emit(); return x; }
  x.state = 'running'; x.decidedBy = { ...d, at: new Date().toISOString() }; forget(id); emit(); // from here on, no second decision is accepted
  try { x.result = await run(d); x.state = 'approved'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); return x;
}
export const get = (id: string) => items.get(id);
export const count = () => items.size;
// pending first, then the last decided
export const all = () => [...items.values()].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.created.localeCompare(a.created)).slice(0, 30);
export const open = () => [...items.values()].filter(x => x.state === 'pending');
export const running = () => [...items.values()].filter(x => x.state === 'running');
export const pendingCount = () => [...items.values()].filter(x => x.state === 'pending').length;
export const pendingFor = (actor: string) => [...items.values()].filter(x => x.actor === actor && x.state === 'pending');
export const hasRefusal = (actor: string, toolId: string) => [...items.values()].some(x => x.actor === actor && x.action === 'tool-refusal' && (x.payload as any)?.id === toolId);
