import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOXES = join(tmpdir(), 'taskboard-sandbox');

export async function stopTaskSandboxes(taskId: string) {
  if (!existsSync(SANDBOXES)) return 0;
  let stopped = 0;
  for (const name of readdirSync(SANDBOXES)) {
    let meta: { ownerTask?: string; root?: string; pid?: number; devPids?: number[]; socket?: string; url?: string };
    try { meta = JSON.parse(readFileSync(join(SANDBOXES, name, 'sandbox.json'), 'utf8')); } catch { continue; }
    if (meta.ownerTask !== taskId || meta.socket !== `tbsb-${name}` || !meta.root || !meta.url) continue;
    let info: { pid?: number; root?: string; role?: string; url?: string };
    try { info = await fetch(meta.url + '/api/info', { signal: AbortSignal.timeout(2000) }).then(r => r.json()); } catch { continue; }
    let recorded: { pid?: number; url?: string };
    try { recorded = JSON.parse(readFileSync(join(SANDBOXES, name, 'tbdir', 'server.pid'), 'utf8')); } catch { continue; }
    if (info.role !== 'sandbox' || info.root !== meta.root || info.url !== meta.url || info.pid !== recorded.pid || recorded.url !== meta.url) continue;
    const pids = meta.devPids?.length ? meta.devPids : [meta.pid];
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || !pid || pid === process.pid) continue;
      try { process.kill(-pid, 'SIGTERM'); stopped++; } catch { /* process ended */ }
    }
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
