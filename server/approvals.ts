// Requests from the controller agent that act on other agents (start, type into, park, archive) wait here
// until you approve them on the dashboard. This does not depend on Claude Code's permission mode.
import { randomUUID } from 'node:crypto';

export interface Approval {
  id: string; actor: string; action: 'new' | 'send' | 'status' | 'kill'; summary: string; detail: string;
  created: string; state: 'pending' | 'approved' | 'denied' | 'failed'; result?: string; payload: unknown;
}
const items = new Map<string, Approval>();
const runners = new Map<string, () => Promise<string>>();
const listeners = new Set<() => void>();
export const onApprovalsChange = (fn: () => void) => { listeners.add(fn); };
const emit = () => listeners.forEach(f => f());

export function request(a: Omit<Approval, 'id' | 'created' | 'state'>, run: () => Promise<string>): Approval {
  const x: Approval = { ...a, id: randomUUID().slice(0, 8), created: new Date().toISOString(), state: 'pending' };
  items.set(x.id, x); runners.set(x.id, run); emit(); return x;
}
export async function decide(id: string, approve: boolean): Promise<Approval | undefined> {
  const x = items.get(id); if (!x || x.state !== 'pending') return x;
  if (!approve) { x.state = 'denied'; x.result = 'Denied by the user.'; emit(); return x; }
  try { x.result = await runners.get(id)!(); x.state = 'approved'; } catch (e) { x.state = 'failed'; x.result = e instanceof Error ? e.message : String(e); }
  runners.delete(id); emit(); return x;
}
export const get = (id: string) => items.get(id);
// pending first, then the last 20 decided
export const all = () => [...items.values()].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.created.localeCompare(a.created)).slice(0, 30);
export const pendingFor = (actor: string) => [...items.values()].filter(x => x.actor === actor && x.state === 'pending');
