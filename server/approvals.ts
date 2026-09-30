// Requests from agents (through `tb`) that act on other agents — start, type into, set aside, archive — wait here
// until you approve them on the dashboard. This does not depend on the agent's own permission mode.
// States: pending → running → approved | failed, or pending → denied. Deciding only works on a pending approval, so
// a second click or a late Deny cannot run the action twice or contradict it. Approvals are saved to
// TB_DIR/approvals.json; after a restart, a pending one is marked expired (nothing ran) and a running one unknown.
// Message cards (mail-in, mail-out) are made again from mail.json after a restart (server/mail/cards.ts). They can also
// be sent back with a comment (pending → returned), and close when the message is decided in the Inbox.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export interface Approval {
  id: string; actor: string; action: 'new' | 'send' | 'status' | 'kill' | 'move' | 'release' | 'git-merge' | 'git-push' | 'tool-refusal' | 'permit' | 'mail-in' | 'mail-out'; summary: string; detail: string;
  created: string; state: 'pending' | 'running' | 'approved' | 'denied' | 'failed' | 'expired' | 'unknown' | 'returned'; result?: string; payload: unknown;
  // the card has a comment box and Send back
  returnable?: boolean;
}
const FILE = join(TB_DIR, 'approvals.json');
const items = new Map<string, Approval>();
const runners = new Map<string, () => Promise<string>>();
const returners = new Map<string, (comment: string) => Promise<string>>();
const deniers = new Map<string, () => void>();
const listeners = new Set<() => void>();
export const onApprovalsChange = (fn: () => void) => { listeners.add(fn); };
const save = () => { try { writeFileSync(FILE, JSON.stringify([...items.values()].slice(-100), null, 2)); } catch { /* disk full */ } };
const emit = () => { save(); listeners.forEach(f => f()); };

// load the saved approvals; their actions (closures) did not survive the restart
try {
  for (const x of JSON.parse(readFileSync(FILE, 'utf8')) as Approval[]) {
    if (x.state === 'pending') { x.state = 'expired'; x.result = 'Taskboard restarted before you decided. Nothing was run; ask again.'; }
    if (x.state === 'running') { x.state = 'unknown'; x.result = 'Taskboard restarted while this was running. It may or may not have happened; check before asking again.'; }
    items.set(x.id, x);
  }
} catch { /* first start */ }

export function request(a: Omit<Approval, 'id' | 'created' | 'state' | 'returnable'>, run: () => Promise<string>,
  more: { giveBack?: (comment: string) => Promise<string>; onDeny?: () => void } = {}): Approval {
  const x: Approval = { ...a, id: randomUUID().slice(0, 8), created: new Date().toISOString(), state: 'pending', ...(more.giveBack ? { returnable: true } : {}) };
  items.set(x.id, x); runners.set(x.id, run);
  if (more.giveBack) returners.set(x.id, more.giveBack);
  if (more.onDeny) deniers.set(x.id, more.onDeny);
  emit(); return x;
}
const forget = (id: string) => { runners.delete(id); returners.delete(id); deniers.delete(id); };
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
export function startExternal(id: string) {
  const x = items.get(id); if (!x || x.state !== 'pending') return false;
  x.state = 'running'; forget(id); emit(); return true;
}
export function finishExternal(id: string, state: 'approved' | 'failed', result: string) {
  const x = items.get(id); if (!x || x.state !== 'running') return;
  x.state = state; x.result = result; emit();
}
export async function decide(id: string, approve: boolean): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  if (!approve) { deniers.get(id)?.(); x.state = 'denied'; x.result = 'Denied by the user.'; forget(id); emit(); return x; }
  const run = runners.get(id);
  if (!run) { x.state = 'expired'; x.result = 'This approval can no longer run.'; emit(); return x; }
  x.state = 'running'; forget(id); emit(); // from here on, no second decision is accepted
  try { x.result = await run(); x.state = 'approved'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); return x;
}
export const get = (id: string) => items.get(id);
// pending first, then the last decided
export const all = () => [...items.values()].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.created.localeCompare(a.created)).slice(0, 30);
export const pendingFor = (actor: string) => [...items.values()].filter(x => x.actor === actor && x.state === 'pending');
export const hasRefusal = (actor: string, toolId: string) => [...items.values()].some(x => x.actor === actor && x.action === 'tool-refusal' && (x.payload as any)?.id === toolId);
