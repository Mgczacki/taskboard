import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-manager-'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-manager-test-${process.pid}`;
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
role.set(group, manager, 'user');

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
