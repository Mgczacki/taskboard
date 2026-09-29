import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import type { Agent, Task } from '../server/store.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-move-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-move-test-${process.pid}`;
const { buildHandoff, conversationExcerpt, HANDOFF_BYTES } = await import('../server/handoff.ts');
const store = await import('../server/store.ts');
const { TOKEN_FILE } = await import('../server/config.ts');
const cwd = join(root, 'project'); mkdirSync(cwd);
execFileSync('git', ['init', cwd], { stdio: 'ignore' });
writeFileSync(join(cwd, 'work.txt'), 'before\n');
execFileSync('git', ['-C', cwd, 'add', '.']);
execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'], { stdio: 'ignore' });
writeFileSync(join(cwd, 'work.txt'), 'after\n');
writeFileSync(join(cwd, 'staged.txt'), 'staged work\n');
execFileSync('git', ['-C', cwd, 'add', 'staged.txt']);
writeFileSync(join(cwd, 'untracked.txt'), 'untracked work\n');

function fixture(agent: Agent, num: number) {
  const sessionId = `old-${agent}-${num}`;
  const transcript = join(root, 'accounts', agent, 'projects', 'project', `${sessionId}.jsonl`);
  mkdirSync(join(root, 'accounts', agent, 'projects', 'project'), { recursive: true });
  const user = 'Keep the completed edits. The next step is NEXT_STEP_42.';
  const answer = 'I completed SAVED_WORK_42. Continue with the next check.';
  const lines = agent === 'claude' ? [
    { type: 'user', sessionId, cwd, message: { content: user } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: answer }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'TOOL_RESULT_OMIT' }] } },
  ] : agent === 'codex' ? [
    { type: 'event_msg', payload: { type: 'user_message', message: user } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: 'PRIVATE_REASONING' } },
  ] : [
    { type: 'USER_INPUT', content: user },
    { type: 'PLANNER_RESPONSE', content: answer },
    { type: 'GENERIC', content: 'TOOL_RESULT_OMIT' },
  ];
  writeFileSync(transcript, lines.map(o => JSON.stringify(o)).join('\n') + '\n{incomplete');
  const t = store.create({ id: `move-${num}`, num, title: `Move ${agent}`, agent, account: `${agent}-default`,
    status: 'stopped', stopReason: 'usage limit reached', session: `task-${num}`, sessionId, transcript,
    cwd, folder: cwd, worktree: true, branch: 'test', groups: ['group-a'], desc: 'ORIGINAL_PROMPT_42: Continue the existing project.' });
  mkdirSync(join(store.taskDir(t.id), 'outbox'));
  writeFileSync(join(store.taskDir(t.id), 'outbox', 'result.md'), 'OUTBOX_RESULT_42');
  store.appendLog(t.id, { did: 'LOG_ENTRY_42', next: 'Continue.' });
  return t;
}

const fixtures = [fixture('claude', 1), fixture('codex', 2), fixture('antigravity', 3), fixture('claude', 4), fixture('codex', 5), fixture('antigravity', 6), fixture('claude', 7), fixture('claude', 8), fixture('codex', 9), fixture('antigravity', 10)];

store.update('move-7', { transcript: '/missing-transcript.jsonl' });

test('handoff reads all three transcript formats and bounds every source', async () => {
  for (const t of fixtures.slice(0, 3)) {
    const text = await buildHandoff(t, 'Codex', 'Claude stays the Ask default.');
    for (const marker of ['ORIGINAL_PROMPT_42', 'LOG_ENTRY_42', 'OUTBOX_RESULT_42', 'NEXT_STEP_42', 'SAVED_WORK_42', '+after', '+staged work', 'untracked.txt', 'Claude stays the Ask default.']) assert.ok(text.includes(marker), marker);
    assert.ok(!text.includes('PRIVATE_REASONING'));
    assert.ok(!text.includes('TOOL_RESULT_OMIT'));
    assert.ok(Buffer.byteLength(text) <= HANDOFF_BYTES);
  }
  const t = fixtures[0];
  writeFileSync(join(store.taskDir(t.id), 'outbox', 'large.md'), 'é'.repeat(100000));
  const text = await buildHandoff({ ...t, desc: '😀'.repeat(100000) }, 'Codex', 'NEW_DECISION_42');
  assert.ok(Buffer.byteLength(text) <= HANDOFF_BYTES);
  assert.ok(text.includes('NEW_DECISION_42') && text.includes('NEXT_STEP_42'));
  assert.match(conversationExcerpt('claude', '/missing'), /unavailable/);
});

test('sandbox API and tb move preserve tasks and reject stale hooks', { timeout: 90000 }, async () => {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const agent = path.basename(process.argv[1]);
if (process.argv.includes('status')) { console.log(agent === 'claude' ? '{"loggedIn":true}' : 'Logged in'); process.exit(0); }
if (agent === 'agy' && (process.argv.includes('models') || process.argv.includes('plugin'))) { console.log('test\\tmodel'); process.exit(0); }
fs.writeFileSync(path.join(process.env.TASK_DIR, 'launch.json'), JSON.stringify({ agent, args: process.argv.slice(2), cwd: process.cwd(), accountDir: process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME }));
console.log(agent === 'agy' ? '? for shortcuts' : 'TEST_AGENT_READY');
if (agent === 'agy') process.stdin.on('data', chunk => fs.appendFileSync(path.join(process.env.TASK_DIR, 'pasted.txt'), chunk));
setInterval(() => {}, 1000);
`;
  for (const name of ['claude', 'codex', 'agy']) { const p = join(bin, name); writeFileSync(p, fake); chmodSync(p, 0o755); }
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'test-tmux');
  writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
if (fs.existsSync(${JSON.stringify(join(root, 'fail-launch'))}) && process.argv.includes('new-session')) process.exit(1);
const r = cp.spawnSync(${JSON.stringify(realTmux)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(r.status || 0);
`); chmodSync(wrapper, 0o755);
  const accounts = ['claude', 'codex', 'antigravity'].map(agent => ({ id: `${agent}-default`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: true, maxParallel: 8, created: new Date().toISOString(), limited: { at: new Date().toISOString(), note: 'Fixture limit' }, usage: { windows: [{ label: 'weekly', usedPct: 99 }], at: new Date().toISOString(), source: 'test' } }));
  accounts.push({ ...accounts[0], id: 'claude-other', name: 'Claude other', dir: join(root, 'accounts', 'claude-other'), isDefault: false });
  accounts.push({ ...accounts[1], id: 'codex-other', name: 'Codex other', dir: join(root, 'accounts', 'codex-other'), isDefault: false });
  for (const a of accounts) mkdirSync(a.dir, { recursive: true });
  writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify(accounts));
  writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'move-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: true, agentsNeedApproval: true } }));
  // The sandbox owns this listening socket and all task sessions.
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(r => probe.close(() => r()));
  const env = { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_TMUX: wrapper, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(root, 'accounts', 'claude'), CODEX_HOME: join(root, 'accounts', 'codex') };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const url = `http://127.0.0.1:${port}`;
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const request = async (path: string, body?: unknown, actor = '', origin = false) => {
    const res = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': actor, ...(origin ? { origin: url } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const current = async (id: string) => (await request('/api/tasks')).data.find((t: Task) => t.id === id);
  const cli = (args: string[], actor = '') => new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['bin/tb', ...args], { env: { ...env, TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE, TASK_ID: actor }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', code => code === 0 ? resolve(out) : reject(new Error(out)));
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) { try { up = (await request('/api/info')).status === 200; if (up) break; } catch {} await sleep(100); }
    assert.ok(up, output);
    assert.match(await cli(['accounts']), /weekly 99%/);
    for (const [i, target] of ['codex-default', 'claude-default', 'codex-default'].entries()) {
      const original = fixtures[i];
      if (i === 0) {
        // The controller uses tb and waits for the existing dashboard approval.
        const moved = cli(['move', String(original.num), '--account', target, '--instruction', 'Claude stays the Ask default.'], 'controller');
        let approval: any;
        for (let n = 0; n < 40 && !approval; n++) { approval = (await request('/api/approvals')).data.find((a: any) => a.state === 'pending'); if (!approval) await sleep(100); }
        assert.ok(approval); assert.equal((await current(original.id)).agent, original.agent);
        assert.equal((await request(`/api/approvals/${approval.id}/approve`, {}, '', true)).status, 200);
        assert.match(await moved, /Moved #1/);
      } else {
        const moved = await request(`/api/tasks/${original.id}/move-account`, { account: target }, '', true);
        assert.equal(moved.status, 200, JSON.stringify(moved.data));
      }
      const t = await current(original.id);
      for (const field of ['id', 'num', 'title', 'cwd', 'folder', 'worktree', 'branch', 'desc', 'groups']) assert.deepEqual(t[field], original[field as keyof Task], field);
      assert.equal(t.account, target); assert.ok(t.pastSessions.includes(original.sessionId));
      assert.match(readFileSync(store.logFile(t.id), 'utf8'), /Moved from/);
      assert.match(t.statusSource, /Moved from/);
      assert.ok(existsSync(join(store.taskDir(t.id), 'outbox', 'result.md')));
      assert.ok(Buffer.byteLength(readFileSync(t.handoff, 'utf8')) <= HANDOFF_BYTES);
      let launch: any;
      for (let n = 0; n < 30; n++) { try { launch = JSON.parse(readFileSync(join(store.taskDir(t.id), 'launch.json'), 'utf8')); break; } catch {} await sleep(100); }
      assert.equal(launch.agent, target.split('-')[0]); assert.equal(launch.cwd, cwd);
      assert.ok(launch.args.at(-1).includes('NEXT_STEP_42'));
      const oldHook = original.agent === 'claude' ? ['/api/hooks/claude', { taskId: t.id, input: { hook_event_name: 'StopFailure', session_id: original.sessionId, error: 'OLD_ERROR' } }]
        : original.agent === 'codex' ? ['/api/hooks/codex', { taskId: t.id, payload: { type: 'agent-turn-complete', 'thread-id': original.sessionId, 'last-assistant-message': 'OLD_ANSWER' } }]
        : ['/api/hooks/antigravity', { taskId: t.id, event: 'Stop', input: { conversationId: original.sessionId, error: 'OLD_ERROR' } }];
      await request(oldHook[0] as string, oldHook[1]);
      assert.equal((await current(t.id)).agent, t.agent); assert.notEqual((await current(t.id)).stopReason, 'OLD_ERROR');
      assert.equal(readFileSync(join(cwd, 'work.txt'), 'utf8'), 'after\n');
    }
    // The other three agent pairs include Antigravity's prompt after workspace trust.
    for (const [id, account] of [['move-8', 'antigravity-default'], ['move-9', 'antigravity-default'], ['move-10', 'claude-default']]) {
      const moved = await request(`/api/tasks/${id}/move-account`, { account });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      assert.match(readFileSync(moved.data.handoff, 'utf8'), /NEXT_STEP_42/);
      if (account === 'antigravity-default') {
        const pasted = join(store.taskDir(id), 'pasted.txt');
        for (let n = 0; n < 60 && !existsSync(pasted); n++) await sleep(100);
        assert.match(readFileSync(pasted, 'utf8'), /NEXT_STEP_42/);
      }
    }
    const candidates = (await request('/api/import')).data;
    assert.ok(!candidates.some((c: any) => c.sessionId === fixtures[0].sessionId));
    const duplicate = await request('/api/import', { items: [{ ...fixtures[0], updated: new Date().toISOString() }] });
    assert.equal(duplicate.data.made.length, 0);
    // A missing transcript still starts with the task prompt and saved files.
    const missing = await request('/api/tasks/move-7/move-account', { account: 'codex-default' });
    assert.equal(missing.status, 200);
    assert.match(readFileSync(missing.data.handoff, 'utf8'), /Old transcript unavailable/);
    // A Claude account transfer resumes the copied session.
    const same = await request('/api/tasks/move-4/move-account', { account: 'claude-other' });
    assert.equal(same.status, 200); assert.equal(same.data.sessionId, fixtures[3].sessionId);
    assert.equal(readFileSync(same.data.transcript, 'utf8'), readFileSync(fixtures[3].transcript!, 'utf8'));
    // A Codex account transfer starts a new conversation with the old context.
    const codex = await request('/api/tasks/move-5/move-account', { account: 'codex-other' });
    assert.equal(codex.status, 200); assert.ok(codex.data.pastSessions.includes(fixtures[4].sessionId));
    await request('/api/hooks/codex', { taskId: 'move-5', payload: { type: 'agent-turn-complete', 'thread-id': fixtures[4].sessionId, 'last-assistant-message': 'STALE' } });
    assert.notEqual((await current('move-5')).now, 'STALE');
    assert.equal((await request('/api/tasks/move-5/move-account', { account: 'codex-other' })).status, 400);
    assert.equal((await request('/api/tasks/move-5/move-account', { account: 'missing' })).status, 400);
    // Only one of two concurrent move requests may replace this task's process.
    const attempts = await Promise.all([
      request('/api/tasks/move-7/move-account', { account: 'claude-default' }),
      request('/api/tasks/move-7/move-account', { account: 'claude-other' }),
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]);
    // A new Claude conversation can retry its saved handoff before SessionStart records a transcript.
    execFileSync(realTmux, ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-session', '-t', '=task-7']);
    const retry = await request('/api/tasks/move-7/resume', {});
    assert.equal(retry.status, 200); assert.equal(retry.data.status, 'working');
    writeFileSync(join(root, 'fail-launch'), 'fail');
    const failed = await request('/api/tasks/move-6/move-account', { account: 'codex-default' });
    assert.equal(failed.status, 400);
    const restored = await current('move-6');
    assert.equal(restored.agent, 'antigravity'); assert.equal(restored.account, 'antigravity-default');
    assert.equal(restored.sessionId, fixtures[5].sessionId); assert.equal(restored.transcript, fixtures[5].transcript);
    assert.match(restored.statusSource, /Move failed/);
    console.log(`Sandbox evidence: ${root}`);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit');
    try { execFileSync(realTmux, ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
});
