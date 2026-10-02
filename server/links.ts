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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
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
// The lists below are computed from all tasks once after each change of a task (store.version), not once per call:
// a task list of 185 tasks called them about 900 times and took 50 ms (scripts/dashboard-load.mjs).
let cache: { v: number; live: Task[]; incoming: Map<string, { from: string; link: TaskLink }[]>; waitedOn?: Map<string, string[]> } | null = null;
function cached() {
  if (cache?.v === store.version()) return cache;
  const list = store.all().filter(t => t.role !== 'controller'), incoming = new Map<string, { from: string; link: TaskLink }[]>();
  for (const t of list) for (const link of t.links || []) { const l = incoming.get(link.to); if (l) l.push({ from: t.id, link }); else incoming.set(link.to, [{ from: t.id, link }]); }
  return (cache = { v: store.version(), live: list, incoming });
}
const live = () => cached().live;

// Every link that points to a task, with the task that holds it.
export function incoming(id: string): { from: string; link: TaskLink }[] {
  return cached().incoming.get(id) || [];
}
// the open tasks that wait on each task: an open dependsOn link to it, or to a task that it replaced
function waitedOn(id: string): string[] {
  const c = cached();
  if (!c.waitedOn) {
    const m = new Map<string, string[]>();
    for (const x of c.live) {
      if (x.status === 'archived') continue;
      const to = new Set((x.links || []).filter(l => l.kind === 'dependsOn' && !depDone(l)).map(l => current(l.to)));
      for (const id of to) { const l = m.get(id); if (l) l.push(x.id); else m.set(id, [x.id]); }
    }
    c.waitedOn = m;
  }
  return c.waitedOn.get(id) || [];
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
  const waitedOnBy = waitedOn(t.id);
  const r: LinkInfo = { count };
  const s = state(t); if (s) r.state = s;
  if (blockedBy.length) r.blockedBy = [...new Set(blockedBy)];
  if (waitedOnBy.length) r.waitedOnBy = [...waitedOnBy];
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

// atStart: the link goes on a task that the caller starts now (tb new --after and the like), so a task may add it.
export function add(fromRef: string, input: NewLink, by: LinkActor, opts: { atStart?: boolean } = {}): TaskLink {
  const from = resolve(fromRef), to = resolve(input.to);
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new Error(`The link type must be one of: ${KINDS.join(', ')}.`);
  if (from.id === to.id) throw new Error('A task cannot have a link to itself.');
  if (by.actor === 'task') {
    if (by.task !== from.id && !opts.atStart) throw new Error(`A task can add links only on itself. Ask the controller or the user to add a link on #${from.num}.`);
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

// tb new --after / --replaces / --follows / --related: checks the links before the task starts, and gives the lines
// for the prompt of the new task. The links are added with addAtStart once the task exists.
const START_LINE: Record<LinkKind, (t: Task) => string> = {
  dependsOn: t => `This task depends on #${t.num} (${t.title}). Taskboard tells you in your inbox when #${t.num} is done.`,
  replaces: t => `This task replaces #${t.num} (${t.title}). Read its log and outbox before you start. Taskboard parks #${t.num}.`,
  followUpOf: t => `This task continues the work of #${t.num} (${t.title}). Read its log and outbox before you start.`,
  relatedTo: t => `This task is related to #${t.num} (${t.title}).`,
};
export function planStart(input: unknown, by: LinkActor): { kind: LinkKind; to: string; folded?: boolean; line: string }[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('links must be a list of { kind, to }.');
  return input.map((x: any) => {
    const kind = x?.kind as LinkKind;
    if (!KINDS.includes(kind)) throw new Error(`The link type must be one of: ${KINDS.join(', ')}.`);
    if (kind === 'replaces' && by.actor === 'task') throw new Error('A task cannot start a task with --replaces, because it parks the other task. Tell the user or the controller.');
    const t = resolve(String(x?.to ?? ''));
    return { kind, to: t.id, ...(x?.folded === true && kind === 'replaces' ? { folded: true } : {}), line: START_LINE[kind](t) };
  });
}
export function addAtStart(newId: string, planned: { kind: LinkKind; to: string; folded?: boolean }[], by: LinkActor): string[] {
  const problems: string[] = [];
  for (const p of planned) {
    try { add(newId, { kind: p.kind, to: p.to, folded: p.folded }, by, { atStart: true }); }
    catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }
  return problems;
}

// One linked set as the overview and tb deps --all show it.
const WAITS: Task['status'][] = ['needs-you', 'stopped', 'review'];
export function summary(ids: string[]) {
  const tasks = ids.map(id => store.get(id)).filter((t): t is Task => !!t);
  const brief = (t: Task) => ({ id: t.id, num: t.num, title: t.title, status: t.status, state: state(t), ...(t.ask ? { ask: t.ask } : {}), ...(t.groups?.length ? { groups: t.groups } : {}) });
  const open = (t: Task) => t.status !== 'archived' && !replacedBy(t.id);
  // longest chain of open dependsOn links, in the order of the work: the first task must finish first
  const blockers = (t: Task) => (t.links || []).filter(l => l.kind === 'dependsOn' && !depDone(l)).map(l => store.get(current(l.to))).filter((x): x is Task => !!x && open(x));
  const memo = new Map<string, string[]>();
  const chainTo = (t: Task, seen = new Set<string>()): string[] => {
    if (memo.has(t.id)) return memo.get(t.id)!;
    if (seen.has(t.id)) return [t.id];
    seen.add(t.id);
    const best = blockers(t).map(b => chainTo(b, seen)).sort((a, b) => b.length - a.length)[0] || [];
    const c = [...best, t.id]; memo.set(t.id, c); return c;
  };
  const chain = tasks.filter(open).map(t => chainTo(t)).sort((a, b) => b.length - a.length)[0] || [];
  const replaced = tasks.filter(t => replacedBy(t.id));
  return {
    tasks: tasks.map(brief),
    counts: {
      waitsForYou: tasks.filter(t => open(t) && WAITS.includes(t.status)).length,
      blocked: tasks.filter(t => open(t) && state(t) === 'blocked').length,
      working: tasks.filter(t => open(t) && t.status === 'working').length,
      replaced: replaced.length,
      archived: tasks.filter(t => t.status === 'archived' && !replacedBy(t.id)).length,
      other: tasks.filter(t => open(t) && !WAITS.includes(t.status) && t.status !== 'working').length,
    },
    chain: chain.length > 1 ? chain : [],
    waiting: tasks.filter(t => open(t) && WAITS.includes(t.status)).map(t => ({ ...brief(t), blockedBy: blockers(t).map(b => b.id) })),
    replaced: replaced.map(t => ({ ...brief(t), by: replacedBy(t.id)! })),
    links: tasks.flatMap(t => (t.links || []).map(l => ({ from: t.id, ...l, ...(l.kind === 'dependsOn' ? { done: depDone(l) } : {}) }))),
  };
}

// The linked sets for a start: one task gives its own set; a list of tasks (a group) gives each set that contains one
// of them. Tasks of the list that have no links and no task parent or child are counted, not listed.
export function setsFor(ids: string[]) {
  const sets: string[][] = [];
  const placed = new Set<string>();
  let unlinked = 0;
  for (const id of ids) {
    if (placed.has(id) || !store.get(id)) continue;
    const set = linkedSet(id);
    set.forEach(x => placed.add(x));
    if (set.length === 1 && ids.length > 1) { unlinked++; continue; }
    sets.push(set);
  }
  return { sets: sets.map(summary), unlinked };
}

// Suggestions: links that the data Taskboard already has points to. They change nothing until someone confirms one
// (which adds the link) or dismisses it (saved in ~/.taskboard/link-suggestions-dismissed.json).
// - a task started by another task (parent): follow-up of that task
// - a document that one task sent to another (tb doc send): the receiver is a follow-up of the sender
// - two tasks with the same title: the newer task replaces the older one
// Only tasks that are not archived, and pairs with no link between them in either direction.
export interface Suggestion { from: string; to: string; kind: LinkKind; reason: string }
const dismissedFile = () => join(TB_DIR, 'link-suggestions-dismissed.json');
const sugKey = (s: { from: string; to: string; kind: string }) => `${s.from}|${s.to}|${s.kind}`;
function dismissed(): Set<string> { try { return new Set(JSON.parse(readFileSync(dismissedFile(), 'utf8'))); } catch { return new Set(); } }
export function dismiss(s: { from: string; to: string; kind: string }) {
  const d = dismissed(); d.add(sugKey(s));
  writeFileSync(dismissedFile(), JSON.stringify([...d], null, 2));
}
export function suggestions(): Suggestion[] {
  const tasks = live().filter(t => t.status !== 'archived');
  const byId = new Map(tasks.map(t => [t.id, t]));
  const linked = (a: string, b: string) => (byId.get(a)?.links || []).some(l => l.to === b) || (byId.get(b)?.links || []).some(l => l.to === a);
  const out = new Map<string, Suggestion>();
  const put = (from: string, to: string, kind: LinkKind, reason: string) => {
    if (from === to || !byId.has(from) || !byId.has(to) || linked(from, to)) return;
    const k = sugKey({ from, to, kind });
    const had = out.get(k);
    out.set(k, { from, to, kind, reason: had ? `${had.reason} ${reason}` : reason });
  };
  for (const t of tasks) if (t.parent && t.parent !== 'controller' && byId.has(t.parent)) put(t.id, t.parent, 'followUpOf', `#${byId.get(t.parent)!.num} started this task.`);
  for (const e of docs.edges()) if (byId.has(e.from)) put(e.to, e.from, 'followUpOf', `#${byId.get(e.from)!.num} sent it ${e.name}.`);
  const byTitle = new Map<string, Task[]>();
  for (const t of tasks) { const k = t.title.trim().toLowerCase(); if (k) (byTitle.get(k) || byTitle.set(k, []).get(k)!).push(t); }
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.num - b.num), newest = sorted[sorted.length - 1];
    for (const old of sorted.slice(0, -1)) put(newest.id, old.id, 'replaces', `Both tasks have the title “${newest.title}”.`);
  }
  const d = dismissed();
  return [...out.values()].filter(s => !d.has(sugKey(s)));
}
