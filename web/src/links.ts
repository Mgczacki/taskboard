// Links between tasks, as the views show them (the server rules are in server/links.ts).
// Each task carries the links it holds (Task.links) and a summary from the server (Task.link). The other direction is
// computed here from the task list, so a view needs no extra request.
import type { LinkKind, Task, TaskLink } from './api';

export interface LinkRow {
  dir: 'out' | 'in';   // out: the task holds the link · in: another task holds a link to it
  link: TaskLink;
  owner: string;       // the task that holds the link
  other: string;       // the task at the other end
  open: boolean;       // dependsOn only: the link still blocks
  label: string;       // the section heading of the row
  movedFrom?: string;  // a dependency on a task that this task replaced
}

const OUT_LABEL: Record<LinkKind, string> = { dependsOn: 'Blocked by', replaces: 'Replaces', followUpOf: 'Follow-up of', relatedTo: 'Related to' };
const IN_LABEL: Record<LinkKind, string> = { dependsOn: 'Waited on by', replaces: 'Replaced by', followUpOf: 'Followed up by', relatedTo: 'Related to' };
// the order of the sections in a card
export const SECTION_ORDER = ['Blocked by', 'Waited on by', 'Replaced by', 'Folded into', 'Replaces', 'Follow-up of', 'Followed up by', 'Related to', 'Depended on (done)', 'Waited on by (done)'];

const byId = (tasks: Task[]) => new Map(tasks.map(t => [t.id, t]));

// The task that does the work of a task now: follows replaces links to the newest replacing task.
export function current(id: string, tasks: Task[]): string {
  const seen = new Set<string>();
  let at = id;
  while (!seen.has(at)) {
    seen.add(at);
    const by = tasks.flatMap(t => (t.links || []).filter(l => l.kind === 'replaces' && l.to === at).map(l => ({ t, l }))).sort((a, b) => b.l.at.localeCompare(a.l.at))[0];
    if (!by) break;
    at = by.t.id;
  }
  return at;
}

export function depOpen(l: TaskLink, tasks: Task[]): boolean {
  if (l.kind !== 'dependsOn' || l.doneAt) return false;
  const t = byId(tasks).get(current(l.to, tasks));
  return !!t && t.status !== 'archived';
}

export function linkRows(t: Task, tasks: Task[]): LinkRow[] {
  const out = (t.links || []).map(link => {
    const open = depOpen(link, tasks);
    const label = link.kind === 'dependsOn' && !open ? 'Depended on (done)' : OUT_LABEL[link.kind];
    return { dir: 'out' as const, link, owner: t.id, other: link.kind === 'dependsOn' && open ? current(link.to, tasks) : link.to, open, label };
  });
  // a dependency on a replaced task belongs to the task that replaced it, so the replaced task does not list it
  const inc = tasks.filter(x => x.id !== t.id).flatMap(x => (x.links || []).filter(l => l.to === t.id && !(l.kind === 'dependsOn' && depOpen(l, tasks) && current(t.id, tasks) !== t.id)).map(link => {
    const open = depOpen(link, tasks);
    const label = link.kind === 'dependsOn' && !open ? 'Waited on by (done)' : link.kind === 'replaces' && link.folded ? 'Folded into' : IN_LABEL[link.kind];
    return { dir: 'in' as const, link, owner: x.id, other: x.id, open, label };
  }));
  // dependencies on a task that this task replaced now wait on this task
  const moved = tasks.filter(x => x.id !== t.id).flatMap(x => (x.links || []).filter(l => l.kind === 'dependsOn' && l.to !== t.id && depOpen(l, tasks) && current(l.to, tasks) === t.id)
    .map(link => ({ dir: 'in' as const, link, owner: x.id, other: x.id, open: true, label: IN_LABEL.dependsOn, movedFrom: link.to })));
  return [...out, ...inc, ...moved];
}

export function sections(rows: LinkRow[]): [string, LinkRow[]][] {
  return SECTION_ORDER.map(s => [s, rows.filter(r => r.label === s)] as [string, LinkRow[]]).filter(([, r]) => r.length);
}

// One day after the last blocker of a ready task was archived or marked done, the views stop showing "ready".
export function recentlyReady(t: Task, tasks: Task[], now = Date.now()): boolean {
  if (t.link?.state !== 'ready') return false;
  const map = byId(tasks);
  const times = (t.links || []).filter(l => l.kind === 'dependsOn').map(l => l.doneAt || map.get(current(l.to, tasks))?.statusAt || '').filter(Boolean);
  const last = Math.max(...times.map(x => Date.parse(x)));
  return Number.isFinite(last) && now - last < 24 * 3600 * 1000;
}

// Windows and rows in link order: a task comes after the open tasks that block it, and a replaced task after the task
// that replaces it. Tasks without such links keep their order.
export function linkOrder<T extends Task>(list: T[], tasks: Task[]): T[] {
  const ids = new Set(list.map(t => t.id));
  const before = new Map<string, string[]>(list.map(t => [t.id, []]));
  for (const t of list) {
    for (const l of t.links || []) {
      if (l.kind === 'dependsOn' && depOpen(l, tasks)) { const b = current(l.to, tasks); if (ids.has(b) && b !== t.id) before.get(t.id)!.push(b); }
      if (l.kind === 'replaces' && ids.has(l.to)) before.get(l.to)!.push(t.id);
    }
  }
  const out: T[] = [], done = new Set<string>(), visiting = new Set<string>();
  const visit = (t: T) => {
    if (done.has(t.id) || visiting.has(t.id)) return;
    visiting.add(t.id);
    for (const b of before.get(t.id) || []) { const bt = list.find(x => x.id === b); if (bt) visit(bt); }
    visiting.delete(t.id); done.add(t.id); out.push(t);
  };
  list.forEach(visit);
  return out;
}

// Indentation for a tree by links: a task is under the first open task that blocks it (mode 'deps') or under the task
// that started it (mode 'parent'), when that task is in the same list.
export function treeDepth<T extends Task>(list: T[], tasks: Task[], mode: 'deps' | 'parent'): { t: T; depth: number; also: string[] }[] {
  const ids = new Set(list.map(t => t.id));
  const parentOf = (t: Task): { p?: string; also: string[] } => {
    if (mode === 'parent') return { p: t.parent && ids.has(t.parent) ? t.parent : undefined, also: [] };
    const bl = (t.links || []).filter(l => l.kind === 'dependsOn' && depOpen(l, tasks)).map(l => current(l.to, tasks)).filter(b => ids.has(b) && b !== t.id);
    return { p: bl[0], also: bl.slice(1) };
  };
  const kids = new Map<string, T[]>(), roots: T[] = [];
  const info = new Map(list.map(t => [t.id, parentOf(t)]));
  for (const t of list) { const p = info.get(t.id)!.p; if (p) (kids.get(p) || kids.set(p, []).get(p)!).push(t); else roots.push(t); }
  const out: { t: T; depth: number; also: string[] }[] = [], seen = new Set<string>();
  const walk = (t: T, depth: number) => { if (seen.has(t.id)) return; seen.add(t.id); out.push({ t, depth, also: info.get(t.id)!.also }); (kids.get(t.id) || []).forEach(k => walk(k, depth + 1)); };
  roots.forEach(r => walk(r, 0));
  list.forEach(t => walk(t, 0)); // tasks in a cycle of parents
  return out;
}

// How many open tasks wait on a task, directly or through other tasks (Triage rule 1).
export function waitingCount(t: Task, tasks: Task[]): number {
  const map = byId(tasks), seen = new Set<string>();
  const walk = (id: string) => { for (const w of map.get(id)?.link?.waitedOnBy || []) if (!seen.has(w)) { seen.add(w); walk(w); } };
  walk(t.id);
  return seen.size;
}

export const isReplaced = (t: Task) => t.link?.state === 'superseded';

// Opens the linked work overview from any view (App.tsx listens).
export function showLinkedWork(q: { task?: string; group?: string }) { window.dispatchEvent(new CustomEvent('tb-linked-work', { detail: q })); }

// The linked sets of a list of tasks: tasks joined by links or by a parent that is a task (not the controller).
// Tasks without any link or task parent are left out.
export function linkedSets<T extends Task>(list: T[]): T[][] {
  const ids = new Set(list.map(t => t.id));
  const up = new Map<string, string>(list.map(t => [t.id, t.id]));
  const root = (x: string): string => { let r = x; while (up.get(r) !== r) r = up.get(r)!; up.set(x, r); return r; };
  const join = (a: string, b: string) => { if (ids.has(a) && ids.has(b)) up.set(root(a), root(b)); };
  const linked = new Set<string>();
  for (const t of list) {
    for (const l of t.links || []) if (ids.has(l.to)) { join(t.id, l.to); linked.add(t.id); linked.add(l.to); }
    if (t.parent && t.parent !== 'controller' && ids.has(t.parent)) { join(t.id, t.parent); linked.add(t.id); linked.add(t.parent); }
  }
  const sets = new Map<string, T[]>();
  for (const t of list) if (linked.has(t.id)) { const r = root(t.id); (sets.get(r) || sets.set(r, []).get(r)!).push(t); }
  return [...sets.values()];
}

// The task that names a linked set: the one with the most links and task parents inside the set (then the lowest number).
export function setLead<T extends Task>(set: T[]): T {
  const ids = new Set(set.map(t => t.id));
  const degree = new Map(set.map(t => [t.id, 0]));
  const bump = (a: string, b: string) => { if (ids.has(a) && ids.has(b)) { degree.set(a, degree.get(a)! + 1); degree.set(b, degree.get(b)! + 1); } };
  for (const t of set) { for (const l of t.links || []) bump(t.id, l.to); if (t.parent) bump(t.id, t.parent); }
  return [...set].sort((a, b) => degree.get(b.id)! - degree.get(a.id)! || a.num - b.num)[0];
}
