import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-restart-impact-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4398';
const { restartImpact } = await import('../server/restart.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(root, { recursive: true, force: true }));

const task = (id: string, num: number, extra: Partial<Task> = {}) => ({ id, num, title: `Task ${num}`, status: 'working', session: `tb-${id}`, ...extra }) as Task;
const base = { askRunning: [], permitsRunning: [], moving: [], pendingApprovals: 0 };

test('agent sessions in their own tmux process group keep running and need no confirmation', () => {
  const i = restartImpact({ ...base, tasks: [task('a', 1), task('b', 2, { status: 'archived' }), task('c', 3, { role: 'controller' })], liveSessions: ['tb-a', 'tb-b', 'tb-c'], tmuxPid: 10, tmuxGroup: 10, ownGroup: 20 });
  assert.deepEqual(i.sessions.map(s => s.num), [1, 3]);
  assert.equal(i.sessions[1].title, 'controller');
  assert.equal(i.stops.length, 0);
  assert.equal(i.tmuxStops, false);
});

test('a tmux server in the same process group as Taskboard lists every session as stopped', () => {
  const i = restartImpact({ ...base, tasks: [task('a', 1), task('b', 2)], liveSessions: ['tb-a', 'tb-b'], tmuxPid: 10, tmuxGroup: 20, ownGroup: 20 });
  assert.equal(i.tmuxStops, true);
  assert.deepEqual(i.stops.map(s => s.num), [1, 2]);
  assert.match(i.stops[0].what, /can stop/);
});

test('Ask answers, running permits, account moves and transfers are listed as stopped work', () => {
  const i = restartImpact({ tasks: [task('a', 1), task('b', 2), task('c', 3), task('d', 4, { transfer: { id: 'x', machine: 'm', task: 't', direction: 'source', state: 'starting' } })], liveSessions: [],
    askRunning: ['a'], permitsRunning: [{ taskId: 'b', id: 'p1' }], moving: ['c'], pendingApprovals: 2 });
  assert.deepEqual(i.stops.map(s => s.num), [1, 2, 3, 4]);
  assert.match(i.stops[1].what, /permit p1/);
  assert.match(i.notes[0], /2 approval cards/);
});
