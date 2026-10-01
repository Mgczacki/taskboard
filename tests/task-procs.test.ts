// Processes of a task (server/task-procs.ts) on a tmux server of the test's own: start, log, exit, stop of the whole
// process group, a child that left the group (setsid), suspend and resume, and the port read from the log.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-procs-')));
const socket = `tb-procs-${process.pid}`;
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = socket;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'procs-test', controller: { autostart: false, remoteControl: false } }));
const procs = await import('../server/task-procs.ts');
after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ } });

const owner = (id: string) => ({ kind: 'task' as const, id, session: `proc-${id}`, dir: join(root, 'vault', 'tasks', id), env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(100); }
  return false;
}

test('portFromText reads the port that a dev server prints', () => {
  assert.equal(procs.portFromText('  ➜  Local:   http://localhost:5173/'), 5173);
  assert.equal(procs.portFromText('Serving HTTP on :: port 8000 (http://[::]:8000/) ...'), 8000);
  assert.equal(procs.portFromText('listening on port 3000'), 3000);
  assert.equal(procs.portFromText('no port here'), undefined);
});

test('a process starts in tmux, writes its log, and stops with its whole group', async () => {
  const o = owner('t1');
  const p = await procs.start(o, { name: 'web', command: 'echo first line; echo "listening on port 4567"; python3 -c "import time; time.sleep(300)" & python3 -c "import time; time.sleep(301)"', cwd: root, startedBy: 'user' });
  assert.equal(p.state, 'starting');
  assert.ok(p.pid);
  assert.ok(await until(async () => (await procs.refresh(o)).find(x => x.name === 'web')?.state === 'running'));
  assert.ok(await until(() => readFileSync(procs.logFile(o, 'web'), 'utf8').includes('first line')), 'the first line of output is in the log');
  const listed = (await procs.refresh(o)).find(x => x.name === 'web')!;
  assert.equal(listed.port, 4567);
  let children: number[] = [];
  assert.ok(await until(async () => (children = await procs.marked('t1', 'web')).length >= 2), 'the processes carry TB_PROC_OWNER and TB_PROC_NAME');
  // this test's first tmux command started the tmux server; the search must never return it
  const server = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}']).toString().trim());
  assert.ok(server > 0 && !(await procs.marked('t1')).includes(server), 'the tmux server is never a marked process');
  await assert.rejects(procs.start(o, { name: 'web', command: 'true', cwd: root, startedBy: 'user' }), /already running/);
  const list = await procs.stop(o, 'web');
  assert.equal(list.find(x => x.name === 'web')!.state, 'stopped');
  for (const pid of children) assert.ok(await until(() => !alive(pid)), `process ${pid} ended`);
});

test('a process that exits is shown as exited with its code', async () => {
  const o = owner('t2');
  await procs.start(o, { name: 'fail', command: 'echo bad; exit 3', cwd: root, startedBy: 'agent' });
  assert.ok(await until(async () => (await procs.refresh(o)).find(x => x.name === 'fail')?.state === 'exited'));
  assert.equal((await procs.refresh(o)).find(x => x.name === 'fail')!.exitCode, 3);
});

test('stopAll also ends a child that left the process group, and runs the stop command first', async () => {
  const o = owner('t3');
  const marker = join(root, 'stopped-by-command');
  await procs.start(o, { name: 'db', command: `python3 -c "import os,time; os.setsid(); time.sleep(300)" & sleep 302`, stop: `touch ${marker}`, cwd: root, startedBy: 'user' });
  let escaped: number[] = [];
  assert.ok(await until(async () => {
    const out = execFileSync('ps', ['-axo', 'pid=,pgid=,command=']).toString();
    escaped = out.split('\n').filter(l => l.includes('os.setsid()') && !l.includes('/bin/sh')).map(l => Number(l.trim().split(/\s+/)[0]));
    return escaped.length > 0;
  }), 'the setsid child runs');
  const n = await procs.stopAll(o, 'stopped');
  assert.equal(n, 1);
  assert.ok(readFileSync(marker) !== undefined, 'the stop command ran');
  for (const pid of escaped) assert.ok(await until(() => !alive(pid)), `the child ${pid} that left the group ended`);
  assert.equal((await procs.refresh(o)).find(x => x.name === 'db')!.state, 'stopped');
});

test('suspend stops processes; resume starts only the ones the suspend stopped', async () => {
  const o = owner('t4');
  await procs.start(o, { name: 'a', command: 'sleep 300', cwd: root, startedBy: 'user' });
  await procs.start(o, { name: 'b', command: 'sleep 300', cwd: root, startedBy: 'user' });
  await procs.stop(o, 'b'); // stopped by hand
  await procs.start(o, { name: 'c', command: 'exit 2', cwd: root, startedBy: 'user' });
  assert.ok(await until(async () => (await procs.refresh(o)).find(x => x.name === 'c')?.state === 'exited'));
  await procs.stopAll(o, 'suspended');
  let list = await procs.refresh(o);
  assert.equal(list.find(x => x.name === 'a')!.state, 'suspended');
  assert.equal(list.find(x => x.name === 'b')!.state, 'stopped');
  assert.equal(list.find(x => x.name === 'c')!.state, 'exited', 'an exited process is not marked as suspended');
  assert.equal(await procs.resumeSuspended(o), 1);
  assert.ok(await until(async () => (await procs.refresh(o)).find(x => x.name === 'a')?.state === 'running'));
  list = await procs.refresh(o);
  assert.equal(list.find(x => x.name === 'b')!.state, 'stopped');
  await procs.stopAll(o, 'stopped');
});

test('a window that disappears (for example after a reboot) is shown as stopped', async () => {
  const o = owner('t5');
  await procs.start(o, { name: 'gone', command: 'sleep 300', cwd: root, startedBy: 'user' });
  execFileSync('tmux', ['-L', socket, 'kill-session', '-t', '=proc-t5']);
  const p = (await procs.refresh(o)).find(x => x.name === 'gone')!;
  assert.equal(p.state, 'stopped');
  assert.match(p.stopNote || '', /window is gone/);
});

test('names and folders are checked', async () => {
  const o = owner('t6');
  assert.throws(() => procs.start(o, { name: '../x', command: 'true', cwd: root, startedBy: 'user' }), /process name/);
  assert.throws(() => procs.start(o, { name: 'x', command: 'true', cwd: join(root, 'missing'), startedBy: 'user' }), /does not exist/);
});
