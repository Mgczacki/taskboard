// The sound switch of a task browser (setSound and muteTabs in server/task-browser.ts) with a real headless Chrome in a
// temporary Taskboard folder. The test reads the mute state of each tab from Chrome (chrome.tabs in the sound
// extension). Checks: a first start is muted; the switch changes a running browser at once, without a restart, with
// its tabs and its agent connection; a new page, a reload, a popup and a new start of the extension keep the state;
// the saved choice holds over a stop, a suspend and a resume; a Chrome that cannot load the extension starts with
// --mute-audio. The route test runs a test server with its own port, folders and tmux socket. Skipped when Chrome is
// not installed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
const machine = await import('../server/machine.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
after(async () => { for (const id of ['template', 's1', 's3']) await browser.stop(id).catch(() => {}); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// the command line of the browser's main Chrome process
const args = (id: string) => execFileSync('ps', ['-o', 'command=', '-p', String(browser.readMeta(id).pid)], { encoding: 'utf8' });

// A DevTools connection to the browser of this id.
async function connect(id: string) {
  const v = await (await fetch(`http://127.0.0.1:${browser.readMeta(id).port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let next = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } });
  const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const n = ++next; waiting.set(n, m => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (expression: string, sessionId: string) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, userGesture: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { call, evaluate, close: () => ws.close() };
}
// The mute state of each tab, as Chrome reports it to the sound extension: { url: muted }. reload loads the extension
// again first, as muteTabs does when Chrome stopped the idle service worker.
const EXT_DIR = join(process.env.TASKBOARD_DIR!, 'browser-extension');
async function mutes(id: string, reload = false): Promise<Record<string, boolean>> {
  const c = await connect(id);
  try {
    const worker = async (ext: string) => (await c.call('Target.getTargets')).targetInfos.find((t: { type: string; url: string }) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ext}/`));
    let ext = (await c.call('Extensions.getExtensions')).extensions.find((e: { path: string }) => e.path === EXT_DIR)?.id as string;
    if (reload || !ext || !(await worker(ext))) {
      ext = (await c.call('Extensions.loadUnpacked', { path: EXT_DIR })).id;
      await sleep(1000); // the old service worker ends
    }
    // a tab that opened a moment ago can wait for its tabs.onCreated handler
    await sleep(300);
    for (let i = 0; ; i++) {
      try {
        const { sessionId } = await c.call('Target.attachToTarget', { targetId: (await worker(ext))?.targetId, flatten: true });
        const list = await c.evaluate('chrome.tabs.query({}).then(ts => ts.map(t => [t.url || t.pendingUrl, !!t.mutedInfo?.muted]))', sessionId) as [string, boolean][];
        return Object.fromEntries(list);
      } catch (e) { if (i > 50) throw e; await sleep(100); }
    }
  } finally { c.close(); }
}
const allMuted = async (id: string, want: boolean) => {
  const m = await mutes(id);
  assert.ok(Object.keys(m).length > 0, 'the browser has tabs');
  assert.deepEqual(Object.entries(m).filter(([, v]) => v !== want), [], `every tab is ${want ? 'muted' : 'not muted'}`);
  return m;
};
// Run an expression in the page of the tab with this id.
async function inPage(id: string, tabId: string, expression: string) {
  const c = await connect(id);
  try {
    const { sessionId } = await c.call('Target.attachToTarget', { targetId: tabId, flatten: true });
    return await c.evaluate(expression, sessionId);
  } finally { c.close(); }
}
const tabIds = async (id: string) => (await browser.tabs(id)).map(t => t.id).sort();
const page = (name: string) => { const f = join(root, `${name}.html`); writeFileSync(f, `<title>${name}</title>`); return `file://${f}`; };

test('a first start is muted, for a task browser and for the template', { skip, timeout: 60000 }, async () => {
  await browser.ensure(browser.TEMPLATE);
  await allMuted(browser.TEMPLATE, true);
  await browser.stop(browser.TEMPLATE);
  await browser.ensure('s1');
  assert.equal(args('s1').includes('--mute-audio'), false, 'the mute comes from the tabs, not from a start flag');
  await allMuted('s1', true);
  const s = await browser.status('s1');
  assert.equal(s.muted, true); assert.equal(s.sound, false);
  assert.equal(browser.readMeta('s1').muted, true);
});

test('the switch changes a running browser at once: no restart, the tabs and the agent connection stay', { skip, timeout: 90000 }, async () => {
  const kept = page('kept');
  await browser.openTab('s1', kept);
  const pid = browser.readMeta('s1').pid, before = await tabIds('s1');

  // a DevTools connection of an agent, through the Taskboard server's forwarding code
  const agent = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send() {}, close() {} }) as unknown as WebSocket;
  browser.proxyAgent(agent, 's1');
  assert.equal(browser.agentCount('s1'), 1);

  const r = await browser.setSound('s1', true);
  assert.equal(r.restarted, false);
  assert.equal(browser.readMeta('s1').pid, pid, 'the same Chrome process');
  assert.deepEqual(await tabIds('s1'), before, 'the same tabs');
  assert.equal(browser.agentCount('s1'), 1, 'the agent connection stays open');
  assert.equal((await allMuted('s1', false))[kept], false);
  const s = await browser.status('s1');
  assert.equal(s.sound, true); assert.equal(s.muted, false);

  assert.equal((await browser.setSound('s1', false)).restarted, false);
  assert.equal(browser.readMeta('s1').pid, pid);
  assert.deepEqual(await tabIds('s1'), before);
  await allMuted('s1', true);
  assert.equal((await browser.status('s1')).muted, true);
  assert.equal(browser.agentCount('s1'), 1);
  (agent as unknown as EventEmitter).emit('close');

  // the same choice again changes nothing
  assert.equal((await browser.setSound('s1', false)).restarted, false);
  await allMuted('s1', true);
});

test('a new page, a reload, a popup and a new start of the extension keep the state', { skip, timeout: 90000 }, async () => {
  for (const on of [true, false]) {
    await browser.setSound('s1', on);
    const t = await browser.openTab('s1', page(`new-${on}`));
    assert.equal((await mutes('s1'))[t.url], !on, 'a new page');
    await inPage('s1', t.id, 'location.reload(), 1');
    await sleep(500);
    assert.equal((await mutes('s1'))[t.url], !on, 'a reload');
    const popup = page(`popup-${on}`);
    await inPage('s1', t.id, `window.open(${JSON.stringify(popup)}, '_blank', 'popup') ? 1 : 0`);
    await sleep(500);
    assert.equal((await mutes('s1'))[popup], !on, 'a popup');
    // a new start of the extension (muteTabs loads it again after Chrome stopped its idle service worker)
    const after = await mutes('s1', true);
    assert.deepEqual(Object.entries(after).filter(([, v]) => v !== !on), [], 'a new start of the extension');
    assert.equal((await browser.setSound('s1', on)).restarted, false);
    await allMuted('s1', !on);
  }
});

test('the saved choice holds over a stop, a suspend and a resume, and a new browser is muted', { skip, timeout: 120000 }, async () => {
  await browser.setSound('s1', true);
  await browser.stop('s1');
  assert.equal(await browser.isRunning('s1'), false);
  assert.equal((await browser.status('s1')).muted, false, 'a stopped browser shows the sound of its next start');
  assert.equal(JSON.parse(readFileSync(join(browser.DIR, 's1', 'browser.json'), 'utf8')).sound, true, 'browser.json keeps the choice');
  await browser.ensure('s1');
  await allMuted('s1', false);
  await browser.stop('s1', { suspended: true });
  await browser.ensure('s1');
  await allMuted('s1', false);

  // a stopped browser saves the choice without a start
  await browser.stop('s1');
  assert.equal((await browser.setSound('s1', false)).restarted, false);
  assert.equal(await browser.isRunning('s1'), false);
  await browser.ensure('s1');
  await allMuted('s1', true);

  // a reset from the template keeps the choice of the task
  await browser.setSound('s1', true);
  await browser.resetFromTemplate('s1');
  await browser.ensure('s1');
  await allMuted('s1', false);

  // a removed browser starts muted again, like a browser that starts for the first time
  await browser.remove('s1');
  await browser.ensure('s1');
  await allMuted('s1', true);
  await browser.stop('s1');
});

test('a Chrome that cannot load the extension starts with --mute-audio, and the switch restarts it', { skip, timeout: 90000 }, async () => {
  // a Chrome program that cannot load extensions
  const wrapper = join(root, 'chrome-without-extensions.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(browser.chromePath())} --disable-extensions "$@"\n`);
  chmodSync(wrapper, 0o755);
  machine.update({ chromePath: wrapper });
  try {
    assert.equal(browser.chromePath(), wrapper);
    await browser.ensure('s3');
    assert.ok(args('s3').includes('--mute-audio'));
    assert.equal(browser.readMeta('s3').muteFlag, true);
    const pid = browser.readMeta('s3').pid;
    assert.equal((await browser.setSound('s3', true)).restarted, true);
    assert.notEqual(browser.readMeta('s3').pid, pid);
    assert.equal(args('s3').includes('--mute-audio'), false);
    assert.equal((await browser.status('s3')).muted, false);
    assert.equal((await browser.setSound('s3', false)).restarted, true);
    assert.ok(args('s3').includes('--mute-audio'));
  } finally { await browser.stop('s3').catch(() => {}); machine.update({ chromePath: '' }); }
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
