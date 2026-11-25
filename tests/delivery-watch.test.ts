import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { DeliverIO } from '../server/deliver-text.ts';
import type { PromptAgent } from '../server/type-command.ts';

process.env.TASKBOARD_TMUX_SOCKET = `tb-delivery-watch-${process.pid}`;
const root = mkdtempSync(join(tmpdir(), 'tb-delivery-watch-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
const store = await import('../server/store.ts');
const delivery = await import('../server/deliver-text.ts');
const recovery = await import('../server/text-recovery.ts');
const queue = await import('../server/message-queue.ts');
const { boxState } = await import('../server/type-command.ts');
const { waitFor } = await import('../server/waiting-board.ts');
const groups = await import('../server/groups.ts');
const docs = await import('../server/docs.ts');
const rule = '─'.repeat(80);
const panel = ['╭' + '─'.repeat(78) + '╮', '│ Bug report drafted',
  '│ clear text to review, send, or dismiss', '╰' + '─'.repeat(78) + '╯'].join('\n');
const screen = (agent: PromptAgent, text = '') => agent === 'codex'
  ? `\x1b[39m› ${text}\n\n  ? for shortcuts`
  : `${rule}\n\x1b[39m${agent === 'claude' ? '❯' : '>'} ${text}\n${rule}\n  ? for shortcuts`;
let n = 0;
function task(agent: PromptAgent = 'claude', id = `watch-${++n}`) {
  return store.create({ id, num: ++n, title: 'Watcher test', agent, status: 'idle', cwd: root, folder: root, session: id, desc: '' });
}
function fixture(agent: PromptAgent = 'claude') {
  const t = task(agent);
  const state = { now: 10_000, keyAt: 0, pane: '%1:100', text: '', enters: 0, deletes: 0,
    accept: false, question: false, hidden: false, partial: false, throws: false };
  const io: DeliverIO = {
    now: () => state.now, lastKeyAt: () => state.keyAt,
    wait: async ms => { state.now += ms; }, size: async () => ({ cols: 200, rows: 50, clients: 0 }),
    resize: async () => {}, saveDraft: () => null, hold: () => () => {},
    capture: async () => state.question ? `${rule}\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n${rule}`
      : state.hidden ? 'Redrawing' : screen(agent, state.text),
    paste: async (_s, text) => { state.text = text; },
    tmux: async (...args) => {
      if (args[0] === 'display-message') return args.at(-1)!.includes('pane_id') ? state.pane : '';
      const key = args.at(-1);
      if (args.includes('-l')) { state.text = state.partial ? key!.slice(0, 4) : key!; if (state.throws) throw new Error('write failed'); }
      else if (key === 'Enter') { state.enters++; if (state.accept) state.text = ''; }
      else if (key === 'BSpace' || key === 'DC') { state.deletes++; state.text = ''; }
      return '';
    },
  };
  return { t, state, io };
}

// These panels reproduce the reported placement. The real startup captures are in the task report.
test('feedback and installed-update notices below the input box do not hide it', () => {
  const s = screen('claude') + '\n' + panel + '\n✔ Update installed · /restart to apply\n  Opus 5.5 · 1 feedback draft';
  assert.equal(boxState(s), 'empty');
});
test('a feedback panel inside the rules is not part of a draft', () => {
  assert.equal(boxState(`${rule}\n\x1b[39m❯ \n${panel}\n${rule}`), 'empty');
});
test('a permission choice in a panel still blocks keys', () => {
  const s = screen('claude') + '\n' + panel.replace('│ Bug report drafted', '│ Do you want to proceed?\n❯ 1. Yes\n  2. No');
  assert.notEqual(boxState(s), 'empty');
  assert.equal(boxState(`${rule}\n\x1b[39m❯ Yes, I trust this folder\n  No, exit\n${rule}`), 'question');
  assert.equal(boxState(screen('claude', 'Do you want to review?')), 'question', 'unowned text keeps the original refusal');
});
test('the update choice still blocks Enter', () => {
  assert.equal(boxState('Update available\n› 1. Update now\n  2. Skip\n\n  enter continue', 'codex'), 'question');
});
for (const agent of ['claude', 'codex', 'antigravity'] as const) {
  test(`${agent}: question words in message text do not turn the text into a dialog`, async () => {
    const f = fixture(agent); f.state.accept = true;
    assert.equal((await delivery.deliverText(f.t, 'Do you want to review? Allow this action on the dashboard.', f.io)).submitted, true);
    assert.equal(f.state.enters, 1);
  });
  test(`${agent}: a partial write is removed before retry`, async () => {
    const f = fixture(agent); f.state.partial = true;
    await assert.rejects(delivery.deliverText(f.t, 'Whole message', f.io), e => e instanceof delivery.NotTyped && e.state === 'retry');
    assert.equal(f.state.text, ''); assert.equal(f.state.enters, 0);
  });
  test(`${agent}: an exception after typing removes our text`, async () => {
    const f = fixture(agent); f.state.throws = true;
    await assert.rejects(delivery.deliverText(f.t, 'Whole message', f.io));
    assert.equal(f.state.text, ''); assert.equal(f.state.enters, 0);
  });
  test(`${agent}: the watcher retries a recorded message at most twice, then removes it`, async () => {
    const f = fixture(agent);
    f.state.text = 'Recorded message';
    recovery.write(f.t.id, { text: f.state.text, session: f.t.session, pane: f.state.pane,
      keyAt: 0, at: f.state.now, reason: 'Not confirmed', attempts: 0 });
    await delivery.recoverText(f.t, f.io);
    f.state.now += 3100;
    await delivery.recoverText(f.t, f.io);
    f.state.now += 3100;
    await delivery.recoverText(f.t, f.io);
    f.state.now += 3100;
    await delivery.recoverText(f.t, f.io);
    assert.equal(f.state.enters, 2); assert.equal(f.state.text, '');
    assert.equal(recovery.read(f.t.id), undefined);
  });
}
test('the watcher keeps a permission refusal and later submits only the recorded message', async () => {
  const f = fixture(); f.state.text = 'Recorded message'; f.state.question = true;
  recovery.write(f.t.id, { text: f.state.text, session: f.t.session, pane: f.state.pane,
    keyAt: 0, at: f.state.now, reason: 'Not confirmed', attempts: 0 });
  await delivery.recoverText(f.t, f.io);
  assert.equal(f.state.enters, 0); assert.equal(f.state.deletes, 0);
  assert.match(queue.deliveryWait(f.t.id)!.reason, /question/);
  f.state.question = false; f.state.accept = true;
  await delivery.recoverText(f.t, f.io); f.state.now += 3100;
  await delivery.recoverText(f.t, f.io);
  assert.equal(await delivery.recoverText(f.t, f.io), 'submitted');
  assert.equal(f.state.enters, 1); assert.equal(f.state.text, '');
});
test('a hidden box is saved for the watcher and blocks hook delivery', async () => {
  const f = fixture();
  const capture = f.io.capture;
  f.io.capture = async s => { if (f.state.enters) f.state.hidden = true; return capture(s); };
  await assert.rejects(delivery.deliverText(f.t, 'Recorded message', f.io));
  assert.ok(recovery.read(f.t.id)); assert.equal(f.state.text, 'Recorded message');
  mkdirSync(store.taskDir(f.t.id), { recursive: true });
  writeFileSync(join(store.taskDir(f.t.id), 'message-queue.json'), JSON.stringify([{ id: 'blocked', text: 'Later',
    kind: 'message', from: 'taskboard', queued: new Date().toISOString(), reason: 'waiting', state: 'queued', tries: 1 }]));
  queue.start(); queue.stop();
  assert.equal(queue.takeForHook(f.t.id, 'Stop'), null);
  assert.match(waitFor(f.t)!.reason, /Cleanup waits/);
});
test('the watcher does not touch changed text or keys from a person', async () => {
  for (const change of ['text', 'keys', 'pane'] as const) {
    const f = fixture(); f.state.text = 'Recorded message';
    recovery.write(f.t.id, { text: f.state.text, session: f.t.session, pane: f.state.pane,
      keyAt: 0, at: f.state.now, reason: 'Not confirmed', attempts: 0 });
    if (change === 'text') f.state.text = 'A person wrote this';
    if (change === 'keys') f.state.keyAt = 5000;
    if (change === 'pane') f.state.pane = '%2:200';
    await delivery.recoverText(f.t, f.io); f.state.now += 3100;
    await delivery.recoverText(f.t, f.io);
    assert.equal(f.state.enters, 0); assert.equal(f.state.deletes, 0);
    assert.ok(queue.deliveryWait(f.t.id));
  }
});
test('a queued message stops after five minutes and tells its controller and manager', async () => {
  const t = task();
  const c = task('claude', 'controller'); const manager = task();
  groups.create('Delivery tests', [t.id, manager.id]);
  const g = groups.all().find(g => g.name === 'Delivery tests')!;
  groups.update(g.id, { manager: manager.id });
  const old = new Date(Date.now() - queue.WARN_MS - 1).toISOString();
  mkdirSync(store.taskDir(t.id), { recursive: true });
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify([{ id: 'late', text: 'Message',
    kind: 'message', from: 'taskboard', queued: old, reason: 'The input box holds an image.', state: 'queued', tries: 1 }]));
  queue.start(); queue.stop();
  await queue.tick();
  assert.equal(queue.list(t.id)[0].state, 'failed');
  assert.match(waitFor(t)!.reason, /five|5|minutes/);
  for (const supervisor of [c, manager]) {
    assert.match(readFileSync(join(docs.inboxDir(supervisor.id), `delivery-${t.id}-late.md`), 'utf8'), /Automatic delivery stopped/);
  }
  assert.equal(queue.takeForHook(t.id, 'Stop'), null);
});

test.after(() => { queue.stop(); rmSync(root, { recursive: true, force: true }); });

test('captured screens from the installed agents preserve refusals and accept the Claude notice', () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/screens', name), 'utf8');
  assert.equal(boxState(fixture('claude-2.1.332-trust.ansi'), 'claude'), 'question');
  assert.equal(boxState(fixture('codex-0.162.1-update.ansi'), 'codex'), 'question');
  assert.equal(boxState(fixture('codex-0.162.1-live-question.txt'), 'codex'), 'question');
  assert.equal(boxState(fixture('antigravity-1.5.17-trust.ansi'), 'antigravity'), 'question');
  assert.equal(boxState(fixture('claude-2.1.330-feedback-status.txt'), 'claude'), 'empty');
});

test('a first prompt enters the durable queue once and stops at the same time limit', async () => {
  const t = task('antigravity'); store.update(t.id, { status: 'parked' });
  const q = queue.queueFirstPrompt(store.get(t.id)!, 'First prompt', 'first-prompt-test');
  assert.equal(queue.queueFirstPrompt(store.get(t.id)!, 'First prompt', 'first-prompt-test').id, q.id);
  assert.equal(queue.list(t.id).length, 1);
  const items = queue.list(t.id); items[0].queued = new Date(Date.now() - queue.WARN_MS - 1).toISOString();
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  await queue.tick();
  assert.equal(queue.list(t.id)[0].state, 'failed');
  assert.match(queue.deliveryWait(t.id)!.reason, /Automatic delivery stopped/);
});

test('a normal delivery in progress does not report an unconfirmed submission as a wait', () => {
  const f = fixture();
  recovery.write(f.t.id, { text: 'Message', session: f.t.session, pane: f.state.pane,
    keyAt: 0, at: f.state.now, reason: 'Taskboard has not confirmed submission.', attempts: 0 });
  recovery.active.add(f.t.id);
  try { assert.equal(queue.deliveryWait(f.t.id), undefined); }
  finally { recovery.active.delete(f.t.id); }
  assert.ok(queue.deliveryWait(f.t.id));
});

test('a redraw after Enter can show an older message before the empty Codex input returns', async () => {
  const f = fixture('codex'); f.state.accept = true;
  const capture = f.io.capture;
  let redraws = 0;
  f.io.capture = async s => f.state.enters && redraws++ < 2 ? screen('codex', 'An older message') : capture(s);
  assert.equal((await delivery.deliverText(f.t, 'New message', f.io)).submitted, true);
  assert.equal(f.state.enters, 1);
  assert.equal(f.state.deletes, 0);
});

test('live Claude directory trust screens remain questions and receive no delivery keys', async () => {
  for (const num of [299, 288]) {
    const captured = readFileSync(join(import.meta.dirname, 'fixtures/screens', `claude-directory-trust-${num}.ansi`), 'utf8');
    assert.equal(boxState(captured, 'claude'), 'question');
    const f = fixture(); f.io.capture = async () => captured;
    await assert.rejects(delivery.deliverText(f.t, 'A message is never an approval.', f.io), e => e instanceof delivery.NotTyped && e.state === 'question');
    assert.equal(f.state.enters, 0); assert.equal(f.state.deletes, 0); assert.equal(f.state.text, '');
  }
});

test('transcript confirmation permits only cleanup of matching text, never another Enter', async () => {
  const f = fixture(); f.state.text = 'Already received';
  recovery.write(f.t.id, { text: f.state.text, session: f.t.session, pane: f.state.pane,
    keyAt: 0, at: f.state.now, reason: 'Confirmed by transcript', attempts: 0, confirmed: true, cleanupOnly: true });
  await delivery.recoverText(f.t, f.io);
  f.state.now += 3100;
  await delivery.recoverText(f.t, f.io);
  assert.equal(f.state.enters, 0);
  assert.equal(f.state.text, '');
  assert.equal(recovery.read(f.t.id), undefined);
});
