import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesBrowser, recoverArchived, type ProcessIdentity, type RecoveryIO } from '../server/browser-recovery.ts';
import { sameStart } from '../server/task-procs.ts';

const chrome: ProcessIdentity = { pid: 701, uid: 501, start: 'Tue Oct 13 09:00:00 2026', name: 'Google Chrome' };
const record = { pid: 701, pidStart: chrome.start };

test('archive recovery ends an exact browser and keeps a live task browser', async () => {
  const signals: string[] = [], ended: string[] = [];
  const io: RecoveryIO = {
    meta: () => record, identity: () => signals.includes('SIGKILL') ? null : chrome, lock: () => 701, uid: 501,
    signal: (_pid, signal) => { signals.push(signal); }, wait: async () => {}, ended: id => { ended.push(id); },
  };
  assert.deepEqual(await recoverArchived([{ id: 'old', status: 'archived' }, { id: 'live', status: 'working' }], io), ['old']);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(ended, ['old']);
});

test('user Chrome and a reused PID cannot pass browser identity checks', () => {
  assert.equal(matchesBrowser(record, chrome, null, 501), false);
  assert.equal(matchesBrowser(record, { ...chrome, start: 'Tue Oct 13 10:00:00 2026' }, 701, 501), false);
  assert.equal(matchesBrowser(record, { ...chrome, uid: 502 }, 701, 501), false);
  assert.equal(matchesBrowser({ pid: 701 }, chrome, 701, 501), false);
});

test('restart recovery leaves a changed process alone', async () => {
  const signals: string[] = [];
  let reads = 0;
  const io: RecoveryIO = {
    meta: () => record, identity: () => ++reads === 1 ? chrome : { ...chrome, start: 'Tue Oct 13 10:00:00 2026' },
    lock: () => 701, uid: 501, signal: (_pid, signal) => { signals.push(signal); }, wait: async () => {}, ended: () => {},
  };
  assert.deepEqual(await recoverArchived([{ id: 'old', status: 'archived' }], io), []);
  assert.deepEqual(signals, []);
});

test('a task process group needs its recorded start time', () => {
  assert.equal(sameStart('Tue Oct 13 09:00:00 2026', 'Tue Oct 13 09:00:00 2026'), true);
  assert.equal(sameStart('Tue Oct 13 09:00:00 2026', 'Tue Oct 13 10:00:00 2026'), false);
  assert.equal(sameStart(undefined, 'Tue Oct 13 09:00:00 2026'), false);
});
