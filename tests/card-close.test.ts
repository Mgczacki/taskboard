// A card closes when its permit expires or its task is archived, and the task status stops waiting on the user
// (server/card-close.ts, permits.cancel). Before, a permit that a read expired kept its card pending until a restart.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-card-close-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
const { taskDir } = await import('../server/store.ts');
const permits = await import('../server/permits.ts');
const { archivedResult, cardsToCloseOnArchive, permitCardClose, statusAfterCards } = await import('../server/card-close.ts');
type Task = import('../server/store.ts').Task;
type Approval = import('../server/approvals.ts').Approval;
mkdirSync(join(root, 'work'), { recursive: true });
const freshTask = (id: string) => { mkdirSync(taskDir(id), { recursive: true }); return { id, num: 7, agent: 'codex', cwd: join(root, 'work'), folder: join(root, 'work'), worktree: false } as Task; };
after(() => rmSync(root, { recursive: true, force: true }));
const card = (state: Approval['state'], action: Approval['action'] = 'permit') => ({ id: 'c1', actor: 't', action, summary: 's', detail: '', created: '2026-10-04T00:00:00Z', state, payload: {} }) as Approval;

test('a permit that a read expired closes its pending card, with the time and "Nothing ran"', () => {
  const task = freshTask('expire-read');
  const p = permits.request(task, 'Check expiry', [{ command: 'pwd' }]);
  p.expiresAt = new Date(Date.now() - 1000).toISOString();
  // GET /api/permits/:id calls expire, as the open card does every 2 s
  assert.equal(permits.expire(p), true);
  const close = permitCardClose(p, card('pending'));
  assert.equal(close?.state, 'expired');
  assert.match(close!.result, /^The permit expired at \d{1,2}:\d{2}.*Nothing ran\.$/);
});

test('a card that is already closed or a permit that still waits does not close', () => {
  const task = freshTask('no-close');
  const p = permits.request(task, 'Still open', [{ command: 'pwd' }]);
  assert.equal(permitCardClose(p, card('pending')), undefined);
  p.state = 'expired';
  assert.equal(permitCardClose(p, card('expired')), undefined);
  assert.equal(permitCardClose(p, undefined), undefined);
  // a denied or run permit is closed by approvals.decide, not here
  p.state = 'denied';
  assert.equal(permitCardClose(p, card('pending')), undefined);
});

test('cancel ends a pending permit without running it, and the card closes with the reason', () => {
  const task = freshTask('cancel');
  const p = permits.request(task, 'Archived before a decision', [{ command: 'pwd' }, { command: 'ls' }]);
  assert.equal(permits.cancel(p, archivedResult(7)), true);
  assert.equal(p.state, 'expired');
  assert.deepEqual(p.steps.map(s => s.state), ['cancelled', 'cancelled']);
  assert.equal(permitCardClose(p, card('pending'))?.result, 'Task #7 was archived before a decision. Nothing ran.');
  // a second cancel or a cancel after a decision changes nothing
  assert.equal(permits.cancel(p, 'again'), false);
  const q = permits.request(freshTask('cancel-denied'), 'Denied first', [{ command: 'pwd' }]);
  permits.deny(q, 'no');
  assert.equal(permits.cancel(q, 'late'), false);
  assert.equal(q.state, 'denied');
});

test('an archived task closes its approval cards but not its Message cards', () => {
  const open = [card('pending', 'permit'), card('pending', 'scope'), card('pending', 'git-merge'), card('pending', 'mail-out'), card('pending', 'mail-in')];
  assert.deepEqual(cardsToCloseOnArchive(open).map(a => a.action), ['permit', 'scope', 'git-merge']);
});

test('the task stops waiting when its last card expired, was denied, or ran', () => {
  const waitingPermit = { status: 'needs-you' as const, ask: 'Approve permit 123', statusSource: 'Waiting for a permit decision on the dashboard.' };
  const expired = statusAfterCards(waitingPermit, { open: 0, last: { state: 'expired', result: 'The permit expired at 11:23 PM. Nothing ran.' } });
  assert.equal(expired?.status, 'working');
  assert.equal(expired?.ask, '');
  assert.match(expired!.statusSource!, /closed without a decision\. The permit expired at 11:23 PM/);
  const scope = { status: 'needs-you' as const, ask: 'Approve scope request ab12: read /x', statusSource: '' };
  assert.equal(statusAfterCards(scope, { open: 0, last: { state: 'expired', result: 'Taskboard restarted before you decided.' } })?.status, 'working');
  const merge = { status: 'needs-you' as const, ask: 'Approve: merge b into local master', statusSource: '' };
  assert.equal(statusAfterCards(merge, { open: 0, last: { state: 'denied' } })?.statusSource, 'Your decision was sent back to the task.');
  assert.equal(statusAfterCards({ ...merge, ask: 'Approve push main' }, { open: 0, last: { state: 'approved' } })?.status, 'working');
});

test('the task keeps waiting while a card is open, and a status that is not about a card stays', () => {
  const waiting = { status: 'needs-you' as const, ask: 'Approve permit 123', statusSource: '' };
  assert.equal(statusAfterCards(waiting, { open: 1 }), undefined);
  // a question card from the agent has its own ask
  assert.equal(statusAfterCards({ status: 'needs-you', ask: 'Approve the plan?', statusSource: '' }, { open: 0, last: { state: 'expired' } }), undefined);
  assert.equal(statusAfterCards({ status: 'working', ask: '', statusSource: '' }, { open: 0, last: { state: 'expired' } }), undefined);
  // a denied refused command: unread, as before
  assert.equal(statusAfterCards({ status: 'needs-you', ask: 'Refused: x', statusSource: 'Claude auto mode refused the command.' }, { open: 0, refusalDenied: true })?.status, 'unread');
});
