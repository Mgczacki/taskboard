import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-manager-'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-manager-test-${process.pid}`;
// A message to an idle task resumes it. These tests must not start the real Codex or write to the real ~/.codex:
// HOME is a scratch folder, and `codex` on PATH ends at once, so the start fails and the message stays queued.
process.env.HOME = join(root, 'home');
mkdirSync(join(root, 'home', '.codex'), { recursive: true });
mkdirSync(join(root, 'bin'));
writeFileSync(join(root, 'bin', 'codex'), '#!/bin/sh\nexit 1\n'); chmodSync(join(root, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;
const store = await import('../server/store.ts');
const groups = await import('../server/groups.ts');
const role = await import('../server/manager-role.ts');
const tokens = await import('../server/task-token.ts');
const approvals = await import('../server/approvals.ts');
const events = await import('../server/manager-events.ts');
const queue = await import('../server/message-queue.ts');
const standing = await import('../server/standing-approvals.ts');

function task(id: string, num: number, parent?: string) {
  return store.create({ id, num, title: id, agent: 'codex', status: 'idle', cwd: root, folder: root,
    session: `no-session-${num}`, desc: '', ...(parent ? { parent } : {}) } as any);
}
const manager = task('manager', 1), worker = task('worker', 2), outside = task('outside', 3), child = task('child', 4, 'manager');
const group = groups.create('Manager tests', [manager.id, worker.id]);
// these tests cover the caps on new tasks, so the manager has the preset Direct and create tasks (the default is Direct the group)
role.set(group, manager, 'user', undefined, 'create');

test('task tokens identify their own task', () => {
  const a = tokens.forTask(manager.id), b = tokens.forTask(worker.id);
  assert.notEqual(a, b);
  assert.equal(tokens.actorFor(a), manager.id);
  assert.equal(tokens.actorFor(b), worker.id);
  assert.equal(tokens.actorFor('forged'), undefined);
  assert.equal(readFileSync(tokens.fileFor(manager.id), 'utf8'), a);
});

test('manager scope keeps other tasks out', () => {
  assert.equal(role.check(manager.id, 'send', worker.id).ok, true);
  assert.equal(role.check(manager.id, 'send', outside.id).ok, false);
  assert.equal(role.check(manager.id, 'group-add', outside.id).ok, false);
  assert.equal(role.check(manager.id, 'group-add', child.id).ok, true);
  assert.equal(role.check(worker.id, 'send', manager.id).ok, false);
});

test('manager message and stop limits become cards after the caps', () => {
  for (let i = 0; i < 3; i++) role.used(manager.id, group, 'stop', worker.id);
  assert.match(role.check(manager.id, 'stop', worker.id).reason, /3 stop/);
  for (let i = 3; i < 30; i++) role.used(manager.id, group, 'send', worker.id);
  assert.match(role.check(manager.id, 'send', worker.id).reason, /30 messages/);
});

test('manager new task cap and group work cap are checked', () => {
  for (let i = 0; i < 8; i++) role.used(manager.id, group, 'new', `new-${i}`);
  assert.match(role.check(manager.id, 'new', '', group.id).reason, /8 new tasks/);
  assert.equal(role.check(manager.id, 'new', '', 'other').ok, false);
});

test('standing rules refuse protected branches and other actions', () => {
  assert.throws(() => standing.add({ action: 'push', actor: worker.id, target: 'private', limitPerDay: 1 }, ['private']), /protected branch/);
  assert.throws(() => standing.add({ action: 'release' as any, actor: worker.id, target: 'stage', limitPerDay: 1 }), /cannot have/);
});

test('one pending card gets a new version for the same target', async () => {
  const a = approvals.request({ actor: worker.id, action: 'send', target: 'manager', summary: 'send one', detail: 'first', payload: { text: 'first' } }, async () => 'first');
  const firstVersion = a.version;
  const b = approvals.request({ actor: worker.id, action: 'send', target: 'manager', summary: 'send one', detail: 'second', payload: { text: 'second' } }, async () => 'second');
  assert.equal(a.id, b.id);
  assert.notEqual(b.version, firstVersion);
  assert.equal((await approvals.decide(a.id, true))?.result, 'second');
});

test('a changed fact stops a card before its runner', async () => {
  let ran = false;
  const a = approvals.request({ actor: worker.id, action: 'git-push', target: 'branch', summary: 'push branch', detail: 'head old', payload: {} },
    async () => { ran = true; return 'ran'; }, { check: async () => 'head old to head new' });
  const result = await approvals.decide(a.id, true);
  assert.equal(ran, false);
  assert.equal(result?.state, 'pending');
  assert.equal(result?.staleFacts, 'head old to head new');
});

test('events remain on disk and one digest enters the manager queue', async () => {
  events.record(worker.id, 'status', 'idle to stopped');
  events.record(worker.id, 'card', 'push approved');
  assert.equal(events.heartbeat(group.id).pending, 2);
  await events.flush(group.id);
  assert.equal(events.heartbeat(group.id).pending, 0);
  assert.equal(readFileSync(join(root, 'private', 'manager-events.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(queue.list(manager.id).filter(x => x.text.startsWith('[Taskboard event digest')).length, 1);
  assert.equal(existsSync(join(store.taskDir(manager.id), 'outbox', 'handoff.md')), true);
});

test('the role goes only to a live task: a task that is set aside is refused, and a set-aside manager can lose the role', () => {
  const resting = store.create({ id: 'resting', num: 9, title: 'resting', agent: 'codex', status: 'parked', cwd: root, folder: root, session: 'no-session-9', desc: '' } as any);
  const g = groups.create('Set aside tests', [resting.id, worker.id]);
  assert.throws(() => role.set(g, resting, 'user'), /Bring this task back first\. A task that is set aside cannot become a manager\./);
  assert.equal(groups.all().find(x => x.id === g.id)?.manager, undefined);
  role.set(g, worker, 'user');
  store.update(worker.id, { status: 'parked' } as any);
  assert.throws(() => role.set(g, store.get(worker.id), 'user', undefined, 'watch'), /set aside/);
  role.set(g, undefined, 'user');
  assert.equal(groups.all().find(x => x.id === g.id)?.manager, undefined);
  store.update(worker.id, { status: 'idle' } as any);
});
