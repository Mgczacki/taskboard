import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastCodexRefusal } from '../server/command-refusal.ts';

test('reads a refused Codex command from its tool result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-codex-refusal-'));
  const path = join(dir, 'rollout.jsonl');
  try {
    const timestamp = new Date().toISOString();
    writeFileSync(path, [
      { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'echo test' }) } },
      { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Command blocked by the sandbox: access denied' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.deepEqual(lastCodexRefusal(path, Date.now() - 1000), { id: 'call-1', command: 'echo test', reason: 'Command blocked by the sandbox: access denied' });
    assert.equal(lastCodexRefusal(path, Date.now() + 1000), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reads a command inside a Codex functions.exec call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-codex-wrapper-'));
  const path = join(dir, 'rollout.jsonl');
  try {
    const timestamp = new Date().toISOString();
    writeFileSync(path, [
      { timestamp, type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'call-2', input: 'const r=await tools.exec_command({cmd:"echo test",workdir:"/tmp/work"}); text(r);' } },
      { timestamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Command blocked by PreToolUse hook: refused' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.deepEqual(lastCodexRefusal(path, Date.now() - 1000), { id: 'call-2', command: 'echo test', cwd: '/tmp/work', reason: 'Command blocked by PreToolUse hook: refused' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
