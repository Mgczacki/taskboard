import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_TYPES, readPermissionAutoApprove, checkPermissionPatch, permissionEnabled, permissionType } from '../shared/permission-policy.ts';
import { decidedByLine } from '../web/src/approvalHistory.ts';
import type { Approval } from '../server/approvals.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-permission-policy-'));
process.env.TASKBOARD_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const machine = await import('../server/machine.ts');
const approvals = await import('../server/approvals.ts');
const urgent = await import('../server/urgent.ts');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (action: Approval['action'], summary: string, run = async () => 'done', payload: unknown = {}) => approvals.request({ action, actor: 't1', summary, detail: summary, payload }, run);
const audit = () => readFileSync(join(root, 'approval-decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('every type defaults to manual', () => {
  assert.equal(PERMISSION_TYPES.length, 20);
  assert.ok(Object.values(machine.get().permissionAutoApprove).every(value => value === false));
  for (const saved of [undefined, null, [], 'true', { permit: 'true', new: 1, release: 'yes', rollback: true }])
    assert.ok(Object.values(readPermissionAutoApprove(saved)).every(value => value === false));
});

test('settings validate all fields before mutation and save only the selected types', () => {
  for (const patch of [null, [], true, { missing: true }, { permit: 'true' }, { permit: true, rollback: true }, { 'tool-refusal': true }, { 'pending:choice': true }]) {
    assert.throws(() => machine.update({ permissionAutoApprove: patch as any }));
    assert.equal(machine.get().permissionAutoApprove.permit, false);
  }
  for (const row of PERMISSION_TYPES) assert.doesNotThrow(() => checkPermissionPatch({ [row.id]: true }), row.id);
  machine.update({ permissionAutoApprove: { new: true } });
  assert.equal(machine.get().permissionAutoApprove.new, true);
  const saved = JSON.parse(readFileSync(join(root, 'machine.json'), 'utf8'));
  assert.equal(readPermissionAutoApprove(saved.permissionAutoApprove).new, true);
  assert.equal(readPermissionAutoApprove(saved.permissionAutoApprove).permit, false);
  machine.update({ permissionAutoApprove: { new: false } });
});

test('new cards use their own switch and log the type, task and card', async () => {
  const settings = readPermissionAutoApprove({ new: true, send: true, permit: true, 'git-push': true, scope: true, 'mail-out': true });
  approvals.setAutoApprover(card => permissionEnabled(settings, permissionType(card)) ? 'permissions' : undefined);
  let runs = 0;
  for (const action of ['new', 'send', 'permit', 'git-push', 'scope', 'mail-out'] as const) {
    const card = request(action, action, async () => { runs++; return 'done'; });
    assert.equal(card.state, 'pending', 'the caller finishes before the action starts');
    await tick();
    assert.equal(card.state, 'approved');
    assert.equal(card.decidedBy?.by, 'permissions');
    assert.match(decidedByLine(card), /Auto-approved through Settings > Permissions/);
    assert.equal(audit().filter(row => row.card === card.id && row.permissionType === action && row.actor === 't1' && row.by === 'permissions').length, 1);
  }
  assert.equal(runs, 6);
  assert.equal(request('external', 'manual external').state, 'pending');
  await tick();
  assert.equal(runs, 6);
});

test('old cards, updated requests, and reopened cards stay pending', async () => {
  let on = false;
  approvals.setAutoApprover(() => on ? 'permissions' : undefined);
  let runs = 0;
  const run = async () => { runs++; return 'done'; };
  const card = request('new', 'old', run);
  on = true;
  await tick();
  assert.equal(card.state, 'pending');
  assert.equal(request('new', 'old', run).id, card.id);
  await tick();
  assert.equal(card.state, 'pending');
  await approvals.decide(card.id, false);
  approvals.undo(card.id);
  await tick();
  assert.equal(card.state, 'pending');
  const changed = request('send', 'updated', run);
  request('send', 'updated', async () => { runs++; return 'different runner'; });
  await tick();
  assert.equal(changed.state, 'pending');
  assert.equal(runs, 0);
});

test('switching off before dispatch or during validation prevents execution', async () => {
  let on = true;
  approvals.setAutoApprover(() => on ? 'permissions' : undefined);
  let runs = 0;
  const card = request('permit', 'disable before dispatch', async () => { runs++; return 'done'; });
  on = false;
  await tick();
  assert.equal(card.state, 'pending');
  on = true;
  let finish!: (value: undefined) => void;
  const check = new Promise<undefined>(resolve => { finish = resolve; });
  const waiting = approvals.request({ actor: 't1', action: 'permit', summary: 'disable during check', detail: '', payload: {} }, async () => { runs++; return 'done'; }, { check: () => check });
  await tick();
  on = false;
  finish(undefined);
  await tick();
  assert.equal(waiting.state, 'pending');
  assert.equal(runs, 0);
});

test('concurrent manual and automatic decisions run the action once', async () => {
  approvals.setAutoApprover(() => 'permissions');
  let runs = 0;
  let finish!: (value: undefined) => void;
  const check = new Promise<undefined>(resolve => { finish = resolve; });
  const card = approvals.request({ actor: 't1', action: 'permit', summary: 'concurrent', detail: '', payload: {} }, async () => { runs++; return 'done'; }, { check: () => check });
  await tick();
  const manual = approvals.decide(card.id, true);
  finish(undefined);
  await manual;
  await tick();
  assert.equal(runs, 1);
  assert.equal(card.state, 'approved');
});

test('denials and changed facts prevent scheduled execution', async () => {
  approvals.setAutoApprover(() => 'permissions');
  let runs = 0;
  const run = async () => { runs++; return 'done'; };
  const denied = request('permit', 'deny first', run);
  await approvals.decide(denied.id, false);
  const stale = approvals.request({ actor: 't1', action: 'git-push', summary: 'changed head', detail: '', payload: {} }, run, { check: async () => 'The head moved.' });
  await tick();
  assert.equal(stale.state, 'pending');
  assert.equal(stale.staleFacts, 'The head moved.');
  assert.equal(denied.state, 'denied');
  assert.equal(runs, 0);
});

test('types that were always manual can be auto-approved through Permissions, but not through urgent mode', async () => {
  let runs = 0;
  const settings = readPermissionAutoApprove({ 'github-pr': true, 'github-pr-merge': true, release: true, restart: true, plan: true, forcePush: true });
  approvals.setAutoApprover(card => permissionEnabled(settings, permissionType(card)) ? 'permissions' : undefined);
  for (const action of ['github-pr', 'github-pr-merge', 'release', 'restart', 'plan'] as const) {
    const card = request(action, `on-${action}`, async () => { runs++; return 'done'; });
    await tick();
    assert.equal(card.state, 'approved', action);
  }
  const force = request('git-push', 'on-force', async () => { runs++; return 'done'; }, { state: { forcePush: true } });
  await tick();
  assert.equal(force.state, 'approved');
  assert.equal(runs, 6);
  urgent.turnOn({ id: 't1', num: 1 }, 'user', 'test');
  for (const action of ['github-pr', 'github-pr-merge', 'release', 'restart', 'plan'] as const)
    assert.equal(urgent.autoApprove({ id: action, actor: 't1', action, summary: action }), false, action);
  assert.equal(urgent.autoApprove({ id: 'force', actor: 't1', action: 'git-push', summary: 'force', payload: { state: { forcePush: true } } }), false);
  urgent.turnOff({ id: 't1', num: 1 }, 'user');
});

test('cards with no automatic decision stay manual even when an automatic policy returns true', async () => {
  let runs = 0;
  for (const by of ['permissions', 'urgent'] as const) {
    approvals.setAutoApprover(() => by);
    const card = request('tool-refusal', `${by}-refusal`, async () => { runs++; return 'bad'; });
    await tick();
    await approvals.decide(card.id, true, { by });
    assert.equal(card.state, 'pending');
  }
  assert.equal(runs, 0);
  for (const stage of ['checking', 'held']) {
    const mail = request('mail-out', stage, async () => { runs++; return 'bad'; }, { stage });
    await tick();
    assert.equal(mail.state, 'pending');
  }
  const archive = request('kill', 'manager archive', async () => { runs++; return 'bad'; }, { managerArchive: true });
  await tick();
  assert.equal(archive.state, 'pending');
  assert.equal(runs, 0);
  assert.equal(permissionEnabled(readPermissionAutoApprove({ unknown: true }), 'unknown'), false);
});
