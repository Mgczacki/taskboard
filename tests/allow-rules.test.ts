// Allow always rules (server/allow-rules.ts): the match by task id for each scope, archived tasks and the controller,
// a task number that a new task uses again, the rate limit, the removal of the rules of a task, and the saved file and
// audit lines. The rules live in a temporary folder, never in the real ~/.taskboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as allow from '../server/allow-rules.ts';
import type { TaskRef } from '../server/allow-rules.ts';
import { kindOf } from '../server/controller-approve.ts';
import type { Approval } from '../server/approvals.ts';

const task = (id: string, num: number, extra: Partial<TaskRef> = {}): TaskRef => ({ id, num, title: `Task ${num}`, status: 'idle', ...extra });
const a = task('task-a', 12), b = task('task-b', 15), c = task('task-c', 20);
const ctl = task('controller', 0, { role: 'controller' });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tb-allow-')); allow.load(dir); return dir; };
const matchOf = (from: TaskRef | undefined, to: TaskRef | undefined) => allow.match(allow.all(), 'message', from, to)?.id;

test('a pair rule covers only the sender to the target', () => {
  fresh();
  const r = allow.add('pair', a, b, 'card1');
  assert.equal(matchOf(a, b), r.id);
  assert.equal(matchOf(b, a), undefined, 'the other direction still needs a card');
  assert.equal(matchOf(c, b), undefined, 'another sender still needs a card');
  assert.equal(matchOf(a, c), undefined, 'another target still needs a card');
});

test('a both rule covers the two directions and no other task', () => {
  fresh();
  const r = allow.add('both', a, b, 'card1');
  assert.equal(matchOf(a, b), r.id);
  assert.equal(matchOf(b, a), r.id);
  assert.equal(matchOf(c, a), undefined);
  assert.equal(matchOf(c, b), undefined);
});

test('an any rule covers every task to the target, but not the target to itself, not the controller and not the reverse', () => {
  fresh();
  const r = allow.add('any', a, b, 'card1');
  assert.equal(r.from, undefined, 'an any rule names no sender');
  assert.equal(matchOf(a, b), r.id);
  assert.equal(matchOf(c, b), r.id);
  assert.equal(matchOf(b, b), undefined);
  assert.equal(matchOf(ctl, b), undefined, 'the controller keeps its own approval rules');
  assert.equal(matchOf(b, a), undefined);
});

test('an archived task, a missing task or the controller never matches, and gets no offer', () => {
  fresh();
  allow.add('both', a, b, 'card1');
  assert.equal(matchOf({ ...a, status: 'archived' }, b), undefined);
  assert.equal(matchOf(a, { ...b, status: 'archived' }), undefined);
  assert.equal(matchOf(undefined, b), undefined);
  assert.equal(allow.offer(ctl, b), undefined);
  assert.equal(allow.offer(a, ctl), undefined);
  assert.equal(allow.offer(a, a), undefined);
  assert.equal(allow.offer(a, { ...b, status: 'archived' }), undefined);
  assert.throws(() => allow.add('pair', ctl, b, 'card2'), /controller/);
});

test('a new task with a reused number does not inherit the rule of the old task', () => {
  fresh();
  allow.add('pair', a, b, 'card1');
  const newTwelve = task('task-a-new', 12, { title: 'Task 12' }); // same number and title, other id
  const newFifteen = task('task-b-new', 15, { title: 'Task 15' });
  assert.equal(matchOf(newTwelve, b), undefined);
  assert.equal(matchOf(a, newFifteen), undefined);
});

test('the offer shows each choice in plain words, with the pair choice first', () => {
  const o = allow.offer(a, b)!;
  assert.deepEqual(o.choices.map(x => x.scope), ['pair', 'both', 'any']);
  assert.equal(allow.DEFAULT_SCOPE, 'pair');
  assert.equal(o.choices[0].text, 'Task #12 "Task 12" may type messages into task #15 "Task 15" without a card. Messages in the other direction still need a card.');
  assert.equal(o.choices[1].text, 'Tasks #12 "Task 12" and #15 "Task 15" may type messages into each other without a card.');
  assert.equal(o.choices[2].text, 'Any task may type messages into task #15 "Task 15" without a card.');
  assert.match(o.limitText, /at most 30 deliveries in one hour/);
});

test('the rate limit stops a rule after 30 deliveries in one hour, and frees it an hour later', () => {
  fresh();
  const r = allow.add('both', a, b, 'card1');
  const t0 = Date.parse('2026-10-03T10:00:00Z');
  for (let i = 0; i < allow.LIMIT_PER_HOUR; i++) {
    assert.equal(allow.limited(allow.get(r.id)!, t0 + i * 1000), undefined, `delivery ${i + 1}`);
    allow.recordDelivery(r.id, { from: i % 2 ? b : a, to: i % 2 ? a : b, state: 'delivered' }, t0 + i * 1000);
  }
  const stopped = allow.limited(allow.get(r.id)!, t0 + 40_000);
  assert.match(stopped!, /already delivered 30 messages in the last hour \(the limit is 30\)\. This card asks you again\./);
  assert.equal(allow.get(r.id)!.count, 30);
  // one hour after the first delivery, that delivery no longer counts
  assert.equal(allow.limited(allow.get(r.id)!, t0 + 3_600_000 + 500), undefined);
  // the count on the rule keeps the total; the recent list keeps only the last hour
  allow.recordDelivery(r.id, { from: a, to: b, state: 'queued' }, t0 + 3_600_000 + 500);
  assert.equal(allow.get(r.id)!.count, 31);
  assert.equal(allow.recentOf(allow.get(r.id)!, t0 + 3_600_000 + 500).length, 30);
});

test('archiving or removing either task removes its rules; an any rule goes with its target only', () => {
  fresh();
  const ab = allow.add('pair', a, b, 'c1'), cb = allow.add('pair', c, b, 'c2'), anyA = allow.add('any', c, a, 'c3');
  assert.equal(allow.removeForTask('task-c', '#20 was archived'), 1);
  assert.deepEqual(allow.all().map(r => r.id).sort(), [ab.id, anyA.id].sort(), 'the any rule names no sender, so it stays');
  assert.equal(allow.removeForTask('task-a', 'the task was removed'), 2);
  assert.deepEqual(allow.all(), []);
  assert.ok(cb.id);
});

test('an equal rule is not added twice; revoke and revoke all write the file and the audit lines', () => {
  const dir = fresh();
  const r1 = allow.add('pair', a, b, 'c1');
  assert.equal(allow.add('pair', a, b, 'c9').id, r1.id);
  const r2 = allow.add('both', a, c, 'c2');
  assert.equal(allow.all().length, 2);
  const saved = JSON.parse(readFileSync(join(dir, 'allow-rules.json'), 'utf8'));
  assert.deepEqual(saved.map((r: { card: string; by: string }) => [r.card, r.by]), [['c1', 'user'], ['c2', 'user']]);
  assert.ok(saved[0].created);
  assert.equal(allow.revoke(r1.id)?.id, r1.id);
  assert.equal(allow.revoke('nope'), undefined);
  assert.equal(allow.revokeAll(), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'allow-rules.json'), 'utf8')), []);
  const events = allow.auditRows().map(x => [x.event, x.rule]);
  assert.deepEqual(events, [['added', r1.id], ['added', r2.id], ['removed', r1.id], ['removed', r2.id]]);
  // a new load of the folder reads the same rules
  allow.add('any', a, b, 'c3'); allow.load(dir);
  assert.equal(allow.all().length, 1);
});

test('the controller cannot approve a "type into" card between two tasks, and the reason names Allow always', () => {
  const card = { id: 'x1', action: 'send', actor: 'task-a', summary: '', detail: '', created: '', state: 'pending', payload: {}, allow: allow.offer(a, b) } as Approval;
  const k = kindOf(card);
  assert.ok('userOnly' in k);
  assert.match((k as { userOnly: string }).userOnly, /decided by the user on the dashboard\. The user can also choose Allow always there\. Only the user adds or revokes/);
  assert.ok('userOnly' in kindOf({ ...card, actor: 'controller', allow: undefined }));
});

test('a rule covers one kind: a message rule does not cover documents, and a document rule does not cover messages', () => {
  fresh();
  const msg = allow.add('pair', a, b, 'c1');
  assert.equal(allow.match(allow.all(), 'doc', a, b), undefined);
  const doc = allow.add('pair', a, b, 'c2', 'doc');
  assert.notEqual(doc.id, msg.id);
  assert.equal(allow.match(allow.all(), 'doc', a, b)?.id, doc.id);
  assert.equal(allow.match(allow.all(), 'message', a, b)?.id, msg.id);
  assert.equal(allow.offer(a, b, 'doc')!.choices[0].text, 'Task #12 "Task 12" may send documents to task #15 "Task 15" without a card. Documents in the other direction still need a card.');
  assert.equal(allow.all().find(r => r.id === doc.id)!.text, 'Task #12 "Task 12" may send documents to task #15 "Task 15" without a card. Documents in the other direction still need a card.');
  assert.throws(() => allow.add('pair', a, b, 'c3', 'status' as never), /only messages or documents/);
});

test('a card can offer only the two choices that name both tasks, with the task numbers of each side', () => {
  fresh();
  const o = allow.offer(a, b, 'message', allow.TASK_SCOPES)!;
  assert.deepEqual(o.choices.map(x => x.scope), ['pair', 'both']);
  assert.equal(o.fromNum, 12); assert.equal(o.toNum, 15);
  assert.equal(o.from, 'task-a'); assert.equal(o.to, 'task-b');
});

test('a match that accepts only pair and both rules ignores a rule for any sender', () => {
  fresh();
  const anyRule = allow.add('any', c, b, 'card1');
  assert.equal(allow.match(allow.all(), 'message', a, b)?.id, anyRule.id);
  assert.equal(allow.match(allow.all(), 'message', a, b, allow.TASK_SCOPES), undefined);
  const pair = allow.add('pair', a, b, 'card2');
  assert.equal(allow.match(allow.all(), 'message', a, b, allow.TASK_SCOPES)?.id, pair.id);
  assert.equal(allow.match(allow.all(), 'message', b, a, allow.TASK_SCOPES), undefined, 'the one-way rule does not cover the reverse direction');
  assert.equal(allow.match(allow.all(), 'message', c, b, allow.TASK_SCOPES), undefined, 'the rule does not cover another sender');
});

