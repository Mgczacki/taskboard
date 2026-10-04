import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTO_OPEN_KEY, DEFAULT_OPEN_KEY, badgeTitle, boardSummary, fmtAge, headerKey, heartbeatState, managerGroupsOf, openKey,
  readAutoOpen, readDefaultOpen, readOpen, refreshManagerDetails, saveAutoOpen, saveDefaultOpen, saveOpen, setManagerGroups,
  shouldAutoOpen, type Board, type ManagerInfo,
} from '../web/src/managerBoard.ts';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
const row = (num: number, ageMinutes: number) => ({ id: 't' + num, num, title: 'Task ' + num, ageMinutes, source: 'checked' });

test('the board is folded by default, and each group keeps its own saved state', () => {
  const s = memory();
  assert.equal(readOpen('g1', s), false);
  saveOpen('g1', true, s);
  assert.equal(readOpen('g1', s), true);
  assert.equal(readOpen('g2', s), false);
  assert.equal(s.m.get(openKey('g1')), 'open');
  saveOpen('g1', false, s);
  assert.equal(readOpen('g1', s), false);
});

test('the global default applies only to groups without a saved state', () => {
  const s = memory();
  saveOpen('g1', false, s);
  saveDefaultOpen(true, s);
  assert.equal(s.m.get(DEFAULT_OPEN_KEY), 'open');
  assert.equal(readDefaultOpen(s), true);
  assert.equal(readOpen('g2', s), true);
  assert.equal(readOpen('g1', s), false);
});

test('a storage that throws counts as empty and does not throw', () => {
  assert.equal(readOpen('g1', broken), false);
  assert.doesNotThrow(() => saveOpen('g1', true, broken));
  assert.doesNotThrow(() => saveAutoOpen(true, broken));
  assert.equal(readAutoOpen(broken), false);
  assert.equal(readOpen('g1', null), false);
});

test('the board opens by itself only when the setting is on and Needs you goes up', () => {
  const s = memory();
  assert.equal(readAutoOpen(s), false);
  saveAutoOpen(true, s);
  assert.equal(s.m.get(AUTO_OPEN_KEY), 'on');
  assert.equal(readAutoOpen(s), true);
  assert.equal(shouldAutoOpen(0, 2, true), true);
  assert.equal(shouldAutoOpen(2, 2, true), false);
  assert.equal(shouldAutoOpen(3, 1, true), false);
  assert.equal(shouldAutoOpen(0, 2, false), false);
});

test('the summary counts each column and shows the oldest wait only past one hour', () => {
  const b: Board = { group: { id: 'g1', name: 'G' }, columns: {
    needsYou: [row(1, 12), row(2, 95)], waitingOther: [row(3, 40), row(4, 190), row(5, 30)], running: [row(6, 500), row(7, 3)], free: [row(8, 25)], blocked: [] } };
  const s = boardSummary(b);
  assert.deepEqual(s.counts, { needsYou: 2, waitingOther: 3, running: 2, free: 1, blocked: 0 });
  // a Running row does not wait, so its 500 minutes do not count
  assert.equal(s.oldestMinutes, 190);
  assert.equal(boardSummary({ group: { id: 'g', name: 'G' }, columns: { needsYou: [row(1, 59)], running: [row(2, 900)] } }).oldestMinutes, null);
  assert.deepEqual(boardSummary({ group: { id: 'g', name: 'G' }, columns: {} }).counts, { needsYou: 0, waitingOther: 0, running: 0, free: 0, blocked: 0 });
  assert.equal(fmtAge(45), '45 min');
  assert.equal(fmtAge(190), '3 h');
  assert.equal(fmtAge(3000), '2 d');
});

test('Enter and Space toggle the header, Escape closes an open board', () => {
  assert.equal(headerKey('Enter', false), 'toggle');
  assert.equal(headerKey(' ', true), 'toggle');
  assert.equal(headerKey('Escape', true), 'close');
  assert.equal(headerKey('Escape', false), null);
  assert.equal(headerKey('a', true), null);
});

test('the heartbeat dot shows when the manager does not respond', () => {
  assert.equal(heartbeatState(undefined).state, 'none');
  assert.equal(heartbeatState({ pending: 0, lastTurn: null, notResponding: false }).state, 'ok');
  assert.equal(heartbeatState({ pending: 2, lastTurn: null, notResponding: false }).state, 'pending');
  assert.match(heartbeatState({ pending: 2, lastTurn: null, notResponding: true }).text, /does not respond/);
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

test('the board header is a button with aria-expanded and aria-controls, and the Settings have both choices', () => {
  const src = readFileSync(new URL('../web/src/components/ManagerBoard.tsx', import.meta.url), 'utf8');
  assert.match(src, /className="mb-toggle" aria-expanded=\{open\} aria-controls=\{panelId\}/);
  assert.match(src, /id=\{panelId\}/);
  assert.match(src, /No manager/);
  assert.match(src, /Set a manager/);
  assert.match(src, /Open full board/);
  const css = readFileSync(new URL('../web/src/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.mb-scroll \{ max-height: 40vh;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.mb-body/);
  const settings = readFileSync(new URL('../web/src/components/Settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /<SettingItem id="managerBoardOpen">/);
  assert.match(settings, /<SettingItem id="managerBoardAutoOpen">/);
});
