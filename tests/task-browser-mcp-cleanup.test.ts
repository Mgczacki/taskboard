import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { cdpKey } from '../server/task-browser.ts';
import { inactiveTaskIds, orphanWrappers, parseMcpProcesses, signalOrphans } from '../server/task-browser-mcp-cleanup.ts';

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

test('audit selects wrappers of older releases and no other command that holds the same path and key', () => {
  const id = 'task-489', uid = 501;
  const endpoint = `--wsEndpoint ws://127.0.0.1:4399/ws/cdp/${id}?key=${cdpKey(id)} --no-usage-statistics`;
  const old = '/Users/u/.tb/releases/20261011-110857-312cb052';
  const rows = parseMcpProcesses([
    // the wrapper of a release before b54914cb: no --click-evidence flag
    `201 1 501 /opt/homebrew/opt/node@22/bin/node --import ${old}/node_modules/tsx/dist/loader.mjs ${old}/server/task-browser-mcp.ts ${old}/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js ${endpoint}`,
    // a tmux server started with an agent command that contains the wrapper path and key
    `202 1 501 tmux -L tbtest new-session -d -s task-1 sh -c node --import ${old}/node_modules/tsx/dist/loader.mjs ${old}/server/task-browser-mcp.ts x ${endpoint}`,
    // an agent whose own arguments contain the wrapper path and key
    `203 1 501 claude --mcp ${old}/server/task-browser-mcp.ts ${endpoint}`,
  ].join('\n'));
  assert.deepEqual(orphanWrappers(rows, new Set([id]), uid).map(row => row.pid), [201]);
});

test('audit does not signal a PID that now belongs to another process', { timeout: 10000 }, async () => {
  const uid = process.getuid!();
  // The row says that a wrapper with parent 1 had this PID. The process at that PID now runs a different command.
  const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const id = 'task-reuse';
    const row = { pid: other.pid!, ppid: 1, uid, args: `/node --import /r/loader.mjs /r/server/task-browser-mcp.ts /r/mcp.js --wsEndpoint ws://127.0.0.1:4399/ws/cdp/${id}?key=${cdpKey(id)}` };
    assert.equal(await signalOrphans([row], uid), 0);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(other.exitCode, null, 'the other process still runs');
    assert.equal(other.signalCode, null);
  } finally { other.kill('SIGKILL'); }
});
