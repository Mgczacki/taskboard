// The group manager rule (server/manager-role.ts, task 273): the manager of a group and the tasks of that group may
// message each other without a card. These tests cover the presets, the inbound rule, its rate limits, the end of the
// rule (role removed, manager archived, manager left the group), a task outside the group and the controller.
// The server routes that use these functions are covered by tests/manager-messages-server.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-manager-messages-'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-manager-messages-${process.pid}`;
process.env.HOME = join(root, 'home');
mkdirSync(join(root, 'home'), { recursive: true });
const store = await import('../server/store.ts');
const groups = await import('../server/groups.ts');
const role = await import('../server/manager-role.ts');

function task(id: string, num: number, extra: Record<string, unknown> = {}) {
  return store.create({ id, num, title: id, agent: 'claude', status: 'idle', cwd: root, folder: root, session: `no-session-${num}`, desc: '', ...extra } as any);
}
const manager = task('manager', 1), w1 = task('w1', 2), w2 = task('w2', 3), w3 = task('w3', 4), outside = task('outside', 5);
const controller = task('controller', 0, { role: 'controller' });
const group = groups.create('Messages', [manager.id, w1.id, w2.id, w3.id]);
const audit = () => readFileSync(join(root, 'private', 'manager-actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const g = () => groups.get(group.id)!;

test('a new manager gets the preset Direct the group by default', () => {
  role.set(g(), manager, 'user');
  assert.equal(g().managerPreset, 'direct');
  assert.equal(role.presetOf(g()), 'direct');
  assert.equal(role.DEFAULT_PRESET, 'direct');
  assert.equal(audit().at(-1).result, 'done, Direct the group');
});

test('Direct the group: the manager sends, stops, parks and links in its group without a card, and starts no task without one', () => {
  for (const a of ['send', 'doc', 'stop', 'park', 'resume', 'dep', 'waiting'] as const) assert.equal(role.check(manager.id, a, w1.id).ok, true, a);
  const created = role.check(manager.id, 'new', '', group.id);
  assert.equal(created.ok, false);
  assert.match(created.reason, /Direct the group/);
  assert.doesNotMatch(created.reason, /outside|another group/, 'a new task makes a card, it is not refused');
  assert.equal(role.usage(g()).mayNew, false);
  assert.equal(role.usage(g()).mayMessage, true);
});

test('a manager cannot act on a task outside its group in any preset', () => {
  for (const p of ['watch', 'direct', 'create'] as const) {
    role.set(g(), manager, 'user', undefined, p);
    assert.match(role.check(manager.id, 'send', outside.id).reason, /outside/, p);
    assert.match(role.check(manager.id, 'doc', outside.id).reason, /outside/, p);
  }
  role.set(g(), manager, 'user', undefined, 'direct');
});

test('Watch only: the manager sends nothing without a card, but still receives from its group', () => {
  role.set(g(), manager, 'user', undefined, 'watch');
  assert.equal(audit().at(-1).action, 'set-preset');
  for (const a of ['send', 'doc', 'stop', 'park', 'dep'] as const) assert.match(role.check(manager.id, a, w1.id).reason, /Watch only/, a);
  assert.equal(role.inbound(w1.id, manager.id)?.id, group.id);
  role.set(g(), manager, 'user', undefined, 'direct');
});

test('the tasks of the group may message the manager; other tasks, the controller and the manager itself are not covered', () => {
  for (const w of [w1, w2, w3]) assert.equal(role.inbound(w.id, manager.id)?.id, group.id, w.id);
  assert.equal(role.inbound(outside.id, manager.id), undefined, 'a task outside the group gets a card as before');
  assert.equal(role.inbound(controller.id, manager.id), undefined, 'the controller keeps its own setting');
  assert.equal(role.inbound(manager.id, manager.id), undefined);
  assert.equal(role.inbound(w1.id, w2.id), undefined, 'the rule covers only messages to the manager, not between workers');
});

test('a worker cannot use the manager rights: a message into the manager gives the sender no manager action', () => {
  assert.equal(role.role(w1.id), undefined);
  assert.match(role.check(w1.id, 'send', w2.id).reason, /not a group manager/);
});

test('rate limit: 30 messages an hour from one task to its manager, then a card', () => {
  for (let i = 0; i < role.PAIR_PER_HOUR; i++) {
    assert.equal(role.inboundLimit(w1.id, manager.id), undefined, `message ${i + 1}`);
    role.received(w1.id, g(), i % 2 ? 'doc' : 'message', 'delivered');
  }
  assert.match(role.inboundLimit(w1.id, manager.id)!, /30 messages and documents to its group manager/);
  assert.equal(role.inboundLimit(w2.id, manager.id), undefined, 'the limit is for each pair');
  // an hour later the pair may send again
  assert.equal(role.inboundLimit(w1.id, manager.id, Date.now() + 3600001), undefined);
  // a failed delivery does not count
  role.received(w2.id, g(), 'message', 'failed');
  assert.equal(audit().at(-1).result, 'failed message');
});

test('rate limit: 60 messages an hour into one manager from all tasks, then a card', () => {
  for (let i = 0; i < 29; i++) role.received(w2.id, g(), 'message', 'queued');
  assert.equal(role.inboundLimit(w3.id, manager.id), undefined);
  role.received(w3.id, g(), 'message', 'delivered');
  assert.match(role.inboundLimit(w3.id, manager.id)!, /received 60/);
});

test('every message into the manager without a card is one line of manager-actions.jsonl, left out of Manager did', () => {
  const lines = audit().filter(x => x.action === 'to-manager');
  assert.equal(lines.length, 61);
  assert.ok(lines.every(x => x.group === group.id && x.target === manager.id));
  assert.equal(role.actions(group.id).some(x => x.action === 'to-manager'), false);
});

test('the rule ends when the user removes the role, and comes back only when the user sets it', () => {
  role.set(g(), undefined, 'user');
  assert.equal(role.inbound(w3.id, manager.id), undefined);
  assert.equal(role.role(manager.id), undefined);
  assert.equal(g().managerPreset, undefined);
  role.set(g(), manager, 'user');
  assert.equal(role.inbound(w3.id, manager.id)?.id, group.id);
});

test('the rule ends when the manager task is archived', () => {
  store.update(manager.id, { status: 'archived' });
  assert.equal(role.inbound(w3.id, manager.id), undefined);
  assert.equal(role.check(manager.id, 'send', w3.id).ok, false);
  store.update(manager.id, { status: 'idle' });
  assert.equal(role.inbound(w3.id, manager.id)?.id, group.id, 'the role is back after the user resumes the task');
});

test('the rule ends when the manager leaves the group, and adding it again does not give the role back', () => {
  groups.update(group.id, { tasks: g().tasks.filter(t => t !== manager.id) });
  assert.equal(g().manager, undefined);
  assert.equal(role.inbound(w3.id, manager.id), undefined);
  groups.update(group.id, { tasks: [...g().tasks, manager.id] });
  assert.equal(role.role(manager.id), undefined);
  role.set(g(), manager, 'user');
  groups.create('Other', []);
  groups.moveTask(manager.id, group.id, groups.all().find(x => x.name === 'Other')!.id);
  assert.equal(g().manager, undefined);
  assert.equal(role.role(manager.id), undefined);
});

test('an archived worker cannot use the rule', () => {
  groups.moveTask(manager.id, groups.all().find(x => x.name === 'Other')!.id, group.id);
  role.set(g(), manager, 'user');
  store.update(w2.id, { status: 'archived' });
  assert.equal(role.inbound(w2.id, manager.id), undefined);
});

test('the controller may not become a manager, and an unknown preset is refused', () => {
  assert.throws(() => role.set(g(), controller, 'user'), /controller cannot manage/);
  assert.throws(() => role.set(g(), manager, 'user', undefined, 'admin' as any), /Choose Watch only/);
});

test('the Settings line and tb allow list text name the rule in plain words', () => {
  assert.equal(role.RULE_TEXT, 'Group managers: the manager of a group and the tasks of that group may message each other without a card.');
  assert.match(role.RULE_LIMIT_TEXT, /at most 30 messages and documents an hour to its manager/);
  assert.match(role.RULE_LIMIT_TEXT, /at most 60 an hour/);
  for (const p of Object.values(role.PRESETS)) assert.ok(p.name && p.may.length);
  assert.ok(role.NEVER.some(x => /Approve a card/.test(x)));
});
