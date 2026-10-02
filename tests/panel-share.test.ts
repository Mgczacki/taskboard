import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelHolds } from '../web/src/panelShare.ts';

test('a panel on its Browser tab leaves the terminal to the Canvas window of the same task', () => {
  assert.deepEqual(panelHolds('a-1', 'a-1', 'browser'), { terminal: false, browser: true });
});

test('a panel on its Terminal tab holds the terminal, and a panel that opens with no tab opens on Terminal', () => {
  assert.deepEqual(panelHolds('a-1', 'a-1', 'terminal'), { terminal: true, browser: false });
  assert.deepEqual(panelHolds('a-1', 'a-1', undefined), { terminal: true, browser: false });
});

test('a panel on the Log, Inbox / Outbox or Processes tab holds nothing', () => {
  for (const tab of ['log', 'docs', 'procs'] as const) assert.deepEqual(panelHolds('a-1', 'a-1', tab), { terminal: false, browser: false });
});

test('a panel of another task, or no panel, holds nothing of this task', () => {
  assert.deepEqual(panelHolds('a-1', 'b-2', 'terminal'), { terminal: false, browser: false });
  assert.deepEqual(panelHolds('a-1', null, 'terminal'), { terminal: false, browser: false });
});
