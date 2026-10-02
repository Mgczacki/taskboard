import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalSocket } from '../web/src/terminalSocket.ts';

function fixture() {
  const sockets: any[] = [];
  let opens = 0, closes = 0;
  const connection = terminalSocket(() => 'ws://test/term', {
    open: () => opens++, message: () => {}, close: () => closes++,
  }, () => {
    const socket = { readyState: 0, onopen: null, onclose: null, onmessage: null, closed: false,
      close() { this.closed = true; }, send() {} };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { connection, sockets, opens: () => opens, closes: () => closes };
}

test('closing a terminal cancels a pending reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.sockets[0].onclose({ code: 1006 });
  f.connection.dispose();
  t.mock.timers.tick(20000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].closed, true);
});

test('a stalled connection retries after ten seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(10000);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.closes(), 1);
  t.mock.timers.tick(1500);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].onopen();
  t.mock.timers.tick(20000);
  assert.equal(f.opens(), 1);
  assert.equal(f.sockets.length, 2);
  f.connection.dispose();
});

test('disposal cancels the connection deadline and detaches callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.connection.dispose();
  t.mock.timers.tick(20000);
  assert.equal(f.closes(), 0);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].onmessage, null);
});

test('an unknown task does not reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.sockets[0].onclose({ code: 4004 });
  t.mock.timers.tick(20000);
  assert.equal(f.sockets.length, 1);
  f.connection.dispose();
});

test('after a server restart the terminal tries again at 250 ms, then waits longer each time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  f.sockets[0].onopen();
  t.mock.timers.tick(60000); // a connection that lasted a minute
  f.sockets[0].onclose({ code: 1006 });
  t.mock.timers.tick(249);
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].onclose({ code: 1006 });
  t.mock.timers.tick(499);
  assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(f.sockets.length, 3);
  for (let i = 3; i < 8; i++) { f.sockets[i - 1].onclose({ code: 1006 }); t.mock.timers.tick(4000); }
  assert.equal(f.sockets.length, 8); // the wait stops growing at 4 s
  f.connection.dispose();
});

test('a terminal for a tmux session that is not running waits 10 s before the next attach', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  f.sockets[0].onopen();
  f.sockets[0].onclose({ code: 4001 });
  t.mock.timers.tick(9999);
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.sockets.length, 2);
  f.connection.dispose();
});
