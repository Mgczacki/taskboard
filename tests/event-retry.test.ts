// web/src/serverStatus.ts eventRetry and the text for a close by the server: the page that the server closes again and
// again (the 1013 loop of 2026-10-04) waits longer each time instead of connecting in a loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awayBanner, eventRetry, linkText } from '../web/src/serverStatus.ts';

test('a page that the server closes with 1013 right after each connect waits 1, 2, 4, 8, 16, then 30 s', () => {
  let attempt = 0;
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) { const r = eventRetry(attempt, 50, 1013); attempt = r.attempt; delays.push(r.delay); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('the 1013 loop connects at most 8 times in two minutes', () => {
  let attempt = 0, clock = 0, connects = 0;
  while (clock < 120_000) { connects++; const r = eventRetry(attempt, 50, 1013); attempt = r.attempt; clock += 50 + r.delay; }
  assert.ok(connects <= 8, `${connects} connects`);
});

test('a connection that was open 5 s or more starts the waits again, and a failed connect keeps the 250 ms steps', () => {
  assert.deepEqual(eventRetry(6, 5000, 1006), { attempt: 1, delay: 250 });
  assert.deepEqual(eventRetry(6, 5000, 1013), { attempt: 1, delay: 1000 });
  assert.deepEqual(eventRetry(2, null, 1006), { attempt: 3, delay: 1000 });
  assert.deepEqual(eventRetry(9, null, 1006), { attempt: 10, delay: 4000 });
});

test('the page says that the server closed the connection, with the reason', () => {
  const l = { state: 'down' as const, since: Date.now(), closed: { code: 1013, reason: 'event client is too slow' } };
  assert.equal(linkText(l), 'the server closed the connection: event client is too slow (code 1013), reconnecting');
  assert.match(awayBanner(l) || '', /the server closed the connection: event client is too slow \(code 1013\)/);
  assert.equal(linkText({ state: 'down', since: Date.now() }), 'server not answering, reconnecting');
});
