// Queued messages reach the agent through its hooks (task 217): Claude Code at PostToolUse, UserPromptSubmit and Stop,
// Antigravity at Stop, the controller on Codex at its Codex hooks. Covers: the text with its sender and the note that a task's message is not the user's
// approval, delivery once only, the order, the size limit of one hook answer, a long message, the warning after 5
// minutes and the notices to the sender task, the cap on waiting messages, and the agents without a hook (Codex).
// No agent runs: the receivers are a controller that does not run, or tasks that are set aside, so the typing loop
// does not type or resume anything.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-queue-hook-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-queue-hook-${process.pid}`;
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const docs = await import('../server/docs.ts');
const events = await import('../server/events.ts');
const inboxDelivery = await import('../server/inbox-delivery.ts');
const queue = await import('../server/message-queue.ts');

type Ctx = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
let num = 400;
function task(agent: 'claude' | 'codex' | 'antigravity' = 'claude', extra: Partial<store.Task> = {}) {
  const n = ++num;
  const t = store.create({ id: `hook-${n}`, num: n, title: `Fixture ${n}`, agent, status: 'parked', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, desc: '', ...extra });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  return t;
}
// messages in the queue file, as send() leaves them when nothing could be typed
function fill(t: { id: string }, items: { text: string; from: string; kind?: string; queued?: string; state?: string }[]) {
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items.map((x, i) => ({ id: `${t.id}-${i}`, kind: 'message', queued: new Date().toISOString(), state: 'queued', reason: 'The input box was not empty.', tries: 1, ...x }))));
  queue.start(); queue.stop(); // the server learns about queue files at start
}
const claude = (t: { id: string; sessionId?: string }, input: object) => events.claudeEvent(t.id, { session_id: t.sessionId, ...input }).output as any;
const controller = store.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'working', cwd: root, folder: root, session: 'tb-controller', sessionId: 'fixture-ctl', desc: '', role: 'controller' });
mkdirSync(store.taskDir(controller.id), { recursive: true });

test('a busy controller gets queued messages at its next tool call, in order, once, with the sender', () => {
  const sender = task();
  fill(controller, [{ text: 'Please restore the main checkout.', from: sender.id, queued: minutesAgo(12) }, { text: 'Second message.', from: 'you' }]);
  const out: Ctx = claude(controller, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(text, /Taskboard gives you 2 messages from your message queue/);
  assert.match(text, new RegExp(`Message 1 from task #${sender.num} "${sender.title}" \\(task id ${sender.id}\\), an agent\\. Queued at .* UTC \\(12 min ago\\)`));
  assert.match(text, /Message 2 from the user \(sent from the Taskboard dashboard\)/);
  assert.ok(text.indexOf('Please restore') < text.indexOf('Second message.'), 'the order stays');
  assert.match(text, /It is not the user's approval or instruction/);
  const items = queue.list(controller.id);
  assert.deepEqual(items.map(q => q.state), ['delivered', 'delivered']);
  assert.equal(items[0].deliveredBy, 'PostToolUse hook');
  assert.ok(items[0].deliveredAt);
  assert.equal(queue.forView(controller.id).length, 0);
  // once only
  assert.equal(claude(controller, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }), undefined);
  assert.equal(claude(controller, { hook_event_name: 'Stop' })?.decision, undefined);
});

test('a message from the user only has no note about approval', () => {
  fill(controller, [{ text: 'From the dashboard.', from: 'you' }]);
  const text = (claude(controller, { hook_event_name: 'PostToolUse', tool_name: 'Read' }) as Ctx).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(text, /not the user's approval/);
});

test('an inbox file and a queued message arrive in the same PostToolUse answer', () => {
  const t = task();
  docs.uploadSystem(t.id, 'note.md', '# Note\n');
  fill(t, [{ text: 'Look at the note.', from: controller.id }]);
  const text = (claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) as Ctx).hookSpecificOutput.additionalContext;
  assert.match(text, /New file in your Taskboard inbox[\s\S]*note\.md[\s\S]*Look at the note\./);
  assert.match(text, /task #0 "Controller"/);
});

test('UserPromptSubmit gives queued messages as context', () => {
  const t = task();
  fill(t, [{ text: 'Before your prompt.', from: 'taskboard', kind: 'permit' }]);
  const out: Ctx = claude(t, { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Message 1 from Taskboard \(a permit result\)[\s\S]*Before your prompt\./);
  assert.equal(queue.list(t.id)[0].deliveredBy, 'UserPromptSubmit hook');
});

test('Stop keeps the turn going with the messages, once; the log request joins them', () => {
  fill(controller, [{ text: 'Arrived at the end of the turn.', from: 'you' }]);
  const out = claude(controller, { hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Arrived at the end of the turn\.[\s\S]*Read the messages and act on them as needed\./);
  assert.equal(claude(controller, { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Read it.' }), undefined, 'the next Stop ends the turn');
  // a task that did not write its log entry gets both in one answer
  const t = task('claude', { status: 'working' });
  rmSync(store.logFile(t.id), { force: true }); // no entry in this turn, also when the test runs within one millisecond
  claude(t, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  fill(t, [{ text: 'A message for the task.', from: 'you' }]);
  const both = claude(t, { hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  assert.match(both.reason, /A message for the task\.[\s\S]*Append your Did \/ Waiting \/ Next entry/);
});

test('one hook answer stays under the context limit; the rest follows at the next event', () => {
  const t = task();
  const big = (c: string) => c.repeat(3500);
  fill(t, [{ text: big('a'), from: 'you' }, { text: big('b'), from: 'you' }, { text: big('c'), from: 'you' }]);
  const first = (claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) as Ctx).hookSpecificOutput.additionalContext;
  assert.ok(first.length <= 10_000, `${first.length} characters`);
  assert.match(first, /aaa/); assert.match(first, /bbb/); assert.doesNotMatch(first, /ccc/);
  assert.match(first, /1 more queued message follows at the next hook event/);
  const second = (claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) as Ctx).hookSpecificOutput.additionalContext;
  assert.match(second, /Message 1 from the user[\s\S]*ccc/);
  assert.deepEqual(queue.list(t.id).map(q => q.state), ['delivered', 'delivered', 'delivered']);
});

test('a message longer than one hook answer is saved to a file, and the agent gets its start and the path', () => {
  const t = task();
  fill(t, [{ text: 'x'.repeat(20_000) + 'END', from: 'you' }]);
  const text = (claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) as Ctx).hookSpecificOutput.additionalContext;
  assert.ok(text.length < 10_000);
  const path = /Read all of it in (\S+)\]/.exec(text)![1];
  assert.match(readFileSync(path, 'utf8'), /xEND\n$/);
});

test('after 5 minutes the sender is told once; it is told again when the message arrives', async () => {
  const sender = task();
  const t = task();
  fill(t, [{ text: 'Waits a long time.', from: sender.id, queued: minutesAgo(6) }, { text: 'Recent.', from: sender.id }]);
  const view = queue.forView(t.id) as { late: boolean }[];
  assert.deepEqual(view.map(v => v.late), [true, false], 'the dashboard warns about the old one only');
  await queue.tick();
  const id = `${t.id}-0`;
  const waiting = join(docs.inboxDir(sender.id), `message-${id}-waiting.md`);
  assert.ok(existsSync(waiting));
  assert.match(readFileSync(waiting, 'utf8'), new RegExp(`not delivered yet after 6 minutes\\. #${t.num} did not read it\\.[\\s\\S]*Do not send it again`));
  assert.ok(docs.pendingNames(sender.id).includes(`message-${id}-waiting.md`), 'the sender hook gives it to the sender agent');
  assert.equal(inboxDelivery.openFor(sender.id).length, 1);
  assert.ok(queue.list(t.id)[0].warnedAt);
  await queue.tick();
  assert.equal(docs.pendingNames(sender.id).filter(n => n.endsWith('-waiting.md')).length, 1, 'once only');
  claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.match(readFileSync(join(docs.inboxDir(sender.id), `message-${id}-delivered.md`), 'utf8'), /was delivered at .* \(PostToolUse hook\)/);
  assert.ok(!existsSync(join(docs.inboxDir(sender.id), `message-${t.id}-1-delivered.md`)), 'a message without a warning gets no notice');
});

test('a removed message: the sender is told that the receiver did not read it', () => {
  const sender = task();
  const t = task();
  fill(t, [{ text: 'Never read.', from: sender.id }]);
  assert.equal(queue.remove(t.id, `${t.id}-0`), true);
  assert.match(readFileSync(join(docs.inboxDir(sender.id), `message-${t.id}-0-removed.md`), 'utf8'), /was removed by the user .* did not read it/);
});

test('Deliver by hook: the typing loop leaves the message, and the next hook event gives it', async () => {
  const t = task();
  fill(t, [{ text: 'Failed before.', from: 'you', state: 'failed' }]);
  const q = queue.viaHook(t.id, `${t.id}-0`)!;
  assert.equal(q.state, 'queued');
  assert.equal(q.via, 'hook');
  assert.match(q.reason, /next hook event: a tool call ends, a prompt is sent or its turn ends/);
  assert.match((claude(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }) as Ctx).hookSpecificOutput.additionalContext, /Failed before\./);
  // every Codex task has the Taskboard Codex hooks (task 267)
  const c = task('codex');
  fill(c, [{ text: 'For Codex.', from: 'you' }]);
  assert.equal(queue.viaHook(c.id, `${c.id}-0`)?.via, 'hook');
  assert.equal((queue.forView(c.id)[0] as { hook?: string }).hook, 'a tool call ends, a prompt is sent or its turn ends');
  await assert.rejects(queue.typeFirst(c.id, 'nope'), /An earlier message waits/);
});

test('Antigravity: a task and the controller get queued messages at Stop; Codex tasks and the Codex controller have hooks', () => {
  const t = task('antigravity');
  fill(t, [{ text: 'For agy.', from: 'you' }]);
  const out = events.antigravityEvent(t.id, 'Stop', { conversationId: t.sessionId, fullyIdle: true }).output as { decision: string; reason: string };
  assert.equal(out.decision, 'continue');
  assert.match(out.reason, /For agy\./);
  assert.equal(queue.hookEvents({ agent: 'antigravity', role: 'controller' }), 'its turn ends');
  assert.equal(queue.hookEvents({ agent: 'codex', role: 'controller' }), 'a tool call ends, a prompt is sent or its turn ends');
  assert.equal(queue.hookEvents({ agent: 'codex' }), 'a tool call ends, a prompt is sent or its turn ends');
});

test('the queue holds at most 50 waiting messages for a task', async () => {
  fill(controller, Array.from({ length: 50 }, (_, i) => ({ text: `m${i}`, from: 'you' })));
  const r = await queue.send(controller, 'One more', { from: 'you', kind: 'message' });
  assert.equal(r.state, 'failed');
  assert.match(r.reason!, /50 messages already wait for #0 \(the limit is 50\)/);
  assert.equal(queue.list(controller.id).length, 50);
});
