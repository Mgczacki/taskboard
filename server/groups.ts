// Groups: named sets of tasks you make yourself. A task can be in any number of groups.
// Stored as Markdown notes in ~/AgentVault/groups/<id>.md so agents and you can read them.
import matter from 'gray-matter';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT } from './config.ts';

// order: the position of the tab on the Canvas page and of the column on the Board, set by reorder().
// A group without order (written before reorder() existed) comes after the groups with one, oldest first.
export interface Group { id: string; name: string; color: string; tasks: string[]; created: string; order?: number }

const DIR = join(VAULT, 'groups');
mkdirSync(DIR, { recursive: true });
const COLORS = ['#e3b341', '#58a6ff', '#3fb950', '#db61a2', '#a371f7', '#f78166', '#2dd4bf', '#8b949e'];
const groups = new Map<string, Group>();
const listeners = new Set<() => void>();
export const onGroupsChange = (fn: () => void) => { listeners.add(fn); };
const emit = () => listeners.forEach(f => f());

function write(g: Group) {
  const body = `# ${g.name}\n\n${g.tasks.map(t => `- [[${t}]]`).join('\n')}\n`;
  const data = { id: g.id, name: g.name, color: g.color, tasks: g.tasks, created: g.created, ...(typeof g.order === 'number' ? { order: g.order } : {}) };
  writeFileSync(join(DIR, g.id + '.md'), matter.stringify(body, data));
}

export function load() {
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.md')) continue;
    try { const { data } = matter(readFileSync(join(DIR, f), 'utf8')); groups.set(data.id, { tasks: [], ...data } as unknown as Group); } catch { /* skip */ }
  }
}
// by order, then oldest first
const rank = (g: Group) => typeof g.order === 'number' ? g.order : Infinity;
export const all = () => [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.created.localeCompare(b.created));
export const get = (id: string) => groups.get(id);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'group';

export function create(name: string, tasks: string[] = []): Group {
  let id = slug(name), n = 2;
  while (groups.has(id)) id = `${slug(name)}-${n++}`;
  const g: Group = { id, name, color: COLORS[groups.size % COLORS.length], tasks: [...new Set(tasks)], created: new Date().toISOString() };
  // after a reorder every group has an order, so a new group goes at the end
  const orders = [...groups.values()].map(rank).filter(Number.isFinite);
  if (orders.length) g.order = Math.max(...orders) + 1;
  groups.set(id, g); write(g); emit(); return g;
}
export function update(id: string, patch: Partial<Pick<Group, 'name' | 'color' | 'tasks'>>): Group | undefined {
  const g = groups.get(id); if (!g) return;
  if (patch.tasks) patch.tasks = [...new Set(patch.tasks)];
  Object.assign(g, patch); write(g); emit(); return g;
}
export function moveTask(taskId: string, fromId: string, toId: string): Group[] {
  const from = groups.get(fromId), to = groups.get(toId);
  if (!from || !to) throw new Error('The source or target group no longer exists.');
  if (fromId === toId) throw new Error('The source and target groups are the same.');
  if (!from.tasks.includes(taskId)) throw new Error('The task is no longer in the source group.');
  const beforeFrom = from.tasks, beforeTo = to.tasks;
  from.tasks = from.tasks.filter(id => id !== taskId);
  to.tasks = [...new Set([...to.tasks, taskId])];
  try { write(to); write(from); }
  catch (e) {
    from.tasks = beforeFrom; to.tasks = beforeTo;
    write(to); write(from);
    throw e;
  }
  emit();
  return [from, to];
}
// Puts the groups in the order of `ids`. An id that no group has is ignored (another browser deleted that group).
// A group that `ids` leaves out (another browser created it) goes after the listed groups, in its old order.
// Only the order field changes. Only the files whose order changed are written.
export function reorder(ids: string[]): Group[] {
  const listed = [...new Set(ids)].map(id => groups.get(id)).filter((g): g is Group => !!g);
  const next = [...listed, ...all().filter(g => !listed.includes(g))];
  const changed = next.filter((g, i) => g.order !== i);
  if (!changed.length) return all();
  const before = new Map(changed.map(g => [g, g.order]));
  next.forEach((g, i) => { g.order = i; });
  try { for (const g of changed) write(g); }
  catch (e) {
    for (const [g, o] of before) { g.order = o; try { write(g); } catch { /* the next write tries again */ } }
    throw e;
  }
  emit();
  return all();
}
export function remove(id: string): Group | undefined {
  const g = groups.get(id); if (!g) return;
  groups.delete(id); const f = join(DIR, id + '.md'); if (existsSync(f)) unlinkSync(f); emit(); return g;
}
export function restore(g: Group) { groups.set(g.id, g); write(g); emit(); }
export const groupsOf = (taskId: string) => all().filter(g => g.tasks.includes(taskId));
