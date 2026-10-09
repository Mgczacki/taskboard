// Messages to a busy agent (task 178). The screen cases use screens captured from Claude Code 2.1.287 in a test tmux
// session (tests/fixtures/screens) and the fake agent in tests/fixtures/fake-agent.cjs, in a temporary Taskboard folder
// and tmux socket. Covers: which screens take a message, the queue in the task folder, the retry, the expiry, the
// order of queued messages, a person's draft, the controller, and inbox notices through the PostToolUse hook.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
const terminalInput = await import('../server/terminal-input.ts');
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
    // Claude Code 2.1.288 as the controller (claude --name): the name is in the upper rule. The box and footer rows are
    // from a capture of the real controller on 2026-10-03; the rows above the box and the machine name are replaced.
    ['claude-controller-named.ansi', 'empty'],
    // the same rows while it works, with Claude Code's own queued-message hint in the box (rows composed, not captured)
    ['claude-controller-named-busy.ansi', 'empty'],
  ];
  for (const [file, want] of cases) assert.equal(boxState(screenFile(file)), want, file);
  // the cause of task 217: the old rule pattern did not match the upper rule with the name, so every check of the
  // controller found no input box ("Claude Code in #0 does not show its input box"), idle or busy
  const upper = plainText(screenFile('claude-controller-named.ansi')).split('\n').find(l => l.includes('Taskboard controller'))!;
  assert.doesNotMatch(upper, /^─{10,}\s*$/);
  assert.equal(boxState(screenFile('claude-controller-named.ansi').replace(upper, '─'.repeat(upper.length))), 'empty');
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

test('Codex questions keep their status and block queued text while collapsed or open', () => {
  const t = store.create({ id: 'question-screen-check', num: 299, title: 'Question screen check', agent: 'codex', status: 'working', cwd: root, folder: root, session: 'no-session-needed', desc: '' });
  const collapsed = '• Queued follow-up inputs\n  ? 1 question · 18s\n    shift+← to answer\n› Ask Codex to do anything';
  const opened = screenFile('codex-choice-question.txt');
  const freeform = 'Question 1/1 (1 unanswered)\nWhat name?\n› Type your answer (optional)\nenter to submit answer | esc to interrupt';
  const asyncQuestion = screenFile('codex-async-question.txt');
  for (const screen of [collapsed, opened, asyncQuestion, freeform, freeform.replace('Type your answer (optional)', 'start')]) {
    events.codexQuestionCheck(t, screen);
    assert.equal(t.status, 'needs-you');
    assert.equal(boxState(screen, 'codex'), 'question');
  }
  events.codexQuestionCheck(t, '› Ask Codex to do anything');
  assert.equal(t.status, 'working');
});

test('a screen answer shares the input lock with normal message delivery and holds terminal keys', async () => {
  const { withTaskInput, sendTaskText } = await import('../server/agents.ts');
  const t = store.create({ id: 'question-input-lock', num: 298, title: 'Question input lock', agent: 'codex', status: 'working', cwd: root, folder: root, session: 'no-lock-session-needed', desc: '' });
  let release!: () => void, typed = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const answer = withTaskInput(t, async () => { await barrier; });
  assert.equal(terminalInput.held(t.session), true);
  terminalInput.write(t.session, () => { typed = true; });
  await assert.rejects(sendTaskText(t, 'follow-up'), /Another message is being typed/);
  assert.equal(typed, false);
  release(); await answer;
  assert.equal(typed, true);
  assert.equal(terminalInput.held(t.session), false);
});

let num = 300;
const fakeState = (t: { id: string }, s: object) => writeFileSync(join(store.taskDir(t.id), 'fake-state.json'), JSON.stringify(s));
const submitted = (t: { id: string }) => {
  const f = join(store.taskDir(t.id), 'submitted.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => (JSON.parse(l) as { text: string }).text) : [];
};
const typed = (t: { id: string }) => { try { return readFileSync(join(store.taskDir(t.id), 'input.txt'), 'utf8'); } catch { return ''; } };
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => { for (let i = 0; i < ms / 100 && !(await check()); i++) await pause(100); return check(); };
async function liveTask(agent: 'claude' | 'codex' | 'antigravity' = 'claude', role?: 'controller') {
  const n = ++num;
  const t = store.create({ id: role ? 'controller' : `queue-${n}`, num: role ? 0 : n, title: 'Queue fixture', agent, status: 'working', cwd: root, folder: root, session: role ? 'tb-controller' : `task-${n}`, sessionId: `fixture-${n}`, account: agent === 'codex' ? 'codex-fixture' : undefined, desc: '', ...(role ? { role } : {}) });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), FAKE_AGENT: agent }, [join(bin, agent === 'antigravity' ? 'agy' : agent)], async () => {});
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
    assert.ok(await until(() => queue.list(t.id).every(q => q.state === 'delivered')));
    assert.match(store.get(t.id)!.statusSource || '', /from the queue/);
  } finally { await tmux.killSession(t.session); }
});

// Task 271: a draft in the box made every message wait until the person sent or cleared it (one message waited 7.6
// hours). Now the draft is moved out once nobody typed for 3 s, the message is submitted, and the draft is put back.
const boxText = (t: { id: string }) => JSON.parse(readFileSync(join(store.taskDir(t.id), 'box.json'), 'utf8')).text as string;
const draftFiles = (t: { id: string }) => { try { return readdirSync(join(store.taskDir(t.id), 'drafts')); } catch { return []; } };
for (const agent of ['claude', 'codex', 'antigravity'] as const) {
  test(`${agent}: a quiet draft is moved out, the message is submitted, and the draft is put back`, { timeout: 60000 }, async () => {
    const t = await liveTask(agent);
    try {
      await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'half a sentence');
      await pause(agent === 'codex' ? 900 : 300); // the fake Codex joins fast keys into one paste after 600 ms
      const r = await queue.send(t, 'Do not join the draft', { from: 'controller', kind: 'message' });
      assert.equal(r.state, 'queued');
      assert.match(r.reason!, /holds a draft/);
      // within 3 s of the last change nothing is typed
      await tick(); await pause(200);
      assert.equal(boxText(t), 'half a sentence');
      assert.deepEqual(submitted(t), []);
      await pause(3200);
      await tick();
      assert.ok(await until(() => submitted(t).includes('Do not join the draft')), `the message is submitted: ${JSON.stringify(queue.list(t.id))}\n${await tmux.capture(t.session, 0)}`);
      assert.ok(await until(() => boxText(t) === 'half a sentence'), 'the draft is back in the box');
      assert.deepEqual(submitted(t), ['Do not join the draft'], 'the draft is not submitted');
      assert.equal(draftFiles(t).length, 1, 'the draft is saved in the task folder');
      assert.match(queue.list(t.id)[0].deliveredBy || '', /the draft in the box was put back/);
    } finally { await tmux.killSession(t.session); }
  });
}

test('a draft that wraps over rows and has several lines comes back exactly', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    await tmux.tmux('resize-window', '-t', `=${t.session}:`, '-x', '120', '-y', '40');
    const draft = 'first line of the draft\n' + 'a second line that is long enough to wrap over more than one row of the box at this width, '.repeat(2).trim() + '\nthird';
    const f = join(root, 'draft.txt'); writeFileSync(f, draft);
    await tmux.tmux('load-buffer', '-b', 'd', f); await tmux.tmux('paste-buffer', '-p', '-d', '-b', 'd', '-t', `=${t.session}:`);
    await until(() => boxText(t) === draft);
    // the first screen read sees the draft; it is moved once it stayed the same for 3 s
    assert.equal((await queue.send(t, 'Message between', { from: 'controller', kind: 'message' })).state, 'queued');
    await pause(3200);
    await tick();
    assert.ok(await until(() => submitted(t).includes('Message between')), JSON.stringify(queue.list(t.id)));
    assert.ok(await until(() => boxText(t) === draft), `the draft is back: ${JSON.stringify(boxText(t))}`);
    assert.deepEqual(submitted(t), ['Message between']);
    assert.match(await tmux.tmux('display-message', '-p', '-t', `=${t.session}:`, '#{window_width}'), /^120\b/, 'the width is set back');
  } finally { await tmux.killSession(t.session); }
});

test('a key from a dashboard terminal in the last 3 s makes the message wait', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'typing now');
    await pause(3200);
    terminalInput.noteKey(t.session);
    const r = await queue.send(t, 'Not yet', { from: 'controller', kind: 'message' });
    assert.equal(r.state, 'queued');
    await tick(); await pause(300);
    assert.deepEqual(submitted(t), []);
    assert.equal(boxText(t), 'typing now');
  } finally { await tmux.killSession(t.session); }
});

test('a draft with a paste placeholder is not moved, and the message waits', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    const f = join(root, 'big.txt'); writeFileSync(f, 'x'.repeat(900));
    await tmux.tmux('load-buffer', '-b', 'b', f); await tmux.tmux('paste-buffer', '-p', '-d', '-b', 'b', '-t', `=${t.session}:`);
    await until(async () => /\[Pasted text #1\]/.test(await tmux.capture(t.session, 0)));
    const r = await queue.send(t, 'Wait for the paste', { from: 'controller', kind: 'message' });
    assert.equal(r.state, 'queued');
    await pause(3200);
    await tick(); await pause(300);
    assert.match(queue.list(t.id)[0].reason, /cannot type back exactly/);
    assert.deepEqual(submitted(t), []);
    assert.equal(boxText(t), 'x'.repeat(900));
  } finally { await tmux.killSession(t.session); }
});

test('a small pane that no terminal shows gets a usable size, and a long message arrives', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    // task 271: at 60x16 a 658 character message did not fit in the visible box, and it stayed in the box
    await tmux.tmux('resize-window', '-t', `=${t.session}:`, '-x', '60', '-y', '16');
    await pause(300);
    const text = 'Long message for a small pane. '.repeat(21).trim();
    assert.equal((await queue.send(t, text, { from: 'controller', kind: 'message' })).state, 'delivered');
    assert.ok(await until(() => submitted(t).includes(text)));
    assert.equal(boxText(t), '');
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
    assert.match(second.reason!, /1 earlier message for #\d+ waits to be delivered first/);
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, 'BSpace');
    await pause(300);
    await tick(); await tick();
    assert.ok(await until(() => submitted(t).length === 2));
    assert.deepEqual(submitted(t), ['First', 'Second']);
  } finally { await tmux.killSession(t.session); }
});

test('a queued message does not expire: each screen check is counted and says what it saw', { timeout: 60000 }, async () => {
  const t = await liveTask();
  try {
    fakeState(t, { permission: true });
    await pause(300);
    const r = await queue.send(t, 'Still waiting', { from: 'controller', kind: 'message' });
    assert.equal(r.state, 'queued');
    // a message from an older version, with the 60 minutes expiry in the past
    const items = queue.list(t.id); items[0].expires = new Date(Date.now() - 1000).toISOString();
    writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
    for (let i = 0; i < 3; i++) await tick();
    const q = queue.list(t.id)[0];
    assert.equal(q.state, 'queued', 'no expiry');
    assert.equal(q.checks, 3);
    assert.equal(q.tries, 1, 'tries counts typing tries only');
    assert.equal(q.seen, 'The agent was working and the agent showed a question or dialog.');
    const view = queue.forView(t.id)[0] as { checks: number; seen: string; late: boolean };
    assert.equal(view.checks, 3);
    assert.equal(view.late, false);
    fakeState(t, {});
    await pause(300);
    await tick();
    assert.ok(await until(() => submitted(t).includes('Still waiting')));
    const done = queue.list(t.id).find(x => x.id === r.id)!;
    assert.equal(done.state, 'delivered');
    assert.equal(done.deliveredBy, 'typed into the input box');
    assert.equal(queue.forView(t.id).length, 0, 'a delivered message is not shown as waiting');
  } finally { await tmux.killSession(t.session); }
});

test('a message that was typed only in part fails, stays visible, and can be typed again', async () => {
  const n = ++num;
  const t = store.create({ id: `failed-${n}`, num: n, title: 'Failed fixture', agent: 'claude', status: 'idle', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, desc: '' });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify([{ id: 'part1', text: 'Half', kind: 'message', from: 'controller', queued: new Date().toISOString(), state: 'failed', reason: 'Enter was not pressed.', tries: 2 }]));
  assert.equal(queue.forView(t.id).length, 0, 'the server has not seen this file yet');
  queue.start(); queue.stop();
  assert.equal(queue.forView(t.id)[0].state, 'failed');
  assert.equal(queue.takeForHook(t.id, 'PostToolUse'), null, 'a hook does not deliver a failed message');
  assert.equal(queue.retry(t.id, 'part1')?.state, 'queued');
  assert.match(queue.takeForHook(t.id, 'PostToolUse') || '', /Half/);
});

// Task 280: task 216 kept two Not delivered cards from 06:57 and 09:13 while later messages reached it by the hook.
test('a failed message closes after an hour once the agent took a turn, and at most MAX_FAILED stay open', () => {
  const n = ++num;
  const now = Date.parse('2026-10-05T12:00:00.000Z'), ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const t = store.create({ id: `expire-${n}`, num: n, title: 'Expire fixture', agent: 'claude', status: 'working', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, desc: '' });
  store.update(t.id, { statusAt: ago(200) });
  const sender = store.create({ id: `sender-${n}`, num: n + 1000, title: 'Sender', agent: 'claude', status: 'idle', cwd: root, folder: root, session: `task-${n + 1000}`, sessionId: `fixture-${n + 1000}`, desc: '' });
  const failed = (id: string, min: number, from = 'taskboard') => ({ id, text: `digest ${id}`, kind: 'message', from, queued: ago(min), triedAt: ago(min), state: 'failed', reason: 'Enter was not pressed.', tries: 1 });
  const write = (items: object[]) => { mkdirSync(store.taskDir(t.id), { recursive: true }); writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items)); queue.start(); queue.stop(); };
  // old (180 min) and young (30 min), with a later message delivered by the hook at 120 min: only the old one closes
  write([failed('old', 180, sender.id), { id: 'later', text: 'later', kind: 'message', from: 'taskboard', queued: ago(121), state: 'delivered', deliveredAt: ago(120), deliveredBy: 'UserPromptSubmit hook', reason: '', tries: 1 }, failed('young', 30)]);
  queue.expireFailed(t.id, now);
  assert.deepEqual(queue.forView(t.id).map(q => q.id), ['young']);
  const old = queue.list(t.id).find(q => q.id === 'old')!;
  assert.equal(old.state, 'expired');
  assert.equal(old.closedAt, new Date(now).toISOString());
  assert.match(readFileSync(join(store.taskDir(sender.id), 'inbox', 'message-old-expired.md'), 'utf8'), /failed and was not delivered/, 'the sender task is told');
  // no turn after the failure: an old failed message stays open
  write([failed('alone', 180)]);
  queue.expireFailed(t.id, now);
  assert.deepEqual(queue.forView(t.id).map(q => q.id), ['alone']);
  // the status changed after the failure: that is a turn
  store.update(t.id, { statusAt: ago(100) });
  queue.expireFailed(t.id, now);
  assert.deepEqual(queue.forView(t.id), []);
  // the cap: 22 young failed messages keep the newest MAX_FAILED open
  store.update(t.id, { statusAt: ago(500) });
  write(Array.from({ length: queue.MAX_FAILED + 2 }, (_, i) => failed(`f${i}`, 50 - i)));
  queue.expireFailed(t.id, now);
  assert.deepEqual(queue.forView(t.id).map(q => q.id), Array.from({ length: queue.MAX_FAILED }, (_, i) => `f${i + 2}`));
  // an expired message cannot be typed again or given to a hook
  assert.equal(queue.retry(t.id, 'f0'), null);
  assert.equal(queue.viaHook(t.id, 'f0'), null);
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
    // as Claude Code 2.1.288 draws the controller: its name in the upper rule, a status line below the box
    fakeState(t, { busy: true, name: 'Taskboard controller · test-machine', footer: ['  Sonnet 5.5 · 5h 8% · week 38%'] });
    await pause(300);
    await tick();
    assert.ok(await until(async () => /❯ Worktree request from #165/.test(await tmux.capture(t.session, 0))));
    assert.ok(await until(() => queue.list(t.id).every(q => q.state === 'delivered')));
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
