import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-account-status-'));
const bin = join(root, 'bin');
const state = join(root, 'models-state');
const started = join(root, 'slow-check-started');
mkdirSync(bin);
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.AGY_TEST_STATE = state;
process.env.AGY_TEST_STARTED = started;
const agy = join(bin, 'agy');
writeFileSync(agy, `#!/usr/bin/env node
const fs = require('node:fs');
const value = fs.readFileSync(process.env.AGY_TEST_STATE, 'utf8').trim();
if (value === 'slow-unsigned') fs.writeFileSync(process.env.AGY_TEST_STARTED, 'yes');
setTimeout(() => console.log(value === 'signed' ? 'model\\tavailable' : 'Please sign in to view available models.'), value === 'slow-unsigned' ? 300 : 0);
`);
chmodSync(agy, 0o755);
const accounts = await import('../server/accounts.ts');
const account = accounts.defaultFor('antigravity');

test('a fresh sign-in check supersedes an older check and its cached result', async () => {
  writeFileSync(state, 'slow-unsigned');
  const old = accounts.status(account);
  for (let i = 0; i < 100 && !existsSync(started); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(started), true);
  writeFileSync(state, 'signed');
  const fresh = await accounts.status(account, true);
  assert.equal(fresh.signedIn, true);
  assert.equal((await old).signedIn, false);
  assert.equal((await accounts.status(account)).signedIn, true);
});
