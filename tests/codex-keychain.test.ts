import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-codex-keychain-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
const { codexKeychainArgs } = await import('../server/agents.ts');
after(() => rmSync(root, { recursive: true, force: true }));

test('Codex commands may write the macOS user cache folder, so gh can read its token from the keychain', () => {
  assert.deepEqual(codexKeychainArgs('linux'), []);
  if (process.platform !== 'darwin') return;
  const dir = execFileSync('getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim().replace(/\/+$/, '');
  assert.deepEqual(codexKeychainArgs(), ['-c', `sandbox_workspace_write.writable_roots=["${dir}"]`]);
});
