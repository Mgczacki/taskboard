// Refused-command cards and the protection of card decisions against stray clicks (task 274).
// Observed on 5 October 2026: refused-command cards were denied 2.8 s after they appeared, the task read "Denied by
// the user." and gave the step up, and the user had not meant to deny. Covers:
//   - Dismiss: a refused-command card closes in the state dismissed, with no denial and with its origin
//   - the task status after Dismiss (server/card-close.ts statusAfterCards)
//   - Undo of a denial (server/approvals.ts undo): the card waits again and can still run; the limits of Undo
//   - permits.reopen and push.reopenPush
//   - the line about a quick denial (card-close.ts quickLine)
//   - the audit file approval-decisions.jsonl
//   - the click rules (web/src/clickGuard.ts) and the text of the card (web/src/refusalText.ts)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-refusal-cards-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
mkdirSync(join(root, 'tbdir'), { recursive: true });
const approvals = await import('../server/approvals.ts');
const { DISMISSED_STATUS, quickLine, statusAfterCards } = await import('../server/card-close.ts');
const { taskDir } = await import('../server/store.ts');
const permits = await import('../server/permits.ts');
const push = await import('../server/push.ts');
const { ARM_MS, cardTime, clickAllowed, needsConfirm, NEW_CARD_MS } = await import('../web/src/clickGuard.ts');
const { refusalText } = await import('../web/src/refusalText.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(root, { recursive: true, force: true }));

const refusal = (actor: string, toolId: string) => approvals.request({ actor, action: 'tool-refusal', summary: `review refused command for task #${actor}`, detail: 'Tool: Bash\nCommand: aws iam create-role\nReason: IAM', payload: { id: toolId, command: 'aws iam create-role', reason: 'IAM', canPermit: false } }, async () => 'unused');
const decisions = () => { const f = join(root, 'tbdir', 'approval-decisions.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []; };

test('Dismiss closes a refused-command card without a decision, and records where the click came from', async () => {
  const seen: string[] = [];
  approvals.onDecision(c => seen.push(`${c.id}:${c.state}`));
  const card = refusal('t-dismiss', 'toolu_1');
  const origin = approvals.cleanOrigin({ from: 'stack', target: 'dismiss', shownMs: 2400, pointerMs: 90, evil: 'x' }, 'Mozilla/5.0 test');
  const x = approvals.dismiss(card.id, origin)!;
  assert.equal(x.state, 'dismissed');
  assert.equal(x.result, approvals.DISMISSED_RESULT);
  assert.equal(x.result, 'Closed by the user without a decision.');
  assert.deepEqual(x.decidedBy?.origin, { from: 'stack', target: 'dismiss', shownMs: 2400, pointerMs: 90, userAgent: 'Mozilla/5.0 test' });
  assert.equal(typeof x.decidedBy?.ageMs, 'number');
  assert.ok(seen.includes(`${card.id}:dismissed`), 'the decision listeners see the dismissed state (index.ts sends no message for it)');
  // a second Dismiss or a late Deny does not change the closed card
  assert.equal(approvals.dismiss(card.id)!.state, 'dismissed');
  assert.equal((await approvals.decide(card.id, false))!.state, 'dismissed');
  const line = decisions().find(d => d.card === card.id);
  assert.equal(line.event, 'dismiss');
  assert.equal(line.origin.from, 'stack');
});

test('Deny on a refused-command card (an older dashboard or the API) dismisses it instead of recording a denial', async () => {
  const card = refusal('t-deny-old', 'toolu_2');
  const x = (await approvals.decide(card.id, false, { by: 'user' }, approvals.cleanOrigin({ from: 'waiting', target: 'deny' })))!;
  assert.equal(x.state, 'dismissed');
  assert.notEqual(x.result, 'Denied by the user.');
  assert.equal(x.undoUntil, undefined);
});

test('only a refused-command card can be dismissed', () => {
  const card = approvals.request({ actor: 't-merge', action: 'git-merge', summary: 'merge a', detail: '', payload: {} }, async () => 'merged');
  assert.throws(() => approvals.dismiss(card.id), /Only a refused-command card/);
  assert.equal(approvals.get(card.id)!.state, 'pending');
});

test('cleanOrigin keeps only known values', () => {
  assert.deepEqual(approvals.cleanOrigin({ from: 'somewhere', target: 'x'.repeat(100), shownMs: -5, pointerMs: 'a' }), { from: 'unknown', target: 'x'.repeat(40) });
  assert.deepEqual(approvals.cleanOrigin(undefined), { from: 'unknown' });
});

test('the task status after Dismiss: unread after a refusal at the end of a turn, working after a refused tb permit', () => {
  const turnEnd = { status: 'needs-you' as const, ask: 'Refused: aws iam create-role. Reason: IAM.', statusSource: 'Claude Code auto mode refused a tool call at 5:59 AM. Use the dashboard.' };
  assert.deepEqual(statusAfterCards(turnEnd, { open: 0, refusalDismissed: true }), { status: 'unread', ask: '', statusSource: DISMISSED_STATUS });
  const inTurn = { status: 'needs-you' as const, ask: 'Refused: git push --force origin x', statusSource: 'This push needs a push request: run tb git push-request.' };
  assert.deepEqual(statusAfterCards(inTurn, { open: 0, refusalDismissed: true }), { status: 'working', ask: '', statusSource: DISMISSED_STATUS });
  assert.doesNotMatch(DISMISSED_STATUS, /denied/);
  // another open card keeps the task waiting
  assert.equal(statusAfterCards(turnEnd, { open: 1, refusalDismissed: true }), undefined);
  // a card denied before Dismiss existed keeps the old text
  assert.equal(statusAfterCards(turnEnd, { open: 0, refusalDenied: true })?.statusSource, 'The user denied the refused command.');
});

test('Undo reopens a denied card: it waits again, its action still runs, and the listeners are told', async () => {
  let ran = 0, reopened = 0; const told: string[] = [];
  approvals.onReopen(c => told.push(c.id));
  const card = approvals.request({ actor: 't-undo', action: 'git-merge', summary: 'merge b', detail: '', payload: {} }, async () => { ran++; return 'merged'; }, { onReopen: () => { reopened++; } });
  const denied = (await approvals.decide(card.id, false, { by: 'user' }, approvals.cleanOrigin({ from: 'stack', target: 'deny', shownMs: 2800 })))!;
  assert.equal(denied.state, 'denied');
  assert.ok(denied.undoUntil && Date.parse(denied.undoUntil) > Date.now());
  assert.equal(approvals.undoBlocked(denied), undefined);
  const x = approvals.undo(card.id, approvals.cleanOrigin({ from: 'stack', target: 'undo' }));
  assert.equal(x.state, 'pending');
  assert.equal(x.decidedBy, undefined);
  assert.equal(x.result, undefined);
  assert.ok(x.reopened?.at);
  assert.equal(x.updated, x.reopened?.at, 'the dashboard sees the reopened card as an arrival');
  assert.equal(reopened, 1);
  assert.deepEqual(told, [card.id]);
  assert.equal(ran, 0, 'nothing ran on the denial or the undo');
  // the reopened card runs its action on Approve
  assert.equal((await approvals.decide(card.id, true))!.state, 'approved');
  assert.equal(ran, 1);
  assert.deepEqual(decisions().filter(d => d.card === card.id).map(d => d.event), ['deny', 'undo', 'approve']);
});

test('Undo has limits: 60 seconds, a denial by the user, and not for a Message card or a dismissed card', async () => {
  const card = approvals.request({ actor: 't-late', action: 'release', summary: 'release', detail: '', payload: {} }, async () => 'released');
  const denied = (await approvals.decide(card.id, false))!;
  assert.match(approvals.undoBlocked(denied, Date.now() + approvals.UNDO_MS + 1000)!, /60 seconds/);
  const mail = approvals.request({ actor: 't-mail', action: 'mail-out', summary: 'send a message', detail: '', payload: {} }, async () => 'sent');
  const rejected = (await approvals.decide(mail.id, false))!;
  assert.match(rejected.noUndo!, /Message card/);
  assert.equal(rejected.undoUntil, undefined);
  assert.throws(() => approvals.undo(mail.id), /Message card/);
  const closed = approvals.dismiss(refusal('t-undo-refusal', 'toolu_3').id)!;
  assert.throws(() => approvals.undo(closed.id), /Only a denied card/);
  const pending = approvals.request({ actor: 't-open', action: 'restart', summary: 'restart', detail: '', payload: {} }, async () => 'ok');
  assert.throws(() => approvals.undo(pending.id), /Only a denied card/);
});

test('a reopened permit and push wait again, with nothing run', () => {
  mkdirSync(join(root, 'work'), { recursive: true });
  mkdirSync(taskDir('permit-task'), { recursive: true });
  const task = { id: 'permit-task', num: 9, agent: 'claude', cwd: join(root, 'work'), folder: join(root, 'work'), worktree: false } as Task;
  const p = permits.request(task, 'Check the folder', [{ command: 'pwd' }]);
  permits.deny(p, 'Denied on the dashboard.');
  assert.equal(p.state, 'denied');
  assert.equal(permits.reopen(p), true);
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.steps.map(s => s.state), ['pending']);
  assert.equal(p.decidedAt, undefined);
  assert.equal(permits.reopen(p), false, 'only a denied permit reopens');
  const record = { id: 'push-1', at: new Date().toISOString(), taskId: 't', branch: 'b', remote: 'origin', remoteUrl: 'u', oldHead: null, newHead: 'abc', state: 'denied' as const, result: 'Denied by the user.' };
  assert.equal(push.reopenPush(record as import('../server/push.ts').PushRecord), true);
  assert.equal(record.state, 'pending');
  assert.equal(record.result, undefined);
});

test('a denial less than 10 seconds after the card appeared gets a line that asks the task to check with the user', () => {
  const at = new Date().toISOString();
  assert.match(quickLine({ state: 'denied', decidedBy: { by: 'user', at, ageMs: 2795 } }), /^The user denied this card 2\.8 seconds after it appeared\. .*check with the user/);
  assert.equal(quickLine({ state: 'denied', decidedBy: { by: 'user', at, ageMs: 12_000 } }), '');
  assert.equal(quickLine({ state: 'approved', decidedBy: { by: 'user', at, ageMs: 500 } }), '');
  assert.equal(quickLine({ state: 'denied', decidedBy: { by: 'user', at } }), '', 'no age, no line');
});

test('the click rules: buttons off for ARM_MS, a click counts only when its pointerdown was on the button after that', () => {
  const shown = 1000, armedAt = shown + ARM_MS;
  assert.equal(ARM_MS, 1500);
  // a click while the buttons are off
  assert.equal(clickAllowed({ armedAt, now: shown + 800, down: { at: shown + 700, target: 'deny' }, target: 'deny', keyboard: false }), false);
  // a pointerdown before the card appeared (meant for the page), released on Deny after the buttons came on
  assert.equal(clickAllowed({ armedAt, now: armedAt + 200, down: { at: shown - 50, target: 'deny' }, target: 'deny', keyboard: false }), false);
  // a pointerdown during the guard does not count either
  assert.equal(clickAllowed({ armedAt, now: armedAt + 200, down: { at: shown + 1200, target: 'deny' }, target: 'deny', keyboard: false }), false);
  // a click with no pointerdown on this button (the pointerdown was on another button)
  assert.equal(clickAllowed({ armedAt, now: armedAt + 200, down: { at: armedAt + 100, target: 'approve' }, target: 'deny', keyboard: false }), false);
  assert.equal(clickAllowed({ armedAt, now: armedAt + 200, target: 'deny', keyboard: false }), false);
  // a deliberate click
  assert.equal(clickAllowed({ armedAt, now: armedAt + 300, down: { at: armedAt + 150, target: 'deny' }, target: 'deny', keyboard: false }), true);
  // the keyboard (Enter or Space on a focused button) counts once the buttons are on
  assert.equal(clickAllowed({ armedAt, now: armedAt + 1, target: 'deny', keyboard: true }), true);
  assert.equal(clickAllowed({ armedAt, now: armedAt - 1, target: 'deny', keyboard: true }), false);
});

test('Confirm deny: a card that appeared less than 10 seconds ago needs a second click', () => {
  const now = Date.parse('2026-10-05T05:59:44.878Z');
  assert.equal(NEW_CARD_MS, 10_000);
  assert.equal(needsConfirm('2026-10-05T05:59:42.083Z', now), true, 'the card of task 216, denied 2.8 s after it appeared');
  assert.equal(needsConfirm('2026-10-05T05:59:30.000Z', now), false);
  assert.equal(cardTime({ created: '2026-10-05T05:00:00Z', updated: '2026-10-05T05:59:40Z' }), '2026-10-05T05:59:40Z', 'a card changed in place counts as new');
  assert.equal(cardTime({ created: '2026-10-05T05:00:00Z', reopened: { at: '2026-10-05T05:59:41Z' } }), '2026-10-05T05:59:41Z');
});

test('the card says who refused the tool call, where the rule is, and what the user can do', () => {
  const card = { detail: 'Tool: Bash\nCommand: aws iam create-role', payload: { id: 'toolu_1', command: 'aws iam create-role' } };
  const claude = refusalText(card, 'claude');
  assert.match(claude.who, /Claude Code auto mode/);
  assert.match(claude.where, /autoMode section of ~\/\.claude\/settings\.json/);
  assert.match(claude.where, /claude auto-mode config/);
  assert.match(claude.todo, /^Taskboard cannot approve this\. It was refused by the agent's own permission check\./);
  assert.equal(claude.command, 'aws iam create-role');
  const codex = refusalText(card, 'codex');
  assert.match(codex.who, /^Codex/);
  assert.match(codex.where, /--ask-for-approval/);
  assert.match(codex.where, /approvals_reviewer/);
  const own = refusalText({ detail: 'git push --force origin x\nThis push needs a push request.', payload: { command: 'git push --force origin x' } }, 'claude');
  assert.match(own.who, /^Taskboard refused/);
  assert.equal(own.command, 'git push --force origin x');
});
