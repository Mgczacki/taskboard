import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-manager-lifecycle-'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-manager-lifecycle-${process.pid}`;
process.env.HOME = join(root, 'home');
mkdirSync(join(root, 'home', '.codex'), { recursive: true });
mkdirSync(join(root, 'bin'));
writeFileSync(join(root, 'bin', 'codex'), '#!/bin/sh\nexit 1\n');
chmodSync(join(root, 'bin', 'codex'), 0o755);
process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;

const store = await import('../server/store.ts');
const groups = await import('../server/groups.ts');
const role = await import('../server/manager-role.ts');
const events = await import('../server/manager-events.ts');
const messages = await import('../server/message-queue.ts');
const links = await import('../server/links.ts');
const board = await import('../server/waiting-board.ts');

const task = (id: string, num: number) => store.create({ id, num, title: id, agent: 'codex', status: 'idle', cwd: root,
  folder: root, session: `no-session-${num}`, desc: '' });
const first = task('first', 1), next = task('next', 2), worker = task('worker', 3), dependency = task('dependency', 4);
const group = groups.create('Lifecycle', [first.id, next.id, worker.id, dependency.id]);
const other = groups.create('Other', []);
role.set(group, first, 'user');
links.add(worker.id, { kind: 'dependsOn', to: dependency.id }, { actor: 'user' });
events.start();

const queued = (id: string) => messages.list(id).filter(m => m.state === 'queued' && m.text.startsWith('[Taskboard event digest'));

test('manager account move sends the current group and dependency wait once', async () => {
  store.update(first.id, { account: 'other-account', status: 'working' });
  await events.flush(group.id);
  assert.equal(queued(first.id).length, 1);
  assert.match(queued(first.id)[0]!.text, /worker.*blocked.*Complete task #4/);
  assert.match(queued(first.id)[0]!.text, /#4 dependency/);
  assert.equal(events.heartbeat(group.id).pending, 0);
  assert.equal(store.get(worker.id)?.status, 'idle');
});

test('replacement manager gets current group and ready work without an old digest', async () => {
  for (const m of messages.list(first.id)) messages.remove(first.id, m.id);
  store.update(dependency.id, { status: 'archived' });
  role.set(group, next, 'user');
  await events.flush(group.id);
  assert.equal(queued(first.id).length, 0);
  assert.equal(messages.list(first.id).some(message => message.text.includes('You no longer manage group Lifecycle.')), true);
  assert.equal(queued(next.id).length, 1);
  assert.match(queued(next.id)[0]!.text, /worker.*ready/);
  assert.equal(links.state(store.get(worker.id)!), 'ready');
  assert.equal(store.get(worker.id)?.status, 'idle');
});

test('a removed member disappears from the group board and manager events', async () => {
  for (const m of messages.list(next.id)) messages.remove(next.id, m.id);
  events.record(worker.id, 'waiting', 'Old wait');
  groups.moveTask(worker.id, group.id, other.id);
  await events.flush(group.id);
  const digest = queued(next.id)[0]?.text || '';
  assert.match(digest, /worker.*left/);
  assert.doesNotMatch(digest, /Old wait/);
  assert.equal(board.board(group).columns.free.some((r: any) => r.id === worker.id), false);
  assert.equal(JSON.parse(readFileSync(join(root, 'private', 'manager-event-queue.json'), 'utf8')).length, 0);
});

test('marking a dependency done tells the manager about ready work without starting the task', async () => {
  for (const m of messages.list(next.id)) messages.remove(next.id, m.id);
  const waiting = task('waiting', 5);
  const blocker = task('blocker', 6);
  groups.update(group.id, { tasks: [...group.tasks, waiting.id, blocker.id] });
  await events.flush(group.id);
  for (const m of messages.list(next.id)) messages.remove(next.id, m.id);
  const link = links.add(waiting.id, { kind: 'dependsOn', to: blocker.id }, { actor: 'user' });
  store.update(waiting.id, { waitingOn: { on: 'task', target: String(blocker.num), reason: 'Blocker must finish', needs: 'Finish blocker', since: new Date().toISOString(), card: '', unblocks: [], source: 'reported' } });
  assert.equal((board.board(group).columns.waitingOther as any[]).some(row => row.id === waiting.id), true);
  links.markDone(waiting.id, link.id, { actor: 'user' });
  await events.flush(group.id);
  for (let attempt = 0; attempt < 20 && !queued(next.id).length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(queued(next.id)[0]!.text, /#5 ready:.*marked done/);
  assert.match(queued(next.id)[0]!.text, /waiting \(idle, ready\)/);
  assert.equal((board.board(group).columns.free as any[]).some(row => row.id === waiting.id), true);
  assert.equal(store.get(waiting.id)?.status, 'idle');
});
