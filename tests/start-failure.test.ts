import { TestResources } from './helpers/test-resources.ts';
const resources = new TestResources();
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-start-failure-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = resources.socket(`tb-start-failure-${process.pid}`);
process.env.HOME = join(root, 'home');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
mkdirSync(join(root, 'vault', 'tasks'), { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false } }));
const store = await import('../server/store.ts');
const events = await import('../server/events.ts');
const agentExit = await import('../server/agent-exit.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('the exit reason has the status and the last output lines, without the tmux line', () => {
  const screen = 'Starting\n\nError: invalid transport\nin `mcp_servers.cua_repl`\n\nPane is dead (status 1, Fri Oct 16 09:07:19 2026)\n\n';
  assert.equal(agentExit.exitReason(1, screen), 'The agent exited with status 1: Starting Error: invalid transport in `mcp_servers.cua_repl`');
  assert.equal(agentExit.exitReason(undefined, '\nPane is dead (status 0)\n'), 'The agent exited');
});

test('an exit soon after the launch is a failed start, a later exit is not', () => {
  const now = Date.now();
  assert.equal(agentExit.failedStart(now - 1000, now), true);
  assert.equal(agentExit.failedStart(now - agentExit.START_WINDOW_MS - 1, now), false);
  assert.equal(agentExit.failedStart(undefined, now), false);
});

test('a SessionStart of another Claude process does not replace the task session', () => {
  const t = store.create({ id: 'start-1', num: 1, title: 'Start', agent: 'claude', status: 'idle', cwd: root, folder: root,
    session: 'task-1', sessionId: 'own-session', transcript: join(root, 'own.jsonl'), desc: '' });
  for (const source of ['startup', 'resume'])
    events.claudeEvent(t.id, { hook_event_name: 'SessionStart', source, session_id: 'other-session', transcript_path: join(root, 'other.jsonl') });
  assert.equal(store.get(t.id)!.sessionId, 'own-session');
  assert.equal(store.get(t.id)!.transcript, join(root, 'own.jsonl'));
  // the task's own start records its transcript, and /clear starts a new conversation in the same process
  events.claudeEvent(t.id, { hook_event_name: 'SessionStart', source: 'resume', session_id: 'own-session', transcript_path: join(root, 'own2.jsonl') });
  assert.equal(store.get(t.id)!.transcript, join(root, 'own2.jsonl'));
  events.claudeEvent(t.id, { hook_event_name: 'SessionStart', source: 'clear', session_id: 'cleared', transcript_path: join(root, 'cleared.jsonl') });
  assert.equal(store.get(t.id)!.sessionId, 'cleared');
});
