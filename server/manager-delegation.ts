import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as groups from './groups.ts';
import * as store from './store.ts';
import * as managerRole from './manager-role.ts';
import * as approvals from './approvals.ts';
import * as controllerApprove from './controller-approve.ts';
import * as permits from './permits.ts';
import * as checkins from './manager-checkins.ts';
import * as board from './waiting-board.ts';

export const KINDS = ['new', 'send', 'status', 'kill', 'move', 'release', 'restart', 'git-merge', 'git-push', 'force-push', 'github-pr', 'github-pr-merge', 'github-pr-ready', 'tool-refusal', 'permit', 'external', 'plan', 'scope', 'mail-in', 'mail-out'] as const;
export type Kind = typeof KINDS[number];
export const WARNINGS: Record<string, string> = {
  'force-push': 'A force push can replace remote commits and remove work from a shared branch.',
  release: 'A Taskboard release can replace the running server and affect every task.',
  restart: 'A Taskboard restart can interrupt the dashboard and every task.',
  'production-write': 'High-risk commands can write production databases or change remote systems. Taskboard cannot fully classify these effects.',
  'github-pr': 'Opening a pull request sends code and text to GitHub and can start remote workflows.',
  'github-pr-merge': 'Merging a pull request changes a remote branch and can deploy code.',
  'tool-refusal': 'A refused tool call can only be dismissed. This switch cannot override the agent permission check.',
};
export interface Delegation { enabled: boolean; kinds: Kind[]; dangerous: string[] }
export const settings = (g: groups.Group): Delegation => g.delegation || { enabled: false, kinds: [], dangerous: [] };
export function configure(g: groups.Group, value: unknown, confirm = false) {
  const x = value as Delegation;
  if (!x || typeof x.enabled !== 'boolean' || !Array.isArray(x.kinds) || !x.kinds.every(k => KINDS.includes(k)) ||
      !Array.isArray(x.dangerous) || !x.dangerous.every(k => Object.hasOwn(WARNINGS, k))) throw new Error('Choose known card kinds and dangerous switches.');
  if (x.enabled && x.dangerous.length && !confirm) throw new Error('Read and accept the dangerous warnings first.');
  return groups.update(g.id, { delegation: { enabled: x.enabled, kinds: [...new Set(x.kinds)], dangerous: [...new Set(x.dangerous)] } })!;
}
export function revoke(group?: string) {
  const targets = groups.all().filter(g => !group || g.id === group);
  // Revoke every group in memory before writing. A failed write must not leave another group enabled.
  for (const g of targets) g.delegation = { ...settings(g), enabled: false };
  const errors: string[] = [];
  for (const g of targets) try { groups.update(g.id, { delegation: g.delegation }); } catch (e) { errors.push((e as Error).message); }
  if (errors.length) throw new Error(`Delegation is off in memory. Could not save every group: ${errors.join('. ')}`);
  return targets;
}
export const kindOf = (a: approvals.Approval): Kind => a.action === 'git-push' && (a.payload as { state?: { forcePush?: boolean } })?.state?.forcePush ? 'force-push' : a.action;
export const cardHead = (a: approvals.Approval) => controllerApprove.headOf(a) || (() => {
  const p = a.payload as { state?: { headCommit?: string; head?: string } } | undefined;
  return p?.state?.headCommit ? { head: p.state.headCommit, branch: p.state.head || '', range: '' } : undefined;
})();
// A plan lists child cards. Their versions must be part of the version the manager reads.
export function versionOf(a: approvals.Approval, seen = new Set<string>()): string {
  if (seen.has(a.id)) throw new Error('The plan contains a cycle.');
  seen.add(a.id);
  if (a.action !== 'plan') return controllerApprove.versionOf(a);
  const steps = (a.payload as { steps?: { card: string }[] })?.steps || [];
  return createHash('sha256').update(JSON.stringify([controllerApprove.versionOf(a), steps.map(s => {
    const child = approvals.get(s.card);
    return child ? [s.card, versionOf(child, new Set(seen))] : [s.card, null];
  })])).digest('hex').slice(0, 12);
}

export function groupFor(actor: string, group: string, target: string) {
  const g = managerRole.roles(actor).find(g => g.id === group);
  if (!g || store.get(actor)?.role === 'controller') throw new Error('This task is not the live manager of this group.');
  if (actor === target) throw new Error('A manager cannot decide its own task.');
  const t = store.get(target);
  if (!t || t.role === 'controller' || t.status === 'archived' || !g.tasks.includes(target)) throw new Error('The target is outside the live tasks of this group.');
  return g;
}
// A card can act on tasks other than its owner. Every named task must remain inside the group.
export function check(actor: string, group: string, a: approvals.Approval, seen = new Set<string>(), approve = true) {
  if (seen.has(a.id)) throw new Error('The plan contains a cycle.');
  seen.add(a.id);
  const g = groupFor(actor, group, a.actor);
  const d = settings(g), kind = kindOf(a);
  if (!d.enabled || !d.kinds.includes(kind)) throw new Error('Delegation is off for this card kind. Mario must decide.');
  if (WARNINGS[kind] && !d.dangerous.includes(kind)) throw new Error(`The separate dangerous switch for ${kind} is off.`);
  const p = a.payload as Record<string, any> | undefined;
  if (p?.managerArchive?.group && p.managerArchive.group !== g.id) throw new Error('The archive request names another group.');
  if (['send', 'status', 'kill', 'move'].includes(a.action) && !a.affectedTasks?.length && !p?.to && !p?.managerArchive)
    throw new Error('This card does not name its affected tasks. Ask for a new card.');
  const targets = [...(a.affectedTasks || []), ...(a.unblocks || []), p?.to, p?.from, p?.task, p?.taskId, p?.managerArchive?.target, p?.proposal?.task,
    ...(Array.isArray(p?.tasks) ? p.tasks : []), ...(Array.isArray(p?.links) ? p.links.map((l: any) => l.to) : [])];
  for (const target of targets) if (typeof target === 'string' && target) {
    const t = store.get(target) || store.all().find(t => String(t.num) === target.replace(/^#/, ''));
    if (!t) throw new Error('A task named on this card no longer exists.');
    groupFor(actor, group, t.id);
  }
  if (a.action === 'new' && ![g.id, g.name].includes(p?.group)) throw new Error('The new task must name this group.');
  if (a.action === 'permit' || a.action === 'external') {
    const permit = permits.get(p?.permitId || '');
    if (!permit || permit.taskId !== a.actor) throw new Error('The permit no longer belongs to this task.');
    const task = store.get(a.actor)!;
    if (permits.classify(permit.steps, task) === 'high' && !d.dangerous.includes('production-write'))
      throw new Error('High-risk permits require the production-write dangerous switch.');
  }
  if (approve && ['mail-in', 'mail-out'].includes(a.action) && ['held', 'checking'].includes(p?.stage)) throw new Error('The mail checks have not passed.');
  if (approve && (a.action === 'kill' || (a.action === 'status' && p?.status === 'archived'))) for (const target of a.affectedTasks || []) {
    const task = store.get(target)!;
    checkins.canArchive(task, board.waitFor(task));
  }
  if (a.action === 'plan') for (const step of p?.steps || []) {
    if (step.askAgain) continue;
    const child = approvals.get(String(step.card));
    if (!child) throw new Error('A plan card no longer exists.');
    check(actor, group, child, new Set(seen), approve);
  }
  return g;
}
export interface AuditRow {
  at: string; group: string; manager: string; card: string | null; kind: string; task: string;
  head: string | null; decision: string; reason: string; state: string;
}
const file = join(TB_DIR, 'manager-decisions.jsonl');
export const audit = (row: Omit<AuditRow, 'at'>) => appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
export function auditRows(group?: string): AuditRow[] {
  let lines: string[];
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  return lines.filter(Boolean).map(l => JSON.parse(l) as AuditRow).filter(r => !group || r.group === group);
}

export async function decide(actor: string, group: string, a: approvals.Approval, input: { version: string; head?: string; reason: string; approve: boolean }, head: string | null = null) {
  check(actor, group, a, new Set(), input.approve);
  if (!input.reason?.trim() || input.reason.length > 2000) throw new Error('Give a reason under 2000 characters.');
  if (a.state !== 'pending' || input.version !== versionOf(a)) throw new Error('The card changed. List the cards again.');
  const h = cardHead(a);
  if (input.approve && h && !controllerApprove.sameHead(input.head || '', h.head)) throw new Error('Give the branch head shown on the card.');
  const expiry = controllerApprove.expiryOf(a, permits.get((a.payload as any)?.permitId || '')?.expiresAt).expired;
  if (input.approve && expiry) throw new Error(expiry);
  const version = versionOf(a);
  if (input.approve) {
    const changed = await approvals.stale(a.id);
    if (changed) throw new Error(changed);
  }
  const authorize = () => {
    check(actor, group, a, new Set(), input.approve);
    if (a.state !== 'pending' || version !== versionOf(a)) throw new Error('The card changed during its checks.');
    const expired = controllerApprove.expiryOf(a, permits.get((a.payload as any)?.permitId || '')?.expiresAt).expired;
    if (input.approve && expired) throw new Error(expired);
  };
  authorize();
  const row = { group, manager: actor, card: a.id, kind: kindOf(a), task: a.actor, head: h?.head || head,
    decision: a.action === 'tool-refusal' ? 'dismiss' : input.approve ? 'approve' : 'deny', reason: input.reason.trim() };
  audit({ ...row, state: 'requested' });
  const d: approvals.Decider = { by: 'manager', manager: actor, group, reason: input.reason.trim() };
  try {
    const result = a.action === 'tool-refusal' ? approvals.dismiss(a.id, undefined, d)
      : await approvals.decide(a.id, input.approve, d, undefined, authorize);
    audit({ ...row, state: result?.state || 'missing' });
    return result;
  } catch (e) {
    audit({ ...row, state: `refused: ${(e as Error).message}` });
    throw e;
  }
}
