import * as groups from './groups.ts';
import * as managerRole from './manager-role.ts';

// Resolve a task's group when its child starts. Manager scope still limits an explicit group.
export function forNewTask(actor: string, groupRef?: string): groups.Group | string | undefined {
  const managed = managerRole.newTaskGroup(actor, groupRef);
  if (managed) return managed;
  if (groupRef) return groups.all().find(g => g.id === groupRef || g.name === groupRef) || groupRef;
  if (!actor || actor === 'controller') return undefined;
  const current = groups.groupsOf(actor);
  if (current.length > 1) throw new Error('This task belongs to more than one group. Set --group on the new task.');
  return current[0];
}
