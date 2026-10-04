import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as groups from './groups.ts';
import * as store from './store.ts';

export type ManagerAction = 'new' | 'send' | 'doc' | 'dep' | 'group-add' | 'park' | 'resume' | 'waiting' | 'stop';
export const DEFAULT_CAPS = { newPerDay: 8, working: 8, messagesPerHour: 30, stopsPerHour: 3 };
const file = join(TB_DIR, 'manager-actions.jsonl');
export interface ManagerAudit { at: string; actor: string; group: string; action: string; target: string; result: string; userRequest?: string }
const recent: ManagerAudit[] = (() => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }
  catch { return []; }
})();
const audit = (entry: Omit<ManagerAudit, 'at'>) => {
  const full = { ...entry, at: new Date().toISOString() };
  appendFileSync(file, JSON.stringify(full) + '\n'); recent.push(full);
  return full;
};
export const actions = (group: string) => recent.filter(x => x.group === group).slice(-100).reverse();
export const role = (actor: string) => groups.all().find(g => g.manager === actor && store.get(actor)?.status !== 'archived');
export const inGroup = (g: groups.Group, task: string) => g.tasks.includes(task);
const count = (actor: string, action: string, ms: number) => recent.filter(x => x.actor === actor && x.action === action && x.result === 'done' && Date.now() - Date.parse(x.at) < ms).length;

export function check(actor: string, action: ManagerAction, target: string, groupRef?: string): { ok: boolean; reason: string; group?: groups.Group } {
  const g = role(actor);
  if (!g) return { ok: false, reason: 'This task is not a group manager.' };
  if (groupRef && ![g.id, g.name].includes(groupRef)) return { ok: false, reason: 'The action names another group.', group: g };
  if (action === 'new') {
    if (!groupRef) return { ok: false, reason: 'A manager must set --group on a new task.', group: g };
    if (count(actor, 'new', 86400000) >= DEFAULT_CAPS.newPerDay) return { ok: false, reason: 'The manager reached 8 new tasks today.', group: g };
    const working = g.tasks.map(id => store.get(id)).filter(t => t?.status === 'working').length;
    if (working >= DEFAULT_CAPS.working) return { ok: false, reason: 'The group has 8 active tasks.', group: g };
  } else if (action === 'group-add') {
    if (!inGroup(g, target) && store.get(target)?.parent !== actor) return { ok: false, reason: 'The manager may add only its own new task.', group: g };
  } else if (!inGroup(g, target)) return { ok: false, reason: 'The target is outside the manager group.', group: g };
  if (action === 'send' || action === 'doc' || action === 'stop') {
    if (count(actor, 'send', 3600000) + count(actor, 'doc', 3600000) + count(actor, 'stop', 3600000) >= DEFAULT_CAPS.messagesPerHour)
      return { ok: false, reason: 'The manager reached 30 messages this hour.', group: g };
    if (action === 'stop' && count(actor, 'stop', 3600000) >= DEFAULT_CAPS.stopsPerHour)
      return { ok: false, reason: 'The manager reached 3 stop messages this hour.', group: g };
  }
  return { ok: true, reason: '', group: g };
}

export function used(actor: string, group: groups.Group, action: ManagerAction, target: string, result = 'done') {
  return audit({ actor, group: group.id, action, target, result });
}
export function set(group: groups.Group, task: store.Task | undefined, by: 'user' | 'controller', userRequest?: string) {
  if (task && (task.id === 'controller' || task.status === 'archived' || !group.tasks.includes(task.id)))
    throw new Error('Choose a live task in this group. The controller cannot manage a group.');
  groups.update(group.id, { manager: task?.id });
  if (task) {
    const dir = join(store.taskDir(task.id), 'outbox'); mkdirSync(dir, { recursive: true });
    const pages: Record<string, string> = {
      'board.md': `# ${group.name} board\n\nRun \`tb board "${group.name}"\` for the current state.\n`,
      'decisions.md': `# ${group.name} decisions\n\nRecord each user decision with its card id and date.\n`,
      'handoff.md': `# ${group.name} handoff\n\nList open waits and the next action for each task.\n`,
    };
    for (const [name, body] of Object.entries(pages)) if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), body);
  }
  return audit({ actor: by, group: group.id, action: task ? 'set-role' : 'revoke-role', target: task?.id || '', result: 'done', ...(userRequest ? { userRequest } : {}) });
}
