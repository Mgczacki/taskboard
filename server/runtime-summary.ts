// What runs for each task: its browser (task-browser.ts) and its processes (task-procs.ts).
// Each task owns its own browser and processes. A group owns none: the group view of the dashboard asks for the items
// of the group's tasks, and each item names the task that owns it.
// - counts(): the number of running browsers and processes of each task. It reads only the registry files and checks
//   the browser's process id, so it is cheap. The server pushes it to the dashboard as a "runtime" event.
// - items(): the same things with names, states, ports and memory, for GET /api/runtime while a view is open.
// Memory is the footprint of the item's process group (server/memory.ts), the number that Activity Monitor shows.
import * as memory from './memory.ts';
import * as store from './store.ts';
import * as procs from './task-procs.ts';
import * as browser from './task-browser.ts';

export interface Count { browser: number; procs: number }
export interface Item {
  task: string; kind: 'browser' | 'proc'; name: string; state: string;
  port?: number; pages?: number; agents?: number; command?: string; memMb: number | null;
}

const ON = new Set<procs.ProcState>(['running', 'starting']);
const pidAlive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
// The browser process recorded in browser.json exists. This does not ask Chrome on its port, so a hung Chrome counts too.
export const browserUp = (id: string) => { const m = browser.readMeta(id); return !!m.port && pidAlive(m.pid); };

// Tasks that can have a browser and processes. The server's store holds only the tasks of this machine.
export const local = (t: store.Task) => t.role !== 'controller' && t.status !== 'archived';

export function countFor(o: procs.Owner, taskId: string): Count {
  return { browser: browserUp(taskId) ? 1 : 0, procs: procs.load(o).filter(p => ON.has(p.state)).length };
}

// Only tasks with at least one running item are in the result, so the event stays small.
export function counts(owner: (t: store.Task) => procs.Owner): Record<string, Count> {
  const out: Record<string, Count> = {};
  for (const t of store.all()) {
    if (!local(t)) continue;
    const c = countFor(owner(t), t.id);
    if (c.browser || c.procs) out[t.id] = c;
  }
  return out;
}

// Taskboard starts Chrome detached, and tmux makes each process window a session leader, so the recorded process id
// of a browser or a process is also its process group id.
export const memMb = (mem: Map<number, number>, pgid?: number): number | null => (pgid ? mem.get(pgid) ?? null : null);

// The browser and the processes of each task in ids. Processes are read from tmux first (procs.refresh), so a process
// that exited shows "exited". A stopped browser with saved pages is listed too, so the user sees what a start opens.
export async function items(ids: string[], owner: (t: store.Task) => procs.Owner): Promise<Item[]> {
  const tasks = ids.map(id => store.get(id)).filter((t): t is store.Task => !!t && local(t));
  // processes first, so one memory call covers every running browser and process
  const procLists = await Promise.all(tasks.map(t => procs.refresh(owner(t)).catch(() => procs.load(owner(t)))));
  const groups = tasks.flatMap((t, k) => [...(browserUp(t.id) ? [browser.readMeta(t.id).pid || 0] : []), ...procLists[k].filter(p => ON.has(p.state)).map(p => p.pid || 0)]).filter(Boolean);
  const mem = await memory.byGroup(groups);
  const rows = await Promise.all(tasks.map(async (t, k) => {
    const list: Item[] = [];
    const m = browser.readMeta(t.id);
    if (browserUp(t.id)) {
      const pages = await browser.tabs(t.id).catch(() => []);
      list.push({ task: t.id, kind: 'browser', name: 'Browser', state: 'running', port: m.port, pages: pages.length, agents: browser.agentCount(t.id), memMb: memMb(mem, m.pid) });
    } else if (m.tabs?.length || m.suspended || m.error) {
      list.push({ task: t.id, kind: 'browser', name: 'Browser', state: m.suspended ? 'suspended' : 'stopped', pages: m.tabs?.length || 0, memMb: null });
    }
    for (const p of procLists[k]) list.push({ task: t.id, kind: 'proc', name: p.name, state: p.state, port: p.port, command: p.command, memMb: ON.has(p.state) ? memMb(mem, p.pid) : null });
    return list;
  }));
  return rows.flat();
}

// Added up for the header of a view: running items and their memory.
export function total(list: Item[]) {
  const on = list.filter(i => i.state === 'running' || i.state === 'starting');
  return {
    browsers: on.filter(i => i.kind === 'browser').length,
    procs: on.filter(i => i.kind === 'proc').length,
    memMb: on.reduce((n, i) => n + (i.memMb || 0), 0),
  };
}
