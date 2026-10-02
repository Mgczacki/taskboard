// Links between tasks: dependsOn, replaces, followUpOf and relatedTo (types in store.ts).
// A link is saved in the frontmatter of the task that holds it (Task.links). The other direction is computed here from
// all tasks, so there is one copy of each link. Links connect tasks on this Taskboard server only.
//
// Computed state of a task (not saved):
// - done: the task is archived
// - superseded: another task has a replaces link to it
// - blocked: it has a dependsOn link that is not done
// - ready: it has dependsOn links and all of them are done
// A dependsOn link is done when someone marked it done (tb dep done), when its task is archived or removed, or, when
// another task replaced its task, when that replacing task is archived.
//
// Side effects:
// - a replaces link parks the replaced task (unless it is parked or archived) and tells it in its inbox
// - when a task becomes ready, Taskboard tells it and the controller in their inboxes
import { randomBytes } from 'node:crypto';
import * as docs from './docs.ts';
import * as store from './store.ts';
import type { LinkActor, LinkKind, Task, TaskLink } from './store.ts';

export type { LinkActor, LinkKind, TaskLink };
export type LinkState = 'done' | 'superseded' | 'blocked' | 'ready';
export const KINDS: LinkKind[] = ['dependsOn', 'replaces', 'followUpOf', 'relatedTo'];
const NOTE_MAX = 500;

// Who sent a request: tb sends x-tb-actor with TASK_ID ('controller' for the controller); the dashboard and tb in your
// own terminal send none, which is you.
export function actorFrom(header: string | undefined): LinkActor {
  const id = header || '';
  if (!id) return { actor: 'user' };
  if (id === 'controller') return { actor: 'controller' };
  if (!store.get(id)) throw new Error(`Unknown task ${id}.`);
  return { actor: 'task', task: id };
}

// A task id, a number (166) or #166.
export function resolve(ref: string): Task {
  const s = String(ref || '').trim();
  const t = store.get(s) || store.all().find(x => x.role !== 'controller' && String(x.num) === s.replace(/^#/, ''));
  if (!t || t.role === 'controller') throw new Error(s.includes('~') ? `${s} is a task on another machine. Links connect tasks on one Taskboard server only.` : `No task ${s}.`);
  return t;
}

const label = (t: Task | undefined, id: string) => t ? `#${t.num}` : id;
const live = () => store.all().filter(t => t.role !== 'controller');

// Every link that points to a task, with the task that holds it.
export function incoming(id: string): { from: string; link: TaskLink }[] {
  return live().flatMap(t => (t.links || []).filter(l => l.to === id).map(link => ({ from: t.id, link })));
}

// The task that now does the work of a task: follows replaces links to the newest replacing task.
export function current(id: string): string {
  const seen = new Set<string>();
  let at = id;
  while (!seen.has(at)) {
    seen.add(at);
    const by = incoming(at).filter(x => x.link.kind === 'replaces').sort((a, b) => b.link.at.localeCompare(a.link.at))[0];
    if (!by) break;
    at = by.from;
  }
  return at;
}

export function depDone(link: TaskLink): boolean {
  if (link.doneAt) return true;
  const t = store.get(current(link.to));
  return !t || t.status === 'archived';
}

export function replacedBy(id: string): string | undefined {
  return incoming(id).filter(x => x.link.kind === 'replaces').sort((a, b) => b.link.at.localeCompare(a.link.at))[0]?.from;
}

export function state(t: Task): LinkState | undefined {
  if (t.status === 'archived') return 'done';
  if (replacedBy(t.id)) return 'superseded';
  const deps = (t.links || []).filter(l => l.kind === 'dependsOn');
  if (!deps.length) return undefined;
  return deps.every(depDone) ? 'ready' : 'blocked';
}

// The short form that goes with each task to the dashboard. Empty when the task has no links in either direction.
export interface LinkInfo { state?: LinkState; blockedBy?: string[]; waitedOnBy?: string[]; replacedBy?: string; count: number }
export function info(t: Task): LinkInfo | undefined {
  const inc = incoming(t.id);
  const count = (t.links || []).length + inc.length;
  if (!count) return undefined;
  const blockedBy = (t.links || []).filter(l => l.kind === 'dependsOn' && !depDone(l)).map(l => current(l.to));
  const waitedOnBy = live().filter(x => x.status !== 'archived' && (x.links || []).some(l => l.kind === 'dependsOn' && !depDone(l) && current(l.to) === t.id)).map(x => x.id);
  const r: LinkInfo = { count };
  const s = state(t); if (s) r.state = s;
  if (blockedBy.length) r.blockedBy = [...new Set(blockedBy)];
  if (waitedOnBy.length) r.waitedOnBy = waitedOnBy;
  const rb = replacedBy(t.id); if (rb) r.replacedBy = rb;
  return r;
}

// Every task that one can reach from a task through links and task parents, in either direction. The controller as a
// parent does not join tasks. Suggestions are not links, so they join nothing.
export function linkedSet(id: string): string[] {
  const tasks = live();
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    const t = store.get(at);
    const next = [
      ...(t?.links || []).map(l => l.to),
      ...incoming(at).map(x => x.from),
      ...(t?.parent && t.parent !== 'controller' ? [t.parent] : []),
      ...tasks.filter(x => x.parent === at).map(x => x.id),
    ];
    for (const n of next) if (store.get(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return [...seen];
}

// true when `from` already depends on `to`, directly or through other tasks (a new link to → from would be a cycle)
function dependsOnPath(from: string, to: string): boolean {
  const seen = new Set<string>();
  const walk = (at: string): boolean => {
    if (at === to) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    return (store.get(at)?.links || []).some(l => l.kind === 'dependsOn' && walk(l.to));
  };
  return walk(from);
}

function cleanNote(note: unknown): string | undefined {
  if (note === undefined || note === null || note === '') return undefined;
  const s = String(note).replace(/\s+/g, ' ').trim();
  if (s.length > NOTE_MAX) throw new Error(`The note is longer than ${NOTE_MAX} characters.`);
  return s || undefined;
}

function tell(taskId: string, name: string, text: string) {
  if (!store.get(taskId)) return;
  try { docs.uploadSystem(taskId, name, text); } catch (e) { console.error('could not write the link notice', e); }
}

export interface NewLink { kind: LinkKind; to: string; note?: string; folded?: boolean }

export function add(fromRef: string, input: NewLink, by: LinkActor): TaskLink {
  const from = resolve(fromRef), to = resolve(input.to);
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new Error(`The link type must be one of: ${KINDS.join(', ')}.`);
  if (from.id === to.id) throw new Error('A task cannot have a link to itself.');
  if (by.actor === 'task') {
    if (by.task !== from.id) throw new Error(`A task can add links only on itself. Ask the controller or the user to add a link on #${from.num}.`);
    if (kind === 'replaces') throw new Error('A task cannot add a replaces link, because it parks the other task. Tell the user or the controller.');
  }
  if (input.folded && kind !== 'replaces') throw new Error('--folded goes only with a replaces link.');
  const note = cleanNote(input.note);
  const own = from.links || [];
  if (own.some(l => l.kind === kind && l.to === to.id)) throw new Error(`#${from.num} already has a ${kind} link to #${to.num}.`);
  if (kind === 'relatedTo' && (to.links || []).some(l => l.kind === 'relatedTo' && l.to === from.id)) throw new Error(`#${to.num} is already related to #${from.num}.`);
  if (kind === 'replaces' && (to.links || []).some(l => l.kind === 'replaces' && l.to === from.id)) throw new Error(`#${to.num} already replaces #${from.num}.`);
  if (kind === 'dependsOn' && dependsOnPath(to.id, from.id)) throw new Error(`#${to.num} already depends on #${from.num}. The new link would make a cycle.`);
  const link: TaskLink = {
    id: randomBytes(4).toString('hex'), kind, to: to.id, at: new Date().toISOString(), by,
    ...(note ? { note } : {}), ...(kind === 'replaces' && input.folded ? { folded: true } : {}),
  };
  store.update(from.id, { links: [...own, link] });
  if (kind === 'replaces') {
    const old = store.get(to.id)!;
    if (!['parked', 'archived'].includes(old.status))
      store.update(old.id, { status: 'parked', statusSource: `Parked because #${from.num} replaces it.` });
    tell(old.id, `replaced-by-${from.num}.md`, [
      `# #${from.num} replaces this task`, '',
      `#${from.num} ${from.title} now ${input.folded ? 'does the work of this task' : 'replaces this task'}.`,
      ...(note ? ['', `Note: ${note}`] : []), '',
      'Taskboard parked this task. Only the user archives it. Do not continue this work unless the user asks.', '',
    ].join('\n'));
  } else store.touch(to.id);
  return link;
}

export function remove(fromRef: string, linkId: string, by: LinkActor): TaskLink {
  const from = resolve(fromRef);
  const link = (from.links || []).find(l => l.id === linkId);
  if (!link) throw new Error(`#${from.num} has no link ${linkId}.`);
  if (by.actor === 'task' && (by.task !== from.id || link.kind === 'replaces')) throw new Error('A task can remove only its own links, and not a replaces link.');
  store.update(from.id, { links: (from.links || []).filter(l => l.id !== linkId) });
  store.touch(link.to);
  return link;
}

export function markDone(fromRef: string, linkId: string, by: LinkActor, note?: string): TaskLink {
  const from = resolve(fromRef);
  const link = (from.links || []).find(l => l.id === linkId);
  if (!link) throw new Error(`#${from.num} has no link ${linkId}.`);
  if (link.kind !== 'dependsOn') throw new Error('Only a dependsOn link can be marked done.');
  if (by.actor === 'task' && by.task !== from.id) throw new Error('A task can mark only its own links as done.');
  if (link.doneAt) return link;
  const before = state(from);
  const doneNote = cleanNote(note);
  const updated: TaskLink = { ...link, doneAt: new Date().toISOString(), doneBy: by, ...(doneNote ? { doneNote } : {}) };
  store.update(from.id, { links: (from.links || []).map(l => l.id === linkId ? updated : l) });
  store.touch(link.to);
  const t = store.get(from.id)!;
  if (before === 'blocked' && state(t) === 'ready') tellReady(t, `The link to ${label(store.get(link.to), link.to)} was marked done${doneNote ? `: ${doneNote}` : '.'}`);
  return updated;
}

// The links of one task in both directions, with what the dashboard and tb deps show for each.
export function detail(ref: string) {
  const t = resolve(ref);
  const brief = (id: string) => { const x = store.get(id); return x ? { id, num: x.num, title: x.title, status: x.status } : { id, num: 0, title: id, status: 'removed' }; };
  return {
    task: brief(t.id),
    state: state(t),
    out: (t.links || []).map(l => ({ ...l, task: brief(l.to), ...(l.kind === 'dependsOn' ? { done: depDone(l), now: brief(current(l.to)) } : {}) })),
    in: incoming(t.id).map(x => ({ ...x.link, from: brief(x.from), ...(x.link.kind === 'dependsOn' ? { done: depDone(x.link) } : {}) })),
    parent: t.parent && t.parent !== 'controller' ? brief(t.parent) : t.parent,
    children: live().filter(x => x.parent === t.id).map(x => brief(x.id)),
    set: linkedSet(t.id).map(brief),
  };
}

export function all() {
  return live().flatMap(t => (t.links || []).map(l => ({ from: t.id, ...l, ...(l.kind === 'dependsOn' ? { done: depDone(l) } : {}) })));
}

function tellReady(t: Task, why: string) {
  const text = [`# #${t.num} is no longer blocked`, '', why, '', `No dependsOn link of #${t.num} ${t.title} is open now.`, ''].join('\n');
  tell(t.id, `unblocked-${Date.now()}.md`, text);
  tell('controller', `unblocked-${t.num}-${Date.now()}.md`, text);
}

// When a task is archived, the tasks that waited on it may become ready. The listener compares the new status with the
// last status it saw, so repeated changes of an archived task do not repeat the notice.
const lastStatus = new Map<string, Task['status']>();
let started = false;
export function start() {
  if (started) return;
  started = true;
  for (const t of store.all()) lastStatus.set(t.id, t.status);
  store.onTaskChange(t => {
    const before = lastStatus.get(t.id);
    lastStatus.set(t.id, t.status);
    if (before === t.status || (before !== 'archived' && t.status !== 'archived')) return;
    // The waiting tasks show a new state on the dashboard in both directions (archived and restored).
    const waiting = live().filter(x => x.id !== t.id && (x.links || []).some(l => l.kind === 'dependsOn' && current(l.to) === t.id));
    for (const x of waiting) {
      store.touch(x.id);
      if (t.status === 'archived' && x.status !== 'archived' && state(x) === 'ready') tellReady(x, `#${t.num} ${t.title} is archived.`);
    }
  });
  store.onTaskRemoved(id => lastStatus.delete(id));
}
