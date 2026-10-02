// Dropping a task on a group or on Ungrouped (canvas tabs, Board columns), the × and remove buttons that take a task out
// of a group, and the Undo of each. Kept apart from Canvas.tsx and Views.tsx (and from api.ts, which opens a
// WebSocket on import) so tests/group-move.test.ts can run it.
//
// Ungrouped is not a group file: it is every task that no group lists. So a task reaches Ungrouped only when it leaves
// its last group. A task can be in any number of groups (server/groups.ts).
import type { Group } from './api';

// the PATCH /api/groups/:id call (api.updateGroup)
export type UpdateGroup = (id: string, patch: { tasks?: string[]; add?: string; remove?: string }) => Promise<unknown>;
export type MoveGroupTask = (taskId: string, fromId: string, toId: string) => Promise<unknown>;

// One change to the groups of one task. `removed` keeps each group's position of the task, so Undo puts it back there.
export interface GroupChange {
  taskId: string; num: number | string;
  added: { id: string; name: string }[];
  removed: { id: string; name: string; index: number }[];
  stillIn: string[]; // names of the groups that still list the task afterwards
}
export type DropPlan = { change: GroupChange } | { refused: string };

const names = (l: string[]) => l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
const removal = (g: Group, taskId: string) => ({ id: g.id, name: g.name, index: g.tasks.indexOf(taskId) });

// Takes the task out of `fromGroup` (the group of the tab or column it was dragged from). Without `fromGroup`
// (dragged from Live, Needs you + unread or a hand-picked window) it takes the task out of every group.
export function planUngroup(taskId: string, num: number | string, groups: Group[], fromGroup?: string): DropPlan {
  const inGroups = groups.filter(g => g.tasks.includes(taskId));
  const from = fromGroup ? inGroups.filter(g => g.id === fromGroup) : inGroups;
  if (!from.length) {
    const g = fromGroup && groups.find(x => x.id === fromGroup);
    return { refused: g ? `#${num} is not in ${g.name}` : `#${num} is not in a group` };
  }
  return { change: { taskId, num, added: [], removed: from.map(g => removal(g, taskId)), stillIn: inGroups.filter(g => !from.includes(g)).map(g => g.name) } };
}

// Adds the task to `target`. With `move` (⌥ held) it also takes the task out of `fromGroup`.
export function planGroupDrop(taskId: string, num: number | string, groups: Group[], target: string, fromGroup: string | undefined, move: boolean): DropPlan {
  const t = groups.find(g => g.id === target);
  if (!t) return { refused: 'That group no longer exists' };
  if (target === fromGroup) return { refused: `#${num} is already in ${t.name}` };
  const src = move && fromGroup ? groups.find(g => g.id === fromGroup && g.tasks.includes(taskId)) : undefined;
  const inTarget = t.tasks.includes(taskId);
  if (inTarget && !src) return { refused: `#${num} is already in ${t.name}${fromGroup && !move ? '. Hold ⌥ to move it here' : ''}` };
  const removed = src ? [removal(src, taskId)] : [];
  const after = groups.filter(g => g.id === target || (g.tasks.includes(taskId) && g.id !== src?.id));
  return { change: { taskId, num, added: inTarget ? [] : [{ id: t.id, name: t.name }], removed, stillIn: after.map(g => g.name) } };
}

export function planCanvasTabDrop(taskId: string, num: number | string, groups: Group[], target: string | null, fromGroup?: string): DropPlan | null {
  if (!target) return null;
  return target === 'ungrouped' ? planUngroup(taskId, num, groups, fromGroup)
    : planGroupDrop(taskId, num, groups, target.slice(2), fromGroup, !!fromGroup);
}

// The notice after a change, for example "Removed #4 from Auth. It is still in Release."
export function changeNotice(c: GroupChange): string {
  const r = names(c.removed.map(g => g.name));
  if (!c.added.length) return `Removed #${c.num} from ${r}. ${c.stillIn.length ? `It is still in ${names(c.stillIn)}.` : 'It is now in Ungrouped.'}`;
  const a = c.added[0].name;
  const others = c.stillIn.filter(n => n !== a);
  return `${c.removed.length ? `Moved #${c.num} from ${r} to ${a}.` : `Added #${c.num} to ${a}.`}${others.length ? ` It is also in ${names(others)}.` : ''}`;
}
// the text in the drag label while the pointer is over a target
export function dropHint(c: GroupChange): string {
  if (!c.added.length) return `Remove from ${names(c.removed.map(g => g.name))}`;
  return c.removed.length ? `Move to ${c.added[0].name}` : `Add to ${c.added[0].name}`;
}

export async function applyChange(c: GroupChange, update: UpdateGroup, move?: MoveGroupTask) {
  if (move && c.added.length === 1 && c.removed.length === 1) {
    await move(c.taskId, c.removed[0].id, c.added[0].id);
    return;
  }
  for (const g of c.added) await update(g.id, { add: c.taskId });
  for (const g of c.removed) await update(g.id, { remove: c.taskId });
}

// Reverses a change against the groups as they are now. A removed task goes back to its old position.
// Returns the names of the groups it could not put the task back into, because they were deleted.
export async function undoChange(c: GroupChange, groupsNow: Group[], update: UpdateGroup): Promise<string[]> {
  const lost: string[] = [];
  for (const a of c.added) if (groupsNow.some(g => g.id === a.id)) await update(a.id, { remove: c.taskId });
  for (const r of c.removed) {
    const g = groupsNow.find(x => x.id === r.id);
    if (!g) { lost.push(r.name); continue; }
    if (g.tasks.includes(c.taskId)) continue;
    const list = [...g.tasks]; list.splice(Math.min(Math.max(0, r.index), list.length), 0, c.taskId);
    await update(g.id, { tasks: list });
  }
  return lost;
}
