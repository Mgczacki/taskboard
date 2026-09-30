import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trimTerminalLog } from '../server/terminal-log.ts';

test('terminal log keeps its recent output below ten MiB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-terminal-log-'));
  const file = join(dir, 'terminal.log');
  try {
    writeFileSync(file, Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 65), Buffer.alloc(5 * 1024 * 1024, 66)]));
    assert.equal(trimTerminalLog(file), true);
    assert.ok(statSync(file).size < 6 * 1024 * 1024);
    assert.equal(readFileSync(file).at(-1), 66);
    assert.equal(trimTerminalLog(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
