import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// One folder for the modules loaded here and for the test server started below. The fixture tasks and accounts are
// written before the server starts; afterwards only the server writes to the folder.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-max-parallel-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-max-parallel-test-${process.pid}`;
mkdirSync(join(root, 'state'), { recursive: true });
const now = new Date().toISOString();
const fixtureAccounts = [
  { id: 'claude-default', agent: 'claude', name: 'Claude Code (default)', dir: join(root, 'home', '.claude'), isDefault: true, maxParallel: 8, created: now },
  { id: 'codex-work', agent: 'codex', name: 'Codex work', dir: join(root, 'home', '.codex-work'), maxParallel: 2, created: now },
];
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify(fixtureAccounts));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'max-parallel-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: false, trustWorkspaces: false, autoReview: false } }));

const accounts = await import('../server/accounts.ts');
const machine = await import('../server/machine.ts');
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const load = await import('../server/load.ts');
const { TOKEN_FILE } = await import('../server/config.ts');

for (const num of [1, 2]) store.create({ id: `busy-${num}`, num, title: `Busy ${num}`, agent: 'codex', account: 'codex-work', status: 'working', cwd: root, folder: root, session: `task-${num}`, desc: '' });

test('each refusal names its own reason', () => {
  const a = accounts.get('codex-work')!;
  assert.equal(accounts.unavailable(a, 1), undefined);
  assert.equal(accounts.unavailable(a, 2), 'Account codex-work is at its limit of 2 tasks (raise it on the Accounts page).');
  const inAnHour = Date.now() + 3600000;
  const full = { ...a, usage: { windows: [{ label: '5-hour', usedPct: 100, resetsAt: inAnHour }], at: now, source: 'test' } };
  assert.match(accounts.unavailable(full, 0)!, /^Account codex-work is at 100% usage until (?:\w{3} \d{1,2} \w{3} )?\d\d:\d\d\.$/);
  const past = { ...full, usage: { ...full.usage, windows: [{ label: '5-hour', usedPct: 100, resetsAt: Date.now() - 1000 }] } };
  assert.equal(accounts.unavailable(past, 0), undefined, 'a window that already reset does not block');
  const limited = { ...a, limited: { at: now, note: 'rate limit reached' } };
  assert.match(accounts.unavailable(limited, 0)!, /^Account codex-work stopped at a usage limit at \d\d:\d\d \(rate limit reached\)\./);
});

test('the maximum is a whole number from 1 to 100', () => {
  for (const bad of [0, 101, 2.5, -1, '', 'x', null]) assert.throws(() => machine.checkMaxParallel(bad), /whole number from 1 to 100/, String(bad));
  assert.equal(machine.checkMaxParallel('7'), 7);
  assert.throws(() => accounts.update('codex-work', { maxParallel: 0 }), /whole number from 1 to 100/);
  assert.equal(accounts.get('codex-work')!.maxParallel, 2);
});

test('a start on a full account is refused with the limit and the running tasks keep running', async () => {
  await assert.rejects(agents.startTask({ title: 'One more', desc: 'x', agent: 'codex', folder: root, account: 'codex-work' }), /^Error: Account codex-work is at its limit of 2 tasks \(raise it on the Accounts page\)\.$/);
  accounts.update('codex-work', { maxParallel: 1 });
  assert.deepEqual(store.all().filter(t => t.account === 'codex-work').map(t => t.status), ['working', 'working']);
  await assert.rejects(agents.startTask({ title: 'One more', desc: 'x', agent: 'codex', folder: root, account: 'codex-work' }), /at its limit of 1 tasks/);
  // the other codex account is marked limited here, so pick asks no CLI for its sign-in
  accounts.get('codex-default')!.limited = { at: now, note: 'fixture' };
  await assert.rejects(accounts.pick('codex', agents.runningOn), /No codex account is available \(Account codex-work is at its limit of 1 tasks \(raise it on the Accounts page\); Account codex-default stopped at a usage limit/);
  delete accounts.get('codex-default')!.limited;
  accounts.update('codex-work', { maxParallel: 2 });
});

test('agent memory sums each pane process and its descendants', () => {
  const ps = ['  10     1  1024', '  11    10  2048', '  12    11   512', '  20     1  4096', '  21     5  9999'].join('\n');
  assert.deepEqual(load.treeKb(ps, [10, 20, 99]), [3584, 4096, 0]);
  assert.equal(load.noteAbove(64 * 1024 ** 3), 32);
  assert.equal(load.noteAbove(16 * 1024 ** 3), 8);
});

test('only the dashboard changes maximums; tb shows the precise refusal', async () => {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fake = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === 'auth status') console.log(JSON.stringify({ loggedIn: true, email: 'test@example.invalid' }));
else if (a === 'login status') console.log('Logged in using ChatGPT');
else if (a === 'models') console.log('model\\tfixture');
`;
  for (const name of ['claude', 'codex', 'agy']) { const p = join(bin, name); writeFileSync(p, fake); chmodSync(p, 0o755); }
  // the two running fixture tasks need tmux sessions on the test socket, or the server marks them suspended
  const socket = process.env.TASKBOARD_TMUX_SOCKET!;
  for (const name of ['task-1', 'task-2']) execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, 'sleep 600']);
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(r => probe.close(() => r()));
  const env = { ...process.env, HOME: join(root, 'home'), TASKBOARD_PORT: String(port), PATH: `${bin}:${process.env.PATH}` };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const url = `http://127.0.0.1:${port}`;
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const as = (who: 'dashboard' | 'tb' | 'agent') => who === 'dashboard' ? { origin: url } : { 'x-taskboard-token': token, ...(who === 'agent' ? { 'x-tb-actor': 'busy-1' } : {}) };
  const request = async (method: string, path: string, who: 'dashboard' | 'tb' | 'agent', body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...as(who) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const tb = (args: string[]) => new Promise<{ code: number | null; out: string }>(done => {
    const p = spawn(process.execPath, ['bin/tb', ...args], { env: { ...env, TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE, TASK_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('exit', code => done({ code, out }));
  });
  try {
    let up = false;
    let last = 0;
    for (let i = 0; i < 100 && !up; i++) { try { last = (await request('GET', '/api/info', 'tb')).status; up = last === 200; } catch { /* not listening yet */ } if (!up) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(up, `status ${last}\n${output}`);

    // the per-account maximum: refused for tb and agents, validated for the dashboard
    assert.equal((await request('PATCH', '/api/accounts/codex-work', 'tb', { maxParallel: 50 })).status, 403);
    assert.equal((await request('PATCH', '/api/accounts/codex-work', 'agent', { maxParallel: 50 })).status, 403);
    assert.equal((await request('PATCH', '/api/accounts/codex-work', 'tb', { routingRules: 'Routine work.' })).status, 200, 'routing rules are unchanged');
    const bad = await request('PATCH', '/api/accounts/codex-work', 'dashboard', { maxParallel: 0 });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /whole number from 1 to 100/);
    assert.equal((await request('PATCH', '/api/accounts/codex-work', 'dashboard', { maxParallel: 101 })).status, 400);

    // tb new on the full account prints the same text as the dashboard
    const refused = await tb(['new', '--agent', 'codex', '--account', 'codex-work', '--folder', root, '--title', 'Refused', 'Do nothing.']);
    assert.equal(refused.code, 1); assert.match(refused.out, /tb: Account codex-work is at its limit of 2 tasks \(raise it on the Accounts page\)\./);
    assert.match((await tb(['accounts'])).out, /codex-work \(Codex work; codex\): signed in; 2\/2 tasks/);

    // lowering the maximum below the running count keeps the tasks
    const lowered = await request('PATCH', '/api/accounts/codex-work', 'dashboard', { maxParallel: 1 });
    assert.equal(lowered.status, 200); assert.equal(lowered.data.maxParallel, 1);
    const tasks = (await request('GET', '/api/tasks', 'tb')).data as { id: string; status: string }[];
    const busy = tasks.filter(t => t.id.startsWith('busy-'));
    assert.equal(busy.length, 2); assert.ok(busy.every(t => !['archived', 'parked', 'suspended'].includes(t.status)), JSON.stringify(busy));

    // the default for accounts added later, in machine.json
    assert.equal((await request('PATCH', '/api/info', 'tb', { defaultMaxParallel: 9 })).status, 403);
    assert.equal((await request('PATCH', '/api/info', 'dashboard', { defaultMaxParallel: 0 })).status, 400);
    const info = await request('PATCH', '/api/info', 'dashboard', { defaultMaxParallel: 9 });
    assert.equal(info.data.settings.accounts.defaultMaxParallel, 9);
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8')).accounts.defaultMaxParallel, 9);
    const added = await request('POST', '/api/accounts', 'dashboard', { agent: 'claude', name: 'Added' });
    assert.equal(added.data.maxParallel, 9);
    let list = (await request('GET', '/api/accounts', 'tb')).data as { id: string; maxParallel: number }[];
    assert.deepEqual(list.map(a => [a.id, a.maxParallel]), [['claude-default', 8], ['codex-work', 1], ['codex-default', 8], ['antigravity-default', 8], ['claude-added', 9]]);

    // Apply to all accounts
    assert.equal((await request('PATCH', '/api/info', 'agent', { applyMaxParallelToAll: true })).status, 403);
    assert.equal((await request('PATCH', '/api/info', 'dashboard', { applyMaxParallelToAll: true })).status, 200);
    list = (await request('GET', '/api/accounts', 'tb')).data;
    assert.ok(list.every(a => a.maxParallel === 9), JSON.stringify(list));

    const agentLoad = (await request('GET', '/api/agent-load', 'tb')).data;
    assert.equal(agentLoad.agents, 2); assert.ok(agentLoad.medianMb >= 0 && agentLoad.totalMb < 100, JSON.stringify(agentLoad)); assert.ok(agentLoad.noteAbove >= 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});
