import { TestResources } from './helpers/test-resources.ts';
const resources = new TestResources();
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import type { Agent, Task } from '../server/store.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-move-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = resources.socket(`tb-move-test-${process.pid}`);
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

const fixtures = [fixture('claude', 1), fixture('codex', 2), fixture('antigravity', 3), fixture('claude', 4), fixture('codex', 5), fixture('antigravity', 6), fixture('claude', 7), fixture('claude', 8), fixture('codex', 9), fixture('antigravity', 10), fixture('claude', 11), fixture('claude', 12), fixture('claude', 13), fixture('claude', 14), fixture('codex', 15)];

store.update('move-12', { model: 'opus' });
store.update('move-7', { transcript: '/missing-transcript.jsonl', desc: 'LARGE_ORIGINAL_42 '.repeat(500) });
writeFileSync(store.logFile('move-7'), 'LARGE_LOG_42 '.repeat(1000));
for (let i = 0; i < 5; i++) writeFileSync(join(store.taskDir('move-7'), 'outbox', `large-${i}.md`), 'LARGE_OUTBOX_42 '.repeat(200));

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
if (agent === 'codex' && process.argv.includes('app-server')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
} else {
if (process.argv.includes('status')) { console.log(agent === 'claude' ? '{"loggedIn":true}' : 'Logged in'); process.exit(0); }
if (agent === 'agy' && (process.argv.includes('models') || process.argv.includes('plugin'))) { console.log('test\\tmodel'); process.exit(0); }
fs.writeFileSync(path.join(process.env.TASK_DIR, 'launch.json'), JSON.stringify({ agent, args: process.argv.slice(2), cwd: process.cwd(), accountDir: process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME }));
// Antigravity draws its input box between two rules (server/type-command.ts); its first prompt is typed in there
console.log(agent === 'agy' ? ['─'.repeat(40), '> ', '─'.repeat(40), '  ? for shortcuts'].join('\\n') : 'TEST_AGENT_READY');
if (agent === 'agy') { process.stdin.setRawMode(true); process.stdin.on('data', chunk => fs.appendFileSync(path.join(process.env.TASK_DIR, 'pasted.txt'), chunk)); }
setInterval(() => {}, 1000);
}
`;
  for (const name of ['claude', 'codex', 'agy']) { const p = join(bin, name); writeFileSync(p, fake); chmodSync(p, 0o755); }
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'test-tmux');
  writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
if (fs.existsSync(${JSON.stringify(join(root, 'fail-launch'))}) && process.argv.includes('new-session')) process.exit(1);
const r = cp.spawnSync(${JSON.stringify(realTmux)}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(r.status || 0);
`); chmodSync(wrapper, 0o755);
  const accounts = ['claude', 'codex', 'antigravity'].map(agent => ({ id: `${agent}-default`, agent, name: agent, dir: join(root, 'accounts', agent), isDefault: agent === 'antigravity', maxParallel: 8, created: new Date().toISOString(), usage: { windows: [{ label: 'weekly', usedPct: 99 }], at: new Date().toISOString(), source: 'test' } }));
  accounts.push({ ...accounts[0], id: 'claude-other', name: 'Claude other', dir: join(root, 'accounts', 'claude-other'), isDefault: false });
  accounts.push({ ...accounts[1], id: 'codex-other', name: 'Codex other', dir: join(root, 'accounts', 'codex-other'), isDefault: false });
  accounts.push({ ...accounts[0], id: 'claude-slot', name: 'Claude slot', dir: join(root, 'accounts', 'claude-slot'), maxParallel: 1, limited: { at: new Date().toISOString(), note: 'fixture' } } as any);
  for (const a of accounts) mkdirSync(a.dir, { recursive: true });
  writeFileSync(join(root, 'state', 'accounts.json'), JSON.stringify(accounts));
  writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'move-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: true, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));
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
    const p = spawn(process.execPath, ['bin/tb', ...args], { env: { ...env, TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE, TB_TASK_TOKEN: '', TB_MAIL_CONTROLLER_TOKEN: actor === 'controller' ? readFileSync(join(root, 'state', 'mail-controller.token'), 'utf8').trim() : '', TASK_ID: actor }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', code => code === 0 || (code === 2 && /Approval pending/.test(out)) ? resolve(out) : reject(new Error(out)));
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
        assert.match(await moved, /Approval pending/);
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
      const prompt = launch.args.find((arg: string) => arg.includes(t.handoff)) || readFileSync(join(store.taskDir(t.id), 'pending-prompt.txt'), 'utf8');
      assert.ok(prompt.includes(t.handoff));
      assert.ok(Buffer.byteLength(prompt) < 1024);
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
        for (let n = 0; n < 60; n++) {
          if (existsSync(pasted) && readFileSync(pasted, 'utf8').includes(moved.data.handoff)) break;
          await sleep(100);
        }
        assert.ok(readFileSync(pasted, 'utf8').includes(moved.data.handoff));
      }
    }
    const candidates = (await request('/api/import')).data;
    assert.ok(!candidates.some((c: any) => c.sessionId === fixtures[0].sessionId));
    const duplicate = await request('/api/import', { items: [{ ...fixtures[0], updated: new Date().toISOString() }] });
    assert.equal(duplicate.data.made.length, 0);
    // A missing transcript still starts with the task prompt and saved files.
    const missing = await request('/api/tasks/move-7/move-account', { account: 'codex-default' });
    assert.equal(missing.status, 200);
    const largeHandoff = readFileSync(missing.data.handoff, 'utf8');
    assert.match(largeHandoff, /Old transcript unavailable/);
    assert.ok(Buffer.byteLength(largeHandoff) > 16000);
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
    // Off keeps an established task on its chosen account.
    const settings = async (autoMoveOnLimit: string) => {
      const r = await fetch(url + '/api/info', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-taskboard-token': token, origin: url }, body: JSON.stringify({ autoMoveOnLimit }) });
      assert.equal(r.status, 200, await r.text());
    };
    const failure = (id: string, session: string, error = 'rate_limit', text = 'You have hit your weekly limit') => request('/api/hooks/claude', { taskId: id, input: { hook_event_name: 'StopFailure', session_id: session, error, last_assistant_message: text } });
    const waitTask = async (id: string, predicate: (t: any) => boolean) => {
      let t: any;
      for (let n = 0; n < 200; n++) { t = await current(id); if (predicate(t)) return t; await sleep(100); }
      assert.fail(JSON.stringify(t) + output.slice(-2000));
    };
    assert.equal((await request('/api/info')).data.settings.accounts.autoMoveOnLimit, 'off');
    await failure('move-11', fixtures[10].sessionId!);
    assert.equal((await current('move-11')).account, 'claude-default');
    assert.equal((await current('move-11')).lastAutoMove, undefined);
    await settings('same-kind');
    // Overload remains a model error and does not start a move.
    await failure('move-12', fixtures[11].sessionId!, 'overloaded', 'Model overloaded');
    assert.equal((await current('move-12')).account, 'claude-default');
    assert.equal((await current('move-12')).lastAutoMove, undefined);
    await failure('move-12', fixtures[11].sessionId!, 'authentication_failed', 'Please sign in');
    assert.equal((await current('move-12')).account, 'claude-default');
    assert.equal((await current('move-12')).lastAutoMove, undefined);
    // Duplicate hooks produce one move. Claude resumes the copied conversation.
    await Promise.all([failure('move-12', fixtures[11].sessionId!), failure('move-12', fixtures[11].sessionId!)]);
    const automatic = await waitTask('move-12', t => !!t.lastAutoMove);
    assert.equal(automatic.account, 'claude-other');
    assert.equal(automatic.sessionId, fixtures[11].sessionId);
    assert.equal(automatic.cwd, fixtures[11].cwd);
    assert.equal(automatic.worktree, true);
    assert.match(automatic.lastAutoMove.reason, /weekly limit/);
    assert.match(readFileSync(store.logFile('move-12'), 'utf8'), /Automatic move from claude .* to Claude other/);
    assert.deepEqual(automatic.autoMoveAttempts, ['claude-default', 'claude-other']);
    await request('/api/hooks/claude', { taskId: 'move-12', input: { hook_event_name: 'StopFailure', session_id: automatic.sessionId, taskboard_account: 'claude-default', error: 'billing_error' } });
    assert.equal((await current('move-12')).status, 'working');
    // Same-kind mode stops when both Claude accounts are limited.
    await failure('move-12', automatic.sessionId);
    const noTarget = await waitTask('move-12', t => /Automatic move stopped/.test(t.statusSource));
    assert.equal(noTarget.account, 'claude-other');
    assert.equal(noTarget.status, 'stopped');
    // A fresh launch can fall back to another kind, with saved context.
    await request('/api/accounts/claude-other/clear-limit', {});
    execFileSync(realTmux, ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-session', '-t', '=task-12']);
    const resumedAuto = await request('/api/tasks/move-12/resume', {});
    assert.equal(resumedAuto.status, 200);
    await settings('any-kind');
    await failure('move-12', automatic.sessionId);
    const cross = await waitTask('move-12', t => t.agent === 'codex' && t.lastAutoMove.to.includes('codex'));
    assert.equal(cross.model, undefined);
    assert.equal(cross.cwd, cwd);
    assert.equal(cross.branch, 'test');
    assert.notEqual(cross.sessionId, automatic.sessionId);
    const autoHandoff = readFileSync(cross.handoff, 'utf8');
    for (const value of [fixtures[11].title, cwd, 'LOG_ENTRY_42', 'old conversation cannot resume here']) assert.ok(autoHandoff.includes(value), value);
    assert.equal((readFileSync(store.logFile('move-12'), 'utf8').match(/Automatic move from/g) || []).length, 2);
    // Manual moves clear the persisted sequence.
    await request('/api/accounts/claude-default/clear-limit', {});
    const manual = await request('/api/tasks/move-12/move-account', { account: 'claude-default' });
    assert.equal(manual.status, 200);
    assert.equal(manual.data.autoMoveAttempts, undefined);
    await request('/api/accounts/claude-other/clear-limit', {});
    await settings('same-kind');
    writeFileSync(join(root, 'fail-launch'), 'fail');
    await failure('move-11', fixtures[10].sessionId!);
    const autoFailed = await waitTask('move-11', t => /Automatic move stopped/.test(t.statusSource));
    assert.equal(autoFailed.account, 'claude-default');
    assert.equal(autoFailed.sessionId, fixtures[10].sessionId);
    assert.equal(autoFailed.status, 'stopped');
    assert.deepEqual(autoFailed.autoMoveAttempts, ['claude-default', 'claude-other']);
    const failed = await request('/api/tasks/move-6/move-account', { account: 'codex-default' });
    assert.equal(failed.status, 400);
    const restored = await current('move-6');
    assert.equal(restored.agent, 'antigravity'); assert.equal(restored.account, 'antigravity-default');
    assert.equal(restored.sessionId, fixtures[5].sessionId); assert.equal(restored.transcript, fixtures[5].transcript);
    assert.match(restored.statusSource, /Move failed/);
    // Two failures compete for one available slot. Only one task can move.
    rmSync(join(root, 'fail-launch'));
    await settings('off');
    await failure('move-4', fixtures[3].sessionId!);
    await request('/api/accounts/claude-slot/clear-limit', {});
    await settings('same-kind');
    await Promise.all([failure('move-13', fixtures[12].sessionId!), failure('move-14', fixtures[13].sessionId!)]);
    const competed = await Promise.all(['move-13', 'move-14'].map(id => waitTask(id, t => !!t.lastAutoMove || /Automatic move stopped/.test(t.statusSource))));
    assert.equal(competed.filter(t => t.account === 'claude-slot').length, 1);
    assert.equal(competed.filter(t => t.account === 'claude-default' && t.status === 'stopped').length, 1);
    // Clearing the old account does not allow a return in the same sequence.
    await request('/api/accounts/claude-default/clear-limit', {});
    const winner = competed.find(t => t.account === 'claude-slot');
    await failure(winner.id, winner.sessionId);
    const stayed = await waitTask(winner.id, t => /Automatic move stopped/.test(t.statusSource));
    assert.equal(stayed.account, 'claude-slot');
    assert.deepEqual(stayed.autoMoveAttempts, ['claude-default', 'claude-slot']);
    // A Codex failure after earlier work moves through the transcript watcher.
    const codexResume = await request('/api/tasks/move-15/resume', {});
    assert.equal(codexResume.status, 200);
    await sleep(1500);
    writeFileSync(fixtures[14].transcript!, '\n' + JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded', message: 'Your workspace is out of credits.' } } }) + '\n', { flag: 'a' });
    const codexAuto = await waitTask('move-15', t => !!t.lastAutoMove);
    assert.equal(codexAuto.agent, 'codex');
    assert.equal(codexAuto.account, 'codex-other');
    assert.equal(codexAuto.cwd, cwd);
    assert.match(codexAuto.lastAutoMove.reason, /out of credits/);
    assert.match(readFileSync(join(root, 'vault', 'tasks', 'move-15.md'), 'utf8'), /autoMoveAttempts:/);
    console.log(`Sandbox evidence: ${root}`);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit');
    try { execFileSync(realTmux, ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
});
