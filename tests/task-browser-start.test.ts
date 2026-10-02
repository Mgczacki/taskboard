// The start of a task browser (server/task-browser.ts) when Chrome is slow, fails, or ends after its start, in a
// temporary Taskboard folder. The Chrome path is a shell script: it sleeps and then runs Chrome (a slow computer), or it
// prints a few log lines and exits (a Chrome that cannot start). The tests that run a real Chrome are skipped when Chrome
// is not installed. A slow start must not be shown as a failure, no second Chrome may run on one profile, and the agent
// gets an answer that says what happens.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readlinkSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-browser-start-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-browser-start-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
const machineFile = join(root, 'state', 'machine.json');
const setChrome = (chromePath: string) => writeFileSync(machineFile, JSON.stringify({ name: 'browser-start-test', controller: { autostart: false, remoteControl: false }, browser: { chromePath, idleStopMinutes: 0 } }));
setChrome('');
const browser = await import('../server/task-browser.ts');
const memory = await import('../server/memory.ts');
const machine = await import('../server/machine.ts');
const CHROME = browser.chromePath();
const skip = CHROME ? false : 'Chrome is not installed';
const IDS = ['slow', 'fails', 'limit', 'exits', 'double', 'agent-slow', 'agent-fails'];
after(async () => { machine.update({ chromePath: CHROME || '' }); for (const id of IDS) await browser.stop(id).catch(() => {}); });

const script = (name: string, body: string) => { const f = join(root, name); writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); return f; };
const useChrome = (path: string) => { machine.update({ chromePath: path }); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// main Chrome processes (and wrapper scripts) that run on the profile of this browser
const onProfile = (id: string) => {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter(l => l.includes(`--user-data-dir=${browser.profileDir(id)}`) && !l.includes('--type=')).map(l => Number(l.trim().split(/\s+/)[0]));
};
const problems: { id: string; message: string; lines: string[] }[] = [];
browser.onProblem((id, message, lines) => problems.push({ id, message, lines }));

// A stand-in for the agent's WebSocket: records what the server sends and whether it closed the connection.
function fakeAgent() {
  const sent: any[] = [];
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)), close: () => { client.readyState = WebSocket.CLOSED; client.emit('close'); } });
  return { client, sent };
}

test('the chrome.log lines for a failure leave out the updater, crash reporter and display lines', () => {
  const text = [
    'DevTools listening on ws://127.0.0.1:63807/devtools/browser/b32acb74',
    'Trying to load the allocator multiple times. This is *not* supported.',
    '[8203:55543805:1002/051836.519366:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670',
    '[10490:55549439:1002/051900.614960:VERBOSE1:chrome/updater/updater.cc:364] Version: 156.0.8067.0, opt, ARM_64',
    '[10490:55549439:1002/051900.691139:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open settings.dat: No such file or directory (2)',
    '[8136:55543771:1002/051840.038083:ERROR:google_apis/gcm/engine/registration_request.cc:291] Registration response error message: DEPRECATED_ENDPOINT',
    'Created TensorFlow Lite XNNPACK delegate for CPU.',
    '[44106:55615147:1002/052701.025770:ERROR:chrome/app/chrome_main_delegate.cc:562] Failed to create a ProcessSingleton for your profile directory.',
    '',
  ].join('\n');
  assert.deepEqual(browser.usefulLines(text), ['[44106:55615147:1002/052701.025770:ERROR:chrome/app/chrome_main_delegate.cc:562] Failed to create a ProcessSingleton for your profile directory.']);
});

test('little free memory is marked low', () => {
  assert.equal(memory.systemMemoryOf(65536, 48000).low, false);
  assert.equal(memory.systemMemoryOf(65536, 9000).low, true, 'below 20 %');
  assert.equal(memory.systemMemoryOf(8192, 1800).low, true, 'below 2 GB');
});

test('a Chrome that exits at its start fails at once, with its exit code and its error lines', async () => {
  useChrome(script('fail.sh', [
    'echo "[2:2:VERBOSE1:chrome/updater/updater.cc:364] Version: 156 (noise)" >&2',
    'echo "[1:1:ERROR:chrome/browser/profile.cc:12] The profile cannot be opened." >&2',
    'exit 21',
  ].join('\n')));
  problems.length = 0;
  // an earlier Chrome of this browser ended by itself: the failed start replaces that state
  mkdirSync(join(root, 'state', 'browsers', 'fails'), { recursive: true });
  writeFileSync(join(root, 'state', 'browsers', 'fails', 'browser.json'), JSON.stringify({ exited: true, error: 'Chrome ended by itself' }));
  const t0 = Date.now();
  await assert.rejects(browser.ensure('fails'), (e: Error & { lines?: string[] }) => {
    assert.match(e.message, /exit code 21/);
    assert.deepEqual(e.lines, ['[1:1:ERROR:chrome/browser/profile.cc:12] The profile cannot be opened.']);
    return true;
  });
  assert.ok(Date.now() - t0 < 10000, 'the failure is known as soon as the process exits');
  const s = await browser.status('fails');
  assert.equal(s.running, false);
  assert.equal(s.starting, undefined);
  assert.match(s.error || '', /exit code 21/);
  assert.deepEqual(s.errorLines, ['[1:1:ERROR:chrome/browser/profile.cc:12] The profile cannot be opened.']);
  assert.ok(s.errorAt);
  assert.equal(s.exited, undefined, 'a failed start is not an exit');
  assert.equal(problems.length, 1, 'the task log gets one entry');
  assert.equal(problems[0].id, 'fails');
});

test('the agent gets "did not start" with the reason when the start fails', async () => {
  const { client, sent } = fakeAgent();
  browser.proxyAgent(client as unknown as WebSocket, 'agent-fails', 5000);
  client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Target.getBrowserContexts' })), false);
  for (let i = 0; i < 100 && !sent.length; i++) await wait(100);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 1);
  assert.match(sent[0].error.message, /^Taskboard: the task browser did not start\. Chrome ended .* \(exit code 21\)\..*Call the browser tool again/);
  for (let i = 0; i < 30 && client.readyState === WebSocket.OPEN; i++) await wait(100);
  assert.equal(client.readyState, WebSocket.CLOSED, 'the connection closes after the answer');
});

test('a Chrome that does not answer by the limit is ended, and no process is left', async () => {
  useChrome(script('never.sh', 'sleep 60'));
  process.env.TASKBOARD_BROWSER_START_LIMIT_MS = '3000';
  try {
    await assert.rejects(browser.ensure('limit'), /did not answer within 3 s/);
    assert.deepEqual(onProfile('limit'), [], 'the waiting process was ended');
  } finally { delete process.env.TASKBOARD_BROWSER_START_LIMIT_MS; }
});

test('a slow start (35 s, longer than the old 30 s limit) shows progress and then works; a second call waits for the same Chrome', { skip, timeout: 120000 }, async () => {
  useChrome(script('slow.sh', `sleep 35\nexec "${CHROME}" "$@"`));
  problems.length = 0;
  const first = browser.ensure('slow');
  await wait(3000);
  const s = await browser.status('slow');
  assert.equal(s.running, false);
  assert.ok(s.starting && s.starting.seconds >= 2 && s.starting.limitSeconds === 90 && s.starting.pid, 'the status shows the start with its time and process');
  assert.equal(s.error, undefined, 'a slow start is not an error');
  const second = browser.ensure('slow');
  assert.equal(second, first, 'the second call waits for the same start');
  // the agent that calls a tool now gets "still starting" after its wait, not a hang and not a cut connection
  const { client, sent } = fakeAgent();
  browser.proxyAgent(client as unknown as WebSocket, 'slow', 1000);
  client.emit('message', Buffer.from(JSON.stringify({ id: 7, method: 'Target.getBrowserContexts' })), false);
  for (let i = 0; i < 50 && !sent.length; i++) await wait(100);
  assert.match(sent[0]?.error?.message || '', /^Taskboard: the task browser is still starting \(Chrome has run for \d+ s; the computer is slow\)\. Call the browser tool again/);
  assert.equal(onProfile('slow').length, 1, 'one process on the profile');
  const b = await first;
  assert.ok((b.startMs || 0) >= 35000);
  assert.equal(await browser.isRunning('slow'), true);
  assert.deepEqual(onProfile('slow'), [b.pid], 'still one Chrome on the profile');
  assert.equal(problems.length, 0);
  await browser.stop('slow');
});

test('a Chrome that ends after its start is seen within seconds, is reported, and starts again at the next use', { skip, timeout: 60000 }, async () => {
  useChrome(CHROME!);
  problems.length = 0;
  const b = await browser.ensure('exits');
  try { process.kill(-b.pid!, 'SIGKILL'); } catch { /* ended */ }
  let m = browser.readMeta('exits');
  for (let i = 0; i < 50 && !m.exited; i++) { await wait(100); m = browser.readMeta('exits'); }
  assert.equal(m.exited, true);
  assert.equal(m.pid, undefined);
  assert.match(m.error || '', /^Chrome ended by itself at .* \(signal SIGKILL\)\. It starts again at the next use\.$/);
  assert.equal(problems.length, 1);
  const again = await browser.ensure('exits');
  assert.notEqual(again.pid, b.pid);
  const s = await browser.status('exits');
  assert.equal(s.running, true);
  assert.equal(s.error, undefined, 'a start that works removes the old error');
  await browser.stop('exits');
  assert.equal(browser.readMeta('exits').exited, undefined, 'a stop is not an exit');
  assert.equal(problems.length, 1);
});

test('a Chrome that holds the profile but did not answer is used again: no second Chrome', { skip, timeout: 60000 }, async () => {
  useChrome(CHROME!);
  const b = await browser.ensure('double');
  // browser.json loses the port, so live() gets no answer (as from a Chrome that is too busy to answer)
  const meta = browser.readMeta('double');
  writeFileSync(join(root, 'state', 'browsers', 'double', 'browser.json'), JSON.stringify({ ...meta, port: 1 }));
  const again = await browser.ensure('double');
  assert.equal(again.pid, b.pid, 'the same Chrome');
  assert.deepEqual(onProfile('double'), [b.pid], 'one Chrome on the profile');
  // browser.json lost the process too (a failed start of an older version did this): stop() still ends it
  writeFileSync(join(root, 'state', 'browsers', 'double', 'browser.json'), JSON.stringify({ ...meta, pid: undefined, port: undefined }));
  assert.match(readlinkSync(join(browser.profileDir('double'), 'SingletonLock')), new RegExp(`-${b.pid}$`), 'the profile lock names the Chrome');
  await browser.stop('double');
  assert.deepEqual(onProfile('double'), [], 'stop() ended the Chrome that browser.json did not name');
});

test('a frozen Chrome that holds the profile is ended at the limit, then one new Chrome starts', { skip, timeout: 60000 }, async () => {
  useChrome(CHROME!);
  const b = await browser.ensure('double');
  process.kill(b.pid!, 'SIGSTOP');
  process.env.TASKBOARD_BROWSER_START_LIMIT_MS = '5000';
  try {
    const again = await browser.ensure('double');
    assert.notEqual(again.pid, b.pid);
    assert.deepEqual(onProfile('double'), [again.pid], 'only the new Chrome runs on the profile');
  } finally { delete process.env.TASKBOARD_BROWSER_START_LIMIT_MS; try { process.kill(b.pid!, 'SIGCONT'); } catch { /* ended */ } }
  await browser.stop('double');
});
