import type { Task } from './api';

export function confirmTriageArchive(t: Task): boolean {
  return t.status === 'working';
}

export function archiveTriageTask(
  t: Task,
  endAndArchive: (id: string) => Promise<unknown>,
  archive: (id: string, status: string) => Promise<unknown>,
): Promise<unknown> {
  return t.status === 'stopped' ? archive(t.id, 'archived') : endAndArchive(t.id);
}
