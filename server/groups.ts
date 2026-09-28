// Groups: named sets of tasks you make yourself. A task can be in any number of groups.
// Stored as Markdown notes in ~/AgentVault/groups/<id>.md so agents and you can read them.
import matter from 'gray-matter';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT } from './config.ts';

export interface Group { id: string; name: string; color: string; tasks: string[]; created: string }

const DIR = join(VAULT, 'groups');
mkdirSync(DIR, { recursive: true });
const COLORS = ['#e3b341', '#58a6ff', '#3fb950', '#db61a2', '#a371f7', '#f78166', '#2dd4bf', '#8b949e'];
const groups = new Map<string, Group>();
const listeners = new Set<() => void>();
export const onGroupsChange = (fn: () => void) => { listeners.add(fn); };
const emit = () => listeners.forEach(f => f());

function write(g: Group) {
  const body = `# ${g.name}\n\n${g.tasks.map(t => `- [[${t}]]`).join('\n')}\n`;
  writeFileSync(join(DIR, g.id + '.md'), matter.stringify(body, { id: g.id, name: g.name, color: g.color, tasks: g.tasks, created: g.created }));
}

export function load() {
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.md')) continue;
    try { const { data } = matter(readFileSync(join(DIR, f), 'utf8')); groups.set(data.id, { tasks: [], ...data } as unknown as Group); } catch { /* skip */ }
  }
}
// oldest first, so tabs keep their order
export const all = () => [...groups.values()].sort((a, b) => a.created.localeCompare(b.created));
export const get = (id: string) => groups.get(id);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'group';

export function create(name: string, tasks: string[] = []): Group {
  let id = slug(name), n = 2;
  while (groups.has(id)) id = `${slug(name)}-${n++}`;
  const g: Group = { id, name, color: COLORS[groups.size % COLORS.length], tasks: [...new Set(tasks)], created: new Date().toISOString() };
  groups.set(id, g); write(g); emit(); return g;
}
export function update(id: string, patch: Partial<Pick<Group, 'name' | 'color' | 'tasks'>>): Group | undefined {
  const g = groups.get(id); if (!g) return;
  if (patch.tasks) patch.tasks = [...new Set(patch.tasks)];
  Object.assign(g, patch); write(g); emit(); return g;
}
export function remove(id: string): Group | undefined {
  const g = groups.get(id); if (!g) return;
  groups.delete(id); const f = join(DIR, id + '.md'); if (existsSync(f)) unlinkSync(f); emit(); return g;
}
export function restore(g: Group) { groups.set(g.id, g); write(g); emit(); }
export const groupsOf = (taskId: string) => all().filter(g => g.tasks.includes(taskId));
