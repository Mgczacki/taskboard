import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('resource samples stay in a small JSON lines file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-resources-'));
  process.env.TASKBOARD_DIR = dir;
  process.env.TASKBOARD_VAULT = join(dir, 'vault');
  try {
    const { sampleResources, resourceLogFile } = await import('../server/resource-log.ts');
    for (let i = 0; i < 3000; i++) sampleResources(() => ({ tasks: i, eventClients: 0 }));
    const file = resourceLogFile()!;
    assert.ok(statSync(file).size < 300_000);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.at(-1).tasks, 2999);
    assert.ok(rows.every(row => Number.isFinite(row.cpuPct) && row.rssMb > 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
