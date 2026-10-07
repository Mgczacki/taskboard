// A group manager asks to archive a task of its own group (`tb archive <task>`, POST /api/tasks/:id/kill).
// The manager never archives a task itself. Each request makes one approval card (server/approvals.ts) that only the
// user decides on the dashboard. The preset of the manager and the Settings switch "agents need approval" do not
// change this. index.ts holds the route and the archive itself. This file holds the rules, so tests can call them.
// The rules (check) apply twice: when the manager asks, and again when the user approves the card:
//   - the requester is the live manager of a group (manager-role.ts roles)
//   - the target is not the requester and not the controller
//   - that group still holds the target
//   - the target exists and is not archived
import type { Approval } from './approvals.ts';
import * as groups from './groups.ts';
import * as managerRole from './manager-role.ts';
import * as store from './store.ts';

// What the card stores about the request. `group` is the id of the managed group that held the target.
export interface ArchiveRequest { manager: string; group: string; target: string }
export type Check = { ok: true; group: groups.Group; target: store.Task } | { ok: false; status: number; reason: string };

// groupId: the group named on the card. At approval time the same group must still give the right, so a manager that
// lost this group and manages another group that holds the target does not use the old card.
export function check(manager: string, targetId: string, groupId?: string): Check {
  const managed = managerRole.roles(manager);
  if (!managed.length) return { ok: false, status: 403, reason: 'This task is not a group manager.' };
  const target = store.get(targetId);
  if (!target) return { ok: false, status: 404, reason: 'The target task does not exist.' };
  if (target.id === manager) return { ok: false, status: 403, reason: 'A group manager cannot archive itself.' };
  if (target.id === 'controller' || target.role === 'controller') return { ok: false, status: 403, reason: 'A group manager cannot archive the controller.' };
  const group = managed.find(g => (!groupId || g.id === groupId) && managerRole.inGroup(g, target.id));
  if (!group) return { ok: false, status: 403, reason: 'The target is outside the manager group.' };
  if (target.status === 'archived') return { ok: false, status: 409, reason: `#${target.num} is archived already.` };
  return { ok: true, group, target };
}

// One card for each manager and target. A second request for the same target updates the open card (approvals.request).
export const cardTarget = (r: ArchiveRequest) => `manager-archive:${r.group}:${r.manager}:${r.target}`;
export const requestOf = (a: Pick<Approval, 'action' | 'payload'> | undefined): ArchiveRequest | undefined => {
  const r = a?.action === 'kill' ? (a.payload as { managerArchive?: ArchiveRequest } | undefined)?.managerArchive : undefined;
  return r && r.manager && r.group && r.target ? r : undefined;
};
export const USER_ONLY = 'A group manager asked to archive a task of its group. Only the user decides this card, on the dashboard.';

export const summary = (target: store.Task) => `end and archive #${target.num} ${target.title}`;
// The text of the card: who asks, the exact target and what the archive does (index.ts endAndArchive and the
// store.onTaskChange listener for an archived task).
export function detail(manager: store.Task, group: groups.Group, target: store.Task, o: { processes?: number; openCards?: number } = {}) {
  const managed = groups.all().filter(g => g.manager === target.id && g.tasks.includes(target.id));
  return [
    `Requested by: #${manager.num} ${manager.title}, the manager of the group ${group.name}`,
    `Target: #${target.num} ${target.title} (task id ${target.id})`,
    `Group: ${group.name} (group id ${group.id})`,
    `Target status at the request: ${target.status}`,
    `Target folder: ${target.cwd || target.folder || 'none'}`,
    '',
    'Effects of Approve:',
    `- Taskboard ends the agent session of #${target.num}. A turn that is in progress stops.`,
    `- Taskboard stops the processes${o.processes ? ` (${o.processes} running now)` : ''}, the test servers and the browser of #${target.num}.`,
    `- #${target.num} gets the status archived and leaves the board.`,
    `- The open approval cards of #${target.num}${o.openCards ? ` (${o.openCards} now)` : ''} close and nothing in them runs. Its allow always rules end.`,
    ...managed.map(g => `- #${target.num} manages the group ${g.name}. That group has no manager after the archive.`),
    `- The files, the branch, the notes and the conversation of #${target.num} stay. You can bring the task back with Resume.`,
    '',
    'This card is valid for one decision. The manager cannot approve it. Taskboard checks the manager role, the group and the target again when you approve.',
  ].join('\n');
}
