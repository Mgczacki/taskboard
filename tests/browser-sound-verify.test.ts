// The real state of the sound of a task browser (judge, checkSound, checkSounds and the --mute-audio start flag in
// server/task-browser.ts), with a real headless Chrome in a temporary Taskboard folder and a local page that plays a
// very quiet tone (Web Audio, gain 0.003, no network). The test reads each tab's mutedInfo.muted and audible from
// Chrome through the sound extension. A tab that is audible and not muted is heard. Cases: a start with the sound off;
// a tab in another browser context (chrome-devtools-mcp new_page with isolatedContext), which the extension cannot
// mute; a popup; a Chrome that the server finds running (a server restart); a browser with no check yet (a Chrome
// from an older release); a task browser in a window (Open in a window). The window runs with --headless added by a
// stand-in for Chrome, so no window appears. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-sound-verify-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-sound-verify-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'sound-verify-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const machine = await import('../server/machine.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
const IDS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
after(async () => { for (const id of IDS) await browser.stop(id).catch(() => {}); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const args = (id: string) => execFileSync('ps', ['-o', 'command=', '-p', String(browser.readMeta(id).pid)], { encoding: 'utf8' });
const TONE = (() => {
  const f = join(root, 'tone.html');
  writeFileSync(f, `<!doctype html><title>tone</title><script>
window.play = () => { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.003; o.connect(g).connect(c.destination); o.start(); setTimeout(() => c.close(), 8000); return c.state; };
</script>`);
  return `file://${f}`;
})();

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
// Each tab's state as Chrome reports it to the sound extension (loaded first when its service worker does not run).
// The read does not change a mute: it only lists the tabs.
type TabState = { muted: boolean; audible: boolean; incognito: boolean };
const EXT_DIR = join(process.env.TASKBOARD_DIR!, 'browser-extension');
async function tabStates(id: string): Promise<TabState[]> {
  browser.writeExtension(); // a start with --mute-audio does not load the extension
  const c = await connect(id);
  try {
    const worker = async (ext: string) => (await c.call('Target.getTargets')).targetInfos.find((t: { type: string; url: string }) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ext}/`));
    let ext = (await c.call('Extensions.getExtensions')).extensions.find((e: { path: string }) => e.path === EXT_DIR)?.id as string;
    if (!ext || !(await worker(ext))) ext = (await c.call('Extensions.loadUnpacked', { path: EXT_DIR })).id;
    for (let i = 0; ; i++) {
      try {
        const { sessionId } = await c.call('Target.attachToTarget', { targetId: (await worker(ext))?.targetId, flatten: true });
        return await c.evaluate('chrome.tabs.query({}).then(ts => ts.map(t => ({ muted: !!t.mutedInfo?.muted, audible: !!t.audible, incognito: !!t.incognito })))', sessionId);
      } catch (e) { if (i > 50) throw e; await sleep(100); }
    }
  } finally { c.close(); }
}
const heard = (list: TabState[]) => list.filter(t => t.audible && !t.muted).length;
const audible = (list: TabState[]) => list.filter(t => t.audible).length;
// Open the tone page in a new tab (in another browser context with isolated) and start the tone.
async function playTone(id: string, opts: { isolated?: boolean } = {}) {
  const c = await connect(id);
  try {
    const ctx = opts.isolated ? (await c.call('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId : undefined;
    const { targetId } = await c.call('Target.createTarget', { url: TONE, ...(ctx ? { browserContextId: ctx } : {}) });
    const { sessionId } = await c.call('Target.attachToTarget', { targetId, flatten: true });
    await waitFor(async () => await c.evaluate('typeof window.play', sessionId).catch(() => '') === 'function', { description: 'the tone page to load', timeoutMs: 15000 });
    await c.evaluate('play()', sessionId);
    return targetId as string;
  } finally { c.close(); }
}
// Chrome marks a tab audible after the sound starts: wait for the expected number of audible tabs
async function waitAudible(id: string, n: number) {
  let seen: TabState[] = [];
  await waitFor(async () => { seen = await tabStates(id); return audible(seen) >= n; }, { description: `${n} audible tab(s) in ${id}`, timeoutMs: 15000, state: () => JSON.stringify(seen) });
  return seen;
}

test('judge: the state from the wanted state, the start flag and the tabs', () => {
  const at = 'x';
  assert.deepEqual(browser.judge(false, false, {}, at), { state: 'on', at });
  assert.deepEqual(browser.judge(true, true, { error: 'no extension' }, at), { state: 'muted', how: 'flag', at });
  assert.deepEqual(browser.judge(true, false, { tabs: [{ muted: true, audible: true }] }, at), { state: 'muted', how: 'tabs', at });
  assert.equal(browser.judge(true, false, { error: 'The connection to Chrome closed.' }, at).state, 'unverified');
  const r = browser.judge(true, false, { tabs: [{ muted: true, audible: false }, { muted: false, audible: true, incognito: true }] }, at);
  assert.equal(r.state, 'unverified');
  assert.match(r.reason!, /1 tab is not muted, 1 of them audible \(a tab in another browser context/);
  const o = browser.judge(true, false, { tabs: [{ muted: true, audible: false }], otherContexts: 1 }, at);
  assert.equal(o.state, 'unverified');
  assert.match(o.reason!, /1 page is in another browser context/);
  assert.equal(browser.hasMuteFlag(process.pid), false);
  assert.equal(browser.hasMuteFlag(undefined), false);
});

test('a start with the sound off: the tone is not audible (--mute-audio)', { skip, timeout: 90000 }, async () => {
  await browser.ensure('v1');
  assert.ok(args('v1').includes('--mute-audio'));
  await playTone('v1');
  await playTone('v1', { isolated: true });
  await sleep(2500);
  const list = await tabStates('v1');
  assert.equal(audible(list), 0, `Chrome with --mute-audio reports no audible tab: ${JSON.stringify(list)}`);
  assert.equal((await browser.status('v1')).soundState, 'muted');
  await browser.stop('v1');
});

test('a tab in another browser context is heard without the flag, and the check restarts the browser with --mute-audio', { skip, timeout: 120000 }, async () => {
  // the sound on, then off again: the browser runs without the flag, and the extension mutes its tabs
  browser.updateMeta('v2', { sound: true });
  await browser.ensure('v2');
  assert.equal(args('v2').includes('--mute-audio'), false);
  assert.equal((await browser.setSound('v2', false)).restarted, false);
  assert.equal((await browser.status('v2')).soundState, 'muted');
  const pid = browser.readMeta('v2').pid;
  // a normal tab with the tone: muted, so not heard
  await playTone('v2');
  let list = await waitAudible('v2', 1);
  assert.equal(heard(list), 0, JSON.stringify(list));
  // a tab in another browser context: the extension cannot mute it, and without the flag its tone is heard (the
  // reported problem, seen with the read of the tabs before this change). The new tab runs the check after 1.5 s,
  // and the check restarts the browser with the flag, without a call from the test.
  await playTone('v2', { isolated: true });
  await waitFor(async () => browser.readMeta('v2').pid !== pid && browser.readMeta('v2').soundCheck?.how === 'flag', { description: 'the restart with --mute-audio', timeoutMs: 60000, state: () => JSON.stringify(browser.readMeta('v2')) });
  assert.ok(args('v2').includes('--mute-audio'));
  assert.equal((await browser.status('v2')).soundState, 'muted');
  await playTone('v2', { isolated: true });
  await sleep(2500);
  assert.equal(audible(await tabStates('v2')), 0);
  await browser.stop('v2');
});

test('a popup with the tone in a browser muted by the extension is muted', { skip, timeout: 90000 }, async () => {
  browser.updateMeta('v3', { sound: true });
  await browser.ensure('v3');
  await browser.setSound('v3', false);
  const opener = await browser.openTab('v3', TONE);
  const c = await connect('v3');
  const { sessionId } = await c.call('Target.attachToTarget', { targetId: opener.id, flatten: true });
  await c.evaluate(`window.open(${JSON.stringify(TONE)}, '_blank', 'popup') ? 1 : 0`, sessionId);
  c.close();
  const popup = await waitFor(async () => (await browser.tabs('v3')).filter(t => t.url === TONE && t.id !== opener.id)[0], { description: 'the popup', timeoutMs: 15000 });
  const p = await connect('v3');
  const s = await p.call('Target.attachToTarget', { targetId: popup.id, flatten: true });
  await waitFor(async () => await p.evaluate('typeof window.play', s.sessionId).catch(() => '') === 'function', { description: 'the popup page', timeoutMs: 15000 });
  await p.evaluate('play()', s.sessionId);
  p.close();
  const list = await waitAudible('v3', 1);
  assert.equal(heard(list), 0, JSON.stringify(list));
  assert.equal((await browser.checkSound('v3'))?.state, 'muted');
  await browser.stop('v3');
});

test('a Chrome that the server finds running keeps or fixes its mute', { skip, timeout: 120000 }, async () => {
  // a Chrome without the flag (sound on) that holds the profile when browser.json lost it, and the sound is off now
  browser.updateMeta('v4', { sound: true });
  await browser.ensure('v4');
  const pid = browser.readMeta('v4').pid;
  browser.updateMeta('v4', { pid: undefined, port: undefined, sound: undefined });
  await browser.ensure('v4');
  assert.equal(browser.readMeta('v4').pid, pid, 'the same Chrome is used again');
  assert.deepEqual([browser.readMeta('v4').soundCheck?.state, browser.readMeta('v4').soundCheck?.how], ['muted', 'tabs']);
  assert.equal(heard(await tabStates('v4')), 0);
  // a Chrome with the flag that holds the profile, and the sound is on now: it starts again without the flag
  await browser.stop('v4');
  await browser.ensure('v4');
  const flagged = browser.readMeta('v4').pid;
  assert.ok(args('v4').includes('--mute-audio'));
  browser.updateMeta('v4', { pid: undefined, port: undefined, sound: true });
  await browser.ensure('v4');
  assert.notEqual(browser.readMeta('v4').pid, flagged);
  assert.equal(args('v4').includes('--mute-audio'), false);
  assert.equal((await browser.status('v4')).soundState, 'on');
  await browser.stop('v4');
});

test('a running browser without a check shows unverified until checkSounds reads it', { skip, timeout: 90000 }, async () => {
  browser.updateMeta('v5', { sound: true });
  await browser.ensure('v5');
  await browser.setSound('v5', false);
  // as a Chrome that an older release started: no soundCheck in browser.json
  browser.updateMeta('v5', { soundCheck: undefined });
  const s = await browser.status('v5');
  assert.equal(s.soundState, 'unverified');
  assert.match(s.soundReason!, /not checked/);
  await browser.checkSounds();
  assert.equal((await browser.status('v5')).soundState, 'muted');
  await browser.stop('v5');
});

test('a task browser in a window (Open in a window) starts with --mute-audio', { skip, timeout: 90000 }, async () => {
  // the stand-in adds --headless, so no window appears; the start flags are those of the window
  const wrapper = join(root, 'chrome-hidden.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(browser.chromePath())} --headless=new "$@"\n`);
  chmodSync(wrapper, 0o755);
  machine.update({ chromePath: wrapper });
  try {
    browser.updateMeta('v6', { window: true });
    await browser.ensure('v6');
    const a = args('v6');
    assert.ok(a.includes('--disable-blink-features=AutomationControlled'), 'the flags of a window');
    assert.ok(a.includes('--mute-audio'));
    await playTone('v6');
    await sleep(2500);
    assert.equal(audible(await tabStates('v6')), 0);
    assert.equal((await browser.status('v6')).soundState, 'muted');
  } finally { await browser.stop('v6').catch(() => {}); machine.update({ chromePath: '' }); }
});
