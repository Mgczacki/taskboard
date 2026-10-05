import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

// A scratch Taskboard (own port, folders and tmux socket; never the real server) with fake agents. Each fake agent is
// a shell script in a tmux session that prints a screen like Claude Code or Codex, puts the cursor in the input box,
// and writes every line typed into it to a file.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-agent-errors-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-agent-errors-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'agent-errors-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: false, trustWorkspaces: false, autoReview: false }, agentErrors: { autoContinue: true, message: 'continue', stallMinutes: 10, accounts: {} } }));
const bin = join(root, 'bin'); mkdirSync(bin);
for (const name of ['claude', 'codex', 'agy']) { writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = auth ] && echo '{"loggedIn":true}' || echo 'Logged in using ChatGPT'\n`); chmodSync(join(bin, name), 0o755); }
const fake = join(root, 'fake.sh');
// After a line was sent it draws the screen again with an empty box, as the agents do after a submit.
writeFileSync(fake, `#!/bin/bash\ndraw() { clear; printf '%b' "$(cat "$1")"; printf '\\033[1A\\033[%sG' "$2"; }\ndraw "$1" "\${3:-3}"\nwhile IFS= read -r line; do echo "$line" >> "$2"; draw "$1" 3; done\nsleep 600\n`); chmodSync(fake, 0o755);
// the retry screen changes to a normal screen after 6 s, as Claude Code does when a retry gets an answer
const retry = join(root, 'retry.sh');
writeFileSync(retry, `#!/bin/bash\nprintf '⏺ Reading the files.\\n\\n✻ API error · Retrying in 1s · attempt 2/10\\n'\nsleep 6\nclear\nprintf '⏺ Read 3 files. The answer arrived.\\n'\nsleep 600\n`); chmodSync(retry, 0o755);

const RULE = '─'.repeat(60);
const claudeScreen = (box: string) => `⏺ Working on the task.\n\n\\033[2m${RULE}\\033[0m\n❯ ${box}\n\\033[2m${RULE}\\033[0m`;
// task 277, Codex 0.160.0 (the reply text is shortened)
const codexScreen = '• Each package completed the mock run.\n\n■ Selected model is at capacity. Please try a different model.\n\n› ';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const store = await import('../server/store.ts');
const { TOKEN_FILE } = await import('../server/config.ts');

function file(name: string, text: string) { const f = join(root, name); writeFileSync(f, text); return f; }
const socket = process.env.TASKBOARD_TMUX_SOCKET!;
function session(name: string, command: string) { execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, '-x', '120', '-y', '30', command]); }
const base = (id: string, num: number, agent: 'claude' | 'codex', status: store.Status) => ({ id, num, title: id, agent, status, cwd: root, folder: root, session: `tbe-${id}`, desc: '', account: `${agent}-default` });

// 1. Codex: the rollout file of task 277 ends with a failed task_complete; the task still says "working"
const rollout = file('rollout.jsonl', [
  JSON.stringify({ timestamp: iso(Date.now() - 60000), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  JSON.stringify({ timestamp: iso(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } } }),
].join('\n') + '\n');
store.create({ ...base('cap', 1, 'codex', 'working'), transcript: rollout, sessionId: 'thread-cap' });
session('tbe-cap', `${fake} ${file('cap.screen', codexScreen)} ${join(root, 'cap.in')}`);
// 2. Claude Code retries by itself, then gets an answer
store.create(base('retry', 2, 'claude', 'working'));
session('tbe-retry', retry);
// 3. a stop that is due for auto-continue, with an empty input box
const stoppedAt = iso(Date.now() - 120000);
const due = { kind: 'overloaded' as const, text: 'API Error: Repeated 529 Overloaded errors.', source: 'hook' as const, at: stoppedAt, phase: 'stopped' as const, since: stoppedAt, seen: stoppedAt, count: 1, auto: { tries: 0, nextAt: iso(Date.now() - 1000) } };
store.create({ ...base('auto', 3, 'claude', 'stopped'), agentError: due, stopReason: 'Stopped: model overloaded' });
session('tbe-auto', `${fake} ${file('auto.screen', claudeScreen(''))} ${join(root, 'auto.in')}`);
// 4. the same, but a person typed a draft into the box
store.create({ ...base('draft', 4, 'claude', 'stopped'), agentError: due, stopReason: 'Stopped: model overloaded' });
session('tbe-draft', `${fake} ${file('draft.screen', claudeScreen('\\033[37mhello there\\033[0m'))} ${join(root, 'draft.in')} 15`);
// 7. the agent takes the line but its box still shows the text, so the check after Enter fails: one try only
const sticky = join(root, 'sticky.sh');
writeFileSync(sticky, `#!/bin/bash\nprintf '%b' "$(cat "$1")"\nprintf '\\033[1A\\033[3G'\nwhile IFS= read -r line; do echo "$line" >> "$2"; done\nsleep 600\n`); chmodSync(sticky, 0o755);
store.create({ ...base('sticky', 7, 'claude', 'stopped'), agentError: due, stopReason: 'Stopped: model overloaded' });
session('tbe-sticky', `${sticky} ${file('sticky.screen', claudeScreen(''))} ${join(root, 'sticky.in')}`);
// 5. working and waiting for the model, with no change: a stall. 6. working on a long tool call: never a stall.
const old = iso(Date.now() - 3600000);
const prompt = JSON.stringify({ type: 'user', timestamp: old, message: { role: 'user', content: 'run the tests' } });
const tool = JSON.stringify({ type: 'assistant', timestamp: old, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'pnpm test' } }] } });
store.create({ ...base('hung', 5, 'claude', 'working'), transcript: file('hung.jsonl', prompt + '\n') });
session('tbe-hung', `${fake} ${file('hung.screen', claudeScreen(''))} ${join(root, 'hung.in')}`);
store.create({ ...base('tool', 6, 'claude', 'working'), transcript: file('tool.jsonl', prompt + '\n' + tool + '\n') });
session('tbe-tool', `${fake} ${file('tool.screen', claudeScreen(''))} ${join(root, 'tool.in')}`);

test('a scratch server shows model errors, retries, stalls and auto-continue, and never types over a draft', { timeout: 150000 }, async () => {
  const net = await import('node:net'); const probe = net.createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const url = `http://127.0.0.1:${port}`;
  // never the real server: the variables of a Taskboard session that point tb at it are removed
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TB_/.test(k)));
  const env = { ...own, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_MACHINE_NAME: 'agent-errors-test', TASKBOARD_ERROR_SCREEN_MS: '1000', TASKBOARD_STALL_MS: '5000' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const headers = { 'content-type': 'application/json', 'x-taskboard-token': token };
  const get = async (id: string) => (await (await fetch(`${url}/api/tasks`, { headers })).json()).find((t: any) => t.id === id);
  const until = async (what: string, fn: () => Promise<boolean>, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 300)); }
    assert.fail(`timed out: ${what}\n${output.slice(-3000)}`);
  };
  const read = (f: string) => existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '';
  try {
    await until('the server answers', async () => (await fetch(url + '/api/info', { headers })).status === 200);

    // 1. task 277 as it was: Stopped: model at capacity, read from the session file, with the log line
    await until('the Codex task stops', async () => (await get('cap')).status === 'stopped');
    const cap = await get('cap');
    assert.equal(cap.errorLabel, 'Stopped: model at capacity');
    assert.equal(cap.agentError.kind, 'overloaded'); assert.equal(cap.agentError.source, 'transcript');
    assert.match(cap.statusSource, /^Read from the session file at \d\d:\d\d: Selected model is at capacity/);
    assert.match(store.readLog('cap'), /- Did: Stopped: model at capacity\./);
    // auto-continue is on, so the next try is planned one minute after the stop; nothing was typed yet
    assert.ok(cap.agentError.auto.nextAt); assert.equal(read('cap.in'), '');

    // 2. a retry keeps "working" with a calm label, and the label goes when the retry ends
    await until('the retry shows', async () => (await get('retry')).errorLabel === 'Retrying (attempt 2/10)');
    assert.equal((await get('retry')).status, 'working');
    await until('the retry ends', async () => !(await get('retry')).agentError);
    assert.equal((await get('retry')).status, 'working');

    // 3. auto-continue types "continue" into the empty box, once
    await until('auto-continue types', async () => read('auto.in') === 'continue\n');
    // the status changes when deliverText returns, after its check of the screen that follows Enter
    await until('the task works again', async () => (await get('auto')).status === 'working');
    const auto = await get('auto');
    assert.equal(auto.status, 'working'); assert.equal(auto.agentError.phase, 'resumed'); assert.equal(auto.agentError.auto.tries, 1);
    assert.match(store.readLog('auto'), /Auto-continue: typed "continue" after model overloaded .*Try 1 of 5\. It is an ordinary turn of the agent\./);
    // the error comes back (Claude Code StopFailure): the same episode, the next try after 2 minutes
    const hook = await fetch(url + '/api/hooks/claude', { method: 'POST', headers, body: JSON.stringify({ taskId: 'auto', input: { hook_event_name: 'StopFailure', error: 'overloaded', last_assistant_message: 'API Error: Repeated 529 Overloaded errors.' } }) });
    assert.equal(hook.status, 200);
    const again = await get('auto');
    assert.equal(again.status, 'stopped'); assert.equal(again.agentError.auto.tries, 1);
    const wait = Date.parse(again.agentError.auto.nextAt) - Date.now();
    assert.ok(wait > 100000 && wait <= 120000, `next try in ${wait} ms`);
    // a turn that ends without an error ends the episode
    await fetch(url + '/api/hooks/claude', { method: 'POST', headers, body: JSON.stringify({ taskId: 'auto', input: { hook_event_name: 'UserPromptSubmit', prompt: 'please go on' } }) });
    await fetch(url + '/api/hooks/claude', { method: 'POST', headers, body: JSON.stringify({ taskId: 'auto', input: { hook_event_name: 'Stop', last_assistant_message: 'Done.', stop_hook_active: true } }) });
    assert.equal((await get('auto')).agentError, undefined);

    // 4. a draft in the box: nothing typed, and auto-continue stops for this error with the reason
    await until('auto-continue gives up on the draft', async () => !!(await get('draft')).agentError?.auto?.off);
    assert.match((await get('draft')).agentError.auto.off, /A person typed in the input box/);
    assert.equal(read('draft.in'), ''); assert.equal((await get('draft')).status, 'stopped');

    // 7. a failed check after Enter ends auto-continue for this error: the agent got the text once, never twice
    await until('the failed try ends auto-continue', async () => /^Typing failed/.test((await get('sticky')).agentError?.auto?.off || ''), 40000);
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(read('sticky.in'), 'continue\n');
    assert.equal((await get('sticky')).agentError.auto.nextAt, undefined);

    // 5 and 6. the stall rule: the task that waits for the model stalls; the long tool call does not
    await until('the hung task stalls', async () => (await get('hung')).status === 'stopped', 30000);
    const hung = await get('hung');
    assert.equal(hung.errorLabel, 'Stalled: no activity (inferred)'); assert.match(hung.statusSource, /^Inferred from no activity/);
    assert.equal((await get('tool')).status, 'working');
    // a stall is inferred: auto-continue does not type into it
    assert.equal(read('hung.in'), '');

    // tb list shows the state
    const list = execFileSync(process.execPath, ['bin/tb', 'list'], { cwd: resolve('.'), env: { ...env, TASK_ID: '', TB_URL: url, TB_TOKEN_FILE: TOKEN_FILE }, encoding: 'utf8' });
    assert.match(list, /#1 +stopped .* — Stopped: model at capacity: Selected model is at capacity/);

    // Dismiss: the task shows idle, and the same record is not read again
    const dismissed = await (await fetch(`${url}/api/tasks/cap/agent-error/dismiss`, { method: 'POST', headers })).json();
    assert.equal(dismissed.status, 'idle'); assert.equal(dismissed.agentError, undefined);
    await new Promise(r => setTimeout(r, 3000));
    assert.equal((await get('cap')).status, 'idle');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
});
