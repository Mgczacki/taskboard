import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TestResources } from '../helpers/test-resources.ts';

const root = process.env.TB_FIXTURE_ROOT;
const socket = process.env.TB_FIXTURE_SOCKET;
if (!root || !socket) throw new Error('Fixture root and socket are required');
const resources = new TestResources();
resources.socket(socket);
resources.browserRoot(root);
const profile = join(root, 'state', 'browsers', 'fixture', 'profile');
mkdirSync(profile, { recursive: true });
const tmux = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'fixture', 'sleep 30'], { timeout: 3000 });
assert.equal(tmux.status, 0, String(tmux.stderr));
const chrome = spawn(process.execPath, [join(import.meta.dirname, 'hold-process.mjs'), `--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' });
chrome.unref();
resources.chromeProcess(chrome.pid, profile, root);
writeFileSync(join(root, 'chrome.pid'), String(chrome.pid));
writeFileSync(join(root, 'ready'), 'ready');

test('resources end after this test', { timeout: process.env.TB_FIXTURE_MODE === 'timeout' ? 100 : 3000 }, async () => {
  if (process.env.TB_FIXTURE_MODE === 'failure') assert.fail('intentional assertion failure');
  await new Promise(resolve => setTimeout(resolve, 500));
});
