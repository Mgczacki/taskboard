import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  badgeTitle, boardOf, boardSummary, fmtAge, loadBoards, managerGroupsOf, needAction, refreshManagerDetails, rowOf, setManagerGroups, waitLabel,
  type Board, type BoardRow, type FindCard, type ManagerInfo,
} from '../web/src/managerBoard.ts';

const row = (num: number, ageMinutes: number, waitingOn?: Partial<NonNullable<BoardRow['waitingOn']>>): BoardRow =>
  ({ id: 't' + num, num, title: 'Task ' + num, ageMinutes, source: 'checked', waitingOn: waitingOn && { on: 'user', target: '', needs: '', reason: '', card: '', unblocks: [], ...waitingOn } });
const cards: FindCard = id => id === 'push1' ? { kind: 'approval', action: 'git-push', pushId: 'p1' } : id === 'merge1' ? { kind: 'approval', action: 'git-merge' }
  : id === 'permit1' ? { kind: 'approval', action: 'permit', permitId: 'x' } : id === 'mail1' ? { kind: 'approval', action: 'mail-out' } : id === 'q1' ? { kind: 'question' } : undefined;

test('the summary counts each column and shows the oldest wait only past one hour', () => {
  const b: Board = { group: { id: 'g1', name: 'G' }, columns: {
    needsYou: [row(1, 12), row(2, 95)], waitingOther: [row(3, 40), row(4, 190), row(5, 30)], running: [row(6, 500), row(7, 3)], free: [row(8, 25)], blocked: [] } };
  const s = boardSummary(b);
  assert.deepEqual(s.counts, { needsYou: 2, waitingOther: 3, running: 2, free: 1, blocked: 0 });
  // a Running row does not wait, so its 500 minutes do not count
  assert.equal(s.oldestMinutes, 190);
  assert.deepEqual(boardSummary({ group: { id: 'g', name: 'G' }, columns: {} }).counts, { needsYou: 0, waitingOther: 0, running: 0, free: 0, blocked: 0 });
  assert.equal(fmtAge(45), '45 min');
  assert.equal(fmtAge(190), '3 h');
  assert.equal(fmtAge(3000), '2 d');
});

test('the window header shows the wait in place of the status word', () => {
  assert.equal(waitLabel(row(1, 5, { card: 'push1' }), 'needsYou', cards), 'Approve push');
  assert.equal(waitLabel(row(1, 5, { card: 'merge1' }), 'needsYou', cards), 'Approve merge');
  assert.equal(waitLabel(row(1, 5, { card: 'q1' }), 'needsYou', cards), 'Answer question');
  assert.equal(waitLabel(row(1, 5, { reason: 'Review requested' }), 'needsYou', cards), 'Review');
  assert.equal(waitLabel(row(1, 5, { reason: 'Choose a format' }), 'needsYou', cards), 'Needs you');
  assert.equal(waitLabel(row(1, 5, { on: 'task', target: '302' }), 'waitingOther', cards), 'Waits on #302');
  assert.equal(waitLabel(row(1, 5, { on: 'ci', target: 'PR 536' }), 'waitingOther', cards), 'Waits on CI PR 536');
  assert.equal(waitLabel(row(1, 5, { on: 'person', target: 'Design team' }), 'waitingOther', cards), 'Waits on Design team');
  assert.equal(waitLabel(row(1, 5), 'blocked', cards), 'Blocked');
  // a task that does not wait keeps its status word
  assert.equal(waitLabel(row(1, 5), 'running', cards), null);
  assert.equal(waitLabel(row(1, 5), 'free', cards), null);
});

test('a Need you row gets Approve and Deny only for a card that one click decides', () => {
  assert.deepEqual(needAction(row(1, 5, { card: 'push1' }), cards), { kind: 'push', pushId: 'p1' });
  assert.deepEqual(needAction(row(1, 5, { card: 'merge1' }), cards), { kind: 'decide', id: 'merge1' });
  assert.deepEqual(needAction(row(1, 5, { card: 'permit1' }), cards), { kind: 'open' });
  assert.deepEqual(needAction(row(1, 5, { card: 'mail1' }), cards), { kind: 'open' });
  assert.deepEqual(needAction(row(1, 5, { card: 'q1' }), cards), { kind: 'open' });
  assert.deepEqual(needAction(row(1, 5, { reason: 'Review requested' }), cards), { kind: 'review' });
  assert.deepEqual(needAction(row(1, 5, { reason: 'Choose' }), cards), { kind: 'open' });
});

test('the boards of all groups load into one store, and a task row is found in them', async () => {
  const list: Board[] = [{ group: { id: 'g1', name: 'A', manager: 't1' }, columns: { running: [row(1, 3)], waitingOther: [row(4, 9, { on: 'task', target: '2' })] } },
    { group: { id: 'g2', name: 'B' }, columns: { free: [row(9, 1)] } }];
  await loadBoards(async () => ({ json: async () => list }));
  assert.equal(boardOf('g1')?.group.manager, 't1');
  assert.deepEqual(rowOf('t4')?.column, 'waitingOther');
  assert.equal(rowOf('t9', 'g1'), undefined);
  assert.equal(rowOf('t9', 'g2')?.column, 'free');
  // a failed read keeps the last boards
  await loadBoards(async () => { throw new Error('offline'); });
  assert.equal(boardOf('g2')?.group.name, 'B');
});

test('the badge knows each manager task and shows its caps and whether it may act now', async () => {
  setManagerGroups([{ id: 'g1', name: 'Release train', manager: 't1' }, { id: 'g2', name: 'Other' }]);
  assert.deepEqual(managerGroupsOf('t1').map(g => g.name), ['Release train']);
  assert.deepEqual(managerGroupsOf('t2'), []);
  assert.deepEqual(managerGroupsOf(undefined), []);
  assert.match(badgeTitle(managerGroupsOf('t1')), /Limits: not loaded yet/);
  const info: ManagerInfo = { group: 'g1', name: 'Release train', manager: 't1', num: 1, caps: { newPerDay: 8, working: 8, messagesPerHour: 30, stopsPerHour: 3 },
    usage: { status: 'working', newToday: 2, working: 8, messagesHour: 4, stopsHour: 3, mayNew: false, mayMessage: true, mayStop: false } };
  await refreshManagerDetails(async () => ({ json: async () => [info] }));
  const text = badgeTitle(managerGroupsOf('t1'));
  assert.match(text, /Manager of the group Release train/);
  assert.match(text, /2 of 8 new tasks today, 8 of 8 working tasks/);
  assert.match(text, /start a task no, send a message yes, stop a task no/);
  assert.match(badgeTitle(managerGroupsOf('t1'), () => ({ ...info, usage: { ...info.usage, status: 'suspended' } })), /is suspended/);
  setManagerGroups([]);
  assert.deepEqual(managerGroupsOf('t1'), []);
});

test('option J: no board above the canvas, the group tab has the ◆ mark and the need you chip, the review page has the badge', () => {
  const canvas = readFileSync(new URL('../web/src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(canvas, /<ManagerBoard\b/);
  assert.match(canvas, /<ManagerMark manager=\{groupManager\(g\)\}/);
  assert.match(canvas, /<GroupNeeds group=\{g\.id\}/);
  assert.match(canvas, /<WaitLabel taskId=\{t\.id\}>/);
  assert.match(canvas, /<ManagerScope group=\{g\.id\}/);
  const review = readFileSync(new URL('../web/src/components/Review.tsx', import.meta.url), 'utf8');
  assert.match(review, /<ManagerBadge id=\{item\.task\} \/>/);
  const src = readFileSync(new URL('../web/src/components/ManagerBoard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Manager #\{/);
  assert.doesNotMatch(src, /Open full board/);
  assert.doesNotMatch(readFileSync(new URL('../web/src/components/Settings.tsx', import.meta.url), 'utf8'), /managerBoard/);
});
