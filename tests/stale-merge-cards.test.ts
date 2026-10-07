// A merge card whose branch head or master head moved after the card was made (task 390).
// Observed in task 381: the card showed branch 5ec09a37 over master 9d2a173a, master moved to 5f527b2b, Approve ran
// nothing, Deny was the only action that closed the card, and the task read the denial as a rejection of its work.
// Covers, without a server:
//   - the facts for a moved master, a moved branch and both (server/merge-stale.ts)
//   - recheck: the card gets the facts without a click on Approve, and loses them when it matches again
//   - Approve on a stale card runs nothing
//   - refresh: the card closes in state stale (not denied), keeps its old heads and the facts, the listeners are told
//     once, a second refresh changes nothing, and the audit file gets a line
//   - a denial is still a denial
//   - a new request after a refresh makes a new card that needs its own approval
//   - the task status after a refresh (server/card-close.ts) and the words on the dashboard (web/src/staleCard.ts)
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-stale-merge-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
mkdirSync(join(root, 'tbdir'), { recursive: true });
const approvals = await import('../server/approvals.ts');
const mergeStale = await import('../server/merge-stale.ts');
const { statusAfterCards } = await import('../server/card-close.ts');
const { deliveryText, isStaleMerge, REFRESH_LABEL, STALE_HELP } = await import('../web/src/staleCard.ts');
const { decidedByLine } = await import('../web/src/approvalHistory.ts');
const { needAction } = await import('../web/src/managerBoard.ts');
after(() => rmSync(root, { recursive: true, force: true }));

// the heads of task 381
const BRANCH = '5ec09a37' + 'a'.repeat(32), MASTER = '9d2a173a' + 'b'.repeat(32), MASTER2 = '5f527b2b' + 'c'.repeat(32), BRANCH2 = '77aa11bb' + 'd'.repeat(32);
type Heads = { source: string; target: string; branch: string };
// A merge card over heads that the test can move. merged counts the runs of the merge.
function mergeCard(actor: string) {
  const expected: Heads = { source: BRANCH, target: MASTER, branch: `task/${actor}` };
  const now: Heads = { ...expected };
  const s = { now, merged: 0, card: undefined as unknown as ReturnType<typeof approvals.request> };
  const ask = (heads: Heads) => approvals.request({ actor, action: 'git-merge', summary: `merge ${heads.branch} into local master`, detail: `Branch head: ${heads.source}\nMaster head: ${heads.target}`, payload: heads },
    async () => { s.merged++; return 'Merged.'; }, { check: async () => mergeStale.staleFacts(heads, s.now) });
  s.card = ask(expected);
  return { ...s, state: s, ask };
}
const origin = (target: string) => approvals.cleanOrigin({ from: 'waiting', target, shownMs: 20_000 });
const only = (id: string) => (a: { id: string }) => a.id === id;

test('the facts say which head moved, with the old and the new head', () => {
  const card = { source: BRANCH, target: MASTER, branch: 'task/x' };
  assert.equal(mergeStale.staleFacts(card, { ...card }), undefined);
  const master = mergeStale.staleFacts(card, { ...card, target: MASTER2 })!;
  assert.match(master, /^Local master moved after this card was made\. The card shows master 9d2a173a\. Master is now 5f527b2b\. The branch head did not change \(5ec09a37\)\.$/);
  const branch = mergeStale.staleFacts(card, { ...card, source: BRANCH2 })!;
  assert.match(branch, /^The task branch moved after this card was made\. The card shows branch head 5ec09a37\. The branch head is now 77aa11bb\. Master did not change \(9d2a173a\)\.$/);
  const both = mergeStale.staleFacts(card, { ...card, source: BRANCH2, target: MASTER2 })!;
  assert.match(both, /Local master and the task branch moved/); assert.match(both, /5f527b2b/); assert.match(both, /77aa11bb/);
  const text = mergeStale.refreshResult(master);
  assert.match(text, /This is not a denial\. The user did not reject the branch\. Nothing was merged\./);
  assert.match(text, /Run tb git rebase, or inspect the change if you must\. Then run tb git merge-request\./);
  assert.match(text, /The user must approve that new card\./);
  assert.match(mergeStale.refreshResult(master, 'docs'), /tb git rebase --worktree docs,.*tb git merge-request --worktree docs\./);
});

test('stale master: the card gets the facts without a click, Approve merges nothing, and the facts go when master is back', async () => {
  const m = mergeCard('t-master');
  assert.deepEqual(await approvals.recheck(only(m.card.id)), [], 'a card that matches does not change');
  assert.equal(m.card.staleFacts, undefined); assert.equal(m.card.updated, undefined);
  m.now.target = MASTER2;
  const changed = await approvals.recheck(only(m.card.id));
  assert.deepEqual(changed.map(c => c.id), [m.card.id]);
  assert.match(m.card.staleFacts!, /Local master moved.*9d2a173a.*5f527b2b/);
  assert.equal(m.card.state, 'pending');
  assert.ok(m.card.updated, 'the dashboard shows the changed card as an arrival');
  assert.deepEqual(await approvals.recheck(only(m.card.id)), [], 'the same facts do not change the card again');
  const approved = (await approvals.decide(m.card.id, true, { by: 'user' }, origin('approve')))!;
  assert.equal(approved.state, 'pending'); assert.equal(m.state.merged, 0);
  m.now.target = MASTER;
  assert.equal((await approvals.recheck(only(m.card.id))).length, 1);
  assert.equal(m.card.staleFacts, undefined);
  await assert.rejects(approvals.refresh(m.card.id, origin('refresh')), /matches the branch and master now/);
  assert.equal(m.card.state, 'pending', 'a card that matches is not closed');
  assert.equal((await approvals.decide(m.card.id, true, { by: 'user' }, origin('approve')))!.state, 'approved');
  assert.equal(m.state.merged, 1);
});

test('refresh closes a stale card as stale, not denied, keeps the record, and tells the listeners once', async () => {
  const told: { id: string; state: string }[] = [];
  approvals.onDecision(c => { if (c.actor === 't-refresh') told.push({ id: c.id, state: c.state }); });
  const m = mergeCard('t-refresh');
  const detail = m.card.detail, version = m.card.version;
  m.now.target = MASTER2;
  // no recheck and no click on Approve before: refresh runs the check itself
  const x = (await approvals.refresh(m.card.id, origin('refresh'), facts => mergeStale.refreshResult(facts)))!;
  assert.equal(x.state, 'stale');
  assert.match(x.staleFacts!, /Master is now 5f527b2b/);
  assert.match(x.result!, /This is not a denial/); assert.doesNotMatch(x.result!, /Denied by the user/);
  assert.equal(x.detail, detail, 'the card keeps the heads that the user saw'); assert.equal(x.version, version);
  assert.deepEqual(x.payload, { source: BRANCH, target: MASTER, branch: 'task/t-refresh' });
  assert.equal(x.decidedBy?.by, 'user'); assert.equal(x.decidedBy?.origin?.target, 'refresh');
  assert.equal(x.undoUntil, undefined);
  assert.equal(m.state.merged, 0);
  assert.deepEqual(told, [{ id: x.id, state: 'stale' }]);
  // repeated refresh, and late clicks on Approve and Deny: nothing changes and the task gets no second message
  assert.equal((await approvals.refresh(x.id, origin('refresh')))!.state, 'stale');
  assert.equal((await approvals.decide(x.id, true, { by: 'user' }))!.state, 'stale');
  assert.equal((await approvals.decide(x.id, false, { by: 'user' }))!.state, 'stale');
  assert.throws(() => approvals.undo(x.id), /Only a denied card/);
  assert.equal(told.length, 1); assert.equal(m.state.merged, 0);
  approvals.setDelivery(x.id, 'Taskboard typed the message into task #7 at 10:02.');
  assert.equal(approvals.get(x.id)!.delivery, 'Taskboard typed the message into task #7 at 10:02.');
  const lines = readFileSync(join(root, 'tbdir', 'approval-decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.card === x.id);
  assert.deepEqual(lines.map(l => [l.event, l.state]), [['refresh', 'stale']]);
  assert.equal(JSON.parse(readFileSync(join(root, 'tbdir', 'approvals.json'), 'utf8')).find((c: { id: string }) => c.id === x.id).state, 'stale');

  // fresh approval: the next request makes a new card with the current heads, and only its own approval merges
  m.state.now = { source: BRANCH2, target: MASTER2, branch: 'task/t-refresh' };
  const fresh = m.ask({ ...m.state.now });
  assert.notEqual(fresh.id, x.id); assert.equal(fresh.state, 'pending'); assert.equal(fresh.staleFacts, undefined);
  assert.match(fresh.detail, new RegExp(`Branch head: ${BRANCH2}\\nMaster head: ${MASTER2}`));
  assert.equal(m.state.merged, 0, 'nothing merges before the new approval');
  assert.equal(approvals.get(x.id)!.state, 'stale', 'the old card stays in the record');
  assert.equal((await approvals.decide(fresh.id, true, { by: 'user' }, origin('approve')))!.state, 'approved');
  assert.equal(m.state.merged, 1);
});

test('stale branch: the card says that the branch moved, and refresh closes it', async () => {
  const m = mergeCard('t-branch');
  m.now.source = BRANCH2;
  await approvals.recheck(only(m.card.id));
  assert.match(m.card.staleFacts!, /^The task branch moved.*5ec09a37.*77aa11bb.*Master did not change/);
  const x = (await approvals.refresh(m.card.id))!;
  assert.equal(x.state, 'stale'); assert.match(x.result!, /not a denial.*The task branch moved/); assert.equal(m.state.merged, 0);
});

test('a new request on a stale card that still waits replaces the facts in place', async () => {
  const m = mergeCard('t-again');
  m.now.target = MASTER2;
  await approvals.recheck(only(m.card.id));
  const again = m.ask({ ...m.now });
  assert.equal(again.id, m.card.id); assert.equal(again.staleFacts, undefined); assert.match(again.detail, new RegExp(MASTER2));
  assert.deepEqual(await approvals.recheck(only(again.id)), []);
});

test('user denial of a stale card is a denial, and other card kinds cannot be refreshed', async () => {
  const told: string[] = [];
  approvals.onDecision(c => { if (c.actor === 't-deny') told.push(c.state); });
  const m = mergeCard('t-deny');
  m.now.target = MASTER2;
  await approvals.recheck(only(m.card.id));
  const x = (await approvals.decide(m.card.id, false, { by: 'user' }, origin('deny')))!;
  assert.equal(x.state, 'denied'); assert.equal(x.result, 'Denied by the user.'); assert.ok(x.undoUntil);
  assert.deepEqual(told, ['denied']);
  assert.equal((await approvals.refresh(x.id))!.state, 'denied', 'a denied card is not refreshed');
  const push = approvals.request({ actor: 't-deny', action: 'git-push', summary: 'push x', detail: '', payload: {} }, async () => 'pushed', { check: async () => 'the remote moved' });
  await assert.rejects(approvals.refresh(push.id), /Only a merge card can be refreshed/);
  assert.equal(push.state, 'pending');
});

test('the task status after a refresh says that the merge was not denied', () => {
  const waits = { status: 'needs-you' as const, ask: 'Approve: merge task/x into local master', statusSource: 'Waiting for your approval on the dashboard.' };
  const patch = statusAfterCards(waits, { open: 0, last: { state: 'stale' } })!;
  assert.equal(patch.status, 'working'); assert.match(patch.statusSource!, /refresh its stale merge card\. The merge was not denied\./);
  assert.equal(statusAfterCards({ ...waits, status: 'parked' }, { open: 0, last: { state: 'stale' } }), undefined, 'a parked task stays parked');
});

test('the dashboard words: stale chip, refresh in place of Approve, and when an idle or parked task gets the message', () => {
  const card = { action: 'git-merge', state: 'pending' as const, staleFacts: 'Local master moved.' };
  assert.equal(isStaleMerge(card), true);
  assert.equal(isStaleMerge({ ...card, staleFacts: undefined }), false);
  assert.equal(isStaleMerge({ ...card, action: 'git-push' }), false);
  assert.equal(isStaleMerge({ ...card, state: 'stale' }), false);
  assert.equal(REFRESH_LABEL, 'Ask task to refresh');
  assert.ok(STALE_HELP.some(l => /not denied/.test(l))); assert.ok(STALE_HELP.some(l => /needs your approval/.test(l)));
  assert.match(deliveryText({ num: 381, status: 'idle' }), /Task #381 is idle\. The message starts a new turn\./);
  assert.match(deliveryText({ num: 381, status: 'needs-you' }), /is idle/);
  assert.match(deliveryText({ num: 381, status: 'parked' }), /is parked\. The message waits in its queue\. Taskboard types it after you resume the task\./);
  assert.match(deliveryText({ num: 381, status: 'suspended' }), /Taskboard resumes it/);
  assert.match(deliveryText(undefined), /No message can be sent/);
  assert.match(decidedByLine({ state: 'stale', decidedBy: { by: 'user', at: '2026-10-07T10:00:00Z' } }), /stale, not denied/);
  const row = { id: 't1', num: 1, title: 'x', waitingOn: { card: 'm1' } } as unknown as Parameters<typeof needAction>[0];
  assert.deepEqual(needAction(row, () => ({ kind: 'approval', action: 'git-merge', stale: true })), { kind: 'refresh', id: 'm1' });
  assert.deepEqual(needAction(row, () => ({ kind: 'approval', action: 'git-merge' })), { kind: 'decide', id: 'm1' });
});
