// Dismissed items of the Waiting page. A dismiss hides one waiting item from the Waiting page, the notification stack,
// the count badges, the Canvas and task panel marker and triage. It does not change the task status (Set aside does).
// Each entry keeps the signature of the item. While the item has the same signature, it stays hidden. When something
// new happens for the item (a new question, a new document version, a new status or text), its signature changes and
// the item shows again. The signatures:
//   - question card (pending.ts): the source, the task id and pending.ts signatureOf (agent, kind, question, command,
//     option labels). The item id is not used for screen cards: a screen card gets a new id when the terminal size
//     changes. A held Claude hook card also has its item id, so a new hook request for the same tool is a new item.
//   - task row (a task that waits with no card): the task id, the status, the waiting text (ask or stopReason), the
//     status time, and for the status review the pending document and its version (taskSignature).
// A held Claude hook card blocks the agent until an answer. Its dismiss lasts HOOK_MS only, and it never answers the
// hook or releases the hold. pending.ts is not changed by a dismiss.
// State: ~/.taskboard/dismissed.json, so every dashboard window and the Mac app agree, and a restart keeps them.
// Limits: MAX entries, MAX_AGE_MS, and an entry whose item is gone for GONE_MS is dropped (prune).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Dismissal {
  sig: string; kind: 'item' | 'task'; taskId: string; taskNum: number; title: string; question: string;
  label: string;            // the kind on the card, for example "Permission" or "Needs you"
  at: string;               // when the user dismissed it
  until?: string;           // a held hook card: the time it shows again
  goneSince?: string;       // the first prune that did not find the item
}

export const HOOK_MS = 10 * 60_000;
export const MAX = 300;
export const MAX_AGE_MS = 30 * 24 * 3600_000;
export const GONE_MS = 2 * 60_000;

let file = '';
let entries: Dismissal[] = [];
const listeners = new Set<() => void>();
export const onDismissChange = (fn: () => void) => { listeners.add(fn); };
let timer: NodeJS.Timeout | undefined;

export function load(dir: string) {
  file = join(dir, 'dismissed.json');
  try { entries = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).entries || []) : []; } catch { entries = []; }
  schedule();
}
function save() {
  if (file) { try { writeFileSync(file + '.tmp', JSON.stringify({ entries }, null, 1)); renameSync(file + '.tmp', file); } catch { /* the next change writes again */ } }
  schedule();
  listeners.forEach(f => f());
}
// a held hook card shows again at its `until` time: tell the listeners then
function schedule() {
  clearTimeout(timer);
  const next = entries.map(e => e.until ? Date.parse(e.until) : Infinity).filter(t => t > Date.now()).sort((a, b) => a - b)[0];
  if (next !== undefined && next !== Infinity) timer = setTimeout(() => { entries = entries.filter(e => !expired(e)); save(); }, Math.min(next - Date.now() + 50, 2 ** 31 - 1));
}

const expired = (e: Dismissal, now = Date.now()) => !!e.until && Date.parse(e.until) <= now;
export const all = (now = Date.now()) => entries.filter(e => !expired(e, now));
export const isDismissed = (sig: string | undefined, now = Date.now()) => !!sig && entries.some(e => e.sig === sig && !expired(e, now));
export const entryFor = (sig: string | undefined, now = Date.now()) => sig ? entries.find(e => e.sig === sig && !expired(e, now)) : undefined;

export function dismiss(e: Omit<Dismissal, 'at' | 'until' | 'goneSince'>, hold: boolean, now = Date.now()): Dismissal {
  const entry: Dismissal = { ...e, question: e.question.slice(0, 400), at: new Date(now).toISOString(), ...(hold ? { until: new Date(now + HOOK_MS).toISOString() } : {}) };
  entries = [entry, ...entries.filter(x => x.sig !== e.sig)].slice(0, MAX);
  save();
  return entry;
}
export function bringBack(sig: string): boolean {
  const n = entries.length;
  entries = entries.filter(e => e.sig !== sig);
  if (entries.length === n) return false;
  save(); return true;
}

// `live`: the signatures of every item that waits now (question cards and task rows). Drops entries older than
// MAX_AGE_MS, expired hook entries, and entries whose item was missing for GONE_MS. The grace time keeps an entry
// while a screen card is read again (after a terminal resize or a restart of Taskboard).
export function prune(live: Set<string>, now = Date.now()) {
  let changed = false;
  const keep: Dismissal[] = [];
  for (const e of entries) {
    if (expired(e, now) || now - Date.parse(e.at) > MAX_AGE_MS) { changed = true; continue; }
    if (live.has(e.sig)) { if (e.goneSince) { delete e.goneSince; changed = true; } keep.push(e); continue; }
    if (!e.goneSince) { e.goneSince = new Date(now).toISOString(); changed = true; keep.push(e); continue; }
    if (now - Date.parse(e.goneSince) > GONE_MS) { changed = true; continue; }
    keep.push(e);
  }
  if (keep.length > MAX) { keep.splice(MAX); changed = true; }
  if (changed) { entries = keep; save(); }
}

// ---------- signatures ----------
export const itemSignature = (i: { source: string; taskId: string; id: string }, signature: string) =>
  ['item', i.source, i.taskId, i.source === 'claude-hook' ? i.id : '', signature].join('\u0000');
export const taskSignature = (t: { id: string; status: string; ask?: string; stopReason?: string; statusAt: string }, review?: { id: string; version: number }) =>
  ['task', t.id, t.status, (t.ask || t.stopReason || '').slice(0, 300), t.statusAt, review ? `${review.id}@v${review.version}` : ''].join('\u0000');

// for tests
export const reset = () => { entries = []; file = ''; clearTimeout(timer); };

// The tasks that wait on the user but have nothing to show: their task row is dismissed, or each of their question
// cards is dismissed. The count badges and the Mac app's Dock badge leave them out. The task status does not change.
export function quietTasks(tasks: { id: string; waitSig?: string }[], items: { taskId: string; dismissed?: unknown }[], now = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    const mine = items.filter(i => i.taskId === t.id);
    if (isDismissed(t.waitSig, now) || (mine.length && mine.every(i => i.dismissed))) out.add(t.id);
  }
  return out;
}
