import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-manager-events-'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-manager-events-${process.pid}`;
process.env.HOME = join(root, 'home');
mkdirSync(join(root, 'private'), { recursive: true });
mkdirSync(join(root, 'home', '.codex'), { recursive: true });
mkdirSync(join(root, 'bin'));
writeFileSync(join(root, 'bin', 'codex'), '#!/bin/sh\nexit 1\n');
chmodSync(join(root, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;

const store = await import('../server/store.ts');
const groups = await import('../server/groups.ts');
const manager = store.create({ id: 'manager', num: 1, title: 'manager', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'no-manager-session', desc: '' });
const worker = store.create({ id: 'worker', num: 2, title: 'worker', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'no-worker-session', desc: '' });
const group = groups.create('Manager events', [manager.id, worker.id]);
groups.update(group.id, { manager: manager.id });

const old = new Date().toISOString();
writeFileSync(join(root, 'private', 'manager-event-queue.json'), JSON.stringify([
  { at: old, group: group.id, task: manager.id, kind: 'status', text: 'working to unread' },
  { at: old, group: group.id, task: manager.id, kind: 'waiting', text: 'The task cleared its reported wait.' },
]));
const events = await import('../server/manager-events.ts');
const messageQueue = await import('../server/message-queue.ts');
const accounts = await import('../server/accounts.ts');
writeFileSync(join(store.taskDir(manager.id), 'message-queue.json'), JSON.stringify([
  { id: 'self', from: 'taskboard', kind: 'message', state: 'queued', text: `[Taskboard event digest, ${old}, group ${group.name}, 2 events]\n- #1 status: working to unread\n- #1 waiting: The task cleared its reported wait.\nBoard: tb board "${group.name}"` },
  { id: 'worker', from: 'taskboard', kind: 'message', state: 'queued', text: `[Taskboard event digest, ${old}, group ${group.name}, 1 events]\n- #2 status: idle to working\nBoard: tb board "${group.name}"` },
]));

test('manager status and waiting changes do not queue or deliver a self-only digest', async () => {
  assert.equal(events.heartbeat(group.id).pending, 0);
  events.start();
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'private', 'manager-event-queue.json'), 'utf8')), []);
  assert.deepEqual(messageQueue.list(manager.id).map(x => x.id), ['worker']);
  messageQueue.remove(manager.id, 'worker');
  store.update(manager.id, { status: 'working' });
  store.update(manager.id, { status: 'unread' });
  events.record(manager.id, 'waiting', 'The task cleared its reported wait.');
  assert.equal(events.heartbeat(group.id).pending, 0);
  await events.flush(group.id);
  assert.equal(messageQueue.list(manager.id).length, 0);
});

test('a worker event still reaches the manager without manager events', async () => {
  events.record(worker.id, 'waiting', 'Waiting for a review.');
  events.record(manager.id, 'status', 'unread to working');
  assert.equal(events.heartbeat(group.id).pending, 1);
  await events.flush(group.id);
  assert.equal(events.heartbeat(group.id).pending, 0);
  const digests = messageQueue.list(manager.id).filter(x => x.text.startsWith('[Taskboard event digest'));
  assert.equal(digests.length, 1);
  assert.match(digests[0]!.text, /#2 waiting: Waiting for a review\./);
  assert.doesNotMatch(digests[0]!.text, /#1 /);
});

test('a worker completion waits while the manager account is limited and reaches the next turn', async () => {
  for (const item of messageQueue.list(manager.id)) messageQueue.remove(manager.id, item.id);
  const account = accounts.defaultFor('codex');
  store.update(manager.id, { status: 'stopped' });
  account.limited = { at: new Date().toISOString(), note: 'model capacity' };
  try {
    store.update(worker.id, { status: 'working' });
    store.update(worker.id, { status: 'unread' });
    assert.equal(events.heartbeat(group.id).pending, 2);
    await events.flush(group.id);
    assert.equal(events.heartbeat(group.id).pending, 0);
    const pending = messageQueue.list(manager.id).filter(x => x.state === 'queued');
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.reason, /model capacity/);
    assert.match(pending[0]!.text, /#2 status: working to unread/);
    assert.equal(store.get(manager.id)?.status, 'stopped');
    assert.equal(messageQueue.takeForHook(manager.id, 'Stop'), null);
    assert.equal(messageQueue.list(manager.id).find(x => x.id === pending[0]!.id)?.state, 'queued');
    delete account.limited;
    assert.match(messageQueue.takeForHook(manager.id, 'Stop') || '', /#2 status: working to unread/);
    assert.equal(messageQueue.list(manager.id).find(x => x.id === pending[0]!.id)?.state, 'delivered');
  } finally { delete account.limited; }
});

test('a full manager message queue keeps the worker event for another flush', async () => {
  for (const item of messageQueue.list(manager.id)) messageQueue.remove(manager.id, item.id);
  const account = accounts.defaultFor('codex');
  account.limited = { at: new Date().toISOString(), note: 'usage limit' };
  store.update(manager.id, { status: 'stopped' });
  const full = Array.from({ length: messageQueue.MAX_OPEN }, (_, i) => ({
    id: `full-${i}`, text: 'Earlier message', kind: 'message', from: 'taskboard',
    queued: old, state: 'queued', reason: 'Waiting', tries: 1,
  }));
  writeFileSync(join(store.taskDir(manager.id), 'message-queue.json'), JSON.stringify(full));
  try {
    events.record(worker.id, 'status', 'working to unread');
    await events.flush(group.id);
    assert.equal(events.heartbeat(group.id).pending, 1);
    assert.equal(messageQueue.list(manager.id).length, messageQueue.MAX_OPEN);
    writeFileSync(join(store.taskDir(manager.id), 'message-queue.json'), '[]');
    await events.flush(group.id);
    assert.equal(events.heartbeat(group.id).pending, 0);
    assert.equal(messageQueue.list(manager.id).filter(x => x.state === 'queued').length, 1);
  } finally { delete account.limited; }
});

test('a worker event waits through review without clearing the review decision', async () => {
  for (const item of messageQueue.list(manager.id)) messageQueue.remove(manager.id, item.id);
  const account = accounts.defaultFor('codex');
  account.limited = { at: new Date().toISOString(), note: 'usage limit' };
  store.update(manager.id, { status: 'review', ask: 'Review report.md' });
  try {
    events.record(worker.id, 'status', 'working to unread');
    await events.flush(group.id);
    const pending = messageQueue.list(manager.id).filter(x => x.state === 'queued');
    assert.equal(pending.length, 1);
    assert.equal(store.get(manager.id)?.status, 'review');
    assert.equal(store.get(manager.id)?.ask, 'Review report.md');
    delete account.limited;
    assert.match(messageQueue.takeForHook(manager.id, 'Stop') || '', /#2 status: working to unread/);
    assert.equal(store.get(manager.id)?.status, 'review');
    assert.equal(store.get(manager.id)?.ask, 'Review report.md');
  } finally { delete account.limited; }
});
