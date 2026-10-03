// The rules for a controller approval of a dashboard card (server/controller-approve.ts) and the history line of a
// decided card (web/src/approvalHistory.ts). The server test is tests/controller-approve-server.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval } from '../server/approvals.ts';

// this test can run inside a Taskboard task: the module must not read or write the real Taskboard folder
const root = mkdtempSync(join(tmpdir(), 'tb-ctl-approve-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir'); process.env.TASKBOARD_VAULT = join(root, 'vault');
const ca = await import('../server/controller-approve.ts');
const { decidedByLine, controllerHistoryText } = await import('../web/src/approvalHistory.ts');

let n = 0;
const card = (action: Approval['action'], payload: unknown = {}, extra: Partial<Approval> = {}): Approval =>
  ({ id: `c0ffee${String(++n).padStart(2, '0')}`, actor: 'task-a', action, summary: action, detail: `detail of ${action}`, created: new Date().toISOString(), state: 'pending', payload, ...extra });
const open = (a: Approval, taskNum: number | null = 209, taskId = `t${taskNum}`): import('../server/controller-approve.ts').OpenCard => {
  const k = ca.kindOf(a); if (!('kind' in k)) throw new Error('user only');
  return { a, kind: k.kind, ...(taskNum === null ? {} : { taskId, taskNum }) };
};
const said = (...messages: string[]) => ({ userWrote: (w: string) => messages.filter(m => m === w).length, usedFor: () => 0 });

test('each card action has a kind with a switch, or stays user only', () => {
  assert.deepEqual(ca.kindOf(card('git-merge')), { kind: 'merge' });
  assert.deepEqual(ca.kindOf(card('git-push', { state: { forcePush: false } })), { kind: 'push' });
  assert.deepEqual(ca.kindOf(card('git-push', { state: { forcePush: true } })), { kind: 'forcePush' });
  for (const [action, kind] of [['release', 'release'], ['restart', 'restart'], ['scope', 'scope'], ['permit', 'permit'], ['mail-out', 'mail'], ['mail-in', 'mail']] as const)
    assert.deepEqual(ca.kindOf(card(action)), { kind });
  for (const action of ['tool-refusal', 'new', 'send', 'status', 'kill', 'move'] as const) assert.ok('userOnly' in ca.kindOf(card(action)), action);
  assert.deepEqual(ca.CONTROLLER_KINDS.sort(), ['forcePush', 'mail', 'merge', 'permit', 'push', 'release', 'restart', 'scope']);
});

test('the version changes with the card contents, and the head must match the card', () => {
  const a = card('git-merge', { source: 'a'.repeat(40), target: 'b'.repeat(40), branch: 'task/x' });
  const v = ca.versionOf(a);
  assert.match(v, /^[0-9a-f]{12}$/);
  assert.equal(ca.versionOf({ ...a }), v);
  assert.notEqual(ca.versionOf({ ...a, payload: { source: 'c'.repeat(40), target: 'b'.repeat(40), branch: 'task/x' } }), v, 'a new branch head');
  assert.notEqual(ca.versionOf({ ...a, detail: 'other' }), v);
  assert.deepEqual(ca.headOf(a), { head: 'a'.repeat(40), range: `${'b'.repeat(40)}..${'a'.repeat(40)}`, branch: 'task/x' });
  const p = card('git-push', { state: { newHead: 'd'.repeat(40), oldHead: null, branch: 'task/y' } });
  assert.equal(ca.headOf(p)?.range, `(new branch)..${'d'.repeat(40)}`);
  assert.ok(ca.sameHead('aaaaaaa', 'a'.repeat(40)));
  assert.ok(ca.sameHead('A'.repeat(40), 'a'.repeat(40)));
  assert.ok(!ca.sameHead('aaaaaa', 'a'.repeat(40)), 'fewer than 7 characters');
  assert.ok(!ca.sameHead('bbbbbbb', 'a'.repeat(40)));
  assert.equal(ca.headOf(card('release')), undefined);
});

test('the message names the card by id, or by task number and kind when that is unique', () => {
  const m1 = open(card('git-merge'), 209, 't209'), m2 = open(card('git-merge'), 206, 't206');
  const all = [m1, m2];
  assert.deepEqual(ca.namesCard(`approve ${m1.a.id}`, m1, all), { by: 'id', key: m1.a.id });
  assert.deepEqual(ca.namesCard('Approve 209, 206 - merge them', m1, all), { by: 'task', key: 't209:merge' });
  assert.deepEqual(ca.namesCard('Approve 209, 206 - merge them', m2, all), { by: 'task', key: 't206:merge' });
  assert.deepEqual(ca.namesCard('merge task #206', m2, all), { by: 'task', key: 't206:merge' });
  assert.ok('refusal' in ca.namesCard('Approve 206 for me', m1, all), 'another task number');
  assert.ok('refusal' in ca.namesCard(`approve ${m2.a.id}`, m1, all), 'another card id');
  assert.ok('refusal' in ca.namesCard('approve all', m1, all), 'approve all names no card');
  assert.ok('refusal' in ca.namesCard('approve 2090 merge', m1, all), 'a longer number is another task');
  // two merge cards of one task: only the id names one
  const m3 = open(card('git-merge'), 209, 't209');
  const named = ca.namesCard('merge 209', m1, [m1, m3]);
  assert.ok('refusal' in named && /2 open merge into local master cards/.test(named.refusal));
  // a card of the controller (restart) has no task: the kind word names it when it is the only one
  const r = open(card('restart', {}, { actor: 'controller' }), null);
  assert.deepEqual(ca.namesCard('yes, restart Taskboard', r, [r]), { by: 'task', key: 'controller:restart' });
  // a message draft only by its card or message id
  const mail = open(card('mail-out', { message: 'msg_123', stage: 'draft' }), 209, 't209');
  assert.ok('refusal' in ca.namesCard('approve the draft of 209', mail, [mail]));
  assert.deepEqual(ca.namesCard('send msg_123', mail, [mail]), { by: 'id', key: mail.a.id });
  // a permit by its permit id
  const permit = open(card('permit', { permitId: 'perm-77' }), 209, 't209');
  assert.deepEqual(ca.namesCard('approve perm-77', permit, [permit]), { by: 'id', key: permit.a.id });
});

test('the shared user request check: empty, no approval word, a no word, not written by the user, reused', () => {
  const m = open(card('git-merge'), 209, 't209');
  const ok = `approve ${m.a.id}`;
  assert.throws(() => ca.checkUserRequest(m, [m], { words: '  ', ...said() }), /exact chat message/);
  assert.throws(() => ca.checkUserRequest(m, [m], { words: `look at ${m.a.id}`, ...said(`look at ${m.a.id}`) }), /no approval word/);
  assert.throws(() => ca.checkUserRequest(m, [m], { words: `don't approve ${m.a.id}`, ...said(`don't approve ${m.a.id}`) }), /says no/);
  assert.throws(() => ca.checkUserRequest(m, [m], { words: ok, ...said('something else') }), /not one user message/);
  assert.throws(() => ca.checkUserRequest(m, [m], { words: 'approve all', ...said('approve all') }), /names no card/);
  assert.deepEqual(ca.checkUserRequest(m, [m], { words: ok, ...said(ok) }), { by: 'id', key: m.a.id });
  assert.throws(() => ca.checkUserRequest(m, [m], { words: 'x'.repeat(2001), ...said() }), /2000/);
  // one message for two cards: it names both, so each card can use it once
  const n1 = open(card('git-merge'), 1, 't1'), n2 = open(card('git-merge'), 2, 't2');
  const both = 'Approve 1, 2 - merge them';
  assert.equal(ca.checkUserRequest(n1, [n1, n2], { words: both, ...said(both) }).key, 't1:merge');
  assert.equal(ca.checkUserRequest(n2, [n1, n2], { words: both, ...said(both) }).key, 't2:merge');
  // a later card of the same task and kind cannot use the old message again, unless the user wrote it again
  const reused = { words: both, userWrote: (w: string) => w === both ? 1 : 0, usedFor: (_w: string, key: string) => key === 't1:merge' ? 1 : 0 };
  assert.throws(() => ca.checkUserRequest(n1, [n1, n2], reused), /already approved/);
  assert.equal(ca.checkUserRequest(n1, [n1, n2], { ...reused, userWrote: () => 2 }).key, 't1:merge');
});

test('extra rules for force push, release, restart, protected branches, permits and message drafts', () => {
  const none = { inFlight: '', protectedBranch: false };
  const force = open(card('git-push', { state: { forcePush: true, newHead: 'a'.repeat(40), branch: 'task/x' } }));
  assert.throws(() => ca.extraRules(force, 'push 209', none), /FORCE PUSH/);
  ca.extraRules(force, 'approve the force push of 209', none);
  const release = open(card('release'));
  assert.throws(() => ca.extraRules(release, `approve ${release.a.id}`, none), /word release/);
  ca.extraRules(release, 'release 209', none);
  assert.throws(() => ca.extraRules(release, 'release 209', { inFlight: 'A restart card runs now (x).', protectedBranch: false }), /runs now/);
  const restart = open(card('restart', {}, { actor: 'controller' }), null);
  assert.throws(() => ca.extraRules(restart, 'approve it', none), /word restart/);
  ca.extraRules(restart, 'restart please', none);
  const master = open(card('git-push', { state: { newHead: 'a'.repeat(40), branch: 'master' } }));
  assert.throws(() => ca.extraRules(master, 'push 209', { inFlight: '', protectedBranch: true }), /protected branch master/);
  ca.extraRules(master, 'push 209 to master', { inFlight: '', protectedBranch: true });
  assert.throws(() => ca.extraRules(open(card('permit', {}, { detail: '1. brew install jq' })), 'approve', none), /installs software/);
  assert.throws(() => ca.extraRules(open(card('permit', {}, { detail: '1. gh auth login' })), 'approve', none), /signs in/);
  ca.extraRules(open(card('permit', {}, { detail: '1. echo hi' })), 'approve', none);
  assert.throws(() => ca.extraRules(open(card('mail-out', { stage: 'held' })), 'approve', none), /holds this draft/);
  ca.extraRules(open(card('mail-out', { stage: 'draft' })), 'approve', none);
});

test('push and permit cards expire; the error says when and that nothing ran', () => {
  const created = '2026-10-02T10:00:00.000Z';
  const p = card('git-push', { state: {} }, { created });
  assert.equal(ca.expiryOf(p, undefined, Date.parse(created) + 599_000).expired, undefined);
  const late = ca.expiryOf(p, undefined, Date.parse(created) + 600_000);
  assert.equal(late.expiresAt, '2026-10-02T10:10:00.000Z');
  assert.match(late.expired!, /expired at .*Nothing ran/);
  assert.match(ca.expiryOf(card('permit'), '2026-10-02T10:00:00.000Z', Date.parse(created) + 1).expired!, /expired/);
  assert.deepEqual(ca.expiryOf(card('git-merge')), {});
});

test('the history line of a decided card names the controller and the user message', () => {
  assert.equal(controllerHistoryText('Approve 206 for me'), 'Approved by the controller on the user\'s request: "Approve 206 for me"');
  assert.equal(ca.historyText('x'), controllerHistoryText('x'), 'the server and the dashboard use the same words');
  assert.equal(decidedByLine({ state: 'approved', decidedBy: { by: 'controller', userRequest: 'merge 206', at: '' } }), 'Approved by the controller on the user\'s request: "merge 206"');
  assert.equal(decidedByLine({ state: 'approved', decidedBy: { by: 'user', at: '' } }), 'Approved by you.');
  assert.equal(decidedByLine({ state: 'denied', decidedBy: { by: 'user', at: '' } }), 'Denied by you.');
  assert.equal(decidedByLine({ state: 'approved' }), '');
});
