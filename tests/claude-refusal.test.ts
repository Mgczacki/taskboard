import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRefusal } from '../server/claude-refusal.ts';

test('reads the refused command and reason from a Claude tool result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-refusal-'));
  const path = join(dir, 'session.jsonl');
  try {
    const at = new Date().toISOString();
    writeFileSync(path, [
      { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'git commit -m test' } }] } },
      { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Interfere With Workloads].' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.deepEqual(lastRefusal(path, Date.now() - 1000), { id: 'call-1', command: 'git commit -m test', reason: 'Interfere With Workloads', toolName: 'Bash' });
    assert.equal(lastRefusal(path, Date.now() + 1000), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keeps an MCP tool name separate from a shell command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-refusal-'));
  const path = join(dir, 'session.jsonl');
  try {
    const at = new Date().toISOString();
    writeFileSync(path, [
      { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'call-mcp', name: 'mcp__claude-in-chrome__browser_batch', input: { actions: [] } }] } },
      { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'call-mcp', content: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass].' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.deepEqual(lastRefusal(path, Date.now() - 1000), { id: 'call-mcp', command: 'mcp__claude-in-chrome__browser_batch', reason: 'Auto-Mode Bypass', toolName: 'mcp__claude-in-chrome__browser_batch' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
