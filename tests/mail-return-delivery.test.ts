// A comment that the user sends back from a mail approval card, and a message routed to a task, must reach the agent
// (server/inbox-delivery.ts). The agents are fake programs in tmux on a test socket: each prints a prompt and saves
// what is typed into TASK_DIR/input.txt. Slack is a fake client.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { SlackClient } from '../server/mail/slack.ts';
import type { Level } from '../server/mail/policy.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-mail-return-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-mail-return-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
mkdirSync(process.env.CODEX_HOME, { recursive: true }); mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('app-server')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => { const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (msg.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command: 'node "$TB_HOOKS_DIR/guard.mjs"', key: '/<session-flags>/config.toml:pre_tool_use:0:0', currentHash: 'sha256:' + 'a'.repeat(64) }] }] } }));
  });
} else {
  console.log('>');
  process.stdin.on('data', chunk => fs.appendFileSync(path.join(process.env.TASK_DIR, 'input.txt'), chunk));
  setInterval(() => {}, 1000);
}
`;
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify([{ id: 'codex-fixture', agent: 'codex', name: 'Codex fixture', dir: process.env.CODEX_HOME, maxParallel: 8, created: new Date().toISOString() }]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ name: 'test', controller: { autostart: false }, permissions: { trustWorkspaces: false } }));

// A draft to U2 that the task #81 of an earlier Taskboard version proposed, sent back by the user; the comment file is
// in its inbox and pending, and the agent was never told
const oldAt = '2026-09-30T00:49:40.256Z', oldFile = 'mail-old-comment-20260930004940256.md';
const tasksDir = join(process.env.TASKBOARD_VAULT, 'tasks');
mkdirSync(join(tasksDir, 'old-81', 'inbox'), { recursive: true });
writeFileSync(join(tasksDir, 'old-81', 'inbox', oldFile), '# The user sent back your draft\n');
writeFileSync(join(tasksDir, 'old-81', 'inbox', '.pending.json'), JSON.stringify([oldFile]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'mail.json'), JSON.stringify({ version: 1, contacts: [], messages: [{
  id: 'old', direction: 'outbox', source: 'agent', from: 'U1', to: 'U2', subject: 'Old', body: 'Old draft', hash: 'h', created: oldAt, updated: oldAt,
  proposedBy: { actor: 'task', task: 'old-81', agent: 'codex' }, rejectedAt: oldAt, routes: [], returns: [{ comment: 'Check first.', at: oldAt }],
}] }));

const store = await import('../server/store.ts');
const tmux = await import('../server/tmux.ts');
const approvals = await import('../server/approvals.ts');
const inboxDelivery = await import('../server/inbox-delivery.ts');
const { mountMail } = await import('../server/mail/routes.ts');
const { URL_BASE, TOKEN } = await import('../server/config.ts');
const { controllerMailToken } = await import('../server/mail/auth.ts');
const { MailStore } = await import('../server/mail/store.ts');

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const input = (id: string) => { const f = join(store.taskDir(id), 'input.txt'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
const waitFor = async (check: () => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (check()) return; await pause(100); } throw new Error(`Timed out: ${what}`); };
const pending = (id: string) => { const f = join(store.taskDir(id), 'inbox', '.pending.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as string[] : []; };
const task = (agent: 'claude' | 'codex' | 'antigravity', num: number, status: store.Task['status'], sessionId?: string) => store.create({
  id: `t-${num}`, num, title: `Fixture ${num}`, agent, status, cwd: root, folder: root, session: `task-${num}`, sessionId,
  account: agent === 'codex' ? 'codex-fixture' : undefined, desc: '' });
const live = async (t: store.Task) => {
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id) }, [join(bin, t.agent === 'antigravity' ? 'agy' : t.agent)], async () => {});
  for (let i = 0; i < 40 && !(await tmux.capture(t.session, 10)).includes('>'); i++) await pause(50);
};

const levels = { incoming: 1 as Level, outgoing: 1 as Level };
const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args: Record<string, string> = {}) => {
  if (method === 'users.info') return { user: { id: args.user, team_id: 'T1' } };
  if (method === 'conversations.open') return { channel: { id: 'D1' } };
  if (method === 'chat.postMessage') return { ts: '1' };
  return {};
} } as unknown as SlackClient;
const app = express(); app.use(express.json());
const cleanup = mountMail(app, { background: false, slack, levels: () => levels, delivery: inboxDelivery,
  review: async () => ({ verdict: 'communication', reason: 'Fixture', at: new Date().toISOString() }) });
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mail`;
const call = async (path: string, actor: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (actor === 'user') headers.origin = URL_BASE;
  else { headers['x-taskboard-token'] = TOKEN; headers['x-tb-actor'] = actor; }
  if (actor === 'controller') headers['x-tb-mail-controller'] = controllerMailToken;
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const mail = new MailStore(join(process.env.TASKBOARD_DIR, 'mail.json'));
const cardFor = (id: string) => approvals.all().find(a => a.state === 'pending' && (a.payload as { message?: string }).message === id);
// a draft from task t to U2 (not trusted: at outgoing level 1 the user approves it on a card), sent back with a comment
const sendBack = async (t: store.Task, comment: string) => {
  const draft = await call('/propose', t.id, { to: 'U2', subject: `Draft of ${t.id}`, body: 'Ready.' });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  await call(`/${draft.data.id}/review`, 'user', {});
  const card = cardFor(draft.data.id); assert.ok(card, 'the draft has a card');
  const result = await approvals.giveBack(card.id, comment);
  const shown = (await call('', 'user')).data.messages.find((m: { id: string }) => m.id === draft.data.id);
  return { id: draft.data.id as string, result: result!, shown };
};

test('a comment on an old draft that was never delivered is typed at start', async () => {
  const t = store.create({ id: 'old-81', num: 81, title: 'Old triage', agent: 'codex', status: 'review', cwd: root, folder: root, session: 'task-81', sessionId: 'old-thread', account: 'codex-fixture', desc: '' });
  await live(t);
  assert.equal(inboxDelivery.get('old-81', oldFile)?.deliveredAt, undefined);
  inboxDelivery.start();
  await waitFor(() => input(t.id).includes(oldFile), 'the notice for the old comment');
  assert.deepEqual(pending(t.id), []);
  assert.ok(inboxDelivery.get('old-81', oldFile)?.deliveredAt);
  const shown = (await call('', 'user')).data.messages.find((m: { id: string }) => m.id === 'old');
  assert.equal(shown.returns[0].delivery.delivered, true);
});

test('give back to an idle Codex task types the notice', async () => {
  const t = task('codex', 1, 'review', 'thread-1'); await live(t);
  const { result, shown } = await sendBack(t, 'Research the Android API first.');
  assert.equal(result.state, 'returned');
  assert.equal(result.result, 'Sent back to task #1 "Fixture 1" with your comment.');
  assert.match(input(t.id), /New file in your Taskboard inbox/);
  assert.match(input(t.id), new RegExp(shown.returns[0].file));
  assert.equal(shown.returns[0].delivery.delivered, true);
  assert.ok(shown.returns[0].delivery.at);
  assert.equal(store.get(t.id)?.status, 'working');
  assert.match(readFileSync(join(store.taskDir(t.id), 'inbox', shown.returns[0].file), 'utf8'), /Research the Android API first/);
});

test('give back to a busy Codex task types the notice, which Codex queues', async () => {
  const t = task('codex', 2, 'working', 'thread-2'); await live(t);
  const { result, shown } = await sendBack(t, 'Wait for the test build.');
  assert.match(result.result!, /^Sent back to task #2/);
  assert.match(input(t.id), new RegExp(shown.returns[0].file));
});

test('give back to a suspended Codex task resumes it first', async () => {
  const t = task('codex', 3, 'suspended', 'thread-3');
  const { result, shown } = await sendBack(t, 'Use the new API.');
  assert.equal(result.result, 'Sent back to task #3 "Fixture 3" with your comment. The task was resumed.');
  assert.match(input(t.id), new RegExp(shown.returns[0].file));
  assert.equal(shown.returns[0].delivery.resumed, true);
});

test('give back to an idle Claude Code task types the notice', async () => {
  const t = task('claude', 4, 'unread', 'session-4'); await live(t);
  const { result, shown } = await sendBack(t, 'Shorter, please.');
  assert.match(result.result!, /^Sent back to task #4/);
  assert.match(input(t.id), new RegExp(shown.returns[0].file));
});

test('a failed notice keeps the file pending, is shown, and is typed when the task next waits for input', async () => {
  const t = task('codex', 5, 'needs-you', 'thread-5'); await live(t);
  const { result, shown } = await sendBack(t, 'Check the numbers.');
  assert.equal(result.state, 'returned');
  assert.doesNotMatch(result.result!, /Sent back/);
  assert.match(result.result!, /^Your comment is in the inbox of task #5 "Fixture 5", but the agent was not told yet: The agent asks a question/);
  assert.equal(shown.returns[0].delivery.delivered, false);
  assert.match(shown.returns[0].delivery.problem, /asks a question/);
  assert.deepEqual(pending(t.id), [shown.returns[0].file]);
  assert.equal(input(t.id), '');
  // the user answers the question and the turn ends
  store.update(t.id, { status: 'working', ask: '' });
  await pause(300);
  assert.equal(input(t.id), '');
  store.update(t.id, { status: 'unread' });
  await waitFor(() => input(t.id).includes(shown.returns[0].file), 'the retried notice');
  assert.deepEqual(pending(t.id), []);
  const again = (await call('', 'user')).data.messages.find((m: { id: string }) => m.id === shown.id);
  assert.equal(again.returns[0].delivery.delivered, true);
});

test('Antigravity learns at the end of its turn, and the delivery is recorded', async () => {
  const docs = await import('../server/docs.ts');
  const t = task('antigravity', 6, 'working', 'conversation-6'); await live(t);
  const { result, shown } = await sendBack(t, 'Add a table.');
  assert.match(result.result!, /Antigravity reads new inbox files when its turn ends/);
  assert.equal(input(t.id), '');
  // the Stop hook passes the pending files on (server/events.ts antigravityEvent)
  assert.match(docs.takeInboxNotice(t.id)!, new RegExp(shown.returns[0].file));
  assert.ok(inboxDelivery.get(t.id, shown.returns[0].file)?.deliveredAt);
});

test('give back on an incoming card reaches the controller, also after the controller starts again', async () => {
  const c = store.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'tb-controller', sessionId: 'controller-session', role: 'controller', desc: '' });
  const target = task('codex', 7, 'idle', 'thread-7'); await live(target);
  const incoming = async (subject: string) => {
    const m = mail.add({ direction: 'inbox', source: 'slack', from: 'U3', to: 'U1', subject, body: 'Please look.' });
    await call(`/${m.id}/review`, 'user', {});
    assert.equal((await call(`/${m.id}/propose-route`, 'controller', { task: target.id })).status, 200);
    return m.id;
  };
  // the controller is not running: the comment waits
  const first = await incoming('First');
  const back = await approvals.giveBack(cardFor(first)!.id, 'Wrong task.');
  assert.match(back!.result!, /^Your comment is in the inbox of the controller, but the agent was not told yet: The controller is not running/);
  await live(c); store.update(c.id, { status: 'working' }); store.update(c.id, { status: 'idle' });
  await waitFor(() => input(c.id).includes(`mail-${first}-comment-`), 'the controller notice');
  // a running controller is told at once
  const second = await incoming('Second');
  const now = await approvals.giveBack(cardFor(second)!.id, 'Also wrong.');
  assert.equal(now!.result, 'Sent back to the controller with your comment.');
  assert.match(input(c.id), new RegExp(`mail-${second}-comment-`));
  // approving a proposed task routes the message, and the task's agent is told
  await call(`/${second}/propose-route`, 'controller', { task: target.id });
  const approved = await approvals.decide(cardFor(second)!.id, true);
  assert.equal(approved!.result, 'Approved and routed to task #7 "Fixture 7". The agent was told.');
  assert.match(input(target.id), new RegExp(`mail-${second}\\.md`));
  const shown = (await call('', 'user')).data.messages.find((m: { id: string }) => m.id === second);
  assert.equal(shown.routes[0].delivery.delivered, true);
});

test.after(async () => {
  cleanup(); await new Promise<void>(r => server.close(() => r()));
  try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});
