import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { TASKS_DIR } from '../server/config.ts';
import { auditOrphanedTaskBrowserMcp, orphanWrappers, readMcpProcesses } from '../server/task-browser-mcp-cleanup.ts';

const ids = new Set(readdirSync(TASKS_DIR).filter(name => name.endsWith('.md')).map(name => basename(name, '.md')));
const exec = promisify(execFile);
async function inactiveTask(id: string): Promise<boolean> {
  let file: string;
  try { file = readFileSync(join(TASKS_DIR, `${id}.md`), 'utf8'); } catch { return false; }
  const session = file.match(/^session: (.+)$/m)?.[1];
  if (!session) return false;
  try {
    const result = await exec('tmux', ['-L', 'taskboard', 'list-sessions', '-F', '#{session_name} #{pane_dead}'], { encoding: 'utf8', timeout: 3000 });
    return !result.stdout.split('\n').some(line => line === `${session} 0`);
  } catch { return false; }
}
const rows = await readMcpProcesses();
const wrappers = orphanWrappers(rows, ids, process.getuid?.() ?? -1);
const inactive = new Set<string>();
for (const wrapper of wrappers) {
  const id = wrapper.args.match(/\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=/)?.[1];
  if (id && await inactiveTask(id)) inactive.add(id);
}
const children = rows.filter(row => wrappers.some(wrapper => row.ppid === wrapper.pid && /chrome-devtools-mcp/.test(row.args)));
if (process.argv.includes('--summary')) {
  console.log(JSON.stringify({ totalWrappers: rows.filter(row => row.args.includes('/server/task-browser-mcp.ts ')).length,
    totalChromeMcp: rows.filter(row => /^chrome-devtools-mcp\s*$/.test(row.args)).length,
    orphanWrappers: wrappers.length, orphanChildren: children.length, inactiveWrappers: wrappers.filter(row => inactive.has(row.args.match(/\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=/)?.[1] || '')).length }));
  process.exit(0);
}
const label = (row: { pid: number; ppid: number; args: string }) => ({
  pid: row.pid, ppid: row.ppid, task: row.args.match(/\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=/)?.[1] || null,
  inactive: inactive.has(row.args.match(/\/ws\/cdp\/([A-Za-z0-9._-]+)\?key=/)?.[1] || ''),
});
console.log(JSON.stringify({ wrappers: wrappers.map(label), children: children.map(row => ({ pid: row.pid, ppid: row.ppid })) }, null, 2));
if (process.argv.includes('--stop')) {
  const result = await auditOrphanedTaskBrowserMcp(inactive, inactiveTask);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const after = await readMcpProcesses();
  const remaining = orphanWrappers(after, ids, process.getuid?.() ?? -1);
  console.log(JSON.stringify({ found: result.found, signaled: result.stopped, remaining: remaining.length,
    childrenRemaining: after.filter(row => remaining.some(wrapper => row.ppid === wrapper.pid && /chrome-devtools-mcp/.test(row.args))).length }));
}
