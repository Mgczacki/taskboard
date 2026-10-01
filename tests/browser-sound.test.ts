// The sound switch of a task browser (setSound in server/task-browser.ts) with a real headless Chrome in a temporary
// Taskboard folder: a first start is muted (--mute-audio), the switch restarts a running browser with its tabs, an
// agent connection needs force, and the saved choice holds over a stop, an idle suspend and a resume. The route test
// runs a test server with its own port, folders and tmux socket. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-sound-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-sound-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'sound-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
after(async () => { for (const id of ['template', 's1', 's2']) await browser.stop(id).catch(() => {}); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// the command line of the browser's main Chrome process
const args = (id: string) => execFileSync('ps', ['-o', 'command=', '-p', String(browser.readMeta(id).pid)], { encoding: 'utf8' });
const mutedArg = (id: string) => args(id).includes('--mute-audio');
async function evaluate(wsUrl: string, expression: string): Promise<any> {
  const ws = new WebSocket(wsUrl); await new Promise(r => ws.once('open', r));
  const r = await new Promise<any>(resolve => { ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) resolve(m.result); }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, userGesture: true, returnByValue: true } })); });
  ws.close(); return r?.result?.value;
}
async function tabUrls(id: string, want: number) {
  let urls: string[] = [];
  for (let i = 0; i < 50 && urls.length !== want; i++) { urls = (await browser.tabs(id)).map(t => t.url).filter(u => u.startsWith('file:')); await sleep(100); }
  return urls;
}

test('a first start is muted, for a task browser and for the template', { skip, timeout: 60000 }, async () => {
  await browser.ensure(browser.TEMPLATE);
  assert.ok(mutedArg(browser.TEMPLATE), 'the template starts with --mute-audio');
  await browser.stop(browser.TEMPLATE);
  await browser.ensure('s1');
  assert.ok(mutedArg('s1'), 'a task browser starts with --mute-audio');
  const s = await browser.status('s1');
  assert.equal(s.muted, true); assert.equal(s.sound, false);
  assert.equal(browser.readMeta('s1').muted, true);
});

// macOS: Chrome takes the "Playing audio" sleep assertion only while a page that is not muted sends sound. This plays
// a quiet tone in the muted browser only, so the test sends no sound to the speakers.
test('a muted browser plays a tone without a "Playing audio" assertion', { skip: skip || (process.platform !== 'darwin' && 'macOS only'), timeout: 30000 }, async () => {
  const page = join(root, 'tone.html');
  writeFileSync(page, '<script>window.play = async () => { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); g.gain.value = 0.02; o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 3); await c.resume(); return c.state; };</script>');
  const t = await browser.openTab('s1', `file://${page}`);
  await sleep(500);
  const target = (await (await fetch(`http://127.0.0.1:${browser.readMeta('s1').port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[]).find(x => x.id === t.id)!;
  assert.equal(await evaluate(target.webSocketDebuggerUrl, 'play()'), 'running', 'the page plays the tone');
  await sleep(1500);
  const pid = browser.readMeta('s1').pid;
  const lines = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).split('\n').filter(l => l.includes(`pid ${pid}(`) && l.includes('Playing audio'));
  assert.deepEqual(lines, []);
  await browser.closeTab('s1', t.id);
});

test('the switch restarts a running browser with its tabs, and needs force while an agent is connected', { skip, timeout: 90000 }, async () => {
  const page = join(root, 'kept.html'); writeFileSync(page, '<title>kept</title>');
  await browser.openTab('s1', `file://${page}`);
  const pid = browser.readMeta('s1').pid;

  // a DevTools connection of an agent, through the Taskboard server's forwarding code
  const agent = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send() {}, close() {} }) as unknown as WebSocket;
  browser.proxyAgent(agent, 's1');
  assert.equal(browser.agentCount('s1'), 1);
  await assert.rejects(browser.setSound('s1', true), browser.AgentConnected);
  assert.equal(browser.readMeta('s1').sound, undefined, 'a refused change saves nothing');
  assert.equal(browser.readMeta('s1').pid, pid, 'a refused change does not restart');

  const r = await browser.setSound('s1', true, { force: true });
  (agent as unknown as EventEmitter).emit('close');
  assert.equal(r.restarted, true);
  assert.notEqual(browser.readMeta('s1').pid, pid);
  assert.equal(mutedArg('s1'), false, 'sound on: no --mute-audio');
  const s = await browser.status('s1');
  assert.equal(s.sound, true); assert.equal(s.muted, false);
  assert.deepEqual(await tabUrls('s1', 1), [`file://${page}`], 'the restart opens the tab again');

  // the same choice again changes nothing
  assert.equal((await browser.setSound('s1', true)).restarted, false);
  await browser.setSound('s1', false);
  assert.ok(mutedArg('s1'), 'muted again');
  assert.equal((await browser.status('s1')).muted, true);
});

test('the saved choice holds over a stop, a suspend and a resume, and a new browser is muted', { skip, timeout: 90000 }, async () => {
  // a stopped browser saves the choice without a start
  await browser.stop('s1');
  assert.equal((await browser.setSound('s1', true)).restarted, false);
  assert.equal(await browser.isRunning('s1'), false);
  assert.equal((await browser.status('s1')).muted, false, 'a stopped browser shows the sound of its next start');
  assert.equal(JSON.parse(readFileSync(join(browser.DIR, 's1', 'browser.json'), 'utf8')).sound, true, 'browser.json keeps the choice');
  await browser.ensure('s1');
  assert.equal(mutedArg('s1'), false);
  await browser.stop('s1', { suspended: true });
  await browser.ensure('s1');
  assert.equal(mutedArg('s1'), false, 'the resume keeps sound on');

  // a reset from the template keeps the choice of the task
  await browser.resetFromTemplate('s1');
  await browser.ensure('s1');
  assert.equal(mutedArg('s1'), false);

  // a removed browser starts muted again, like a browser that starts for the first time
  await browser.remove('s1');
  await browser.ensure('s1');
  assert.ok(mutedArg('s1'));
  await browser.stop('s1');
});

test('only the dashboard changes the sound', { skip, timeout: 60000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tb-sound-route-')));
  const tbdir = join(dir, 'tbdir'), vault = join(dir, 'vault'), work = join(dir, 'work');
  mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true }); mkdirSync(work);
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
  writeFileSync(join(vault, 'tasks', 's2.md'), `---\nid: s2\nnum: 1\ntitle: Task 1\nagent: claude\nstatus: idle\ncwd: ${work}\nfolder: ${work}\nsession: tb-sound-s2\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Task 1\n`);
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
  const socket = `tb-sound-route-${port}`, base = `http://127.0.0.1:${port}`;
  const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'sound-test' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/info')).ok) break; } catch { /* the server starts */ }
      await sleep(100);
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const post = (path: string, headers: Record<string, string>, body: object) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/tasks/s2/browser/sound', { 'x-taskboard-token': token }, { on: true })).status, 403, 'an agent or the tb tool cannot turn the sound on');
    const r = await post('/api/tasks/s2/browser/sound', { origin: base }, { on: true });
    const s = await r.json() as { sound: boolean; muted: boolean; restarted: boolean };
    assert.equal(r.status, 200, JSON.stringify(s));
    assert.deepEqual([s.sound, s.muted, s.restarted], [true, false, false]);
    assert.equal(JSON.parse(readFileSync(join(tbdir, 'browsers', 's2', 'browser.json'), 'utf8')).sound, true);
    const t = await post('/api/browser-template/sound', { origin: base }, { on: false });
    assert.equal(t.status, 200);
    assert.equal(((await t.json()) as { muted: boolean }).muted, true);
  } finally {
    child.kill();
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
  }
});
