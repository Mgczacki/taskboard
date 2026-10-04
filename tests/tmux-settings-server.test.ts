// A scratch Taskboard server (its own port, TASKBOARD_DIR, TASKBOARD_VAULT and tmux socket) with a stand-in for
// Claude Code. The scratch tmux server ends while the Taskboard server runs, and the next task start must give the new
// tmux server the Taskboard settings again (on 4 October 2026 it did not: every console showed a green status bar).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-tmux-settings-server-')));
const socket = `tb-tmux-settings-server-${process.pid}`;
const dir = join(root, 'state'); mkdirSync(dir); mkdirSync(join(root, 'vault'));
writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'tmux-settings-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: false, trustWorkspaces: false, autoReview: false } }));
// a stand-in for Claude Code: signed in, and it keeps running
const bin = join(root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/bin/sh\n[ "$1" = auth ] && { echo '{"loggedIn":true,"email":"test@example.com"}'; exit 0; }\nexec sleep 600\n`); chmodSync(join(bin, 'claude'), 0o755);
const work = join(root, 'work'); mkdirSync(work);

const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const endScratch = () => { try { tmux('kill' + '-server'); } catch { /* not running */ } };
const show = (o: string) => tmux('show-options', '-gqv', o);
const expectSettings = (when: string) => {
  const want: Record<string, string> = { status: 'off', mouse: 'on', 'escape-time': '0', 'history-limit': '5000', 'remain-on-exit': 'on', 'extended-keys': 'on' };
  for (const [k, v] of Object.entries(want)) assert.equal(show(k), v, `${when}: ${k}`);
  assert.match(tmux('show-hooks', '-g', 'alert-bell'), /api\/hooks\/bell/, `${when}: bell hook`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, ms = 10000) { for (let i = 0; i < ms / 100 && !check(); i++) await sleep(100); }

test('the tmux server gets the Taskboard settings at server start, after it ends, and when a process window starts it', { timeout: 120000 }, async () => {
  // a tmux server with the tmux defaults runs before the Taskboard server starts
  tmux('new-session', '-d', '-s', 'before', 'sleep 600');
  assert.equal(show('status'), 'on');
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: dir, TASKBOARD_VAULT: join(root, 'vault'), TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'tmux-settings-test' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  try {
    let token = '';
    for (let i = 0; i < 200; i++) {
      try { token = readFileSync(join(dir, 'token'), 'utf8').trim(); if ((await fetch(url + '/api/info', { headers: { 'x-taskboard-token': token } })).ok) break; } catch { /* not listening yet */ }
      await sleep(100);
    }
    const info = await (await fetch(url + '/api/info', { headers: { 'x-taskboard-token': token } })).json();
    assert.deepEqual({ running: info.tmuxSettings?.running, differ: info.tmuxSettings?.differ }, { running: true, differ: [] }, output);
    expectSettings('after the server start');
    assert.match(output, /set the Taskboard settings again\. These differed: .*status/);

    const start = async (title: string) => {
      const r = await fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ title, desc: title, agent: 'claude', folder: work, worktree: false }) });
      assert.equal(r.status, 200, await r.clone().text());
      const t = await r.json();
      await until(() => { try { return tmux('has-session', '-t', '=' + t.session) === ''; } catch { return false; } });
    };
    await start('one');
    expectSettings('after the first task');

    // the tmux server ends while the Taskboard server runs; the next task starts a new tmux server
    endScratch();
    await start('two');
    expectSettings('after the tmux server ended and a task started');

    // a process window (tb run, task-procs.ts) starts the new tmux server before the next task
    endScratch();
    tmux('new-session', '-d', '-s', 'proc-x', 'sleep 600');
    await start('three');
    expectSettings('after a process window started the tmux server');

    assert.ok(!output.includes(token), 'the server log does not contain the token');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    endScratch();
    rmSync(root, { recursive: true, force: true });
  }
});
