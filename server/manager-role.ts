import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as groups from './groups.ts';
import * as store from './store.ts';

export type ManagerAction = 'new' | 'send' | 'doc' | 'dep' | 'group-add' | 'park' | 'resume' | 'waiting' | 'stop';
export const DEFAULT_CAPS = { newPerDay: 8, working: 8, messagesPerHour: 30, stopsPerHour: 3 };
// The user picks one preset when the user sets the manager (the group menu on the dashboard). The preset says which
// manager actions run without a card. An action that the preset does not allow makes a normal card.
// Direct the group is the default (decision of task 259).
export type ManagerPreset = NonNullable<groups.Group['managerPreset']>;
export const DEFAULT_PRESET: ManagerPreset = 'direct';
export const PRESETS: Record<ManagerPreset, { name: string; may: string[]; not: string[] }> = {
  watch: { name: 'Watch only',
    may: ['Read the board and the events of the group', 'Write its own notes and reports', 'Receive messages and documents from the tasks of this group without a card', 'Ask you, with a card'],
    not: ['Send messages or documents to tasks', 'Stop, park, resume or start tasks'] },
  direct: { name: 'Direct the group',
    may: ['Everything in Watch only', 'Send up to 30 messages and documents an hour to the tasks of this group', 'Stop up to 3 tasks an hour, park and resume tasks of this group', 'Add and remove links between tasks of this group'],
    not: ['Start new tasks'] },
  create: { name: 'Direct and create tasks',
    may: ['Everything in Direct the group', 'Start up to 8 new tasks a day in this group', 'Keep up to 8 tasks of this group working at the same time'],
    not: [] },
};
// What a manager never does, in every preset.
export const NEVER = ['Approve a card, a push, a merge, a release or a deploy', 'Send to a task outside this group without your approval on a card', 'Change Settings, rules or roles'];
const ALLOWS: Record<ManagerPreset, ManagerAction[]> = {
  watch: ['waiting'],
  direct: ['send', 'doc', 'dep', 'park', 'resume', 'waiting', 'stop'],
  create: ['send', 'doc', 'dep', 'park', 'resume', 'waiting', 'stop', 'new', 'group-add'],
};
export const presetOf = (g: groups.Group): ManagerPreset => g.managerPreset && g.managerPreset in PRESETS ? g.managerPreset : DEFAULT_PRESET;

// The group manager rule: the manager of a group and the tasks of that group may message each other, and send
// documents to each other, without a card. The rule is not stored. It comes from the role, so it exists exactly as long
// as role() finds the manager. The manager side uses check() and DEFAULT_CAPS. A task of the group that sends to its
// manager uses inbound() and inboundLimit(): at most PAIR_PER_HOUR from one task to its manager, and at most
// MANAGER_IN_PER_HOUR into one manager from all tasks. After a limit, the message gets a normal card again.
export const PAIR_PER_HOUR = 30;
export const MANAGER_IN_PER_HOUR = 60;
export const RULE_TEXT = 'Group managers: the manager of a group and the tasks of that group may message each other without a card.';
export const RULE_LIMIT_TEXT = `Each task may send at most ${PAIR_PER_HOUR} messages and documents an hour to its manager. A manager receives at most ${MANAGER_IN_PER_HOUR} an hour from all tasks. A manager sends at most ${DEFAULT_CAPS.messagesPerHour} an hour. After a limit, a card asks you again. The rule ends when you remove the role, when the manager task is archived or when it leaves the group. Only you set or remove the role.`;

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
// The actions of the manager, for "Manager did". The messages that tasks sent to the manager (action 'to-manager')
// stay in the audit file and are left out here.
export const actions = (group: string) => recent.filter(x => x.group === group && x.action !== 'to-manager').slice(-100).reverse();
// The group that `actor` manages: the group names it as manager, it is still a task of the group and it is not archived.
export const roles = (actor: string) => groups.all().filter(g => g.manager === actor && g.tasks.includes(actor) && !!store.get(actor) && store.get(actor)?.status !== 'archived');
export const role = (actor: string) => roles(actor)[0];
// A manager with several groups must name one when starting a task. Prefer an id over a name when both match.
export function newTaskGroup(actor: string, groupRef?: string): groups.Group | undefined {
  const managed = roles(actor);
  if (!managed.length) return undefined;
  if (!groupRef) {
    if (managed.length > 1) throw new Error('This task manages more than one group. Set --group on the new task.');
    return managed[0];
  }
  const byId = managed.find(g => g.id === groupRef);
  if (byId) return byId;
  const byName = managed.filter(g => g.name === groupRef);
  if (byName.length > 1) throw new Error('More than one managed group has this name. Set --group to a group id.');
  if (!byName.length) throw new Error('The action names another group.');
  return byName[0];
}
export const inGroup = (g: groups.Group, task: string) => g.tasks.includes(task);
const count = (actor: string, action: string, ms: number) => recent.filter(x => x.actor === actor && x.action === action && x.result === 'done' && Date.now() - Date.parse(x.at) < ms).length;

// The group whose live manager is `to` and that holds the sender `from`, or undefined. The sender must be a task that
// is not the controller, not archived and not the manager itself.
export function inbound(from: string, to: string): groups.Group | undefined {
  const sender = store.get(from);
  if (!sender || from === to || sender.role === 'controller' || sender.status === 'archived') return undefined;
  const g = role(to);
  return g && inGroup(g, from) ? g : undefined;
}
// undefined when one more message from `from` to its manager `to` may go without a card, or the reason for a card.
export function inboundLimit(from: string, to: string, now = Date.now()): string | undefined {
  const hour = recent.filter(x => x.action === 'to-manager' && x.target === to && x.result === 'done' && now - Date.parse(x.at) < 3600000);
  const pair = hour.filter(x => x.actor === from).length;
  if (pair >= PAIR_PER_HOUR) return `This task already sent ${pair} messages and documents to its group manager in the last hour (the limit is ${PAIR_PER_HOUR}). This card asks you again. Two tasks may answer each other in a loop.`;
  if (hour.length >= MANAGER_IN_PER_HOUR) return `The group manager already received ${hour.length} messages and documents from the tasks of its group in the last hour (the limit is ${MANAGER_IN_PER_HOUR}). This card asks you again.`;
  return undefined;
}
// One line in manager-actions.jsonl for a message or document from a task of the group to its manager without a card.
export const received = (from: string, g: groups.Group, kind: 'message' | 'doc', state: string) =>
  audit({ actor: from, group: g.id, action: 'to-manager', target: g.manager || '', result: state === 'failed' ? `failed ${kind}` : 'done' });
// One line for a message or document from a manager to the controller (no card, as for every task).
export const reported = (actor: string, g: groups.Group, kind: 'message' | 'doc', state: string) =>
  audit({ actor, group: g.id, action: 'to-controller', target: 'controller', result: `${kind} ${state}` });

export function check(actor: string, action: ManagerAction, target: string, groupRef?: string): { ok: boolean; reason: string; group?: groups.Group } {
  let g: groups.Group | undefined;
  try { g = action === 'new' ? newTaskGroup(actor, groupRef) : role(actor); }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (!g) return { ok: false, reason: 'This task is not a group manager.' };
  if (action !== 'new' && groupRef && ![g.id, g.name].includes(groupRef)) return { ok: false, reason: 'The action names another group.', group: g };
  if (action !== 'new' && action !== 'group-add' && !inGroup(g, target)) return { ok: false, reason: 'The target is outside the manager group.', group: g };
  const preset = presetOf(g);
  if (!ALLOWS[preset].includes(action)) return { ok: false, reason: `The preset ${PRESETS[preset].name} of this manager does not allow this action without a card.`, group: g };
  if (action === 'new') {
    if (count(actor, 'new', 86400000) >= DEFAULT_CAPS.newPerDay) return { ok: false, reason: 'The manager reached 8 new tasks today.', group: g };
    const working = g.tasks.map(id => store.get(id)).filter(t => t?.status === 'working').length;
    if (working >= DEFAULT_CAPS.working) return { ok: false, reason: 'The group has 8 active tasks.', group: g };
  } else if (action === 'group-add') {
    if (!inGroup(g, target) && store.get(target)?.parent !== actor) return { ok: false, reason: 'The manager may add only its own new task.', group: g };
  }
  if (action === 'send' || action === 'doc' || action === 'stop') {
    if (count(actor, 'send', 3600000) + count(actor, 'doc', 3600000) + count(actor, 'stop', 3600000) >= DEFAULT_CAPS.messagesPerHour)
      return { ok: false, reason: 'The manager reached 30 messages this hour.', group: g };
    if (action === 'stop' && count(actor, 'stop', 3600000) >= DEFAULT_CAPS.stopsPerHour)
      return { ok: false, reason: 'The manager reached 3 stop messages this hour.', group: g };
  }
  return { ok: true, reason: '', group: g };
}

// What the manager used of each cap (DEFAULT_CAPS) and whether check() would allow each kind of action now.
// The dashboard shows it in the tooltip of the Manager badge (GET /api/managers).
export function usage(g: groups.Group) {
  const actor = g.manager || '';
  const status = store.get(actor)?.status;
  const newToday = count(actor, 'new', 86400000);
  const working = g.tasks.map(id => store.get(id)).filter(t => t?.status === 'working').length;
  const stopsHour = count(actor, 'stop', 3600000);
  const messagesHour = count(actor, 'send', 3600000) + count(actor, 'doc', 3600000) + stopsHour;
  const may = ALLOWS[presetOf(g)];
  return { status, preset: presetOf(g), newToday, working, messagesHour, stopsHour,
    mayNew: may.includes('new') && newToday < DEFAULT_CAPS.newPerDay && working < DEFAULT_CAPS.working,
    mayMessage: may.includes('send') && messagesHour < DEFAULT_CAPS.messagesPerHour,
    mayStop: may.includes('stop') && messagesHour < DEFAULT_CAPS.messagesPerHour && stopsHour < DEFAULT_CAPS.stopsPerHour };
}

export function used(actor: string, group: groups.Group, action: ManagerAction, target: string, result = 'done') {
  return audit({ actor, group: group.id, action, target, result });
}
export function set(group: groups.Group, task: store.Task | undefined, by: 'user' | 'controller', userRequest?: string, preset?: ManagerPreset) {
  if (task && (task.id === 'controller' || task.status === 'archived' || !group.tasks.includes(task.id)))
    throw new Error('Choose a live task in this group. The controller cannot manage a group.');
  // a task that is set aside does not act, so it cannot take the role or change its preset (task 276). It can lose the role.
  if (task?.status === 'parked') throw new Error('Bring this task back first. A task that is set aside cannot become a manager.');
  if (preset && !(preset in PRESETS)) throw new Error('Choose Watch only, Direct the group or Direct and create tasks.');
  // a new manager starts with the given preset or the default. The same manager keeps its preset unless one is given.
  const nextPreset = !task ? undefined : preset || (group.manager === task.id ? group.managerPreset : undefined) || DEFAULT_PRESET;
  const change = task && group.manager === task.id && group.managerPreset !== nextPreset ? 'set-preset' : undefined;
  groups.update(group.id, { manager: task?.id, managerPreset: nextPreset });
  if (task) {
    const dir = join(store.taskDir(task.id), 'outbox'); mkdirSync(dir, { recursive: true });
    const pages: Record<string, string> = {
      'board.md': `# ${group.name} board\n\nRun \`tb board "${group.name}"\` for the current state.\n`,
      'decisions.md': `# ${group.name} decisions\n\nRecord each user decision with its card id and date.\n`,
      'handoff.md': `# ${group.name} handoff\n\nList open waits and the next action for each task.\n`,
    };
    for (const [name, body] of Object.entries(pages)) if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), body);
  }
  return audit({ actor: by, group: group.id, action: change || (task ? 'set-role' : 'revoke-role'), target: task?.id || '', result: task ? `done, ${PRESETS[nextPreset!].name}` : 'done', ...(userRequest ? { userRequest } : {}) });
}
