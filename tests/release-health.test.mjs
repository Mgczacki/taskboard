import assert from 'node:assert/strict';
import test from 'node:test';
import { staysUp } from '../scripts/lib.mjs';

function checks(replies, isAlive = () => true) {
  let time = 0;
  let count = 0;
  return {
    probe: async () => replies[count++],
    pause: async ms => { time += ms; },
    clock: () => time,
    isAlive,
    count: () => count,
  };
}

test('release watch retries one missed response and then accepts the same process', async () => {
  const watch = checks([null, { pid: 42 }]);
  assert.equal(await staysUp(42, 5000, watch), true);
  assert.equal(watch.count(), 2);
});

test('release watch stops after two missed responses', async () => {
  const watch = checks([null, null]);
  assert.equal(await staysUp(42, 5000, watch), false);
  assert.equal(watch.count(), 2);
});

test('release watch stops when the original process exits', async () => {
  const watch = checks([null], () => false);
  assert.equal(await staysUp(42, 5000, watch), false);
  assert.equal(watch.count(), 1);
});

test('release watch stops when a different process answers', async () => {
  const watch = checks([{ pid: 43 }]);
  assert.equal(await staysUp(42, 5000, watch), false);
  assert.equal(watch.count(), 1);
});
