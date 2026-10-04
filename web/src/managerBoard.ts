// The manager board of a group (GET /api/board, server/waiting-board.ts) and the Manager badge of a manager task.
// ManagerBoard.tsx draws them. This file holds the parts without React: the summary counts of the folded header,
// the open or closed state saved in this browser, the keys of the header, and the text of the badge tooltip.

export type BoardKey = 'needsYou' | 'waitingOther' | 'running' | 'free' | 'blocked';
// [column key, column title, word after the count in the folded header]
export const BOARD_COLUMNS: [BoardKey, string, string][] = [
  ['needsYou', 'Needs you', 'need you'], ['waitingOther', 'Waiting on other', 'waiting'], ['running', 'Running', 'running'],
  ['free', 'Free', 'free'], ['blocked', 'Blocked', 'blocked'],
];
export interface BoardRow { id: string; num: number; title: string; ageMinutes: number; source: string; now?: string; waitingOn?: { on: string; needs: string; reason: string; unblocks: string[] } }
export interface Heartbeat { pending: number; lastTurn: string | null; notResponding: boolean }
export interface Board { group: { id: string; name: string; manager?: string }; heartbeat?: Heartbeat; columns: Partial<Record<BoardKey, BoardRow[]>> }

// The folded header shows the age of the oldest wait only when it is older than this
export const OLD_WAIT_MINUTES = 60;

export function boardSummary(b: Board) {
  const counts = Object.fromEntries(BOARD_COLUMNS.map(([k]) => [k, b.columns[k]?.length || 0])) as Record<BoardKey, number>;
  // Running and Free rows do not wait for anything, so only the other three columns count for the oldest wait
  const ages = (['needsYou', 'waitingOther', 'blocked'] as const).flatMap(k => (b.columns[k] || []).map(r => r.ageMinutes));
  const oldest = ages.length ? Math.max(...ages) : 0;
  return { counts, oldestMinutes: oldest > OLD_WAIT_MINUTES ? oldest : null };
}

export const fmtAge = (m: number) => m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;

// The dot next to the folded header: has the manager read its events?
export function heartbeatState(h: Heartbeat | undefined): { state: 'ok' | 'pending' | 'down' | 'none'; text: string } {
  if (!h) return { state: 'none', text: 'No manager heartbeat yet.' };
  const last = h.lastTurn ? `Last manager update: ${new Date(h.lastTurn).toLocaleString()}.` : 'The manager has not updated yet.';
  const events = `${h.pending} ${h.pending === 1 ? 'event waits' : 'events wait'} for the manager.`;
  if (h.notResponding) return { state: 'down', text: `The manager does not respond. ${last} ${events}` };
  return { state: h.pending ? 'pending' : 'ok', text: `${last} ${events}` };
}

// Open or closed, saved in this browser: one value for each group, and a default for groups without a value.
// A storage that throws (private mode, blocked site data) counts as empty.
type KV = Pick<Storage, 'getItem' | 'setItem'>;
const browserStorage = (): KV | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
export const openKey = (group: string) => `tb-mboard-open:${group}`;
export const DEFAULT_OPEN_KEY = 'tb-mboard-default';
export const AUTO_OPEN_KEY = 'tb-mboard-auto-open';
const read = (s: KV | null, k: string) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const write = (s: KV | null, k: string, v: string) => { try { s?.setItem(k, v); } catch { /* storage off */ } };

export const readDefaultOpen = (s = browserStorage()) => read(s, DEFAULT_OPEN_KEY) === 'open';
export const saveDefaultOpen = (open: boolean, s = browserStorage()) => write(s, DEFAULT_OPEN_KEY, open ? 'open' : 'closed');
export function readOpen(group: string, s = browserStorage()) {
  const v = read(s, openKey(group));
  return v === 'open' ? true : v === 'closed' ? false : readDefaultOpen(s);
}
export const saveOpen = (group: string, open: boolean, s = browserStorage()) => write(s, openKey(group), open ? 'open' : 'closed');
// Settings: open the folded board by itself when the count of Needs you rows goes up (off by default)
export const readAutoOpen = (s = browserStorage()) => read(s, AUTO_OPEN_KEY) === 'on';
export const saveAutoOpen = (on: boolean, s = browserStorage()) => write(s, AUTO_OPEN_KEY, on ? 'on' : 'off');
export const shouldAutoOpen = (before: number, now: number, auto: boolean) => auto && now > before;

// The keys of the header button. The page calls preventDefault for each key that returns an action,
// so the browser does not also click the button.
export function headerKey(key: string, open: boolean): 'toggle' | 'close' | null {
  if (key === 'Enter' || key === ' ') return 'toggle';
  if (key === 'Escape' && open) return 'close';
  return null;
}

// Which tasks are managers. App.tsx calls setManagerGroups with each new group list. The badges read it.
export interface ManagerUsage { status?: string; newToday: number; working: number; messagesHour: number; stopsHour: number; mayNew: boolean; mayMessage: boolean; mayStop: boolean }
export interface ManagerInfo { group: string; name: string; manager: string; num?: number; caps: { newPerDay: number; working: number; messagesPerHour: number; stopsPerHour: number }; usage: ManagerUsage }
type GroupLike = { id: string; name: string; manager?: string };
let roles = new Map<string, GroupLike[]>();
let details = new Map<string, ManagerInfo>();
let version = 0, fetchedAt = 0, loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => { version++; listeners.forEach(f => f()); };
export const subscribeManagers = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const managersVersion = () => version;

export function setManagerGroups(groups: GroupLike[]) {
  const next = new Map<string, GroupLike[]>();
  for (const g of groups) if (g.manager) next.set(g.manager, [...next.get(g.manager) || [], g]);
  const sig = (m: Map<string, GroupLike[]>) => [...m].map(([id, l]) => id + ':' + l.map(g => g.id + '=' + g.name).join(',')).sort().join('|');
  if (sig(next) === sig(roles)) return;
  roles = next; changed();
}
export const managerGroupsOf = (taskId: string | undefined) => (taskId && roles.get(taskId)) || [];

// The caps and their use, read at most every 30 s, when a badge is shown or hovered
export function refreshManagerDetails(get: (url: string) => Promise<{ json(): Promise<unknown> }> = url => fetch(url)) {
  if (!roles.size || loading || Date.now() - fetchedAt < 30_000) return loading;
  loading = get('/api/managers').then(r => r.json()).then(list => {
    if (Array.isArray(list)) details = new Map((list as ManagerInfo[]).map(x => [x.group, x]));
    fetchedAt = Date.now(); changed();
  }).catch(() => { /* the badge keeps its old text */ }).finally(() => { loading = null; });
  return loading;
}
export const managerDetails = (group: string) => details.get(group);

const yes = (b: boolean) => b ? 'yes' : 'no';
export function badgeTitle(groups: GroupLike[], info: (group: string) => ManagerInfo | undefined = managerDetails) {
  return groups.map(g => {
    const d = info(g.id);
    if (!d) return `Manager of the group ${g.name}. Limits: not loaded yet.`;
    const { caps: c, usage: u } = d;
    const stopped = u.status && ['archived', 'suspended', 'parked', 'stopped'].includes(u.status) ? ` The manager task is ${u.status}, so it does not act until it runs again.` : '';
    return [`Manager of the group ${g.name}.`,
      `Limits: ${u.newToday} of ${c.newPerDay} new tasks today, ${u.working} of ${c.working} working tasks in the group, ${u.messagesHour} of ${c.messagesPerHour} messages this hour, ${u.stopsHour} of ${c.stopsPerHour} stop messages this hour.`,
      `May act now: start a task ${yes(u.mayNew)}, send a message ${yes(u.mayMessage)}, stop a task ${yes(u.mayStop)}.${stopped}`].join('\n');
  }).join('\n\n');
}
