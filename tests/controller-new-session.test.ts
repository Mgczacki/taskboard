import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-controller-new-session-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-controller-new-session-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'new-session-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: true, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));
// a stand-in for Claude Code: it records its arguments and keeps running
const bin = join(root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" > ${join(root, 'args')}\nexec sleep 600\n`); chmodSync(join(bin, 'claude'), 0o755);
const store = await import('../server/store.ts');
const { TOKEN_FILE } = await import('../server/config.ts');
const transcript = join(root, 'old.jsonl'); writeFileSync(transcript, '');
store.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'working', cwd: root, folder: root, session: 'tb-controller', sessionId: 'old-session', transcript, role: 'controller', desc: '' });

test('the dashboard starts the controller in a new session', { timeout: 60000 }, async () => {
  const socket = process.env.TASKBOARD_TMUX_SOCKET!;
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'tb-controller', 'sleep 600']);
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_MACHINE_NAME: 'new-session-test' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const request = async (path: string, actor: 'controller' | 'dashboard', body: object) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(actor === 'dashboard' ? { origin: url } : { 'x-taskboard-token': token, 'x-tb-actor': 'controller' }) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(url + '/api/info', { headers: { 'x-taskboard-token': token } })).status === 200; } catch { /* not listening yet */ } if (!up) await new Promise(done => setTimeout(done, 100)); }
    assert.ok(up, output);
    assert.equal((await request('/api/controller/new-session', 'controller', { when: 'now' })).status, 403);

    const later = await request('/api/controller/new-session', 'dashboard', { when: 'after-turn' });
    assert.equal(later.status, 200); assert.equal(later.data.newSessionWhenDone, true); assert.equal(later.data.sessionId, 'old-session');
    const cancelled = await request('/api/controller/new-session', 'dashboard', { when: 'cancel' });
    assert.equal(cancelled.data.newSessionWhenDone, undefined);

    const now = await request('/api/controller/new-session', 'dashboard', { when: 'now' });
    assert.equal(now.status, 200, JSON.stringify(now.data) + output);
    assert.notEqual(now.data.sessionId, 'old-session'); assert.equal(now.data.transcript, undefined); assert.equal(now.data.status, 'idle');
    for (let i = 0; i < 50 && !existsSync(join(root, 'args')); i++) await new Promise(done => setTimeout(done, 100));
    const args = readFileSync(join(root, 'args'), 'utf8');
    assert.match(args, new RegExp(`--session-id ${now.data.sessionId}`)); assert.doesNotMatch(args, /--resume/);
    assert.match(readFileSync(store.logFile('controller'), 'utf8'), /- Did: Controller started in a new session\./);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    try { execFileSync('tmux', ['-L', socket, 'kill-session', '-t', 'tb-controller'], { stdio: 'ignore' }); } catch { /* test session is already gone */ }
  }
});
