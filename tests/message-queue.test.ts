// Messages to a busy agent (task 178). The screen cases use screens captured from Claude Code 2.1.287 in a test tmux
// session (tests/fixtures/screens) and the fake agent in tests/fixtures/fake-agent.cjs, in a temporary Taskboard folder
// and tmux socket. Covers: which screens take a message, the queue in the task folder, the retry, the expiry, the
// order of queued messages, a person's draft, the controller, and inbox notices through the PostToolUse hook.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-message-queue-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-message-queue-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = readFileSync(join(import.meta.dirname, 'fixtures', 'fake-agent.cjs'), 'utf8');
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify([{ id: 'codex-fixture', agent: 'codex', name: 'Codex fixture', dir: process.env.CODEX_HOME, maxParallel: 100, created: new Date().toISOString() }]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const tmux = await import('../server/tmux.ts');
const docs = await import('../server/docs.ts');
const events = await import('../server/events.ts');
const inboxDelivery = await import('../server/inbox-delivery.ts');
const queue = await import('../server/message-queue.ts');
const { blockingQuestion } = await import('../server/agents.ts');
const { boxState, plainText, readyForInput } = await import('../server/type-command.ts');
const { bottom } = await import('../server/deliver-text.ts');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const screenFile = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'screens', name), 'utf8');

test('Claude Code 2.1.287 screens: which ones take a message', () => {
  const cases: [string, string][] = [
    ['claude-long-tool-call.txt', 'empty'], // a long Bash call runs: spinner, empty box, "esc to interrupt"
    ['claude-queued.txt', 'empty'], // a message waits in Claude Code's own queue; the box shows the hint
    ['claude-queued-hint.ansi', 'empty'], // the same, with colors: the hint is dim
    ['claude-idle-suggestion.ansi', 'empty'], // idle, with the dim suggestion "Try ..."
    ['claude-background-notice.txt', 'empty'], // a background command finished; its notice is above the box
    ['claude-idle-question-words-above.txt', 'empty'], // idle; the agent's own reply above the box asks "Do you want to ..."
    ['claude-permission.txt', 'question'], // the permission question replaces the box
    ['claude-draft.ansi', 'draft'], // a person typed "my draft"
  ];
  for (const [file, want] of cases) assert.equal(boxState(screenFile(file)), want, file);
  // the cause of the refusal: the old check searched the whole screen (and deliverText the bottom 15 rows) for question
  // words, and found them in the agent's earlier reply above an empty box
  const idle = screenFile('claude-idle-question-words-above.txt');
  assert.match(idle, /Do you want to approve the merge/);
  assert.match(bottom(idle), blockingQuestion, 'the old dialog check matched this idle screen');
  // a draft cannot be seen in a plain capture: the old check took it for a suggestion and typed after it
  assert.equal(boxState(plainText(screenFile('claude-draft.ansi'))), 'empty');
  assert.match(plainText(screenFile('claude-draft.ansi')), /❯\smy draft/);
});

test('Codex 0.160.0 and Antigravity boxes: a dim placeholder is empty, other text is a draft', () => {
  const footer = '\n\n  GPT-6-Sol medium · ~/project\n  ← for agents · ? for shortcuts';
  // bytes as tmux capture-pane -e showed them
  assert.equal(boxState('• Ran tests\n\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m' + footer, 'codex'), 'empty');
  assert.equal(boxState('• Ran tests\n\n\x1b[1m›\x1b[0m my codex draft' + footer, 'codex'), 'draft');
  // Codex shows the answers of its question with its prompt mark, so the box itself is the question
  assert.equal(boxState('  Would you like to run the following command?\n  $ rm -rf build\n\n› 1. Yes, proceed (y)\n  2. No (esc)\n\n  Press enter to confirm', 'codex'), 'question');
  const rule = '─'.repeat(60);
  assert.equal(boxState(`  Do you want to see the plan?\n${rule}\n>\n${rule}\n? for shortcuts`, 'antigravity'), 'empty');
  assert.equal(boxState(`${rule}\n> Run this\n${rule}\n● Bash(touch a.txt)\n${rule}\nRequesting permission for:\n   touch a.txt\nRun this command?\n> 1. Yes, run command\n  4. No, cancel`, 'antigravity'), 'question');
  // a color given as 38;2;r;g;b with g = 2 is not the dim attribute
  assert.equal(boxState(`${rule}\n\x1b[39m❯ \x1b[38;2;10;2;30mhello\x1b[0m\n${rule}\n  ? for shortcuts`), 'draft');
  assert.equal(readyForInput(`${rule}\n❯ \n${rule}\n  ? for shortcuts`), true);
});

let num = 300;
const fakeState = (t: { id: string }, s: object) => writeFileSync(join(store.taskDir(t.id), 'fake-state.json'), JSON.stringify(s));
const submitted = (t: { id: string }) => {
  const f = join(store.taskDir(t.id), 'submitted.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => (JSON.parse(l) as { text: string }).text) : [];
};
const typed = (t: { id: string }) => { try { return readFileSync(join(store.taskDir(t.id), 'input.txt'), 'utf8'); } catch { return ''; } };
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => { for (let i = 0; i < ms / 100 && !(await check()); i++) await pause(100); return check(); };
async function liveTask(agent: 'claude' | 'codex' = 'claude', role?: 'controller') {
  const n = ++num;
  const t = store.create({ id: role ? 'controller' : `queue-${n}`, num: role ? 0 : n, title: 'Queue fixture', agent, status: 'working', cwd: root, folder: root, session: role ? 'tb-controller' : `task-${n}`, sessionId: `fixture-${n}`, account: agent === 'codex' ? 'codex-fixture' : undefined, desc: '', ...(role ? { role } : {}) });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), FAKE_AGENT: agent }, [join(bin, agent)], async () => {});
  await until(async () => /for shortcuts/.test(await tmux.capture(t.session, 0)), 4000);
  return t;
}
// one run of the retry loop for this task (the server runs it every 2 s)
const tick = () => queue.tick();

test('a busy Claude Code with an empty box takes the message at once; Claude Code queues it itself', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    fakeState(t, { busy: true, history: ['⏺ Do you want to approve the merge of task 12?'] });
    await pause(300);
    const r = await queue.send(t, 'Message while busy', { from: 'controller', kind: 'message' });
    assert.equal(r.state, 'delivered');
    assert.match(await tmux.capture(t.session, 0), /❯ Message while busy\n {2}ctrl\+x ctrl\+s to send now/);
    assert.deepEqual(submitted(t), [], 'Claude Code keeps it until the turn ends');
    fakeState(t, {});
    assert.ok(await until(() => submitted(t).includes('Message while busy')));
  } finally { await tmux.killSession(t.session); }
});

test('a background task notice and question words in earlier output do not stop a message', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    fakeState(t, { notice: true, history: ['⏺ Would you like to see the approval requested by task 9 first?', '  Allow this action on the dashboard.'] });
    await pause(300);
    assert.equal((await queue.send(t, 'After the notice', { from: 'controller', kind: 'message' })).state, 'delivered');
    assert.ok(await until(() => submitted(t).includes('After the notice')));
  } finally { await tmux.killSession(t.session); }
});

test('a permission question: nothing is typed, the message is queued, and it is typed after the answer', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    fakeState(t, { permission: true });
    await pause(300);
    const r = await queue.send(t, 'Wait for the answer', { from: 'task-165', kind: 'message' });
    assert.equal(r.state, 'queued');
    assert.match(r.reason!, /asks a question or shows a dialog/);
    assert.doesNotMatch(typed(t), /Wait for the answer/);
    // durable: the message is in the task folder
    const saved = JSON.parse(readFileSync(join(store.taskDir(t.id), 'message-queue.json'), 'utf8'));
    assert.equal(saved[0].text, 'Wait for the answer');
    assert.equal(saved[0].state, 'queued');
    assert.equal(queue.forView(t.id)[0].reason, r.reason);
    await tick();
    assert.doesNotMatch(typed(t), /Wait for the answer/, 'the retry does not type into the question');
    // the person answers the question
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '1');
    await until(() => submitted(t).includes('PERMISSION_ANSWERED'));
    await tick();
    assert.ok(await until(() => submitted(t).includes('Wait for the answer')));
    assert.ok(await until(() => queue.list(t.id).length === 0));
    assert.match(store.get(t.id)!.statusSource || '', /from the queue/);
  } finally { await tmux.killSession(t.session); }
});

test('a draft typed by a person is never changed, and the message waits until the box is empty', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'half a sentence');
    await pause(300);
    const r = await queue.send(t, 'Do not join the draft', { from: 'controller', kind: 'message' });
    assert.equal(r.state, 'queued');
    assert.match(r.reason!, /holds a draft that a person typed/);
    for (let i = 0; i < 3; i++) { await tick(); await pause(200); }
    assert.match(await tmux.capture(t.session, 0), /❯ half a sentence\n/, 'the draft is unchanged');
    assert.doesNotMatch(typed(t), /Do not join the draft/);
    assert.deepEqual(submitted(t), []);
    // the person sends the draft; then the box is empty and the queued message is typed
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, 'Enter');
    await until(() => submitted(t).includes('half a sentence'));
    await tick();
    assert.ok(await until(() => submitted(t).includes('Do not join the draft')));
    assert.deepEqual(submitted(t), ['half a sentence', 'Do not join the draft']);
  } finally { await tmux.killSession(t.session); }
});

test('queued messages keep their order, and a new message waits behind them', { timeout: 60000 }, async () => {
  const t = await liveTask('codex');
  try {
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'x');
    await pause(800);
    assert.equal((await queue.send(t, 'First', { from: 'controller', kind: 'message' })).state, 'queued');
    const second = await queue.send(t, 'Second', { from: 'controller', kind: 'message' });
    assert.equal(second.state, 'queued');
    assert.match(second.reason!, /1 earlier message for #\d+ waits to be typed first/);
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, 'BSpace');
    await pause(300);
    await tick(); await tick();
    assert.ok(await until(() => submitted(t).length === 2));
    assert.deepEqual(submitted(t), ['First', 'Second']);
  } finally { await tmux.killSession(t.session); }
});

test('a message that is not typed within the set time fails, stays visible, and can be typed again', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    fakeState(t, { permission: true });
    await pause(300);
    const r = await queue.send(t, 'Too late', { from: 'controller', kind: 'message' });
    const items = queue.list(t.id); items[0].expires = new Date(Date.now() - 1000).toISOString();
    writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
    await tick();
    const failed = queue.list(t.id)[0];
    assert.equal(failed.state, 'failed');
    assert.match(failed.reason, /^Not typed within 60 minutes\. Last reason: .*asks a question/);
    assert.equal(queue.forView(t.id)[0].state, 'failed');
    fakeState(t, {});
    await pause(300);
    await tick();
    assert.deepEqual(submitted(t), [], 'a failed message is not typed without the user');
    queue.retry(t.id, r.id!);
    assert.ok(await until(() => submitted(t).includes('Too late')));
    assert.ok(await until(() => queue.list(t.id).length === 0));
  } finally { await tmux.killSession(t.session); }
});

test('the controller: queued while it does not run, typed when it runs and its box is empty', { timeout: 60000 }, async () => {
  const t = store.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'working', cwd: root, folder: root, session: 'tb-controller', sessionId: 'fixture-ctl', desc: '', role: 'controller' });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  const r = await queue.send(t, 'Worktree request from #165', { from: 'task-165', kind: 'message' });
  assert.equal(r.state, 'queued');
  assert.equal(r.reason, 'The controller is not running.');
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), FAKE_AGENT: 'claude' }, [join(bin, 'claude')], async () => {});
  try {
    await until(async () => /for shortcuts/.test(await tmux.capture(t.session, 0)), 4000);
    fakeState(t, { busy: true });
    await pause(300);
    await tick();
    assert.ok(await until(async () => /❯ Worktree request from #165/.test(await tmux.capture(t.session, 0))));
    assert.ok(await until(() => queue.list(t.id).length === 0));
  } finally { await tmux.killSession(t.session); }
});

test('an inbox notice reaches a working Claude Code at its next tool call (PostToolUse hook)', async () => {
  const n = ++num;
  const t = store.create({ id: `hook-${n}`, num: n, title: 'Hook fixture', agent: 'claude', status: 'working', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, desc: '' });
  docs.uploadSystem(t.id, 'controller-worktree-request.md', '# Request\n');
  inboxDelivery.track(t.id, 'controller-worktree-request.md', 'The input box holds a draft.');
  assert.equal(inboxDelivery.openFor(t.id).length, 1);
  const out = events.claudeEvent(t.id, { hook_event_name: 'PostToolUse', session_id: `fixture-${n}`, tool_name: 'Bash' }).output as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /New file in your Taskboard inbox[\s\S]*controller-worktree-request\.md/);
  assert.equal(inboxDelivery.openFor(t.id).length, 0, 'the notice counts as delivered');
  // the next tool call has nothing new
  assert.equal(events.claudeEvent(t.id, { hook_event_name: 'PostToolUse', session_id: `fixture-${n}`, tool_name: 'Bash' }).output, undefined);
});

test('an inbox notice that cannot be typed is tried again when the box becomes empty', { timeout: 60000 }, async () => {
  const t = await liveTask('codex');
  try {
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'y');
    await pause(800);
    docs.uploadSystem(t.id, 'review-note.md', '# Note\n');
    const d = await inboxDelivery.deliver(t.id, 'review-note.md');
    assert.equal(d.deliveredAt, undefined);
    assert.match(d.problem || '', /holds a draft/);
    assert.equal(queue.forView(t.id).find(x => x.kind === 'inbox')?.reason, d.problem);
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, 'BSpace');
    await pause(300);
    await tick();
    assert.ok(await until(() => submitted(t).some(s => /New file in your Taskboard inbox/.test(s))));
    assert.ok(inboxDelivery.get(t.id, 'review-note.md')?.deliveredAt);
  } finally { await tmux.killSession(t.session); }
});
