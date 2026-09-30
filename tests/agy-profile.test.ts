import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareProfile } from '../server/agy-profile.ts';

test('prepareProfile unlocks before it reads the keychain search list', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-agy-profile-'));
  const path = join(home, 'Library', 'Keychains', 'antigravity-profile.keychain-db');
  const passwordFile = join(home, '.taskboard-keychain-password');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(path, '');
  writeFileSync(passwordFile, 'test-password', { mode: 0o600 });
  const calls: string[] = [];
  let unlocked = false;
  await prepareProfile(home, async (actualHome, args, input = '') => {
    assert.equal(actualHome, home);
    assert.equal(args.includes('test-password'), false);
    calls.push(args[0]);
    if (args[0] === 'unlock-keychain') {
      assert.deepEqual(args, ['unlock-keychain', path]);
      assert.equal(input, 'test-password\n');
      unlocked = true;
      return '';
    }
    assert.equal(unlocked, true);
    return `"${path}"\n`;
  });
  assert.deepEqual(calls, ['unlock-keychain', 'list-keychains', 'default-keychain']);
});

test('prepareProfile rejects another default keychain after unlocking', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-agy-profile-'));
  const path = join(home, 'Library', 'Keychains', 'antigravity-profile.keychain-db');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(path, '');
  writeFileSync(join(home, '.taskboard-keychain-password'), 'test-password', { mode: 0o600 });
  await assert.rejects(prepareProfile(home, async (_home, args) =>
    args[0] === 'default-keychain' ? '"/tmp/other.keychain-db"\n' : `"${path}"\n`
  ), /not isolated/);
});
