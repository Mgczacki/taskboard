import { test } from 'node:test';
import type { Status, WaitingOn } from '../server/store.ts';
import type { Approval, Runner } from '../server/approvals.ts';
import type { Kind } from '../server/manager-delegation.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestResources } from './helpers/test-resources.ts';

const resources = new TestResources();
const root = mkdtempSync(join(tmpdir(), 'tb-manager-delegation-'));
mkdirSync(join(root, 'workspace'));
const workspace = realpathSync(join(root, 'workspace'));
process.env.TASKBOARD_DIR = join(root, 'private');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = resources.socket(`tb-delegation-${process.pid}`);
const store = await import('../server/store.ts');
const groups = await import('../server/groups.ts');
const roles = await import('../server/manager-role.ts');
const approvals = await import('../server/approvals.ts');
const delegation = await import('../server/manager-delegation.ts');
const checkins = await import('../server/manager-checkins.ts');
const messages = await import('../server/message-queue.ts');
const board = await import('../server/waiting-board.ts');
const permits = await import('../server/permits.ts');

let sequence = 0;
function fixture() {
  const n = ++sequence;
  const task = (name: string, status: Status = 'idle') => store.create({
    id: `${name}-${n}`, num: n * 10 + (name === 'manager' ? 1 : name === 'worker' ? 2 : 3), title: name,
    agent: 'codex', status, cwd: workspace, folder: workspace, session: `unused-${name}-${n}`, desc: '',
  });
  const manager = task('manager', 'parked'), worker = task('worker'), outside = task('outside');
  const group = groups.create(`Group ${n}`, [manager.id, worker.id]);
  groups.update(group.id, { manager: manager.id });
  const enable = (kinds: Kind[], dangerous: string[] = []) => delegation.configure(group, { enabled: true, kinds, dangerous }, true);
  const card = (action: Approval['action'] = 'scope', more: Partial<Approval> = {}, run: Runner = async () => 'done', check?: () => Promise<string | undefined>) =>
    approvals.request({ actor: worker.id, action, summary: `${action} ${n}`, detail: '', payload: {}, ...more }, run, { check });
  return { manager, worker, outside, group, enable, card };
}
const input = (a: Approval) => ({ version: delegation.versionOf(a), head: delegation.cardHead(a)?.head, reason: 'Checked the task and card facts.', approve: true });

test('delegation defaults off and only selected kinds run', async () => {
  const f = fixture(); let ran = 0;
  const a = f.card('scope', {}, async d => { ran++; assert.equal(d.by, 'manager'); return 'done'; });
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, input(a)), /off/);
  f.enable(['git-merge']);
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, input(a)), /off/);
  f.enable(['scope']);
  assert.equal((await delegation.decide(f.manager.id, f.group.id, a, input(a)))?.state, 'approved');
  assert.equal(ran, 1);
  const rows = delegation.auditRows(f.group.id);
  assert.deepEqual(rows.map(r => r.state), ['requested', 'approved']);
  assert.equal(rows[0].manager, f.manager.id);
  assert.equal(rows[0].card, a.id);
  assert.equal(rows[0].task, f.worker.id);
  assert.equal(rows[0].kind, 'scope');
  assert.equal(rows[0].decision, 'approve');
  assert.ok(rows[0].at && rows[0].reason);
  assert.equal(rows[0].head, null);
});

test('manager decisions refuse self cards, another group, ordinary tasks and the controller', async () => {
  const f = fixture(); f.enable(['scope']);
  const a = f.card();
  for (const actor of [f.worker.id, 'controller']) await assert.rejects(delegation.decide(actor, f.group.id, a, input(a)), /manager/);
  const own = f.card('scope', { actor: f.manager.id });
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, own, input(own)), /own task/);
  const outside = f.card('scope', { actor: f.outside.id });
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, outside, input(outside)), /outside/);
  await assert.rejects(delegation.decide(f.manager.id, 'missing', a, input(a)), /manager/);
});

test('a card owned by a group task cannot affect another group or the manager', () => {
  const f = fixture(); f.enable(['send', 'status', 'new']);
  for (const target of [f.outside.id, f.manager.id]) {
    const a = f.card('send', { affectedTasks: [target] });
    assert.throws(() => delegation.check(f.manager.id, f.group.id, a), /outside|own task/);
  }
  const old = f.card('status');
  assert.throws(() => delegation.check(f.manager.id, f.group.id, old), /affected tasks/);
  const child = f.card('new', { payload: { group: 'Other' } });
  assert.throws(() => delegation.check(f.manager.id, f.group.id, child), /this group/);
});

test('every dangerous kind requires a separate warning acceptance and switch', async () => {
  const f = fixture();
  for (const kind of ['force-push', 'release', 'restart', 'github-pr', 'github-pr-merge', 'tool-refusal'] as const) {
    const a = kind === 'force-push' ? f.card('git-push', { payload: { state: { forcePush: true } } }) : f.card(kind);
    f.enable([kind]);
    assert.throws(() => delegation.check(f.manager.id, f.group.id, a), /dangerous switch/);
    assert.throws(() => delegation.configure(f.group, { enabled: true, kinds: [kind], dangerous: [kind] }), /warnings/);
    f.enable([kind], [kind]);
    assert.equal(delegation.check(f.manager.id, f.group.id, a).id, f.group.id);
  }
  assert.throws(() => delegation.configure(f.group, { enabled: true, kinds: ['unknown'], dangerous: [] }), /known/);
});

test('high-risk permits need the separate production-write switch', () => {
  const f = fixture(); f.enable(['permit']);
  const p = permits.request(f.worker, 'Read the folder', [{ command: 'pwd', cwd: workspace }]);
  const a = f.card('permit', { payload: { permitId: p.id } });
  assert.equal(delegation.check(f.manager.id, f.group.id, a).id, f.group.id);
  p.steps[0].network = true;
  assert.throws(() => delegation.check(f.manager.id, f.group.id, a), /production-write/);
  f.enable(['permit'], ['production-write']);
  assert.equal(delegation.check(f.manager.id, f.group.id, a).id, f.group.id);
});

test('plan decisions require child delegation and include child versions', () => {
  const f = fixture(); f.enable(['plan']);
  const child = f.card();
  const plan = f.card('plan', { payload: { steps: [{ card: child.id }] } });
  assert.throws(() => delegation.check(f.manager.id, f.group.id, plan), /off/);
  f.enable(['scope', 'plan']);
  assert.equal(delegation.check(f.manager.id, f.group.id, plan).id, f.group.id);
  const version = delegation.versionOf(plan);
  child.detail = 'Changed scope';
  assert.notEqual(delegation.versionOf(plan), version);
  child.actor = f.outside.id;
  assert.throws(() => delegation.check(f.manager.id, f.group.id, plan), /outside/);
  const cycle = f.card('plan', { payload: { steps: [{ card: plan.id }] } });
  plan.payload = { steps: [{ card: cycle.id }] };
  assert.throws(() => delegation.versionOf(plan), /cycle/);
});

test('revocation or membership changes during a card check prevent the runner', async () => {
  for (const change of ['group', 'all', 'membership', 'manager', 'version']) {
    const f = fixture(); f.enable(['scope']); let ran = 0, checks = 0;
    const a = f.card('scope', {}, async () => { ran++; return 'done'; }, async () => {
      // The second check runs inside approvals.decide, after the first audit row.
      if (++checks === 2) {
        if (change === 'group') delegation.revoke(f.group.id);
        if (change === 'all') delegation.revoke();
        if (change === 'membership') groups.update(f.group.id, { tasks: [f.manager.id] });
        if (change === 'manager') groups.update(f.group.id, { manager: undefined });
        if (change === 'version') a.detail = 'Changed while checking';
      }
      return undefined;
    });
    await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, input(a)), /off|outside|manager|changed/);
    assert.equal(ran, 0);
    assert.equal(a.state, 'pending');
  }
});

test('versions, branch heads, expiry and changed facts prevent execution', async () => {
  const f = fixture(); f.enable(['git-merge']); let ran = 0;
  const head = 'a'.repeat(40);
  const a = f.card('git-merge', { payload: { source: head, target: 'b'.repeat(40), branch: 'task/test' } }, async () => { ran++; return 'done'; });
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, { ...input(a), version: 'wrong' }), /changed/);
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, { ...input(a), head: 'b'.repeat(40) }), /branch head/);
  a.validUntil = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, input(a)), /expired/);
  a.validUntil = undefined;
  assert.equal((await delegation.decide(f.manager.id, f.group.id, a, input(a)))?.state, 'approved');
  assert.equal(delegation.auditRows(f.group.id)[0].head, head);
  assert.equal(ran, 1);
  f.enable(['scope']);
  const stale = f.card('scope', {}, async () => { ran++; return 'bad'; }, async () => 'The facts changed.');
  await assert.rejects(delegation.decide(f.manager.id, f.group.id, stale, input(stale)), /facts changed/);
  assert.equal(ran, 1);
});

test('refused tool calls can be dismissed and never execute their runner', async () => {
  const f = fixture(); f.enable(['tool-refusal'], ['tool-refusal']); let ran = false;
  const a = f.card('tool-refusal', {}, async () => { ran = true; return 'bad'; });
  assert.equal((await delegation.decide(f.manager.id, f.group.id, a, input(a)))?.state, 'dismissed');
  assert.equal(ran, false);
  assert.equal(a.decidedBy?.by, 'manager');
  assert.equal(delegation.auditRows(f.group.id)[0].decision, 'dismiss');
});

test('a denial can close a stale card without running it or requiring a branch head', async () => {
  const f = fixture(); f.enable(['git-merge']); let ran = false;
  const a = f.card('git-merge', { payload: { source: 'a'.repeat(40), target: 'b'.repeat(40) } }, async () => { ran = true; return 'bad'; }, async () => 'The branch moved.');
  const result = await delegation.decide(f.manager.id, f.group.id, a, { ...input(a), head: undefined, approve: false });
  assert.equal(result?.state, 'denied');
  assert.equal(ran, false);
  assert.match(result?.result || '', /Denied by manager/);
  assert.equal(delegation.auditRows(f.group.id)[0].decision, 'deny');
});

test('concurrent manager decisions run a card once', async () => {
  const f = fixture(); f.enable(['scope']); let ran = 0;
  const a = f.card('scope', {}, async () => { ran++; return 'done'; });
  const results = await Promise.allSettled([
    delegation.decide(f.manager.id, f.group.id, a, input(a)),
    delegation.decide(f.manager.id, f.group.id, a, input(a)),
  ]);
  assert.equal(ran, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('archive through either card kind refuses work without an explicit final result', () => {
  const f = fixture(); f.enable(['status', 'kill']);
  for (const action of ['status', 'kill'] as const) {
    const a = f.card(action, { payload: { status: 'archived' }, affectedTasks: [f.worker.id] });
    assert.throws(() => delegation.check(f.manager.id, f.group.id, a), /final result/);
  }
});

test('a manager can deny an unfinished archive request without running it', async () => {
  const f = fixture(); f.enable(['kill']); let ran = false;
  const a = f.card('kill', { affectedTasks: [f.worker.id] }, async () => { ran = true; return 'bad'; });
  const result = await delegation.decide(f.manager.id, f.group.id, a, { ...input(a), approve: false });
  assert.equal(result?.state, 'denied');
  assert.equal(ran, false);
  assert.notEqual(f.worker.status, 'archived');
});

test('audit failure prevents a decision from starting', async () => {
  const f = fixture(); f.enable(['scope']); let ran = false;
  const a = f.card('scope', {}, async () => { ran = true; return 'bad'; });
  const file = join(root, 'private', 'manager-decisions.jsonl'), saved = file + '.saved';
  renameSync(file, saved); mkdirSync(file);
  try { await assert.rejects(delegation.decide(f.manager.id, f.group.id, a, input(a)), /directory|EISDIR/); }
  finally { rmSync(file, { recursive: true }); renameSync(saved, file); }
  assert.equal(ran, false); assert.equal(a.state, 'pending');
});

test('settings persist, and a replacement manager does not inherit delegation', () => {
  const f = fixture(); f.enable(['scope']);
  assert.match(readFileSync(join(root, 'vault', 'groups', f.group.id + '.md'), 'utf8'), /delegation:/);
  roles.set(f.group, f.worker, 'user');
  assert.equal(delegation.settings(f.group).enabled, false);
});

test('state rule and archive checks require explicit completion without outstanding work', () => {
  const f = fixture();
  assert.match(checkins.violation(f.worker)!, /No named wait/);
  assert.throws(() => checkins.canArchive(f.worker), /final result/);
  store.update(f.worker.id, { status: 'working' });
  assert.equal(checkins.violation(f.worker), undefined);
  assert.match(checkins.violation(f.worker, undefined, Date.now() + checkins.SILENCE_MS)!, /No named wait/);
  const wait: WaitingOn = { on: 'task', target: f.outside.id, reason: 'Read the result', needs: 'Final result', since: new Date().toISOString(), card: '', unblocks: [], source: 'reported' };
  assert.equal(checkins.violation(f.worker, wait), undefined);
  store.update(f.worker.id, { status: 'idle', completion: { at: new Date().toISOString(), result: 'Finished the requested work.' } });
  checkins.canArchive(f.worker);
  assert.throws(() => checkins.canArchive(f.worker, wait), /named wait/);
  const row = Object.values(board.board(f.group).columns).flat().find((r: any) => r.id === f.worker.id) as any;
  assert.match(row.violation, /Archive/);
  const ungrouped = board.allBoards().find(b => b.group.id === '__ungrouped__');
  assert.ok(ungrouped);
  assert.ok(Object.values(ungrouped.columns).flat().some((r: any) => r.id === f.outside.id && r.violation));
  store.update(f.worker.id, { status: 'working' });
  assert.equal(f.worker.completion, undefined);
  assert.throws(() => checkins.canArchive(f.worker), /final result/);
});

test('communication includes log edits, messages, state and outbox results', async () => {
  const f = fixture();
  const before = checkins.lastCommunication(f.worker);
  const future = new Date(before + 60000);
  utimesSync(store.logFile(f.worker.id), future, future);
  assert.equal(checkins.lastCommunication(f.worker), future.getTime());
  const outbox = join(store.taskDir(f.worker.id), 'outbox'); mkdirSync(outbox);
  writeFileSync(join(outbox, 'result.md'), 'Final result');
  const resultTime = new Date(future.getTime() + 60000);
  utimesSync(join(outbox, 'result.md'), resultTime, resultTime);
  assert.equal(checkins.lastCommunication(f.worker), resultTime.getTime());
  const old = new Date(Date.now() - 3600000).toISOString();
  store.update(f.worker.id, { status: 'parked', communicationAt: old });
  await messages.send(f.worker, 'Please report status.', { from: f.manager.id, kind: 'message', holdWhenParked: true });
  assert.ok(Date.parse(f.worker.communicationAt!) > Date.parse(old));
  assert.ok(Date.parse(f.manager.communicationAt!) > Date.parse(old));
});

test('check-ins keep one pending notice and do not count as task communication', async () => {
  const f = fixture();
  // Other fixtures remain active. All managers are parked, so no external agent starts.
  const last = checkins.lastCommunication(f.worker);
  const count = () => messages.list(f.manager.id).filter(m => m.text.startsWith('[Taskboard check-in') && m.text.includes(`task #${f.worker.num}]`)).length;
  await checkins.checkIns(last + checkins.SILENCE_MS - 1);
  assert.equal(count(), 0);
  await checkins.checkIns(last + checkins.SILENCE_MS);
  assert.equal(count(), 1);
  assert.equal(checkins.lastCommunication(f.worker), last);
  await checkins.checkIns(last + checkins.SILENCE_MS * 2 - 1);
  assert.equal(count(), 1);
  await checkins.checkIns(last + checkins.SILENCE_MS * 2);
  assert.equal(count(), 1);
  assert.match(messages.list(f.manager.id).find(m => m.text.includes(`task #${f.worker.num}]`))!.text, /Task log.*never approval/);
  store.update(f.worker.id, { status: 'archived' });
  await checkins.checkIns(last + checkins.SILENCE_MS * 3);
  assert.equal(count(), 1);
});

test('check-ins do not repeat while the worker waits for the user', async () => {
  const f = fixture();
  store.update(f.worker.id, { status: 'needs-you', ask: 'Approve the report' });
  const last = checkins.lastCommunication(f.worker);
  await checkins.checkIns(last + checkins.SILENCE_MS * 2);
  assert.equal(messages.list(f.manager.id).filter(m => m.text.startsWith('[Taskboard check-in') && m.text.includes(`task #${f.worker.num}]`)).length, 0);
});
