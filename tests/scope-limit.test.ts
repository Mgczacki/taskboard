import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-scope-limit-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const machine = await import('../server/machine.ts');
after(() => rmSync(root, { recursive: true, force: true }));

test('old settings have no count maximum and saved values use positive safe integers', () => {
  assert.deepEqual(machine.get().scopeLimit, { enabled: false, max: 8 });
  for (const value of [undefined, null, [], {}, { enabled: 'yes', max: 0 }, { enabled: false, max: 1.5 }])
    assert.deepEqual(machine.readScopeLimit(value), { enabled: false, max: 8 });
  assert.deepEqual(machine.readScopeLimit({ enabled: true, max: 12 }), { enabled: true, max: 12 });
  machine.update({ scopeLimit: { max: 12 } });
  assert.deepEqual(machine.get().scopeLimit, { enabled: false, max: 12 });
  machine.update({ scopeLimit: { enabled: true } });
  const saved = JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8'));
  assert.deepEqual(saved.scopeLimit, { enabled: true, max: 12 });
  assert.deepEqual(machine.readScopeLimit(saved.scopeLimit), saved.scopeLimit);
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => machine.update({ scopeLimit: { max: value } }), /positive whole number/);
  assert.deepEqual(machine.get().scopeLimit, { enabled: true, max: 12 });
  machine.update({ scopeLimit: { enabled: false } });
  assert.deepEqual(machine.get().scopeLimit, { enabled: false, max: 12 });
});
