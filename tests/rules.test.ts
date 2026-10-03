import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-rules-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-rules-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'rules-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: true, agentsNeedApproval: true, trustWorkspaces: false, autoReview: false } }));
// stand-ins for the agents: each records its arguments and keeps running
const bin = join(root, 'bin'); mkdirSync(bin);
for (const name of ['claude', 'codex', 'agy']) { writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(root, `args-${name}`)}\nexec sleep 600\n`); chmodSync(join(bin, name), 0o755); }
process.env.PATH = `${bin}:${process.env.PATH}`;
const rules = await import('../server/rules.ts');
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const tmux = await import('../server/tmux.ts');
const { TOKEN_FILE } = await import('../server/config.ts');

const task = (agent: 'claude' | 'codex' | 'antigravity', num: number) => store.create({ id: `rules-${agent}`, num, title: `Rules ${agent}`, agent, status: 'idle', cwd: root, folder: root, session: `tb-rules-${agent}`, sessionId: `s-${agent}`, desc: '' });

test('saving writes the rules file in the Taskboard folder and refuses text that is too long', () => {
  assert.equal(rules.read('task'), '');
  assert.equal(rules.section('task'), '');
  const saved = rules.write('task', 'Run the tests.\r\nWrite short commits.');
  assert.equal(saved.file, join(root, 'state', 'rules', 'task.md'));
  assert.equal(readFileSync(saved.file, 'utf8'), 'Run the tests.\nWrite short commits.');
  assert.equal(saved.chars, 35);
  assert.ok(saved.updated);
  assert.throws(() => rules.write('task', 'x'.repeat(rules.MAX_RULES_CHARS.task + 1)), /maximum is 2000/);
  assert.equal(rules.read('task'), 'Run the tests.\nWrite short commits.');
  assert.throws(() => rules.write('task', 42), /must be a string/);
  assert.equal(rules.isKind('project'), false);
});

test('the preview shows the first lines that are not empty', () => {
  assert.deepEqual(rules.preview(''), { lines: [], more: false });
  assert.deepEqual(rules.preview('\n# Rules\n\n- one  \n- two\n'), { lines: ['# Rules', '- one', '- two'], more: false });
  assert.deepEqual(rules.preview('a\nb\nc\nd\ne'), { lines: ['a', 'b', 'c', 'd'], more: true });
  rules.write('controller', 'line 1\nline 2\nline 3\nline 4\nline 5');
  assert.deepEqual(rules.info('controller').preview, { lines: ['line 1', 'line 2', 'line 3', 'line 4'], more: true });
});

test('a new task session receives the current task rules for each agent', () => {
  rules.write('task', 'RULE-ALPHA: run pnpm test before each commit.');
  const claude = agents.command(task('claude', 901), 'Do the work.', false);
  const prompt = claude[claude.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /## The user's rules for every task session/);
  assert.match(prompt, /RULE-ALPHA: run pnpm test before each commit\.$/);

  const codex = agents.command(task('codex', 902), 'Do the work.', false);
  const dev = codex.find(a => a.startsWith('developer_instructions='))!;
  assert.match(JSON.parse(dev.slice('developer_instructions='.length)), /RULE-ALPHA/);

  const agy = task('antigravity', 903);
  const agyCmd = agents.command(agy, 'Do the work.', false);
  const first = agyCmd.includes('-i') ? agyCmd[agyCmd.indexOf('-i') + 1] : agents.pendingPrompt.get(agy.id)!;
  assert.match(first, /RULE-ALPHA[\s\S]*---\n\nDo the work\.$/);

  // a saved change reaches the next session; a resumed conversation keeps its text
  rules.write('task', 'RULE-BETA');
  assert.match(agents.taskInstructions(task('claude', 901)), /RULE-BETA/);
  assert.doesNotMatch(agents.taskInstructions(task('claude', 901)), /RULE-ALPHA/);
  assert.deepEqual(agents.command(agy, 'x', true).slice(-2), ['--conversation', 's-antigravity']);
  rules.write('task', '');
  assert.doesNotMatch(agents.taskInstructions(task('claude', 901)), /user's rules/);
});

test('task rules at the maximum length fit, and a long prompt moves them into a copy in the task folder', { timeout: 30000 }, async () => {
  const t = task('claude', 904);
  try {
    // the maximum length and a short prompt: the rules fit and go on the command line
    rules.write('task', 'Rule text. '.repeat(Math.floor(rules.MAX_RULES_CHARS.task / 11)));
    const short = agents.command(t, 'Do the work.', false);
    assert.ok(Buffer.byteLength(short.join(' ')) <= agents.MAX_COMMAND_BYTES);
    assert.match(short.join(' '), /Rule text\. Rule text\./);
    // a long prompt: the instructions name the copy, and tmux accepts the command. The command without the rules is about
    // 10.9 KB plus the prompt (the browser lines of task 202 added about 160 bytes); the prompt keeps about 100 bytes of
    // room below MAX_COMMAND_BYTES (the temp folder path varies).
    const long = agents.command(t, 'Do the work. '.repeat(228), false);
    assert.doesNotMatch(long.join(' '), /Rule text\. Rule text\./);
    assert.ok(Buffer.byteLength(long.join(' ')) <= agents.MAX_COMMAND_BYTES);
    const copy = join(store.taskDir(t.id), 'rules.md');
    assert.match(long.join(' '), new RegExp(`rules for every task session are in ${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(readFileSync(copy, 'utf8'), /Rule text\. Rule text\./);
    await tmux.newSession(t.session, root, { TB_TASK_ID: t.id }, long, async () => {});
    // the fake claude writes its arguments while the test reads, so wait for the whole text (not only for the file)
    const args = () => existsSync(join(root, 'args-claude')) ? readFileSync(join(root, 'args-claude'), 'utf8') : '';
    for (let i = 0; i < 50 && !/Read that file before you start work/.test(args()); i++) await new Promise(done => setTimeout(done, 100));
    assert.match(args(), /Read that file before you start work/);
  } finally {
    rules.write('task', '');
    try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  }
});

test('only the dashboard saves rules, and a new controller session starts with the controller rules', { timeout: 60000 }, async () => {
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_MACHINE_NAME: 'rules-test' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const request = async (method: string, path: string, actor: 'agent' | 'dashboard', body?: object) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(actor === 'dashboard' ? { origin: url } : { 'x-taskboard-token': token, 'x-tb-actor': 'controller' }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(url + '/api/info', { headers: { 'x-taskboard-token': token } })).status === 200; } catch { /* not listening yet */ } if (!up) await new Promise(done => setTimeout(done, 100)); }
    assert.ok(up, output);
    assert.equal((await request('PUT', '/api/rules/controller', 'agent', { text: 'from an agent' })).status, 403);
    assert.equal((await request('PUT', '/api/rules/project', 'dashboard', { text: 'x' })).status, 404);
    const saved = await request('PUT', '/api/rules/controller', 'dashboard', { text: 'CTRL-RULE: answer in two lines.' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.preview.lines, ['CTRL-RULE: answer in two lines.']);
    const list = await request('GET', '/api/rules', 'agent');
    assert.deepEqual(list.data.map((f: { kind: string }) => f.kind), ['controller', 'task']);

    const started = await request('POST', '/api/controller/new-session', 'dashboard', { when: 'now' });
    assert.equal(started.status, 200, JSON.stringify(started.data) + output);
    // Claude Code reads CLAUDE.md in the controller folder; Codex and Antigravity read AGENTS.md there
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const md = readFileSync(join(root, 'vault', 'controller', f), 'utf8');
      assert.match(md, /## The user's rules for the controller\n[\s\S]*CTRL-RULE: answer in two lines\./);
    }
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  }
});
