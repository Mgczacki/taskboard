// Tests for server/server-life.ts (uncaught errors, start history, restart reasons), server/log-rotate.ts and
// web/src/serverStatus.ts. Each test uses its own temporary folder; nothing touches ~/.taskboard.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classify, decide, readStarts, recordEnd, recordStart, signalEnd, writeIntent } from '../server/server-life.ts';
import { rotateIfLarge } from '../server/log-rotate.ts';
import { awayBanner, linkText, restartBanner, retryDelay, type ServerHealth } from '../web/src/serverStatus.ts';

const err = (code: string, message = `write ${code}`) => Object.assign(new Error(message), { code });

test('write and spawn errors on one socket, pipe or terminal are recoverable', () => {
  for (const code of ['EPIPE', 'EIO', 'EBADF', 'ECONNRESET']) assert.equal(classify(err(code)), 'recoverable', code);
  assert.equal(classify(new Error('posix_spawnp failed.')), 'recoverable');
  assert.equal(classify(new RangeError('Invalid string length')), 'fatal');
  assert.equal(classify(new TypeError('x is undefined')), 'unknown');
});

test('the server keeps running for recoverable errors and stops for a second unknown error within 10 s', () => {
  const recent: number[] = [];
  for (let i = 0; i < 20; i++) assert.equal(decide(err('EPIPE'), 1000 + i, recent).exit, false);
  const first = decide(new TypeError('a'), 10_000, recent);
  assert.equal(first.exit, false);
  assert.match(first.line, /^recovered: an uncaught error of an unknown kind/);
  // 11 s later the first one no longer counts
  assert.equal(decide(new TypeError('b'), 21_001, recent).exit, false);
  const second = decide(new TypeError('c'), 25_000, recent);
  assert.equal(second.exit, true);
  assert.match(second.line, /^crashed: stopping because this is the second uncaught error within 10 s/);
  assert.equal(decide(new RangeError('Array buffer allocation failed'), 0, []).exit, true);
});

test('the start history records each start and how the one before ended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-life-'));
  recordStart(dir, 100, '/x/releases/r1', new Date('2026-10-02T09:00:00Z'));
  recordEnd(dir, 100, { kind: 'crash', detail: 'Error: write EPIPE' });
  recordStart(dir, 101, '/x/releases/r1');
  // 101 ends without writing (SIGKILL): the next start marks it unknown
  const list = recordStart(dir, 102, '/x/releases/r2');
  assert.deepEqual(list.map(s => [s.pid, s.end?.kind]), [[100, 'crash'], [101, 'unknown'], [102, undefined]]);
  assert.equal(list[2].release, 'r2');
  assert.equal(readStarts(dir)[0].end?.detail, 'Error: write EPIPE');
  // an end is written once
  recordEnd(dir, 102, { kind: 'signal' });
  recordEnd(dir, 102, { kind: 'crash' });
  assert.equal(readStarts(dir)[2].end?.kind, 'signal');
});

test('a SIGTERM after a fresh restart intent is a planned stop, otherwise a signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-life-'));
  assert.equal(signalEnd(dir, 'SIGTERM').kind, 'signal');
  writeIntent(dir, 'release', 'release 20261002-104935');
  assert.deepEqual(signalEnd(dir, 'SIGTERM'), { kind: 'release', detail: 'release 20261002-104935' });
  // an intent older than 2 minutes does not explain a later SIGTERM
  assert.equal(signalEnd(dir, 'SIGTERM', Date.now() + 121_000).kind, 'signal');
});

test('the log rotates by copy and truncate, and an append writer continues at the new end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-rotate-'));
  const file = join(dir, 'server.log');
  writeFileSync(file, 'x'.repeat(2000));
  const fd = openSync(file, 'a'); // launchd opens the log with O_APPEND
  try {
    assert.equal(rotateIfLarge(file, 1000, 3, fd), true);
    assert.equal(statSync(`${file}.1`).size, 2000);
    writeSync(fd, 'after\n');
    // the write lands at offset 0, not at offset 2000 after a gap of zero bytes
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    // a second rotation moves .1 to .2
    writeFileSync(file, 'y'.repeat(2000));
    assert.equal(rotateIfLarge(file, 1000, 3, fd), true);
    assert.equal(readFileSync(`${file}.2`, 'utf8')[0], 'x');
    // another file than stdout is left alone
    const other = join(dir, 'other.log'); writeFileSync(other, 'z'.repeat(5000));
    assert.equal(rotateIfLarge(other, 1000, 3, fd), false);
  } finally { closeSync(fd); }
});

const health = (startedAt: string, previous: ServerHealth['previous']): ServerHealth => ({ pid: 1, startedAt, uptimeSec: 1, release: 'r', previous, starts: [],
  counts: { crash: 0, signal: 0, release: 0, rollback: 0, manual: 0, exit: 0, unknown: 0 }, planned: 0, recovered: { count: 0 } });

test('the dashboard waits 250 ms first, says what is wrong, and names the reason of a restart', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(a => retryDelay(a)), [250, 500, 1000, 2000, 4000, 4000]);
  const now = Date.parse('2026-10-02T10:00:10Z');
  assert.equal(linkText({ state: 'connected', since: now }), 'server connected');
  assert.equal(linkText({ state: 'down', since: now - 8000 }, now), 'server not answering for 8 s, reconnecting');
  assert.equal(linkText({ state: 'restarting', since: now - 1000, stopReason: 'release' }, now), 'server restarting (release), reconnecting');
  assert.match(linkText({ state: 'offline', since: now }, now), /no network/);
  assert.equal(awayBanner({ state: 'down', since: now - 500 }, now), null); // a short gap shows no banner
  assert.match(awayBanner({ state: 'restarting', since: now, stopReason: 'manual' }, now) || '', /^Server stopped at .*, reason: manual restart, reconnecting\. Terminals keep their last screen/);
  assert.equal(restartBanner(health('a', null), health('a', null)), null);
  assert.match(restartBanner(health('2026-10-02T10:00:00Z', null), health('2026-10-02T10:02:47Z', { kind: 'crash', detail: 'Error: write EPIPE' })) || '',
    /^Server restarted at .*, reason: crash \(Error: write EPIPE\)$/);
});
