// Requests from agents (through `tb`) that act on other agents — start, type into, set aside, archive — wait here
// until you approve them on the dashboard. This does not depend on the agent's own permission mode.
// States: pending → running → approved | failed, or pending → denied. Deciding only works on a pending approval, so
// a second click or a late Deny cannot run the action twice or contradict it. Approvals are saved to
// TB_DIR/approvals.json; after a restart, a pending one is marked expired (nothing ran) and a running one unknown.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';

export interface Approval {
  id: string; actor: string; action: 'new' | 'send' | 'status' | 'kill' | 'move'; summary: string; detail: string;
  created: string; state: 'pending' | 'running' | 'approved' | 'denied' | 'failed' | 'expired' | 'unknown'; result?: string; payload: unknown;
}
const FILE = join(TB_DIR, 'approvals.json');
const items = new Map<string, Approval>();
const runners = new Map<string, () => Promise<string>>();
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

export function request(a: Omit<Approval, 'id' | 'created' | 'state'>, run: () => Promise<string>): Approval {
  const x: Approval = { ...a, id: randomUUID().slice(0, 8), created: new Date().toISOString(), state: 'pending' };
  items.set(x.id, x); runners.set(x.id, run); emit(); return x;
}
export async function decide(id: string, approve: boolean): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  if (!approve) { x.state = 'denied'; x.result = 'Denied by the user.'; runners.delete(id); emit(); return x; }
  const run = runners.get(id);
  if (!run) { x.state = 'expired'; x.result = 'This approval can no longer run.'; emit(); return x; }
  x.state = 'running'; runners.delete(id); emit(); // from here on, no second decision is accepted
  try { x.result = await run(); x.state = 'approved'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  emit(); return x;
}
export const get = (id: string) => items.get(id);
// pending first, then the last decided
export const all = () => [...items.values()].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.created.localeCompare(a.created)).slice(0, 30);
export const pendingFor = (actor: string) => [...items.values()].filter(x => x.actor === actor && x.state === 'pending');
