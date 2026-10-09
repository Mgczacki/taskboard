// A pending permit whose approval card closed without it blocks the task's next request (permits.request refuses a
// second pending permit). A restart did this: approvals.ts marked the pending card expired, but the permit stayed
// pending with no expiresAt. permits.closeOrphans expires such a permit at startup, and permits.withdraw lets the task
// cancel its own pending permit.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-permit-orphans-'));
const tbdir = join(root, 'tbdir');
process.env.TASKBOARD_DIR = tbdir;
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
mkdirSync(join(root, 'work'), { recursive: true });
mkdirSync(join(tbdir, 'permits'), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

// The saved state before the restart, as task #216 had it: a pending permit without expiresAt and its pending card.
const ORPHAN = 'b9e727db-4ab4-4df2-9e37-fa48d61b716f';
const KEPT = 'c0ffee00-0000-4000-8000-000000000001';
const step = { command: 'gh run cancel 1', argv: ['gh', 'run', 'cancel', '1'], cwd: join(root, 'work'), timeoutSeconds: 30, network: true, state: 'pending' };
const permit = (id: string, taskId: string, approvalId?: string) => ({ id, taskId, taskNum: 216, agent: 'claude', reason: 'Cancel a run', ...(approvalId ? { approvalId } : {}),
  createdAt: '2026-10-09T10:00:00.000Z', expiresAt: '', state: 'pending', stepHash: 'x', riskFlags: [], steps: [{ ...step }] });
writeFileSync(join(tbdir, 'permits', `${ORPHAN}.json`), JSON.stringify(permit(ORPHAN, 't216', '3be77196')));
writeFileSync(join(tbdir, 'permits', `${KEPT}.json`), JSON.stringify(permit(KEPT, 't217')));
writeFileSync(join(tbdir, 'approvals.json'), JSON.stringify([
  { id: '3be77196', actor: 't216', action: 'permit', summary: 'run 1 approved step', detail: '', created: '2026-10-09T10:00:00.000Z', state: 'pending', payload: { permitId: ORPHAN } },
]));

const { taskDir } = await import('../server/store.ts');
const approvals = await import('../server/approvals.ts');
const permits = await import('../server/permits.ts');
const { permitCardClose } = await import('../server/card-close.ts');
type Task = import('../server/store.ts').Task;
const freshTask = (id: string, num = 216) => { mkdirSync(taskDir(id), { recursive: true }); return { id, num, agent: 'claude', cwd: join(root, 'work'), folder: join(root, 'work'), worktree: false } as Task; };
const saved = (id: string) => JSON.parse(readFileSync(join(tbdir, 'permits', `${id}.json`), 'utf8'));
// the card of a permit as index.ts createPermit makes it, with a runner that must never run here
const cardFor = (p: import('../server/permits.ts').Permit) => {
  const card = approvals.request({ actor: p.taskId, action: 'permit', summary: 'run 1 approved step', detail: '', payload: { permitId: p.id } },
    async () => { throw new Error('The test card must not run.'); });
  permits.attachApproval(p, card.id);
  return card;
};

test('after a restart, a pending permit whose card expired is expired with the reason and its steps cancelled', () => {
  assert.equal(approvals.get('3be77196')?.state, 'expired');
  permits.load();
  assert.equal(permits.get(ORPHAN)?.state, 'pending');
  const closed = permits.closeOrphans(approvals.get);
  const p = permits.get(ORPHAN)!;
  assert.ok(closed.some(x => x.id === ORPHAN));
  assert.equal(p.state, 'expired');
  assert.deepEqual(p.steps.map(s => s.state), ['cancelled']);
  assert.equal(p.steps[0].exitCode, undefined);
  assert.match(p.error!, /approval card 3be77196 closed without a decision on the permit \(expired: Taskboard restarted before you decided/);
  assert.match(permits.notice(p), /expired\. Reason: Its approval card 3be77196/);
  assert.equal(saved(ORPHAN).state, 'expired');
  // the task can ask again
  const next = permits.request(freshTask('t216'), 'Ask again', [{ command: 'pwd' }]);
  assert.equal(next.state, 'pending');
  permits.deny(next, 'test');
});

test('a pending permit without any approval card is expired too', () => {
  const p = permits.get(KEPT)!;
  assert.equal(p.state, 'expired');
  assert.match(p.error!, /has no approval card/);
});

test('a permit with a pending or running card and a running permit stay as they are', () => {
  const task = freshTask('t-open', 300);
  const waiting = permits.request(task, 'Wait for the user', [{ command: 'pwd' }]);
  const card = cardFor(waiting);
  assert.deepEqual(permits.closeOrphans(approvals.get).map(x => x.id), []);
  assert.equal(waiting.state, 'pending');
  assert.equal(approvals.get(card.id)?.state, 'pending');
  // the card started its permit: the controller path marks the card running before permits.run
  assert.equal(approvals.startExternal(card.id), true);
  permits.closeOrphans(approvals.get);
  assert.equal(waiting.state, 'pending');
  // a running permit is never changed, even when its card has closed
  waiting.state = 'running';
  approvals.finishExternal(card.id, 'failed', 'test');
  assert.deepEqual(permits.closeOrphans(approvals.get).map(x => x.id), []);
  assert.equal(waiting.state, 'running');
  waiting.state = 'failed';
});

test('a card that closes while the server runs releases its permit on the next check', () => {
  const task = freshTask('t-runtime', 301);
  const p = permits.request(task, 'Card closes', [{ command: 'pwd' }]);
  const card = cardFor(p);
  approvals.close(card.id, 'expired', 'Closed elsewhere.');
  assert.deepEqual(permits.closeOrphans(approvals.get).map(x => x.id), [p.id]);
  assert.match(p.error!, /\(expired: Closed elsewhere\.\)/);
  assert.equal(permits.request(task, 'Again', [{ command: 'pwd' }]).state, 'pending');
});

test('a task withdraws its own pending permit: nothing runs, the card closes with the reason, and it can ask again', () => {
  const task = freshTask('t-withdraw', 302);
  const p = permits.request(task, 'Withdraw me', [{ command: 'pwd' }]);
  const card = cardFor(p);
  assert.throws(() => permits.withdraw(p, 'someone-else', ''), /only its own permit/);
  assert.equal(p.state, 'pending');
  permits.withdraw(p, task.id, 'The run finished on its own.');
  assert.equal(p.state, 'cancelled');
  assert.ok(p.withdrawnAt);
  assert.deepEqual(p.steps.map(s => s.state), ['cancelled']);
  assert.equal(p.error, 'Task #302 withdrew this permit before a decision: The run finished on its own.');
  const close = permitCardClose(p, approvals.get(card.id));
  assert.deepEqual(close, { state: 'expired', result: 'Task #302 withdrew this permit before a decision: The run finished on its own. Nothing ran.' });
  approvals.close(card.id, close!.state, close!.result);
  assert.equal(approvals.get(card.id)?.state, 'expired');
  assert.throws(() => permits.withdraw(p, task.id, ''), /is cancelled\. Only a pending permit can be withdrawn/);
  assert.equal(permits.request(task, 'Again', [{ command: 'pwd' }]).state, 'pending');
});

test('a cancelled permit that the task did not withdraw does not close a card', () => {
  assert.equal(permitCardClose({ state: 'cancelled', expiresAt: '', error: 'stopped' }, { state: 'pending' }), undefined);
});
