import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { staysUp, waitForInfo } from '../scripts/lib.mjs';

test('release health accepts a response that takes more than two seconds', async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => res.end(JSON.stringify({ pid: 42 })), 2200);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await waitForInfo(url, '/missing-test-token', 5000), { pid: 42 });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('release health stops at its deadline when a server never answers', async () => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await waitForInfo(url, '/missing-test-token', 100), null);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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
