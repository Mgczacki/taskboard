// "Close and archive all" on a canvas group tab: which tasks it ends, and the calls it makes. Kept apart from
// Canvas.tsx (and from api.ts, which opens a WebSocket on import) so tests/group-archive.test.ts can run it.
import type { Group, Status, Task } from './api';

const WAITS: Status[] = ['needs-you', 'stopped', 'review']; // the same list as ATTN in api.ts

export interface ArchiveTarget { task: Task; alsoIn: string[] } // alsoIn: names of the other groups that list the task
export interface ArchivePlan { targets: ArchiveTarget[]; working: number; waiting: number; notRunning: number }

// Every task the group lists that is not archived yet, in the group's order. The controller is never included.
// Suspended and set-aside tasks are included too, so the tab is empty afterwards (their "end" only archives them).
export function archivePlan(g: Group, groups: Group[], tasks: Task[]): ArchivePlan {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const targets = [...new Set(g.tasks)].map(id => byId.get(id))
    .filter((t): t is Task => !!t && t.status !== 'archived' && t.role !== 'controller')
    .map(task => ({ task, alsoIn: groups.filter(x => x.id !== g.id && x.tasks.includes(task.id)).map(x => x.name) }));
  const count = (f: (t: Task) => boolean) => targets.filter(x => f(x.task)).length;
  return {
    targets,
    working: count(t => t.status === 'working'),
    waiting: count(t => WAITS.includes(t.status)),
    notRunning: count(t => t.status === 'suspended' || t.status === 'parked'),
  };
}

export interface ArchiveResult { done: { id: string; before: Status }[]; failed: { id: string; error: string }[] }

// Calls kill (POST /api/tasks/:id/kill, the same call as the ⏻ button) for each task, at most `at` calls at a time.
// A failed call is recorded and the others go on.
export async function archiveAll(list: Task[], kill: (id: string) => Promise<unknown>, onProgress?: (finished: number) => void, at = 3): Promise<ArchiveResult> {
  const result: ArchiveResult = { done: [], failed: [] };
  let next = 0, finished = 0;
  const worker = async () => {
    while (next < list.length) {
      const t = list[next++];
      try { await kill(t.id); result.done.push({ id: t.id, before: t.status }); }
      catch (e) { result.failed.push({ id: t.id, error: e instanceof Error ? e.message : String(e) }); }
      onProgress?.(++finished);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, list.length) }, worker));
  const order = new Map(list.map((t, i) => [t.id, i]));
  result.done.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  result.failed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return result;
}

// The single Restore sets the task to idle. A task that was set aside goes back to parked. The server then finds no
// tmux session and marks the others suspended; they come back on the canvas after Resume.
export async function restoreAll(done: ArchiveResult['done'], setStatus: (id: string, status: string) => Promise<unknown>) {
  const failed: string[] = [];
  for (const d of done) await setStatus(d.id, d.before === 'parked' ? 'parked' : 'idle').catch(() => failed.push(d.id));
  return failed;
}
