import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-delivery-followup-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-followup-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
const store = await import('../server/store.ts');
const queue = await import('../server/message-queue.ts');
const recovery = await import('../server/text-recovery.ts');
let num = 0;
function task(status: store.Status = 'parked') {
  const n = ++num;
  return store.create({ id: `followup-${n}`, num: n, title: 'Follow-up', agent: 'codex', status,
    cwd: root, folder: root, session: `followup-${n}`, desc: '' });
}
function fill(t: store.Task, state: queue.Queued['state'], count: number) {
  const items = Array.from({ length: count }, (_, n) => ({ id: `earlier-${n}`, text: `Earlier ${n}`,
    from: 'you', kind: 'message', queued: new Date().toISOString(), state, reason: 'Waiting',
    tries: 1, ...(state === 'failed' ? { blockedAt: new Date().toISOString() } : {}) }));
  mkdirSync(store.taskDir(t.id), { recursive: true });
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  queue.start(); queue.stop();
}
test('failed messages do not fill the capacity for messages waiting for delivery', async () => {
  const t = task(); fill(t, 'failed', queue.MAX_OPEN);
  const result = await queue.send(t, 'New message', { from: 'you', kind: 'message', holdWhenParked: true });
  assert.equal(result.state, 'queued');
  assert.equal(queue.list(t.id).filter(q => q.state === 'queued').length, 1);
  assert.ok(queue.list(t.id).some(q => q.state === 'failed'));
});
for (const status of ['archived', 'parked'] as const) {
  test(`sending to a ${status} task fails with its status before an older queue can hide it`, async () => {
    const t = task(status); fill(t, 'queued', 1);
    const result = await queue.send(t, 'New message', { from: 'you', kind: 'message' });
    assert.equal(result.state, 'failed');
    assert.match(result.reason!, /archived|set aside/);
    assert.equal(queue.list(t.id).at(-1)!.state, 'failed');
  });
}
test('the queue preserves failed messages in files when it closes old failures above its display limit', () => {
  const t = task(); fill(t, 'failed', queue.MAX_OPEN);
  queue.expireFailed(t.id);
  assert.equal(queue.list(t.id).filter(q => q.state === 'failed').length, queue.MAX_FAILED);
  const saved = JSON.parse(readFileSync(join(store.taskDir(t.id), 'failed-messages', 'earlier-0.json'), 'utf8'));
  assert.equal(saved.text, 'Earlier 0');
  assert.equal(saved.state, 'failed');
});
test('a full active queue describes automatic expiry instead of requiring manual cleanup', async () => {
  const t = task(); fill(t, 'queued', queue.MAX_OPEN);
  const result = await queue.send(t, 'New message', { from: 'you', kind: 'message', holdWhenParked: true });
  assert.equal(result.state, 'failed');
  assert.doesNotMatch(result.reason!, /Remove some|dashboard first/);
  assert.match(result.reason!, /five minutes|5 minutes/);
});
test('an exact user message in the transcript resolves an uncertain failure without keys', async () => {
  const t = task(); fill(t, 'failed', 1);
  const path = join(root, 'receipt.jsonl');
  store.update(t.id, { transcript: path });
  const items = queue.list(t.id);
  items[0].reason = 'Taskboard could not confirm that the message was submitted. Submission is unknown.';
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  writeFileSync(path, JSON.stringify({ timestamp: new Date(Date.now() + 1).toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier 0' }] } }) + '\n');
  await queue.tick();
  const q = queue.list(t.id)[0];
  assert.equal(q.state, 'delivered');
  assert.match(q.deliveredBy!, /transcript/);
});
test('an old user message or an assistant quote cannot resolve an uncertain failure', async () => {
  const t = task(); fill(t, 'failed', 1);
  const path = join(root, 'not-receipts.jsonl');
  store.update(t.id, { transcript: path });
  const items = queue.list(t.id);
  items[0].reason = 'Taskboard could not confirm that the message was submitted. Submission is unknown.';
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  writeFileSync(path, [
    { timestamp: new Date(0).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Earlier 0' }] } },
    { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Earlier 0' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  await queue.tick();
  assert.equal(queue.list(t.id)[0].state, 'failed');
});

test('transcript proof disables Enter retries for a matching recovery record', async () => {
  const t = task(); fill(t, 'failed', 1);
  const path = join(root, 'proof-and-cleanup.jsonl');
  store.update(t.id, { transcript: path });
  const items = queue.list(t.id);
  items[0].reason = 'Submission is unknown.';
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  recovery.write(t.id, { text: 'Earlier 0', session: t.session, pane: '%1:100', at: Date.now(), keyAt: 0, reason: 'Unknown', attempts: 0 });
  writeFileSync(path, JSON.stringify({ timestamp: new Date(Date.now() + 1).toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier 0' }] } }) + '\n');
  await queue.tick();
  assert.equal(queue.list(t.id)[0].state, 'delivered');
  assert.equal(recovery.read(t.id)?.confirmed, true);
  assert.equal(recovery.read(t.id)?.cleanupOnly, true);
  assert.equal(queue.takeForHook(t.id, 'Stop'), null);
});

test('a direct send can arrive before Taskboard saves its uncertain failure', async () => {
  const t = task(); fill(t, 'failed', 1);
  const path = join(root, 'direct-send.jsonl'), at = Date.now();
  store.update(t.id, { transcript: path });
  const items = queue.list(t.id);
  items[0].reason = 'Submission is unknown.';
  items[0].typingStartedAt = new Date(at - 1000).toISOString();
  items[0].queued = new Date(at + 1000).toISOString();
  writeFileSync(join(store.taskDir(t.id), 'message-queue.json'), JSON.stringify(items));
  writeFileSync(path, JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier 0' }] } }) + '\n');
  await queue.tick();
  assert.equal(queue.list(t.id)[0].state, 'delivered');
});
test.after(() => { queue.stop(); rmSync(root, { recursive: true, force: true }); });
