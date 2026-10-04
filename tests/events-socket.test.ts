// /ws/events with 300 tasks with long descriptions: the dashboard stays connected. On 2026-10-04 the server closed each
// dashboard with 1013 'event client is too slow' right after its task list (0.99 MB for 240 tasks), and the page
// connected again in a loop. The server here is a test server of this checkout: its own TASKBOARD_DIR, vault, port and
// tmux socket in the system temp folder, no controller. Nothing touches ~/.taskboard or the tmux socket "taskboard".
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { waitFor } from './helpers/wait-for.ts';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tb-events-'));
const socket = `tbevents-${process.pid}`;
let pid = 0;
after(() => {
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ }
  rmSync(root, { recursive: true, force: true });
});
const env: NodeJS.ProcessEnv = { ...process.env }; delete env.TASK_ID; delete env.TB_URL; delete env.TB_TOKEN_FILE;
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

// 300 task notes in the format of server/store.ts, each with a description of 4000 characters
function writeTasks(vault: string) {
  const statuses = ['archived', 'idle', 'parked', 'suspended'];
  for (let i = 1; i <= 300; i++) {
    const id = `long-${i}`, at = new Date(Date.now() - i * 60000).toISOString();
    const fm = { id, num: i, title: `Long task ${i}`, agent: 'claude', status: statuses[i % statuses.length], cwd: '/tmp', folder: '/tmp', session: `task-long-${i}`, created: at, updated: at, statusAt: at };
    const desc = `Task ${i}: ` + 'the server sends the task list to each page when it connects. '.repeat(64);
    mkdirSync(join(vault, 'tasks', id), { recursive: true });
    writeFileSync(join(vault, 'tasks', id, 'log.md'), `# Log: ${fm.title}\n`);
    writeFileSync(join(vault, 'tasks', id + '.md'), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n# ${fm.title}\n\n${desc}\n`);
  }
}

test('a dashboard with 300 long tasks stays connected for 30 s', { timeout: 120000 }, async () => {
  const port = await freePort();
  const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), log = join(root, 'server.log');
  mkdirSync(tbdir, { recursive: true }); writeTasks(vault);
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'events-test', controller: { autostart: false, remoteControl: false } }));
  const child = spawn('/bin/sh', ['-c', `exec "${process.execPath}" --import tsx server/index.ts >> "${log}" 2>&1`], {
    cwd: checkout, detached: true, stdio: 'ignore',
    env: { ...env, TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'events-test' },
  });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  const info = await waitFor(async () => { try { const r = await fetch(url + '/api/info', { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() as { pid: number } : null; } catch { return null; } }, { description: 'the test server', timeoutMs: 30000 });
  pid = info.pid;
  const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
  const full = await (await fetch(`${url}/api/tasks`, { headers: { 'x-taskboard-token': token } })).text();
  assert.ok(full.length > 1_048_576, `the whole task list is ${full.length} bytes, more than the old 1 MiB limit`);

  // three dashboards at the same time, as the page and the desktop app connect
  const clients = Array.from({ length: 3 }, () => new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { origin: url } }));
  const seen = clients.map(ws => {
    const s = { types: [] as string[], tasks: [] as { id: string; desc: string; descCut?: number }[], closed: null as null | { code: number; reason: string } };
    ws.on('message', d => { const m = JSON.parse(d.toString()); s.types.push(m.type); if (m.type === 'tasks') s.tasks = m.tasks; });
    ws.on('close', (code, reason) => { s.closed = { code, reason: reason.toString() }; });
    return s;
  });
  await waitFor(() => seen.every(s => s.types.includes('runtime')), { description: 'the first messages on each socket', timeoutMs: 20000, state: () => JSON.stringify(seen.map(s => ({ types: s.types, closed: s.closed }))) });
  assert.match(clients[0].extensions, /permessage-deflate/);
  for (const s of seen) assert.deepEqual(s.types.slice(0, 8), ['hello', 'tasks', 'groups', 'canvasOrder', 'approvals', 'pending', 'dismissed', 'runtime']);
  assert.equal(seen[0].tasks.length, 300);

  // the list has the start of each description; the task panel reads the whole text over HTTP
  const one = seen[0].tasks.find(t => t.id === 'long-7')!;
  assert.equal(one.desc.length, 1000);
  const whole = await (await fetch(`${url}/api/tasks/long-7/desc`, { headers: { 'x-taskboard-token': token } })).json() as { desc: string };
  assert.equal(one.descCut, whole.desc.length);
  assert.ok(whole.desc.startsWith(one.desc));

  await new Promise(r => setTimeout(r, 30000));
  for (const s of seen) assert.equal(s.closed, null, `a socket was closed: ${JSON.stringify(s.closed)}`);
  assert.ok(clients.every(ws => ws.readyState === WebSocket.OPEN));
  assert.doesNotMatch(readFileSync(log, 'utf8'), /closed a client/);
  clients.forEach(ws => ws.close());
});
