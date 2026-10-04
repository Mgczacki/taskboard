// server/slow-client.ts: a client that reads a large first message stays open. A client that does not read is closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { EVENT_LIMITS, checkSlow, sendChecked } from '../server/slow-client.ts';

const MB = 1_048_576;
// a socket with the parts that sendChecked uses; bufferedAmount is set by the test
function fake(bufferedAmount = 0) {
  return { OPEN: 1, readyState: 1, bufferedAmount, sent: 0, closed: null as null | { code: number; reason: string },
    send() { this.sent++; }, close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 2; } };
}
const quiet = <T>(t: { mock: { method: (o: object, m: string, f: () => void) => unknown } }, f: () => T) => { t.mock.method(console, 'error', () => {}); return f(); };

test('a client above the limit whose buffer falls is not closed', t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const ws = fake(3 * MB) as unknown as WebSocket & ReturnType<typeof fake>;
  for (let i = 0; i < 30; i++) {
    assert.equal(sendChecked(ws, 'x', EVENT_LIMITS, 'too slow', 'task'), true);
    t.mock.timers.tick(1000);
    (ws as { bufferedAmount: number }).bufferedAmount -= 50_000; // it reads 50 KB each second
  }
  assert.equal(ws.closed, null);
  assert.equal(ws.sent, 30);
});

test('a client whose buffer does not fall for the grace time is closed with 1013 and one log line', t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const lines: string[] = [];
  t.mock.method(console, 'error', (l: string) => { lines.push(l); });
  const ws = fake(2 * MB) as unknown as WebSocket & ReturnType<typeof fake>;
  assert.equal(sendChecked(ws, 'x', EVENT_LIMITS, 'event client is too slow', 'task'), true);
  t.mock.timers.tick(EVENT_LIMITS.graceMs - 1);
  assert.equal(sendChecked(ws, 'x', EVENT_LIMITS, 'event client is too slow', 'task'), true);
  t.mock.timers.tick(1);
  assert.equal(sendChecked(ws, 'x', EVENT_LIMITS, 'event client is too slow', 'approvals'), false);
  assert.deepEqual(ws.closed, { code: 1013, reason: 'event client is too slow' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /closed a client: event client is too slow; buffer 2097152 bytes, above 1048576 and not falling for 10 s; origin none \(token\); message approvals/);
});

test('a client above the hard limit is closed at once', t => {
  const ws = fake(EVENT_LIMITS.hardLimit + 1) as unknown as WebSocket & ReturnType<typeof fake>;
  assert.equal(quiet(t, () => sendChecked(ws, 'x', EVENT_LIMITS, 'too slow', 'task')), false);
  assert.equal(ws.closed?.code, 1013);
});

test('the first messages after a connect are sent without the check', t => {
  const ws = fake(EVENT_LIMITS.hardLimit + 1) as unknown as WebSocket & ReturnType<typeof fake>;
  assert.equal(sendChecked(ws, 'x', EVENT_LIMITS, 'too slow', 'tasks', true), true);
  assert.equal(ws.closed, null);
  assert.deepEqual(checkSlow(fake(MB) as unknown as WebSocket, EVENT_LIMITS), { slow: false });
});

// The fault of 2026-10-04: a 1.3 MB task list and then the other first messages and some changes, on a real socket.
test('a real client that receives a 3 MB first message and then 200 changes stays open', async () => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: { threshold: 1024 } });
  await once(wss, 'listening');
  const port = (wss.address() as { port: number }).port;
  let closedByServer = false;
  wss.on('connection', ws => {
    ws.on('close', () => { closedByServer = true; });
    sendChecked(ws, JSON.stringify({ type: 'tasks', tasks: 'd'.repeat(3 * MB) }), EVENT_LIMITS, 'too slow', 'tasks', true);
    for (let i = 0; i < 200; i++) sendChecked(ws, JSON.stringify({ type: 'task', i, text: 'e'.repeat(4000) }), EVENT_LIMITS, 'too slow', 'task');
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  let n = 0;
  const done = new Promise<void>(resolve => client.on('message', () => { if (++n === 201) resolve(); }));
  const end = new Promise<number>(resolve => client.on('close', code => resolve(code)));
  await done;
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(closedByServer, false);
  client.close();
  await end;
  wss.close();
});
