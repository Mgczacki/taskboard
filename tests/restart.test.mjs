// Tests for scripts/restart.mjs, `tb restart`, the guard rule and the /api/restart routes. Every server here is a
// sandbox: its own TASKBOARD_DIR, vault, port and tmux socket in the system temp folder. Nothing touches ~/.taskboard.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describeImpact, restartTaskboard } from '../scripts/restart.mjs';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const script = join(checkout, 'scripts', 'restart.mjs');
const guard = join(checkout, 'server', 'hooks', 'guard.mjs');
const tb = join(checkout, 'bin', 'tb');
const root = mkdtempSync(join(tmpdir(), 'tb-restart-'));
const sockets = [];
const pids = [];
after(() => {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const s of sockets) { try { execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* none */ } }
  for (const s of sockets) rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, s), { force: true });
  rmSync(root, { recursive: true, force: true });
});
const env = { ...process.env }; delete env.TASK_ID; delete env.TB_URL; delete env.TB_TOKEN_FILE;
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const info = async url => { try { const r = await fetch(url + '/api/info', { signal: AbortSignal.timeout(2000) }); return r.ok ? r.json() : null; } catch { return null; } };
async function waitFor(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 300)); } return null; }

// a sandbox server of this checkout, with one task whose agent session is a `sleep` in the sandbox's tmux socket
async function sandbox(name) {
  const dir = join(root, name), port = await freePort(), socket = `tbrst-test-${process.pid}-${name}`;
  sockets.push(socket);
  mkdirSync(join(dir, 'tbdir'), { recursive: true }); mkdirSync(join(dir, 'vault', 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'tbdir', 'machine.json'), JSON.stringify({ name: 'restart-test', controller: { autostart: false, remoteControl: false } }));
  writeFileSync(join(dir, 'vault', 'tasks', 'agent-task.md'), `---\nid: agent-task\nnum: 7\ntitle: Agent at work\nagent: claude\nstatus: working\ncwd: ${dir}\nfolder: ${dir}\nsession: tb-agent-task\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Agent at work\n`);
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'tb-agent-task', 'sleep 600']);
  const sbEnv = { ...env, TASKBOARD_DIR: join(dir, 'tbdir'), TASKBOARD_VAULT: join(dir, 'vault'), TASKBOARD_PORT: String(port), TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'restart-test' };
  const out = join(dir, 'tbdir', 'server.log');
  const child = spawn(join(checkout, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], { cwd: checkout, env: sbEnv, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  const first = await waitFor(() => info(url));
  assert.ok(first, `the sandbox did not start; log ${out}`);
  pids.push(first.pid);
  const token = readFileSync(join(dir, 'tbdir', 'token'), 'utf8').trim();
  const sessionPane = () => execFileSync('tmux', ['-L', socket, 'list-panes', '-t', '=tb-agent-task', '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim();
  return { dir, url, port, socket, env: sbEnv, token, first, sessionPane, tbDir: join(dir, 'tbdir') };
}

test('the text says first what a restart does and asks only when work stops', () => {
  assert.equal(describeImpact(null, false).mustConfirm, false);
  assert.equal(describeImpact(null, true).mustConfirm, true);
  const quiet = describeImpact({ sessions: [{ num: 1, title: 'a', status: 'working' }], stops: [], notes: [], tmuxStops: false }, true);
  assert.equal(quiet.mustConfirm, false);
  assert.match(quiet.lines[0], /1 agent session keeps running in tmux/);
  const loud = describeImpact({ sessions: [], stops: [{ num: 4, title: 'Docs', what: 'the answer to the running Ask question is lost' }], notes: [], tmuxStops: false }, true);
  assert.equal(loud.mustConfirm, true);
  assert.ok(loud.lines.includes('  - #4 Docs: the answer to the running Ask question is lost'));
  assert.equal(describeImpact({ sessions: [{ num: 1, title: 'a', status: 'working' }], stops: [], notes: [], tmuxStops: true, tmuxPid: 9 }, true).mustConfirm, true);
});

test('a task cannot run the script or tb restart, and the controller gets only a dashboard request', () => {
  const r = spawnSync(process.execPath, [script, '--yes'], { env: { ...env, TASK_ID: 'task-1', TASKBOARD_DIR: join(root, 'none') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Only the user restarts Taskboard/);
  const t = spawnSync(process.execPath, [tb, 'restart', '--yes'], { env: { ...env, TASK_ID: 'task-1' }, encoding: 'utf8' });
  assert.equal(t.status, 1);
  assert.match(t.stderr, /only the user restarts Taskboard/);
  const g = (command, taskId) => spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', env: { ...env, TASKBOARD_DIR: join(root, 'guard'), TASK_ID: taskId } }).stdout;
  assert.match(g('tb restart', 'task-1'), /permissionDecision.*deny/);
  assert.match(g('env -u TASK_ID tb restart --yes', 'task-1'), /permissionDecision.*deny/);
  assert.match(g('~/.taskboard/bin/tb restart', 'task-1'), /permissionDecision.*deny/);
  assert.match(g('node scripts/restart.mjs --yes', 'task-1'), /permissionDecision.*deny/);
  assert.match(g('node ~/.taskboard/app/scripts/restart.mjs', 'controller'), /permissionDecision.*deny/);
  assert.match(g('launchctl kickstart -k gui/501/com.taskboard.server', 'task-1'), /permissionDecision.*deny/);
  assert.equal(g('tb restart', 'controller'), '');
  assert.equal(g('tb list', 'task-1'), '');
});

test('the restart routes refuse tasks and requests without the dashboard', async () => {
  const s = await sandbox('routes');
  const post = (path, headers) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': s.token, ...headers }, body: '{}' }).then(r => r.status);
  assert.equal(await post('/api/restart', {}), 403);
  assert.equal(await post('/api/restart', { origin: s.url, 'x-tb-actor': 'agent-task' }), 403);
  assert.equal(await post('/api/restart/request', { 'x-tb-actor': 'agent-task' }), 403);
  assert.equal(await post('/api/restart/request', { 'x-tb-actor': 'controller' }), 403); // no controller secret
  const impact = await fetch(s.url + '/api/restart/check', { headers: { 'x-taskboard-token': s.token } }).then(r => r.json());
  assert.deepEqual(impact.sessions.map(x => x.num), [7]);
  assert.equal(impact.tmuxStops, false);
  assert.equal(await fetch(s.url + '/api/restart/check').then(r => r.status), 403);
  assert.equal((await info(s.url)).pid, s.first.pid);
});

test('the script restarts a sandbox server and the agent session keeps running', { timeout: 120000 }, async () => {
  const s = await sandbox('script');
  const pane = s.sessionPane();
  const r = spawnSync(process.execPath, [script, '--yes'], { env: s.env, encoding: 'utf8', timeout: 100000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /What a restart does:\n {2}1 agent session keeps running in tmux/);
  assert.match(r.stdout, /Taskboard restarted: process \d+ stopped, process \d+ answers/);
  assert.match(r.stdout, /1 agent session running in tmux/);
  const now = await info(s.url);
  pids.push(now.pid);
  assert.notEqual(now.pid, s.first.pid);
  assert.equal(alive(s.first.pid), false);
  assert.equal(s.sessionPane(), pane, 'the same agent process runs in tmux');
  const result = JSON.parse(readFileSync(join(s.tbDir, 'restart-result.json'), 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.newPid, now.pid);
});

test('the dashboard restart runs the script as its own process', { timeout: 120000 }, async () => {
  const s = await sandbox('dashboard');
  const r = await fetch(s.url + '/api/restart', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.url }, body: JSON.stringify({ confirm: true }) });
  assert.equal(r.status, 202);
  const now = await waitFor(async () => { const i = await info(s.url); return i && i.pid !== s.first.pid ? i : null; }, 90000);
  assert.ok(now, `no new server; ${readFileSync(join(s.tbDir, 'restart.log'), 'utf8')}`);
  pids.push(now.pid);
  const last = await waitFor(async () => { const x = await fetch(s.url + '/api/restart/last', { headers: { 'x-taskboard-token': s.token } }).then(r => r.json()); return x?.ok ? x : null; });
  assert.equal(last.newPid, now.pid);
  assert.ok(s.sessionPane());
});

test('installed code that does not start leaves the running server alone', { timeout: 120000 }, async () => {
  const s = await sandbox('broken');
  const app = join(root, 'broken-app');
  mkdirSync(join(app, 'server'), { recursive: true }); symlinkSync(join(checkout, 'node_modules'), join(app, 'node_modules'));
  writeFileSync(join(app, 'server', 'index.ts'), 'throw new Error("broken release");\n');
  const lines = [];
  const r = await restartTaskboard({ tbDir: s.tbDir, appDir: app, url: s.url, env: s.env, launchd: false, yes: true, log: l => lines.push(l) });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not pass its start check/);
  assert.ok(lines.some(l => /did not start in a test run.*Log: /.test(l)));
  assert.equal((await info(s.url)).pid, s.first.pid, 'the old server still answers');
});

test('a failed start prints the error and the log path', { timeout: 120000 }, async () => {
  const s = await sandbox('nostart');
  const app = join(root, 'broken-app2');
  mkdirSync(join(app, 'server'), { recursive: true }); symlinkSync(join(checkout, 'node_modules'), join(app, 'node_modules'));
  writeFileSync(join(app, 'server', 'index.ts'), 'console.error("broken release"); process.exit(1);\n');
  const r = await restartTaskboard({ tbDir: s.tbDir, appDir: app, url: s.url, env: s.env, launchd: false, yes: true, check: false, startMs: 3000, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(`Log: ${join(s.tbDir, 'server.log')}`));
  assert.match(r.message, /broken release/);
  assert.equal(alive(s.first.pid), false);
});

test('a lock file that names another process stops nothing', async () => {
  const s = await sandbox('lock');
  writeFileSync(join(s.tbDir, 'server.pid'), JSON.stringify({ pid: 1, url: s.url, started: 'x' }));
  const r = await restartTaskboard({ tbDir: s.tbDir, appDir: checkout, url: s.url, env: s.env, launchd: false, yes: true, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /Nothing was stopped/);
  assert.equal((await info(s.url)).pid, s.first.pid);
  assert.ok(existsSync(join(s.tbDir, 'restart-result.json')));
});
