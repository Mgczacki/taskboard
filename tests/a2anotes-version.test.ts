import { test } from 'node:test';
import assert from 'node:assert/strict';
import { olderVersion } from '../server/a2anotes/setup.ts';
import { versionLines } from '../web/src/a2aCard.ts';

test('only a running service that is older than the installed package needs a restart', () => {
  assert.equal(olderVersion('0.3.0', '0.4.0'), true);
  assert.equal(olderVersion('0.4.0', '0.4.0'), false);
  assert.equal(olderVersion('0.10.0', '0.4.0'), false);
  assert.equal(olderVersion('0.4', '0.4.1'), true);
});

test('the version line names both versions, and the warning gives the restart step', () => {
  const step = 'Click Restart A2A Notes.';
  assert.deepEqual(versionLines({ installed: true, version: '0.4.0', running: true, serviceVersion: '0.4.0', updateAvailable: false, restartStep: step }),
    { line: 'A2A Notes service: running 0.4.0, installed 0.4.0.' });
  assert.deepEqual(versionLines({ installed: true, version: '0.4.0', running: true, serviceVersion: '0.3.0', updateAvailable: true, restartStep: step }), {
    line: 'A2A Notes service: running 0.3.0, installed 0.4.0.',
    warning: 'Running 0.3.0, installed 0.4.0. Restart the A2A Notes service to use the new format.',
    step,
  });
  assert.equal(versionLines({ installed: true, version: '0.4.0', running: false, updateAvailable: false }).line, 'A2A Notes service: not running, installed 0.4.0.');
});
