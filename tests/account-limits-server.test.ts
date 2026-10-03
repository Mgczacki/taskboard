import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { waitFor } from './helpers/wait-for.ts';

// A test Taskboard (own port, TASKBOARD_DIR, TASKBOARD_VAULT and tmux socket) with a fake codex. On the account
// folder codex-nocredit the fake prints what Codex 0.160.0 printed for tasks 163 and 164 and writes the same rollout lines.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-account-limits-server-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-account-limits-server-test-${process.pid}`;
mkdirSync(join(root, 'state'), { recursive: true });
const now = new Date().toISOString();
const acctDir = (name: string) => join(root, 'accounts', name);
const fixtureAccounts = [
  { id: 'codex-nocredit', agent: 'codex', name: 'Codex no credit', dir: acctDir('codex-nocredit'), maxParallel: 8, created: now,
    usage: { windows: [{ label: 'weekly', usedPct: 10 }], at: now, source: 'Codex session file' } },
  { id: 'codex-default', agent: 'codex', name: 'Codex (default)', dir: acctDir('codex-ok'), isDefault: true, maxParallel: 8, created: now },
  { id: 'codex-stale', agent: 'codex', name: 'Codex stale', dir: acctDir('codex-stale'), maxParallel: 8, created: now,
    usage: { windows: [{ label: 'weekly', usedPct: 1 }], at: new Date(Date.now() - 48 * 3600000).toISOString(), source: 'Codex session file' } },
  { id: 'claude-default', agent: 'claude', name: 'Claude Code (default)', dir: acctDir('claude'), isDefault: true, maxParallel: 8, created: now },
  { id: 'antigravity-default', agent: 'antigravity', name: 'Antigravity (default)', dir: acctDir('agy'), isDefault: true, maxParallel: 8, created: now },
];
for (const a of fixtureAccounts) mkdirSync(a.dir, { recursive: true });
mkdirSync(join(root, 'home', '.codex'), { recursive: true }); // the default Codex account writes its settings here
writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify(fixtureAccounts));
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'account-limits-server-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: false, trustWorkspaces: false, autoReview: false } }));
const { TOKEN_FILE } = await import('../server/config.ts');

const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const agent = path.basename(process.argv[1]), args = process.argv.slice(2);
if (agent === 'codex' && args.includes('app-server')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
} else if (args.includes('status')) { console.log(agent === 'claude' ? '{"loggedIn":true}' : 'Logged in using ChatGPT'); }
else if (agent === 'agy') { console.log('model\\tfixture'); }
else {
  const home = process.env.CODEX_HOME || '';
  fs.appendFileSync(path.join(process.env.TASK_DIR, 'launches.txt'), home + '\\n');
  if (home.includes('nocredit')) {
    const d = path.join(home, 'sessions', '2026', '10', '01'); fs.mkdirSync(d, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(d, 'rollout-' + Date.now() + '.jsonl'), [
      { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: null }, rate_limit_reached_type: 'workspace_member_credits_depleted' } } },
      { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', codex_error_info: 'usage_limit_exceeded' } } },
    ].map(o => JSON.stringify(o)).join('\\n') + '\\n');
    console.log('› Do the work.\\n\\n■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.\\n\\n  Usage limit reached\\n  Request a limit increase from your owner to continue using codex. Request increase?\\n› 1. Yes (y)\\n  2. No (default) (n)');
  } else console.log('TEST_AGENT_READY');
  setInterval(() => {}, 1000);
}
`;

test('a task without credit stops with its reason; an automatic choice moves once; your choice is refused, not switched', { timeout: 120000 }, async () => {
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['claude', 'codex', 'agy']) { const p = join(bin, name); writeFileSync(p, fake); chmodSync(p, 0o755); }
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(r => probe.close(() => r()));
  const socket = process.env.TASKBOARD_TMUX_SOCKET!;
  const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: acctDir('codex-ok'), TASKBOARD_PORT: String(port), TASKBOARD_MACHINE_NAME: 'test', PATH: `${bin}:${process.env.PATH}` };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const url = `http://127.0.0.1:${port}`;
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', 'x-taskboard-token': token, origin: url }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const tb = (args: string[]) => new Promise<{ code: number | null; out: string }>(done => {
    const p = spawn(process.execPath, ['bin/tb', ...args], { env: { ...env, TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE, TASK_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('exit', code => done({ code, out }));
  });
  const task = async (num: number) => ((await request('GET', '/api/tasks')).data as any[]).find(t => t.num === num);
  const account = async (id: string) => ((await request('GET', '/api/accounts')).data as any[]).find(a => a.id === id);
  const until = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 40000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}\n${output}\n${JSON.stringify((await request('GET', '/api/tasks')).data, null, 1)}`); await sleep(250); }
  };
  const launches = (id: string) => existsSync(join(root, 'vault', 'tasks', id, 'launches.txt')) ? readFileSync(join(root, 'vault', 'tasks', id, 'launches.txt'), 'utf8').trim().split('\n') : [];
  try {
    await until('server up', async () => (await request('GET', '/api/info').catch(() => ({ status: 0 }))).status === 200);

    // (c) old usage shows as stale and unknown
    const stale = await account('codex-stale');
    assert.equal(stale.usageStale, true); assert.equal(stale.usageStaleHours, 6);
    assert.equal((await account('codex-nocredit')).usageStale, false);
    assert.match((await tb(['accounts'])).out, /codex-stale \(Codex stale; codex\): signed in; 0\/8 tasks; weekly 1%; as of \S+ \(STALE: older than 6 h, counted as unknown\)/);

    // (b) and (e): no account chosen. The automatic choice takes codex-nocredit (10% used, fresh). The first screen shows
    // no credit: the account gets its mark, and the task starts once more on codex-default.
    const auto = await tb(['new', '--agent', 'codex', '--folder', root, '--no-worktree', '--title', 'Auto', 'Do the work.']);
    assert.equal(auto.code, 0, auto.out); assert.match(auto.out, /Started #1 Auto \(codex on codex-nocredit\)/);
    const moved = await until('task 1 moved', async () => { const t = await task(1); return t?.account === 'codex-default' && /started it again/.test(t.statusSource) && t; });
    assert.match(moved.statusSource, /^Codex no credit has no credit or has a billing problem: Your workspace is out of credits\. Ask your workspace owner to refill in order to continue\. No account was chosen for this task, so Taskboard started it again on Codex \(default\) at \d\d:\d\d\.$/);
    assert.equal(moved.status, 'working');
    await waitFor(() => launches(moved.id).length === 2, {
      description: 'the fake Codex agent to record both starts', timeoutMs: 60_000,
      state: () => `expected starts on codex-nocredit and codex-ok; launches: ${JSON.stringify(launches(moved.id))}; task: ${JSON.stringify(moved)}; server: ${output.slice(-3000)}`,
    });
    assert.deepEqual(launches(moved.id), [acctDir('codex-nocredit'), acctDir('codex-ok')], 'one retry, on the other account');
    const limited = (await account('codex-nocredit')).limited;
    assert.match(limited.note, /Your workspace is out of credits\. .*\(on #1\)$|Codex: Your workspace is out of credits/);
    assert.match(readFileSync(join(root, 'vault', 'tasks', moved.id, 'log.md'), 'utf8'), /started it again on Codex \(default\)/);
    await sleep(3000);
    assert.equal(launches(moved.id).length, 2, 'no second retry');

    // (a) your choice of an account with a mark is refused with the cause and the other accounts; no task is created
    const refused = await tb(['new', '--agent', 'codex', '--account', 'codex-nocredit', '--folder', root, '--no-worktree', '--title', 'Chosen', 'Do the work.']);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /tb: Account codex-nocredit stopped at a usage limit at \d\d:\d\d \(.*out of credits.*\)\. Clear the limit mark on the Accounts page after the limit resets\. Choose another Codex account: codex-default \(Codex \(default\), 1 running, usage unknown\); codex-stale \(Codex stale, 0 running, usage unknown, data 48 h old\)\./);
    assert.equal(await task(2), undefined);

    // (d) you clear the mark on the Accounts page. Your choice is then used; on no credit the task stops and stays there.
    assert.equal((await request('POST', '/api/accounts/codex-nocredit/clear-limit')).status, 200);
    assert.equal((await account('codex-nocredit')).limited, undefined);
    const chosen = await tb(['new', '--agent', 'codex', '--account', 'codex-nocredit', '--folder', root, '--no-worktree', '--title', 'Chosen', 'Do the work.']);
    assert.equal(chosen.code, 0, chosen.out); assert.match(chosen.out, /Started #2 Chosen \(codex on codex-nocredit\)/);
    const stopped = await until('task 2 stopped', async () => { const t = await task(2); return t?.status === 'stopped' && t; });
    assert.equal(stopped.account, 'codex-nocredit');
    assert.match(stopped.stopReason, /^Codex no credit has no credit or has a billing problem: Your workspace is out of credits\./);
    assert.match(stopped.statusSource, /You chose this account, so Taskboard did not move the task\.$/);
    assert.match(stopped.ask, /^Move the task to another account, or clear the limit mark on the Accounts page when Codex no credit works again\. Choose another Codex account: codex-default/);
    assert.ok((await account('codex-nocredit')).limited, 'marked again by the new failure');
    // the session with the "Request increase?" dialog is gone, and the task keeps its reason
    assert.throws(() => execFileSync('tmux', ['-L', socket, 'has-session', '-t', '=task-2'], { stdio: 'ignore' }));
    await sleep(3000);
    const later = await task(2);
    assert.equal(later.status, 'stopped'); assert.equal(later.stopReason, stopped.stopReason);
    assert.deepEqual(launches(later.id), [acctDir('codex-nocredit')]);

    // resume checks the account before it starts the agent
    const resumed = await request('POST', `/api/tasks/${later.id}/resume`, {});
    assert.equal(resumed.status, 400); assert.match(resumed.data.error, /^Account codex-nocredit stopped at a usage limit.*Or move the task to another account\.$/);
    assert.deepEqual(launches(later.id), [acctDir('codex-nocredit')]);
    // a move to the account with the mark is refused too
    const toLimited = await request('POST', `/api/tasks/${moved.id}/move-account`, { account: 'codex-nocredit' });
    assert.equal(toLimited.status, 400); assert.match(toLimited.data.error, /^Account codex-nocredit stopped at a usage limit/);
    assert.equal((await task(1)).account, 'codex-default');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});
