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
// The last group list: App.tsx gives the store groups, setManager() changes one manager at once after the server said yes
let lastGroups: GroupLike[] = [];

export function setManagerGroups(groups: GroupLike[]) {
  lastGroups = groups;
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

// The manager of a group as this page knows it now: the store groups, or the result of setManager() before the
// server sends the new groups. The ◆ on a group tab reads it, so the tab and the Manager badge change together.
export function groupManager(g: { id: string; manager?: string }) {
  const known = lastGroups.find(x => x.id === g.id);
  return known ? known.manager : g.manager;
}

// The manager scope of one group (GET /api/manager/:group): the manager, its preset, the preset texts, the caps and the
// manager actions. The group menu (ManagerScope) and the manager item of a task menu (ManagerRoleMenu) read the same
// copy, and setManager() reloads it, so the two places show the same manager and preset.
export type PresetKey = 'watch' | 'direct' | 'create';
export interface PresetText { name: string; may: string[]; not: string[] }
export interface Audit { at: string; actor: string; action: string; target: string; result: string; userRequest?: string }
export interface Scope {
  group: { id: string; name: string; manager?: string; tasks: string[] }; caps: Record<string, number>; actions: Audit[];
  preset: PresetKey | null; defaultPreset: PresetKey; presets: Record<PresetKey, PresetText>; never: string[]; rule: string; ruleLimits: string;
}
const scopes = new Map<string, Scope>();
export const scopeOf = (group: string) => scopes.get(group);
export async function loadScope(group: string, get: Get = httpGet) {
  try {
    const s = await get(`/api/manager/${encodeURIComponent(group)}`).then(r => r.json()) as Scope;
    if (s && s.group) { scopes.set(group, s); changed(); }
    return s;
  } catch { return scopes.get(group); }
}
type Post = (url: string, body: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const httpPost: Post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// POST /api/manager/:group from the dashboard. task null removes the manager. The server refuses the controller, an
// archived task and a task outside the group (server/manager-role.ts set()). A refusal throws its error text.
export async function setManager(group: string, body: { task: string | null; preset?: PresetKey }, post: Post = httpPost, get: Get = httpGet) {
  const r = await post(`/api/manager/${encodeURIComponent(group)}`, body);
  if (!r.ok) {
    const e = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(e.error || 'The server did not change the manager.');
  }
  setManagerGroups(lastGroups.map(g => g.id === group ? { ...g, manager: body.task || undefined } : g));
  fetchedAt = 0;
  await Promise.all([loadScope(group, get), loadBoards(get)]);
}

// The manager item of a task menu (the ◆ button of a canvas window header, its ⋯ menu and the task panel).
// One entry for each group of the task:
// - make: the group has no manager. replace: another task manages it. The user confirms the replacement.
// - stop and preset: this task manages the group.
// disabled is the reason when the task cannot take the role now. hint is the reason when no entry applies.
export type ManagerChoice = { kind: 'make' | 'replace' | 'stop' | 'preset'; group: { id: string; name: string }; current?: { id: string; num?: number; title?: string }; label: string; disabled?: string };
export type ManagerMenu = { hidden: true } | { hidden?: false; label: string; choices: ManagerChoice[]; hint?: string };
type TaskLike = { id: string; num: number; title: string; status: string; role?: string };
type GroupOfTask = { id: string; name: string; tasks: string[]; manager?: string };

export const NO_GROUP_HINT = 'Add this task to a group first. Use Add to group in the task panel, or drag its canvas window onto a group tab.';
export function managerMenu(t: TaskLike, groups: GroupOfTask[], tasks: TaskLike[], presetCount = 3): ManagerMenu {
  // the server refuses the controller (server/manager-role.ts set()), so its menu has no manager item
  if (t.role === 'controller' || t.id === 'controller') return { hidden: true };
  const mine = groups.filter(g => g.tasks.includes(t.id));
  if (!mine.length) return { label: 'Make manager', choices: [], hint: NO_GROUP_HINT };
  const cannot = t.status === 'archived' ? 'Restore this task first. An archived task cannot manage a group.'
    : t.status === 'parked' ? 'Bring this task back first. A task that is set aside cannot become a manager.' : undefined;
  const choices: ManagerChoice[] = [];
  for (const g of mine) {
    const group = { id: g.id, name: g.name };
    const manager = groupManager(g);
    if (manager === t.id) {
      choices.push({ kind: 'stop', group, label: `Stop managing ${g.name}` });
      if (presetCount > 1 && !cannot) choices.push({ kind: 'preset', group, label: `Change preset of ${g.name}` });
    } else if (manager) {
      const m = tasks.find(x => x.id === manager);
      choices.push({ kind: 'replace', group, current: { id: manager, num: m?.num, title: m?.title }, label: `Replace ${m ? `#${m.num}` : manager} as manager of ${g.name}`, disabled: cannot });
    } else choices.push({ kind: 'make', group, label: `Make manager of ${g.name}`, disabled: cannot });
  }
  const label = choices.length === 1 ? choices[0].label : choices.some(c => c.kind === 'stop') ? 'Manager role' : 'Make manager of…';
  return { label, choices };
}
