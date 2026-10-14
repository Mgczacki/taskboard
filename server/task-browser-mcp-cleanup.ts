// End old task-browser MCP wrappers after their agent has exited. The browser process is a child of the wrapper.
// The process table is bounded, and every signal checks the command and process start again.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cdpKey } from './task-browser.ts';
import { identity } from './browser-recovery.ts';

const exec = promisify(execFile);
const MAX_ROWS = 4096;
const MAX_CANDIDATES = 128;
const MAX_STOPS = 64;

export interface McpProcess { pid: number; ppid: number; uid: number; args: string }

export function inactiveTaskIds(tasks: { id: string; session: string }[], sessions: { name: string; dead: boolean }[]): Set<string> {
  const live = new Set(sessions.filter(session => !session.dead).map(session => session.name));
  return new Set(tasks.filter(task => !live.has(task.session)).map(task => task.id));
}

export function parseMcpProcesses(output: string): McpProcess[] {
  return output.split('\n').slice(0, MAX_ROWS).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), args: match[4] }] : [];
  });
}

export function orphanWrappers(rows: McpProcess[], taskIds: Set<string>, uid: number): McpProcess[] {
  return rows.filter(row => {
    if (row.ppid !== 1 || row.uid !== uid || !row.args.includes('/server/task-browser-mcp.ts ')) return false;
    const match = row.args.match(/--wsEndpoint ws:\/\/127\.0\.0\.1:\d+\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=([a-f0-9]{32})(?:\s|$)/);
    return !!match && taskIds.has(match[1]) && match[2] === cdpKey(match[1]);
  }).slice(0, MAX_CANDIDATES);
}

export async function readMcpProcesses(): Promise<McpProcess[]> {
  const result = await exec('ps', ['-axo', 'pid=,ppid=,uid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return parseMcpProcesses(result.stdout);
}

async function readRow(pid: number): Promise<McpProcess | undefined> {
  const result = await exec('ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024 });
  return parseMcpProcesses(result.stdout)[0];
}

export async function auditOrphanedTaskBrowserMcp(taskIds: Set<string>, canStop?: (taskId: string) => Promise<boolean>): Promise<{ found: number; stopped: number }> {
  const uid = process.getuid?.() ?? -1;
  const candidates = orphanWrappers(await readMcpProcesses(), taskIds, uid);
  let stopped = 0;
  for (const candidate of candidates.slice(0, MAX_STOPS)) {
    const taskId = candidate.args.match(/\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=/)?.[1];
    if (!taskId || (canStop && !await canStop(taskId))) continue;
    const before = identity(candidate.pid);
    if (!before || before.uid !== uid) continue;
    const current = await readRow(candidate.pid).catch(() => undefined);
    if (!current || current.ppid !== 1 || current.uid !== uid || current.args !== candidate.args) continue;
    if (identity(candidate.pid)?.start !== before.start) continue;
    try { process.kill(candidate.pid, 'SIGTERM'); stopped++; } catch { /* already exited */ }
  }
  return { found: candidates.length, stopped };
}
