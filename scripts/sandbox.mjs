#!/usr/bin/env node
// Isolated Taskboard servers for trying code, especially from inside Taskboard. Each sandbox gets its own port,
// folders (in the system temp folder) and tmux socket, never starts a controller, and is stopped by its own process id.
//
//   pnpm sandbox [start] [--name n]   start the code in the current folder as sandbox n (default: the folder's name)
//   pnpm sandbox stop [--name n] [--clean]   stop it (and its tmux agents); --clean also deletes its folders
//   pnpm sandbox list
//   pnpm dev                          sandbox with the server restarting on changes, plus the Vite interface
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SANDBOXES, ensureDir, freePort, log, readJson, startServer, waitForInfo, writeJson } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = ['start', 'stop', 'list', 'dev'].includes(args[0]) ? args.shift() : 'start';
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const root = process.cwd();
const name = (opt('--name') || basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 30) || 'sandbox';
const base = join(SANDBOXES, name), meta = join(base, 'sandbox.json');

function envFor(port) {
  return { TASKBOARD_DIR: join(base, 'tbdir'), TASKBOARD_VAULT: join(base, 'vault'), TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: `tbsb-${name}`, TASKBOARD_MACHINE_NAME: `sandbox-${name}` };
}
function prepare() {
  ensureDir(join(base, 'tbdir')); ensureDir(join(base, 'vault'));
  // no controller in a sandbox unless you turn it on in its Accounts page
  const mf = join(base, 'tbdir', 'machine.json');
  if (!existsSync(mf)) writeJson(mf, { name: `sandbox-${name}`, controller: { autostart: false, remoteControl: false } });
}
const running = async (m, folder = base) => {
  if (!m?.url || !m?.root) return false;
  const info = await waitForInfo(m.url, join(folder, 'tbdir', 'token'), 2000);
  const recorded = readJson(join(folder, 'tbdir', 'server.pid'), null);
  return info?.role === 'sandbox' && info.root === m.root && info.url === m.url && info.pid === recorded?.pid;
};
function show(m) {
  log(`Sandbox "${name}": ${m.url}  (process ${m.pid}, code ${m.root})`);
  log(`  folders ${base}  ·  tmux -L ${m.socket}  ·  log ${join(base, 'server.log')}`);
  log(`  use tb against it:  export TB_URL=${m.url} TB_TOKEN_FILE=${join(base, 'tbdir', 'token')}`);
  log(`  stop it:            pnpm sandbox stop --name ${name}`);
}

if (cmd === 'list') {
  if (!existsSync(SANDBOXES)) { log('No sandboxes.'); process.exit(0); }
  for (const n of readdirSync(SANDBOXES)) { const folder = join(SANDBOXES, n); const m = readJson(join(folder, 'sandbox.json'), null); if (m) log(`${n.padEnd(24)} ${await running(m, folder) ? 'running' : 'stopped'}  ${m.url}  ${m.root}`); }
} else if (cmd === 'stop') {
  const m = readJson(meta, null);
  if (await running(m)) {
    for (const pid of m.devPids || [m.pid]) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await new Promise(resolve => setTimeout(resolve, 400));
    if (await running(m)) { log(`Could not stop sandbox "${name}" (process ${m.pid}).`); process.exit(1); }
    log(`Stopped sandbox "${name}" (process ${m.pid}).`);
  } else log(`Sandbox "${name}" is not running.`);
  try { execFileSync('tmux', ['-L', `tbsb-${name}`, 'kill-server'], { stdio: 'ignore' }); } catch { /* no agents */ }
  if (args.includes('--clean')) { rmSync(base, { recursive: true, force: true }); log(`Deleted ${base}.`); }
} else if (cmd === 'start') {
  const m = await running(readJson(meta, null)) ? readJson(meta, null) : null;
  if (m) { show(m); process.exit(0); }
  prepare();
  const port = await freePort(4400);
  const pid = startServer(root, envFor(port), join(base, 'server.log'));
  const m2 = { pid, port, url: `http://127.0.0.1:${port}`, root, socket: `tbsb-${name}`, started: new Date().toISOString(), ownerTask: process.env.TASK_ID || undefined };
  writeJson(meta, m2);
  const info = await waitForInfo(m2.url, join(base, 'tbdir', 'token'), 20000);
  if (!info) { log(`The sandbox did not come up. Its log (${join(base, 'server.log')}):`); log(readFileSync(join(base, 'server.log'), 'utf8').split('\n').slice(-20).join('\n')); process.exit(1); }
  show(m2);
} else if (cmd === 'dev') {
  // foreground: server restarts on code changes (tsx watch), interface with hot reload (Vite) on a free port
  prepare();
  const port = await freePort(4400), webPort = await freePort(5173);
  const env = { ...process.env, ...envFor(port) };
  log(`Sandbox "${name}" in development mode: interface http://localhost:${webPort}  ·  server http://127.0.0.1:${port}  ·  Ctrl-C stops both`);
  const kids = [
    spawn(join(root, 'node_modules', '.bin', 'tsx'), ['watch', 'server/index.ts'], { cwd: root, env, stdio: 'inherit', detached: true }),
    spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(webPort)], { cwd: root, env, stdio: 'inherit', detached: true }),
  ];
  writeJson(meta, { pid: kids[0].pid, devPids: kids.map(k => k.pid), port, url: `http://127.0.0.1:${port}`, root, socket: `tbsb-${name}`, started: new Date().toISOString(), ownerTask: process.env.TASK_ID || undefined });
  const stop = () => { kids.forEach(k => { try { process.kill(-k.pid, 'SIGTERM'); } catch { /* gone */ } }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
