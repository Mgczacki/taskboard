// The dashboard view of a task browser (attachViewer) with a real headless Chrome and the local test site
// tests/fixtures/popup-site.mjs, in a temporary Taskboard folder. The view is a stand-in for its WebSocket. Clicks go
// through the view (mouse messages), like the user's clicks. Each case checks whether the view switches to the new tab
// (the 'active' message with auto), how long that takes after the click, whether it goes back when a popup closes,
// and that a frame of the new tab follows. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import WebSocket from 'ws';
import { startPopupSite } from './fixtures/popup-site.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-popups-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-popups-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'popups-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const machine = await import('../server/machine.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
const ID = 'popups';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

let site: { url: string; close: () => void };
let port = 0, mainId = '';
type Sent = { at: number; type: string; [k: string]: any };
const sent: Sent[] = [];
let frames: number[] = [], lastActive = '';
const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => {
  if (typeof d !== 'string') { frames.push(Date.now()); return; }
  const m = { at: Date.now(), ...JSON.parse(d) };
  sent.push(m);
  if (m.type === 'active') lastActive = m.id;
} });
const emit = (m: object) => client.emit('message', JSON.stringify(m));
const click = (y: number, button = 'left', modifiers = 0) => {
  emit({ type: 'mouse', event: 'mousePressed', x: 100, y, button, buttons: button === 'left' ? 1 : 4, clickCount: 1, modifiers });
  emit({ type: 'mouse', event: 'mouseReleased', x: 100, y, button, buttons: 0, clickCount: 1, modifiers });
};
const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { id: string; type: string; url: string; title: string }[]).filter(t => t.type === 'page');
const shown = () => lastActive;
const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 5000) => { const end = Date.now() + ms; let good = false; while (!(good = await ok()) && Date.now() < end) await wait(25); assert.ok(good, what); };

before(async () => {
  if (skip) return;
  site = await startPopupSite();
  port = (await browser.ensure(ID)).port!;
  mainId = (await browser.openTab(ID, site.url + '/')).id;
  for (const t of await pages()) if (t.id !== mainId) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
  emit({ type: 'hello', acks: false });
  browser.attachViewer(client as unknown as WebSocket, ID, false);
  await until(() => shown() === mainId, 'the view shows the main page');
});
after(async () => { client.emit('close'); await browser.stop(ID).catch(() => {}); site?.close(); });

// Close the other tabs, show the main page again, and wait until the view is quiet.
async function reset() {
  for (const t of await pages()) if (t.id !== mainId) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
  await until(async () => (await pages()).length === 1, 'only the main page is open');
  emit({ type: 'select', id: mainId });
  await until(() => shown() === mainId, 'the view shows the main page');
  await wait(300);
  sent.length = 0; frames = [];
}
// The first switch by the view to a tab other than the main page, after `from`.
const switched = (reason?: string) => sent.find(m => m.type === 'active' && m.auto && m.id !== mainId && (!reason || m.auto.reason === reason));

test('a popup from a click takes the view within 150 ms, and a frame of the popup follows', { skip, timeout: 30000 }, async () => {
  await reset();
  const t0 = Date.now();
  click(40);
  await until(() => !!switched('popup'), 'the view switches to the popup');
  const s = switched('popup')!;
  assert.ok(s.at - t0 < 150, `the switch took ${s.at - t0} ms`);
  assert.equal(s.auto.from, mainId);
  const popup = (await pages()).find(t => t.url.endsWith('/popup?click'));
  assert.equal(s.id, popup?.id);
  await until(() => frames.some(f => f > s.at), 'a frame of the popup arrives');
  // keys and the mouse go to the shown tab: a key typed now reaches the popup
  assert.equal(shown(), popup?.id);
});

test('a link with target=_blank, a timer popup and a sized popup take the view', { skip, timeout: 30000 }, async () => {
  for (const [y, url] of [[290, '/target'], [90, '/popup?timer'], [140, '/popup?sized']] as const) {
    await reset();
    click(y);
    await until(() => !!switched('popup'), `the view switches to ${url}`);
    assert.equal(switched('popup')!.id, (await pages()).find(t => t.url.endsWith(url))?.id);
  }
});

test('an OAuth popup takes the view over two redirects, gives its token to the opener, and the view goes back to the opener', { skip, timeout: 30000 }, async () => {
  await reset();
  click(190);
  await until(() => !!switched('popup'), 'the view switches to the popup');
  const popup = switched('popup')!.id;
  await until(() => sent.some(m => m.type === 'active' && m.auto?.reason === 'back'), 'the view goes back when the popup closes');
  const back = sent.find(m => m.type === 'active' && m.auto?.reason === 'back')!;
  assert.equal(back.id, mainId);
  assert.equal(back.auto.from, popup);
  await until(async () => (await pages()).find(t => t.id === mainId)?.title === 'got token', 'the opener got the token');
});

test('a popup right after the user selected a tab takes the view (no 60 s wait)', { skip, timeout: 30000 }, async () => {
  await reset();
  emit({ type: 'select', id: mainId });
  await wait(100);
  click(40);
  await until(() => !!switched('popup'), 'the view switches to the popup');
});

test('two popups (the first from a click, the second from the page with a user gesture): the view goes back through both', { skip, timeout: 30000 }, async () => {
  await reset();
  click(40);
  await until(() => !!switched('popup'), 'the first popup');
  const first = switched('popup')!.id;
  // the second popup: the main page opens it (the user's next click would go to the popup that the view shows now)
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(list.find(t => t.id === mainId)!.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "window.open('/popup?two', 'two')", userGesture: true } }));
  await until(() => sent.some(m => m.type === 'active' && m.auto?.reason === 'popup' && m.id !== first), 'the second popup');
  ws.close();
  const second = sent.find(m => m.type === 'active' && m.auto?.reason === 'popup' && m.id !== first)!.id;
  await fetch(`http://127.0.0.1:${port}/json/close/${second}`);
  await until(() => sent.some(m => m.type === 'active' && m.auto?.reason === 'back' && m.id === first), `back to the first popup (${JSON.stringify({ first, second, main: mainId, active: sent.filter(m => m.type === 'active') })})`);
  await fetch(`http://127.0.0.1:${port}/json/close/${first}`);
  await until(() => sent.some(m => m.type === 'active' && m.auto?.reason === 'back' && m.id === mainId), 'back to the main page');
});

test('a tab that an agent opens with Target.createTarget takes the view', { skip, timeout: 30000 }, async () => {
  await reset();
  const { ws: browserWs } = await browser.ensure(ID);
  const t0 = Date.now();
  const { targetId } = await browser.once(browserWs, 'Target.createTarget', { url: site.url + '/popup?agent' });
  await until(() => !!switched('agent'), 'the view switches to the agent tab');
  assert.equal(switched('agent')!.id, targetId);
  assert.ok(switched('agent')!.at - t0 < 150, `the switch took ${switched('agent')!.at - t0} ms`);
});

test('a middle click and a Cmd click open background tabs: the view stays and offers them', { skip, timeout: 30000 }, async () => {
  for (const [button, modifiers] of [['middle', 0], ['left', 4]] as const) {
    await reset();
    click(340, button, modifiers);
    await until(() => sent.some(m => m.type === 'offer'), `the view offers the tab (${button} ${modifiers})`);
    const offer = sent.find(m => m.type === 'offer')!;
    assert.equal(offer.reason, 'background');
    await until(async () => (await pages()).some(t => t.url.endsWith('/bgtarget')), 'Chrome lists the background tab');
    assert.equal(offer.id, (await pages()).find(t => t.url.endsWith('/bgtarget'))?.id);
    await wait(300);
    assert.equal(shown(), mainId, 'the view stays on the main page');
    assert.ok(!switched(), 'no switch');
  }
});

test('a blank popup that closes at once does not take the view', { skip, timeout: 30000 }, async () => {
  await reset();
  click(390);
  await wait(1500);
  assert.ok(!switched(), `no switch (${JSON.stringify(sent.filter(m => m.type === 'active'))})`);
  assert.equal(shown(), mainId);
});

test('with the switch off for this browser the view offers a popup; the Settings choice applies when the override is gone', { skip, timeout: 30000 }, async () => {
  await reset();
  emit({ type: 'autoSwitch', on: false });
  await until(() => browser.readMeta(ID).autoSwitch === false, 'the override is saved');
  sent.length = 0;
  click(40);
  await until(() => sent.some(m => m.type === 'offer'), 'the view offers the popup');
  assert.equal(sent.find(m => m.type === 'offer')!.reason, 'off');
  await until(() => sent.some(m => m.type === 'tabs' && m.autoSwitch === false && m.autoSwitchOwn === true), 'the tab list says the switch is off for this browser');
  assert.ok(!switched());
  // the same choice as Settings removes the override
  emit({ type: 'autoSwitch', on: true });
  await until(() => browser.readMeta(ID).autoSwitch === undefined, 'the override is gone');
  machine.update({ browserAutoSwitch: false });
  try { assert.equal(browser.autoSwitchOn(ID), false, 'Settings off'); } finally { machine.update({ browserAutoSwitch: true }); }
  assert.equal(browser.autoSwitchOn(ID), true);
});

test('a popup that a page opens in a timer without a click is blocked by Chrome: no tab, no switch', { skip, timeout: 30000 }, async () => {
  await reset();
  emit({ type: 'nav', action: 'go', url: site.url + '/?autotimer=1' });
  await wait(1500);
  assert.equal((await pages()).length, 1, 'Chrome opened no popup');
  assert.ok(!switched());
  emit({ type: 'nav', action: 'go', url: site.url + '/' });
  await until(async () => (await pages()).find(t => t.id === mainId)?.url === site.url + '/', 'the main page is back');
});
