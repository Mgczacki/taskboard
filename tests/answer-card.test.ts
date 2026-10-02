// The answer to a question card for a question at the end of a turn (task 204). Before the fix, agents.sendTaskText
// refused every answer while the task was "needs you" from the Stop hook, and the card exists only in that status.
// The cases use the fake agent (tests/fixtures/fake-agent.cjs) in a test tmux socket, the real Stop and
// UserPromptSubmit hook handlers (events.ts), pending.scan, and pending.setIo wired as server/index.ts wires it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-answer-card-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-answer-card-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = readFileSync(join(import.meta.dirname, 'fixtures', 'fake-agent.cjs'), 'utf8');
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const tmux = await import('../server/tmux.ts');
const events = await import('../server/events.ts');
const agents = await import('../server/agents.ts');
const pending = await import('../server/pending.ts');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

pending.setIo({
  capture: session => tmux.capture(session, 0),
  key: async (session, key, literal) => { await tmux.tmux('send-keys', '-t', '=' + session + ':', ...(literal ? ['-l', key] : [key])); },
  cancelCopyMode: async () => {},
  sendText: (t, text) => agents.sendTaskText(t, text, { answer: true }),
  getTask: id => store.get(id),
  log: () => {},
  answered: (t, note) => { if (store.get(t.id)?.status === 'needs-you') store.update(t.id, { status: 'working', ask: '', statusSource: note }); },
  wait: pause,
});

const QUESTION = 'Do you want me to send the merge request now?';
const history = ['⏺ The branch is ready. ' + QUESTION];
let num = 0;
const fakeState = (t: { id: string }, s: object) => writeFileSync(join(store.taskDir(t.id), 'fake-state.json'), JSON.stringify(s));
const submitted = (t: { id: string }) => {
  const f = join(store.taskDir(t.id), 'submitted.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => (JSON.parse(l) as { text: string }).text) : [];
};
const typed = (t: { id: string }) => { try { return readFileSync(join(store.taskDir(t.id), 'input.txt'), 'utf8'); } catch { return ''; } };
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => { for (let i = 0; i < ms / 100 && !(await check()); i++) await pause(100); return check(); };

// a fake Claude Code that ended its turn with the question: the Stop hook sets "needs you", and the watcher's scan makes the card
async function askedTask() {
  const n = ++num;
  const t = store.create({ id: `answer-${n}`, num: 200 + n, title: 'Answer fixture', agent: 'claude', status: 'working', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, desc: '' });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  fakeState(t, { history });
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), FAKE_AGENT: 'claude' }, [join(bin, 'claude')], async () => {});
  await until(async () => (await tmux.capture(t.session, 0)).includes(QUESTION), 4000);
  events.claudeEvent(t.id, { hook_event_name: 'Stop', session_id: `fixture-${n}`, last_assistant_message: `The branch is ready. ${QUESTION}` });
  const cur = store.get(t.id)!;
  assert.equal(cur.status, 'needs-you');
  assert.equal(cur.ask, QUESTION);
  pending.scan(cur, await tmux.capture(t.session, 0));
  const card = pending.list().find(i => i.taskId === t.id)!;
  assert.equal(card.kind, 'text');
  assert.equal(card.source, 'turn-end');
  return { t, card };
}

test('cause: the old path refuses to type while the status is "needs you" from the Stop hook', { timeout: 30000 }, async () => {
  const { t } = await askedTask();
  try {
    await assert.rejects(agents.sendTaskText(store.get(t.id)!, 'yes'), /asks a question in its terminal \(Do you want me to send the merge request now\?\)\. Nothing was typed\./);
    assert.equal(typed(t), '');
  } finally { await tmux.killSession(t.session); }
});

test('needs you with a question at the end of a turn: the card answer is typed and submitted', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    const done = await pending.answer(card.id, { text: 'yes', by: 'user' });
    assert.equal(done.state, 'answered');
    assert.deepEqual(submitted(t), ['yes']);
    // the card does not come back before the prompt hook sets "working"
    assert.equal(store.get(t.id)!.status, 'working');
    pending.scan(store.get(t.id)!, await tmux.capture(t.session, 0));
    assert.equal(pending.list().filter(i => i.taskId === t.id).length, 0);
  } finally { await tmux.killSession(t.session); }
});

test('a dialog on the screen: nothing is typed, one message without the task number, and the card stays', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    fakeState(t, { history, permission: true });
    await until(async () => /Do you want to proceed\?/.test(await tmux.capture(t.session, 0)), 4000);
    await assert.rejects(pending.answer(card.id, { text: 'yes', by: 'user' }), (e: Error) => {
      assert.equal(e.message, 'The terminal shows a dialog or a different question now. Taskboard typed nothing. Open the terminal and answer it there.');
      return true;
    });
    const item = pending.get(card.id)!;
    assert.equal(item.state, 'pending');
    assert.equal(item.result, 'The terminal shows a dialog or a different question now. Taskboard typed nothing. Open the terminal and answer it there.');
    assert.equal(item.needsTerminal, true);
    assert.equal(typed(t), '');
  } finally { await tmux.killSession(t.session); }
});

test('a draft in the input box: nothing is typed and the draft stays', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'half a sentence');
    await until(async () => /❯ half a sentence/.test(await tmux.capture(t.session, 0)), 4000);
    await assert.rejects(pending.answer(card.id, { text: 'yes', by: 'user' }), /holds text that a person typed\. Taskboard does not type into it\. Open the terminal/);
    assert.match(await tmux.capture(t.session, 0), /❯ half a sentence\n/);
    assert.equal(typed(t), 'half a sentence');
    assert.equal(pending.get(card.id)!.needsTerminal, true);
  } finally { await tmux.killSession(t.session); }
});

test('an out of date card: a new turn, a newer question, or a status without the question removes the card', { timeout: 60000 }, async () => {
  const cases: [string, (t: { id: string; sessionId?: string }) => void, RegExp][] = [
    ['new turn', t => events.claudeEvent(t.id, { hook_event_name: 'UserPromptSubmit', session_id: t.sessionId }), /the agent started a new turn/],
    ['newer question', t => store.update(t.id, { ask: 'Shall I also push it?' }), /the agent asked a newer question/],
    ['unread', t => store.update(t.id, { status: 'unread', ask: '' }), /no longer waits on this question/],
    ['idle', t => store.update(t.id, { status: 'idle', ask: '' }), /no longer waits on this question/],
    ['dialog from a hook', t => store.update(t.id, { ask: 'Run: ls', statusSource: 'Claude Code PermissionRequest hook at 10:00: Bash.' }), /waits on a dialog or an approval/],
  ];
  for (const [name, change, why] of cases) {
    const { t, card } = await askedTask();
    try {
      change(store.get(t.id)!);
      await assert.rejects(pending.answer(card.id, { text: 'yes', by: 'user' }), (e: Error) => {
        assert.match(e.message, /^This card is out of date: /, name);
        assert.match(e.message, why, name);
        return true;
      });
      assert.equal(pending.get(card.id)!.state, 'gone', name);
      assert.equal(pending.list().filter(i => i.id === card.id).length, 0, name);
      assert.equal(typed(t), '', name);
    } finally { await tmux.killSession(t.session); }
  }
});

test('a screen that is still drawing: the answer waits and is typed when the box shows', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    fakeState(t, { history, drawing: true });
    await until(async () => !/❯/.test(await tmux.capture(t.session, 0)), 4000);
    setTimeout(() => fakeState(t, { history }), 1500);
    const started = Date.now();
    const done = await pending.answer(card.id, { text: 'yes', by: 'user' });
    assert.equal(done.state, 'answered');
    assert.ok(Date.now() - started >= 1000, 'it waited for the box');
    assert.deepEqual(submitted(t), ['yes']);
  } finally { await tmux.killSession(t.session); }
});

test('a screen that stays without a box: refused after the retries, with the next step', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    fakeState(t, { history, drawing: true });
    await until(async () => !/❯/.test(await tmux.capture(t.session, 0)), 4000);
    const started = Date.now();
    await assert.rejects(pending.answer(card.id, { text: 'yes', by: 'user' }), /did not show an empty input box within 4 s\. Taskboard typed nothing\. Try again, or open the terminal/);
    assert.ok(Date.now() - started >= (pending.ANSWER_TRIES - 1) * pending.ANSWER_GAP_MS);
    assert.equal(pending.get(card.id)!.state, 'pending');
    assert.equal(typed(t), '');
    // the box shows again: a second click answers
    fakeState(t, { history });
    await until(async () => /❯/.test(await tmux.capture(t.session, 0)), 4000);
    assert.equal((await pending.answer(card.id, { text: 'yes', by: 'user' })).state, 'answered');
  } finally { await tmux.killSession(t.session); }
});

test('the question is not on the screen any more: nothing is typed', { timeout: 30000 }, async () => {
  const { t, card } = await askedTask();
  try {
    fakeState(t, { history: ['⏺ Something else entirely.'] });
    await until(async () => !(await tmux.capture(t.session, 0)).includes(QUESTION), 4000);
    await assert.rejects(pending.answer(card.id, { text: 'yes', by: 'user' }), /cannot find this question on the terminal screen/);
    assert.equal(typed(t), '');
  } finally { await tmux.killSession(t.session); }
});

test.after(() => { try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } });
