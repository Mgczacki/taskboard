import assert from 'node:assert/strict';
import test from 'node:test';
import { cdpKey } from '../server/task-browser.ts';
import { inactiveTaskIds, orphanWrappers, parseMcpProcesses } from '../server/task-browser-mcp-cleanup.ts';

test('audit selects only adopted wrappers with a valid task key', () => {
  const id = 'task-522';
  const args = `/opt/node --import /release/node_modules/tsx/dist/loader.mjs /release/server/task-browser-mcp.ts /release/node_modules/chrome-devtools-mcp.js --wsEndpoint ws://127.0.0.1:4317/ws/cdp/${id}?key=${cdpKey(id)} --no-usage-statistics`;
  const rows = parseMcpProcesses(`101 1 501 ${args}\n102 99 501 ${args}\n103 1 502 ${args}\n104 1 501 ${args.replace(cdpKey(id), '0'.repeat(32))}\n105 1 501 chrome-devtools-mcp`);
  assert.deepEqual(orphanWrappers(rows, new Set([id]), 501).map(row => row.pid), [101]);
  assert.deepEqual(orphanWrappers(rows, new Set(['other-task']), 501), []);
});

test('startup audit excludes tasks with a live agent session', () => {
  const tasks = [{ id: 'active', session: 'task-1' }, { id: 'ended', session: 'task-2' }, { id: 'dead', session: 'task-3' }];
  const sessions = [{ name: 'task-1', dead: false }, { name: 'task-3', dead: true }];
  assert.deepEqual([...inactiveTaskIds(tasks, sessions)], ['ended', 'dead']);
});
