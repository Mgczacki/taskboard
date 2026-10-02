import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// machine.ts reads machine.json when it loads. The file here is an old one: it has no confirmRisk value.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-confirm-risk-test-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(join(root, 'state'), { recursive: true });
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'confirm-risk-test', controller: { autostart: false, remoteControl: false }, permissions: { holdPermissionHook: true } }));
const machine = await import('../server/machine.ts');

test('the default: only the wide access confirm is off', () => {
  assert.deepEqual(machine.DEFAULT_CONFIRM_RISK, { wideAccess: false, installs: true, spends: true, exits: true });
});

test('an old settings file without confirmRisk gets the defaults', () => {
  assert.deepEqual(machine.get().confirmRisk, { wideAccess: false, installs: true, spends: true, exits: true });
  assert.deepEqual(machine.readConfirmRisk(undefined), machine.DEFAULT_CONFIRM_RISK);
  // a partial or invalid saved value: each missing or invalid field gets its default
  assert.deepEqual(machine.readConfirmRisk({ installs: false, spends: 'no', other: true }), { wideAccess: false, installs: false, spends: true, exits: true });
  assert.deepEqual(machine.readConfirmRisk({ wideAccess: true }), { wideAccess: true, installs: true, spends: true, exits: true });
});

test('each setting changes on its own and is saved in machine.json', () => {
  const saved = () => JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8')).confirmRisk;
  machine.update({ confirmRisk: { wideAccess: true } });
  assert.deepEqual(saved(), { wideAccess: true, installs: true, spends: true, exits: true });
  for (const key of ['installs', 'spends', 'exits'] as const) {
    machine.update({ confirmRisk: { [key]: false } });
    assert.equal(saved()[key], false, key);
  }
  assert.deepEqual(machine.get().confirmRisk, { wideAccess: true, installs: false, spends: false, exits: false });
  machine.update({ confirmRisk: { wideAccess: false, installs: true, spends: true, exits: true } });
  assert.deepEqual(saved(), machine.DEFAULT_CONFIRM_RISK);
});

test('an invalid confirmRisk change is refused', () => {
  for (const bad of [null, [], { wideAccess: 'off' }, { other: true }]) assert.throws(() => machine.update({ confirmRisk: bad as never }), /confirmRisk/, JSON.stringify(bad));
  assert.deepEqual(machine.get().confirmRisk, machine.DEFAULT_CONFIRM_RISK);
});
