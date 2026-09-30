import type { Task } from './store.ts';

export function idleSuspendMinutes(value: string | undefined) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 0;
}

export function maySuspendIdleTask(task: Task, now: number, minutes: number, transcriptTime: number, launchedAt: number, viewed: boolean) {
  return minutes > 0 && task.role !== 'controller' && task.status === 'idle' && !task.openElsewhere && !viewed &&
    now - Math.max(Date.parse(task.statusAt) || 0, transcriptTime, launchedAt) >= minutes * 60000;
}
