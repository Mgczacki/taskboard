// The manager parts of the dashboard without React (ManagerBoard.tsx draws them):
// - the boards of all groups (GET /api/board?all=1, server/waiting-board.ts), read every 15 s while a view uses them
// - which task manages which group, for the Manager badge and the ◆ mark on a group tab
// - the caps of each manager and their use (GET /api/managers), for the badge tooltip
// - the short wait text of a task ("Waits on #302", "Approve push") for its canvas window header
// - which button a "Need you" row of the group drop-down gets

export type BoardKey = 'needsYou' | 'waitingOther' | 'running' | 'free' | 'blocked';
export const BOARD_COLUMNS: [BoardKey, string][] = [['needsYou', 'Needs you'], ['waitingOther', 'Waiting on other'], ['running', 'Running'], ['free', 'Free'], ['blocked', 'Blocked']];
export interface WaitingOn { on: string; target: string; needs: string; reason: string; card: string; unblocks: string[] }
export interface BoardRow { id: string; num: number; title: string; ageMinutes: number; source: string; now?: string; waitingOn?: WaitingOn }
export interface Board { group: { id: string; name: string; manager?: string }; columns: Partial<Record<BoardKey, BoardRow[]>> }

export function boardSummary(b: Board) {
  const counts = Object.fromEntries(BOARD_COLUMNS.map(([k]) => [k, b.columns[k]?.length || 0])) as Record<BoardKey, number>;
  // Running and Free rows do not wait for anything, so only the other three columns count for the oldest wait
  const ages = (['needsYou', 'waitingOther', 'blocked'] as const).flatMap(k => (b.columns[k] || []).map(r => r.ageMinutes));
  const oldest = ages.length ? Math.max(...ages) : 0;
  return { counts, oldestMinutes: oldest > 60 ? oldest : null };
}

export const fmtAge = (m: number) => m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;

let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; listeners.forEach(f => f()); };
export const subscribeManagers = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const managersVersion = () => version;

// The boards of all groups. watchBoards() starts the reads and returns the function that stops them;
// the reads stop when the last view that watches them closes.
let boards = new Map<string, Board>();
let watchers = 0, timer: ReturnType<typeof setInterval> | null = null;
type Get = (url: string) => Promise<{ json(): Promise<unknown> }>;
const httpGet: Get = url => fetch(url);
export async function loadBoards(get: Get = httpGet) {
  try {
    const list = await get('/api/board?all=1').then(r => r.json());
    if (Array.isArray(list)) { boards = new Map((list as Board[]).map(b => [b.group.id, b])); changed(); }
  } catch { /* keep the last boards */ }
}
export function watchBoards() {
  if (!watchers++) { void loadBoards(); timer = setInterval(() => void loadBoards(), 15_000); }
  return () => { if (!--watchers && timer) { clearInterval(timer); timer = null; } };
}
export const boardOf = (group: string | undefined) => group ? boards.get(group) : undefined;
// The row of a task on the board of a group, and its column
export function rowOf(taskId: string, group?: string): { row: BoardRow; column: BoardKey } | undefined {
  for (const b of group ? [boards.get(group)].filter((x): x is Board => !!x) : boards.values())
    for (const [k] of BOARD_COLUMNS) { const row = b.columns[k]?.find(r => r.id === taskId); if (row) return { row, column: k }; }
}

// The cards that the dashboard knows (approvals and questions in the store), found by the card id of a wait
export interface CardRef { kind: 'approval'; action: string; pushId?: string; permitId?: string }
export type FindCard = (id: string) => CardRef | { kind: 'question' } | undefined;
const ACTION_WORD: Record<string, string> = {
  'git-push': 'Approve push', 'git-merge': 'Approve merge', release: 'Approve release', restart: 'Approve restart', scope: 'Approve scope',
  permit: 'Approve permit', external: 'Approve action', plan: 'Approve plan', new: 'Approve new task', send: 'Approve message',
  'mail-in': 'Approve message', 'mail-out': 'Approve message', 'tool-refusal': 'Refused command',
};

// The text that replaces the status word in the window header of a task that waits. Null: show the status word.
export function waitLabel(row: BoardRow, column: BoardKey, find: FindCard): string | null {
  const w = row.waitingOn;
  if (column === 'needsYou') {
    const card = w?.card ? find(w.card) : undefined;
    if (card?.kind === 'approval') return ACTION_WORD[card.action] || 'Approve';
    if (card?.kind === 'question') return 'Answer question';
    if (w?.reason === 'Review requested') return 'Review';
    return 'Needs you';
  }
  if (column === 'blocked') return 'Blocked';
  if (column !== 'waitingOther' || !w) return null;
  if (w.on === 'task' && w.target) return `Waits on #${w.target.replace(/^#/, '')}`;
  if (w.on === 'ci') return w.target ? `Waits on CI ${w.target}` : 'Waits on CI';
  if (w.target) return `Waits on ${w.target}`;
  return `Waits on ${w.on}`;
}

// The buttons of a "Need you" row in the group drop-down. Approve and Deny only for the cards that the approval card
// on the Waiting page also decides with one click; a permit, a refused command or a message needs its full card.
export type NeedAction = { kind: 'push'; pushId: string } | { kind: 'decide'; id: string } | { kind: 'review' } | { kind: 'open' };
const FULL_CARD = ['permit', 'external', 'tool-refusal', 'mail-in', 'mail-out', 'send'];
export function needAction(row: BoardRow, find: FindCard): NeedAction {
  const w = row.waitingOn;
  const card = w?.card ? find(w.card) : undefined;
  if (card?.kind === 'approval') {
    if (card.action === 'git-push') return card.pushId ? { kind: 'push', pushId: card.pushId } : { kind: 'open' };
    return FULL_CARD.includes(card.action) ? { kind: 'open' } : { kind: 'decide', id: w!.card };
  }
  if (w?.reason === 'Review requested') return { kind: 'review' };
  return { kind: 'open' };
}

// Which tasks are managers. App.tsx calls setManagerGroups with each new group list. The badges read it.
export interface ManagerUsage { status?: string; newToday: number; working: number; messagesHour: number; stopsHour: number; mayNew: boolean; mayMessage: boolean; mayStop: boolean }
export interface ManagerInfo { group: string; name: string; manager: string; num?: number; caps: { newPerDay: number; working: number; messagesPerHour: number; stopsPerHour: number }; usage: ManagerUsage }
type GroupLike = { id: string; name: string; manager?: string };
let roles = new Map<string, GroupLike[]>();
let details = new Map<string, ManagerInfo>();
let fetchedAt = 0, loading: Promise<void> | null = null;

export function setManagerGroups(groups: GroupLike[]) {
  const next = new Map<string, GroupLike[]>();
  for (const g of groups) if (g.manager) next.set(g.manager, [...next.get(g.manager) || [], g]);
  const sig = (m: Map<string, GroupLike[]>) => [...m].map(([id, l]) => id + ':' + l.map(g => g.id + '=' + g.name).join(',')).sort().join('|');
  if (sig(next) === sig(roles)) return;
  roles = next; changed();
}
export const managerGroupsOf = (taskId: string | undefined) => (taskId && roles.get(taskId)) || [];

// The caps and their use, read at most every 30 s, when a badge is shown or hovered
export function refreshManagerDetails(get: Get = httpGet) {
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
