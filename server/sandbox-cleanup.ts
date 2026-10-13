import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOXES = join(tmpdir(), 'taskboard-sandbox');

export async function stopTaskSandboxes(taskId: string) {
  if (!existsSync(SANDBOXES)) return 0;
  let stopped = 0;
  for (const name of readdirSync(SANDBOXES)) {
    let meta: { ownerTask?: string; root?: string; pid?: number; pidStart?: string; devPids?: number[]; devPidStarts?: (string | undefined)[]; socket?: string; url?: string };
    try { meta = JSON.parse(readFileSync(join(SANDBOXES, name, 'sandbox.json'), 'utf8')); } catch { continue; }
    if (meta.ownerTask !== taskId || meta.socket !== `tbsb-${name}` || !meta.root || !meta.url) continue;
    let info: { pid?: number; root?: string; role?: string; url?: string };
    try { info = await fetch(meta.url + '/api/info', { signal: AbortSignal.timeout(2000) }).then(r => r.json()); } catch { continue; }
    let recorded: { pid?: number; url?: string };
    try { recorded = JSON.parse(readFileSync(join(SANDBOXES, name, 'tbdir', 'server.pid'), 'utf8')); } catch { continue; }
    if (info.role !== 'sandbox' || info.root !== meta.root || info.url !== meta.url || info.pid !== recorded.pid || recorded.url !== meta.url) continue;
    const pids = meta.devPids?.length ? meta.devPids : [meta.pid];
    const starts = meta.devPids?.length ? meta.devPidStarts : [meta.pidStart];
    const before = stopped;
    for (const [index, pid] of pids.entries()) {
      if (!Number.isSafeInteger(pid) || !pid || pid === process.pid) continue;
      if (!sandboxPidMatches(pid, starts?.[index])) continue;
      if (!sandboxPidMatches(pid, starts?.[index])) continue;
      try { process.kill(-pid, 'SIGTERM'); stopped++; } catch { /* process ended */ }
    }
    if (stopped === before) continue;
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const response = await fetch(meta.url + '/api/info', { signal: AbortSignal.timeout(1000) });
      if (response.ok) throw new Error(`Sandbox ${name} is still running. Stop it before archiving this task.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Sandbox ${name} is still running`)) throw error;
    }
    try { execFileSync('tmux', ['-L', meta.socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sandbox sessions */ }
  }
  return stopped;
}

// A missing start time leaves an older sandbox for review. A PID alone can refer to a new process.
export function sandboxPidMatches(pid: number, start: string | undefined): boolean {
  if (!start || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const current = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim();
    const uid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf8', timeout: 3000 }).trim());
    return current === start && uid === (process.getuid?.() ?? -1);
  } catch { return false; }
}

export async function recoverArchivedSandboxes(tasks: { id: string; status: string }[]) {
  if (!existsSync(SANDBOXES)) return 0;
  const archived = new Set(tasks.filter(t => t.status === 'archived').map(t => t.id));
  const owners = new Set<string>();
  for (const name of readdirSync(SANDBOXES)) {
    try {
      const meta = JSON.parse(readFileSync(join(SANDBOXES, name, 'sandbox.json'), 'utf8')) as { ownerTask?: string };
      if (meta.ownerTask && archived.has(meta.ownerTask)) owners.add(meta.ownerTask);
    } catch { /* no owner record */ }
  }
  let count = 0;
  for (const id of owners) count += await stopTaskSandboxes(id);
  return count;
}
