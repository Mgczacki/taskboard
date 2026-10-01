import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-controller-resume-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-controller-resume-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
const now = new Date().toISOString();
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify([
  { id: 'codex-work', agent: 'codex', name: 'Codex work', dir: join(root, 'codex'), maxParallel: 2, created: now },
  { id: 'codex-limited', agent: 'codex', name: 'Codex limited', dir: join(root, 'codex-limited'), maxParallel: 2, created: now, limited: { at: now, note: 'rate limit reached' } },
  { id: 'codex-full', agent: 'codex', name: 'Codex full', dir: join(root, 'codex-full'), maxParallel: 2, created: now, usage: { windows: [{ label: '5-hour', usedPct: 100, resetsAt: Date.now() + 3600000 }], at: now, source: 'test' } },
]));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'resume-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: true, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));
const store = await import('../server/store.ts');
const { TOKEN_FILE } = await import('../server/config.ts');
for (const [id, num, status, account] of [
  ['parked', 1, 'parked', 'codex-work'],
  ['archived', 2, 'archived', 'codex-work'],
  ['busy', 3, 'working', 'codex-work'],
  ['limited', 4, 'parked', 'codex-limited'],
  ['full', 5, 'archived', 'codex-full'],
] as const) store.create({ id, num, title: id, agent: 'codex', account, status, cwd: root, folder: root, session: `task-${num}`, sessionId: `session-${num}`, desc: '' });

test('tb resume uses the panel status route and keeps approval cards', { timeout: 60000 }, async () => {
  const socket = process.env.TASKBOARD_TMUX_SOCKET!;
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'task-1', 'sleep 600']);
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'task-3', 'sleep 600']);
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_MACHINE_NAME: 'resume-test' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const request = async (method: string, path: string, actor: 'controller' | 'dashboard' | 'read', body?: object) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(actor === 'dashboard' ? { origin: url } : { 'x-taskboard-token': token, ...(actor === 'controller' ? { 'x-tb-actor': 'controller' } : {}) }) }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const tb = (args: string[]) => new Promise<{ code: number | null; out: string }>(done => {
    const p = spawn(process.execPath, ['bin/tb', ...args], { env: { ...env, TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE, TASK_ID: 'controller' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.once('exit', code => done({ code, out }));
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await request('GET', '/api/info', 'read')).status === 200; } catch { /* not listening yet */ } if (!up) await new Promise(done => setTimeout(done, 100)); }
    assert.ok(up, output);
    const pending = await request('POST', '/api/tasks/parked/send', 'controller', { text: 'Keep the pending card' });
    assert.equal(pending.status, 202);
    const card = pending.data.approval.id;
    const off = await tb(['resume', '1']);
    assert.equal(off.code, 1); assert.match(off.out, /cannot resume tasks while.*Settings/);
    assert.equal((await request('GET', '/api/tasks', 'read')).data.find((t: { id: string }) => t.id === 'parked').status, 'parked');
    assert.equal((await request('PATCH', '/api/info', 'dashboard', { controllerNeedsApproval: false })).status, 200);

    const parked = await tb(['resume', '1']);
    assert.equal(parked.code, 0); assert.match(parked.out, /#1 resumed\. Status: idle/);
    assert.equal(execFileSync('tmux', ['-L', socket, 'has-session', '-t', 'task-1']).length, 0);
    assert.equal((await request('GET', `/api/approvals/${card}`, 'read')).data.state, 'pending');
    assert.match(readFileSync(store.logFile('parked'), 'utf8'), /## \d{4}-\d\d-\d\d \d\d:\d\d\n- Did: Task resumed by the controller\./);
    assert.equal((await request('GET', '/api/tasks', 'read')).data.find((t: { id: string }) => t.id === 'parked').statusSource, 'Resumed by the controller.');
    const already = await tb(['resume', '1']);
    assert.equal(already.code, 1); assert.match(already.out, /Only parked or archived tasks/);
    const running = await tb(['resume', '3']);
    assert.equal(running.code, 1); assert.match(running.out, /#3 is working/);

    assert.equal((await request('POST', '/api/tasks/parked/status', 'dashboard', { status: 'parked' })).status, 200);
    const archived = await tb(['resume', '2']);
    assert.equal(archived.code, 0); assert.match(archived.out, /#2 resumed\. Status: idle/);
    assert.equal((await request('GET', '/api/tasks', 'read')).data.find((t: { id: string }) => t.id === 'archived').status, 'idle');
    assert.throws(() => execFileSync('tmux', ['-L', socket, 'has-session', '-t', 'task-2'], { stdio: 'ignore' }));

    const limited = await tb(['resume', '4']);
    assert.equal(limited.code, 1); assert.match(limited.out, /Account codex-limited stopped at a usage limit/);
    const usage = await tb(['resume', '5']);
    assert.equal(usage.code, 1); assert.match(usage.out, /Account codex-full is at 100% usage/);
    assert.equal((await request('PATCH', '/api/accounts/codex-work', 'dashboard', { maxParallel: 1 })).status, 200);
    const full = await tb(['resume', '1']);
    assert.equal(full.code, 1); assert.match(full.out, /Account codex-work is at its limit of 1 tasks/);
    const all = (await request('GET', '/api/tasks', 'read')).data;
    assert.equal(all.find((t: { id: string }) => t.id === 'parked').status, 'parked');
    assert.equal(all.find((t: { id: string }) => t.id === 'limited').status, 'parked');
    assert.equal(all.find((t: { id: string }) => t.id === 'full').status, 'archived');
    assert.equal((await request('GET', `/api/approvals/${card}`, 'read')).data.state, 'pending');
    const refusedSend = await tb(['send', '1', 'Hello']);
    assert.equal(refusedSend.code, 1); assert.match(refusedSend.out, /Run tb resume <task>, then send again/);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    for (const name of ['task-1', 'task-3']) try { execFileSync('tmux', ['-L', socket, 'kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* test session is already gone */ }
  }
});
