// The notices of one task in the task panel (NoticeStrip.tsx), and the saved fold state of the task panel header.
// A notice is one line in the strip above the tabs. The strip shows one notice at a time, most urgent first (errors,
// then warnings, then information), and oldest first within the same level. Notices of the same kind are one item with
// a count: two failed messages from Taskboard are "Not delivered ×2". The list is made again from the task on each
// update, so a notice that is no longer true (a message that was delivered, a question that was answered) goes away.
// An information notice (autoHide) hides itself after AUTO_HIDE_MS or at the next click. The LOG tab lists the notices
// that the panel showed in this browser session (noticeHistory).
import type { Approval, PendingItem, QueuedMessage, Task } from './api';
import { fmtWait } from './api';
import { queueReason } from './components/QueuedMessage';
import { autoText, errorDetail } from './agentErrorText';

export type NoticeLevel = 'error' | 'warn' | 'info';
export type NoticeKind = 'agent-error' | 'message' | 'inbox' | 'question' | 'card' | 'stopped' | 'restart-failed' | 'resumed' | 'error' | 'hook-note' | 'drop' | 'imported';
export interface TaskNotice {
  key: string; // stable: the same notice keeps its key while the task changes
  kind: NoticeKind; level: NoticeLevel;
  title: string; reason: string; full: string; // one line each; full is the whole text behind "more"
  at: string; // the oldest time of the item (ISO), for the order
  count: number;
  ids: string[]; // queued message ids, question card ids or approval ids of the item
  autoHide?: boolean;
}
export const AUTO_HIDE_MS = 10_000;
const RANK: Record<NoticeLevel, number> = { error: 0, warn: 1, info: 2 };
export const LEVEL_WORD: Record<NoticeLevel, string> = { error: 'Error', warn: 'Warning', info: 'Information' };

const WHAT = { message: 'Message', review: 'Review feedback', permit: 'Permit result', inbox: 'Inbox notice' } as const;
const ageOf = (iso: string, now: number) => fmtWait(Math.max(0, Math.round((now - Date.parse(iso)) / 60000)));
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clock = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

// The status text that a hook writes when it gave queued messages to the agent (server/message-queue.ts takeForHook)
export const isHookNote = (s?: string) => !!s && /queued messages? (was|were) given to the agent by the .* hook/.test(s);

export interface NoticeInput {
  t: Pick<Task, 'id' | 'num' | 'status' | 'statusAt' | 'statusSource' | 'stopReason' | 'queue' | 'interrupted' | 'restartFailed' | 'imported' | 'errorLabel' | 'agentError' | 'autoContinueOn'>;
  pending?: PendingItem[]; // question cards of this task
  approvals?: Approval[]; // waiting approval cards of this task
  error?: string; // the last error of a panel button
  drop?: string; // the result of files dropped on the panel
  autoMessage?: string; // the auto-continue message (Settings), for the text of a model error
  now?: number;
}

export function taskNotices({ t, pending = [], approvals = [], error, drop, autoMessage = 'continue', now = Date.now() }: NoticeInput): TaskNotice[] {
  const out: TaskNotice[] = [];
  // queued and failed messages: one item for each state, kind and sender
  const groups = new Map<string, QueuedMessage[]>();
  for (const q of t.queue || []) {
    const state = q.kind === 'inbox' ? 'inbox' : q.state === 'failed' ? 'failed' : q.late ? 'late' : 'queued';
    const k = `${state}|${q.kind}|${q.from}`;
    groups.set(k, [...(groups.get(k) || []), q]);
  }
  for (const [k, list] of groups) {
    const [state] = k.split('|'), q = list[0], n = list.length;
    const times = n > 1 ? ` ×${n}` : '';
    const head = state === 'failed' ? 'Not delivered' : state === 'late' ? `Not delivered after ${ageOf(q.queued, now)}` : state === 'inbox' ? 'Inbox file not told yet' : 'Queued';
    out.push({
      key: `q:${k}`, kind: state === 'inbox' ? 'inbox' : 'message', level: state === 'failed' ? 'error' : state === 'late' ? 'warn' : 'info',
      title: `${head}${times} · ${state === 'inbox' ? 'from Taskboard' : `${WHAT[q.kind]} from ${q.from}`}`,
      reason: oneLine(queueReason(list[n - 1])),
      full: list.map(x => `${clock(x.queued)} · ${queueReason(x)}${x.text ? `\nStart of the message: ${oneLine(x.text).slice(0, 200)}` : ''}`).join('\n\n'),
      at: list.map(x => x.queued).sort()[0], count: n, ids: list.map(x => x.id),
    });
  }
  if (pending.length) {
    const first = pending[0], q = oneLine(first.question);
    out.push({ key: 'question', kind: 'question', level: 'warn', title: `Waits for your answer${pending.length > 1 ? ` ×${pending.length}` : ''}`, reason: q, full: pending.map(p => oneLine(p.question)).join('\n'), at: first.createdAt, count: pending.length, ids: pending.map(p => p.id) });
  }
  for (const a of approvals) {
    const refused = a.action === 'tool-refusal';
    out.push({ key: `a:${a.id}`, kind: 'card', level: 'warn', title: refused ? 'Refused command' : 'Waits for your approval', reason: oneLine(a.summary), full: a.detail || a.summary, at: a.created, count: 1, ids: [a.id] });
  }
  // a model or API error (task 278): stopped needs you; working means the agent retries or Taskboard continued it
  const modelError = !!(t.errorLabel && t.agentError);
  if (modelError && t.status === 'stopped') {
    const e = t.agentError!, detail = errorDetail(e), auto = autoText(t, autoMessage);
    out.push({ key: `agent-error:${e.at || e.seen}`, kind: 'agent-error', level: 'error', title: t.errorLabel!, reason: oneLine(`${detail} ${auto}`), full: `${detail}${auto ? `\n\n${auto}` : ''}`, at: e.at || e.seen || t.statusAt, count: 1, ids: [] });
  } else if (modelError && t.status === 'working') {
    const e = t.agentError!, what = e.phase === 'retrying' ? 'The agent retries by itself. Nothing to do.' : 'Taskboard continued the agent after the error.';
    out.push({ key: `agent-error:${e.at || e.seen}:${e.phase}`, kind: 'agent-error', level: 'info', title: t.errorLabel!, reason: oneLine(`${errorDetail(e)} ${what}`), full: `${errorDetail(e)}\n\n${what}`, at: e.at || e.seen || t.statusAt, count: 1, ids: [] });
  }
  if (t.status === 'stopped' && !modelError) {
    const why = (t.stopReason || 'Stopped').replace(/\.$/, '');
    out.push({ key: `stopped:${t.statusAt}`, kind: 'stopped', level: 'error', title: why, reason: 'The agent is not working.', full: `${why}. The agent is not working.`, at: t.statusAt, count: 1, ids: [] });
  }
  if (t.restartFailed) out.push({ key: `restart:${t.restartFailed}`, kind: 'restart-failed', level: 'error', title: 'The restart failed', reason: oneLine(t.restartFailed), full: t.restartFailed, at: t.statusAt, count: 1, ids: [] });
  if (error) out.push({ key: `error:${error}`, kind: 'error', level: 'error', title: 'The last action failed', reason: oneLine(error), full: error, at: new Date(now).toISOString(), count: 1, ids: [] });
  if (t.interrupted && t.status !== 'suspended') out.push({ key: `resumed:${t.interrupted}`, kind: 'resumed', level: 'warn', title: 'Resumed', reason: oneLine(t.interrupted), full: t.interrupted, at: t.statusAt, count: 1, ids: [] });
  if (isHookNote(t.statusSource)) out.push({ key: `hook:${t.statusSource}`, kind: 'hook-note', level: 'info', title: 'Delivered by hook', reason: t.statusSource!, full: t.statusSource!, at: t.statusAt, count: 1, ids: [], autoHide: true });
  if (drop) out.push({ key: `drop:${drop}`, kind: 'drop', level: 'info', title: 'Files dropped', reason: oneLine(drop), full: drop, at: new Date(now).toISOString(), count: 1, ids: [], autoHide: true });
  if (t.imported && t.status === 'suspended' && !error) out.push({ key: 'imported', kind: 'imported', level: 'info', title: 'Imported', reason: oneLine(t.imported), full: t.imported, at: t.statusAt, count: 1, ids: [], autoHide: true });
  return sortNotices(out);
}

export const sortNotices = (list: TaskNotice[]) => [...list].sort((a, b) => RANK[a.level] - RANK[b.level] || a.at.localeCompare(b.at));

// The index of the notice to show: the same key as before when it is still there, else the same position (the next
// one moves up when the shown one closes), else the first.
export function stripIndex(list: TaskNotice[], key: string | null, lastIndex = 0): number {
  if (!list.length) return 0;
  const i = list.findIndex(n => n.key === key);
  return i >= 0 ? i : Math.min(Math.max(0, lastIndex), list.length - 1);
}
// Notices for the count chip and the default fold state: an information notice that hides itself does not count
export const lasting = (list: TaskNotice[]) => list.filter(n => !n.autoHide);
export const countText = (list: TaskNotice[]) => { const n = list.reduce((s, x) => s + x.count, 0); return `${n} notice${n === 1 ? '' : 's'}`; };

// The notices that the panel showed in this browser session, for the LOG tab. Newest first, at most HISTORY_MAX each.
const HISTORY_MAX = 50;
const history = new Map<string, { key: string; at: string; title: string; reason: string }[]>();
export function rememberNotice(taskId: string, n: TaskNotice, now = Date.now()) {
  const list = history.get(taskId) || [];
  if (list.some(x => x.key === n.key)) return;
  history.set(taskId, [{ key: n.key, at: new Date(now).toISOString(), title: n.title, reason: n.reason }, ...list].slice(0, HISTORY_MAX));
}
export const noticeHistory = (taskId: string) => history.get(taskId) || [];
// information notices that hid themselves: they stay hidden while this page is open
const hiddenInfo = new Map<string, Set<string>>();
export const infoHidden = (taskId: string, key: string) => !!hiddenInfo.get(taskId)?.has(key);
export function hideInfo(taskId: string, keys: string[]) {
  const s = hiddenInfo.get(taskId) || new Set<string>();
  for (const k of keys) s.add(k);
  hiddenInfo.set(taskId, s);
}

// A path that fits in max characters: the start and the end, with … in the middle
export function middleEllipsis(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

// The fold state of the task panel header (the info section above the tabs), saved in this browser.
// - The default (Settings): 'auto' opens the info when the task waits on you or has a notice, 'open' always opens it,
//   'closed' always folds it.
// - A task that the user opened or folded keeps that choice (tb-task-info, at most INFO_MAX tasks).
export type InfoDefault = 'auto' | 'open' | 'closed';
const DEFAULT_KEY = 'tb-task-info-default', INFO_KEY = 'tb-task-info', INFO_MAX = 300;
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
export const infoDefault = (): InfoDefault => { const v = read(DEFAULT_KEY); return v === 'open' || v === 'closed' ? v : 'auto'; };
export const setInfoDefault = (v: InfoDefault) => write(DEFAULT_KEY, v);
const saved = (): Record<string, boolean> => { try { const o = JSON.parse(read(INFO_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
export function infoOpen(taskId: string, wants: { attention: boolean; notices: number }): boolean {
  const s = saved()[taskId];
  if (typeof s === 'boolean') return s;
  const d = infoDefault();
  return d === 'open' || (d === 'auto' && (wants.attention || wants.notices > 0));
}
export function setInfoOpen(taskId: string, open: boolean) {
  const s = saved();
  delete s[taskId]; s[taskId] = open; // the newest choice goes last, so the oldest ones go first over INFO_MAX
  const keys = Object.keys(s);
  for (const k of keys.slice(0, Math.max(0, keys.length - INFO_MAX))) delete s[k];
  write(INFO_KEY, JSON.stringify(s));
}
