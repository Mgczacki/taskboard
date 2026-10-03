// The browser of a task (server/task-browser.ts) with a real headless Chrome in a temporary Taskboard folder:
// the template copy with its cookies, a stop that keeps the open pages for the next start, the refusal to copy an
// open template, and the key that lets only one task's agents reach its browser. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-browser-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-browser-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'browser-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const machine = await import('../server/machine.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
after(async () => { for (const id of ['template', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']) await browser.stop(id).catch(() => {}); });

function cdp(wsUrl: string, method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
    ws.on('error', reject);
  });
}

test('keys differ between tasks and the address names the task', { skip }, () => {
  assert.notEqual(browser.cdpKey('a'), browser.cdpKey('b'));
  assert.match(browser.cdpUrl('a'), /\/ws\/cdp\/a\?key=[0-9a-f]{32}$/);
});

test('a new task browser copies the template profile with its cookies', { skip, timeout: 60000 }, async () => {
  const t = await browser.ensure(browser.TEMPLATE);
  await cdp(t.ws, 'Storage.setCookies', { cookies: [{ name: 'signed_in', value: 'yes', domain: 'example.com', path: '/', expires: Date.now() / 1000 + 3600 }] });
  await assert.rejects(browser.ensure('b1'), /template browser is open/);
  await browser.stop(browser.TEMPLATE);
  const b = await browser.ensure('b1');
  const { cookies } = await cdp(b.ws, 'Storage.getCookies');
  assert.ok(cookies.some((c: { name: string; value: string }) => c.name === 'signed_in' && c.value === 'yes'));
  assert.ok(browser.readMeta('b1').copiedFromTemplate);
  assert.ok(!existsSync(join(browser.profileDir('b1'), 'SingletonLock')) || (await browser.isRunning('b1')), 'no lock file was copied');
});

test('a stop keeps the open pages and the next start opens them again', { skip, timeout: 60000 }, async () => {
  const page = join(root, 'page.html'); writeFileSync(page, '<title>kept</title>');
  const page2 = join(root, 'page2.html'); writeFileSync(page2, '<title>kept 2</title>');
  await browser.ensure('b2');
  await browser.openTab('b2', 'data:text/html,<title>first</title>');
  await browser.openTab('b2', 'about:blank');
  // only http, https and file pages are kept
  await browser.openTab('b2', `file://${page}`);
  await browser.openTab('b2', `file://${page2}`);
  await browser.stop('b2', { suspended: true });
  assert.equal(await browser.isRunning('b2'), false);
  const meta = browser.readMeta('b2');
  assert.equal(meta.suspended, true);
  assert.deepEqual([...(meta.tabs || [])].sort(), [`file://${page}`, `file://${page2}`]);
  await browser.ensure('b2');
  // Chrome opens and closes the tabs a moment after the start
  const want = JSON.stringify([`file://${page}`, `file://${page2}`]);
  let urls: string[] = [];
  for (let i = 0; i < 50 && JSON.stringify(urls) !== want; i++) { urls = (await browser.tabs('b2')).map(t => t.url).sort(); await new Promise(r => setTimeout(r, 100)); }
  assert.equal(JSON.stringify(urls), want, 'both kept pages opened again, and no blank start page is left');
  assert.equal(browser.readMeta('b2').suspended, undefined);
});

test('status reports a running browser and its memory', { skip, timeout: 30000 }, async () => {
  const s = await browser.status('b2');
  assert.equal(s.running, true);
  assert.ok((s.rssMb || 0) > 0);
  await browser.stop('b2');
  assert.equal((await browser.status('b2')).running, false);
});

// The dashboard view (attachViewer) with a stand-in for its WebSocket: frames arrive as binary JPEG messages, the letters
// c, n and t typed in the view reach a search box of the page, ⌘A selects, and ⌘C / ⌘X (a 'copy' message) return the
// selected text of the page.
test('keys typed in the view reach the page, and copy returns the selected text', { skip, timeout: 60000 }, async () => {
  const b = await browser.ensure('b3');
  const tab = await browser.openTab('b3', 'data:text/html,<input id="q" type="search" value="hello world">');
  const sent: any[] = [];
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => sent.push(typeof d === 'string' ? JSON.parse(d) : { type: 'binary', jpeg: d[0] === 0xff && d[1] === 0xd8 }) });
  browser.attachViewer(client as unknown as WebSocket, 'b3', false);
  const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 100)); assert.ok(ok(), what); };
  client.emit('message', JSON.stringify({ type: 'select', id: tab.id }));
  await until(() => sent.some(m => m.type === 'active' && m.id === tab.id), 'the view shows the tab');
  await until(() => sent.some(m => m.type === 'binary'), 'a frame arrives as a binary message');
  assert.ok(sent.find(m => m.type === 'binary').jpeg, 'the frame is JPEG bytes');
  assert.ok(sent.some(m => m.type === 'frameSize' && m.w > 0 && m.h > 0), 'the size of the frame comes before it');
  const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
  const pageWs = list.find(x => x.id === tab.id)!.webSocketDebuggerUrl;
  const value = async (js: string) => (await cdp(pageWs, 'Runtime.evaluate', { expression: js, returnByValue: true })).result.value;
  await value('q.focus(), q.setSelectionRange(0, 5)');
  client.emit('message', JSON.stringify({ type: 'copy' }));
  await until(() => sent.some(m => m.type === 'copied'), 'the view gets the copied text');
  assert.equal(sent.find(m => m.type === 'copied').text, 'hello');
  await value('q.value = "", q.focus()');
  for (const k of ['c', 'n', 't']) {
    const code = 'Key' + k.toUpperCase(), keyCode = k.toUpperCase().charCodeAt(0);
    client.emit('message', JSON.stringify({ type: 'key', down: true, key: k, code, keyCode, modifiers: 0 }));
    client.emit('message', JSON.stringify({ type: 'key', down: false, key: k, code, keyCode, modifiers: 0 }));
  }
  let typed = '';
  for (let i = 0; i < 50 && typed !== 'cnt'; i++) { typed = await value('q.value'); await new Promise(r => setTimeout(r, 100)); }
  assert.equal(typed, 'cnt');
  // ⌘A selects the text of the box, ⌘C copies it, and ⌘X (copy with cut) copies and deletes it
  client.emit('message', JSON.stringify({ type: 'key', down: true, key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 }));
  client.emit('message', JSON.stringify({ type: 'key', down: false, key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 }));
  let selected = '';
  for (let i = 0; i < 50 && selected !== 'cnt'; i++) { selected = await value('q.value.slice(q.selectionStart, q.selectionEnd)'); await new Promise(r => setTimeout(r, 100)); }
  assert.equal(selected, 'cnt', '⌘A selects all');
  sent.length = 0;
  client.emit('message', JSON.stringify({ type: 'copy', cut: true }));
  await until(() => sent.some(m => m.type === 'copied'), 'the view gets the cut text');
  assert.equal(sent.find(m => m.type === 'copied').text, 'cnt');
  let left = 'cnt';
  for (let i = 0; i < 50 && left !== ''; i++) { left = await value('q.value'); await new Promise(r => setTimeout(r, 100)); }
  assert.equal(left, '', '⌘X deletes the selection');
  client.emit('close');
});

// A dialog of a page (here prompt()) shows in the tab list that the view gets, and the view's answer reaches the page:
// the page puts the answer in its title. Chrome opens a dialog of a background tab only when that tab comes to the
// front, so the view shows the tab first.
test('the view sees a dialog of a page and answers it', { skip, timeout: 60000 }, async () => {
  const b = await browser.ensure('b5');
  const tab = await browser.openTab('b5', `data:text/html,<title>ask</title><script>setTimeout(() => { document.title = 'answer ' + prompt('Your name?', 'Mario') }, 500)</script>`);
  const sent: any[] = [];
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => { if (typeof d === 'string') sent.push(JSON.parse(d)); } });
  browser.attachViewer(client as unknown as WebSocket, 'b5', false);
  const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 150 && !ok(); i++) await new Promise(r => setTimeout(r, 100)); assert.ok(ok(), what); };
  const shown = () => [...sent].reverse().find(m => m.type === 'tabs')?.tabs.find((t: any) => t.id === tab.id);
  client.emit('message', JSON.stringify({ type: 'select', id: tab.id }));
  await until(() => shown()?.dialog?.type === 'prompt', 'the tab list reports the prompt');
  assert.deepEqual(shown().dialog, { type: 'prompt', message: 'Your name?', defaultPrompt: 'Mario' });
  client.emit('message', JSON.stringify({ type: 'dialog', id: tab.id, accept: true, text: 'Ada' }));
  await until(() => !shown()?.dialog, 'the dialog is gone from the tab list');
  let title = '';
  for (let i = 0; i < 50 && title !== 'answer Ada'; i++) {
    const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json() as { id: string; title: string }[];
    title = list.find(x => x.id === tab.id)?.title || ''; await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(title, 'answer Ada', 'the page got the answer');
  client.emit('close');
});

// Settings → Task browsers → Sharp view: a browser that starts with it streams frames with two pixels for each CSS
// pixel, and the page keeps its CSS size (the view's size message sets 800 x 600).
test('the sharp view streams frames twice the size of the page', { skip, timeout: 60000 }, async () => {
  machine.update({ browserSharp: true });
  try {
    await browser.ensure('b4');
    assert.equal((await browser.status('b4')).sharp, true);
    const tab = await browser.openTab('b4', 'data:text/html,<h1>Sharp</h1>');
    const sent: any[] = [];
    const jpegs: string[] = [];
    const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => {
      if (typeof d === 'string') { sent.push(JSON.parse(d)); return; }
      for (let i = 2; i < d.length - 9; i++) if (d[i] === 0xff && (d[i + 1] === 0xc0 || d[i + 1] === 0xc2)) { jpegs.push(`${d.readUInt16BE(i + 7)}x${d.readUInt16BE(i + 5)}`); break; }
    } });
    browser.attachViewer(client as unknown as WebSocket, 'b4', false);
    client.emit('message', JSON.stringify({ type: 'size', w: 800, h: 600 }));
    client.emit('message', JSON.stringify({ type: 'select', id: tab.id }));
    // the first frame after the size change can still have the old shape; the next one has the new size
    for (let i = 0; i < 100 && !jpegs.includes('1600x1200'); i++) await new Promise(r => setTimeout(r, 100));
    client.emit('close');
    assert.ok(jpegs.includes('1600x1200'), `a frame has two pixels for each CSS pixel (frames: ${jpegs.join(', ')})`);
  } finally { machine.update({ browserSharp: false }); await browser.stop('b4'); }
  assert.equal((await browser.status('b4')).sharp, false);
});

// Settings → Task browsers → Picture, 'screen': a view reports the device pixel ratio of its screen ('hello' with dpr),
// and a browser that starts later uses it, also when no view is open then (browsers/screen.json).
test('a browser starts with the pixel density of the screen that a view reported', { skip, timeout: 60000 }, async () => {
  machine.update({ browserScale: 'screen' });
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: () => {} });
  browser.attachViewer(client as unknown as WebSocket, 'b6', false);
  client.emit('message', JSON.stringify({ type: 'hello', acks: true, dpr: 2.2 }));
  client.emit('close');
  assert.equal(browser.startScale(), 2.25, 'the ratio is kept in steps of 0.25');
  machine.update({ browserScale: 'one' });
  assert.equal(browser.startScale(), 1);
  machine.update({ browserScale: 'screen' });
  try {
    await browser.ensure('b6');
    const st = await browser.status('b6');
    assert.equal(st.sharp, true);
    assert.equal(browser.readMeta('b6').scale, 2.25);
  } finally { browser.noteScreen(1); await browser.stop('b6'); }
});

// A view that sends 'hello' with acks (the dashboard): the server sends at most two frames that the view did not
// report as drawn, and about one each second after that (HELD_MS). Reports let the frames flow again. A hidden view
// ('visible' false) gets no frames, and gets a frame soon after it shows again. A mouse move over a link gives the
// view the pointer cursor.
test('the view gets frames only as fast as it draws them, none while hidden, and the page cursor', { skip, timeout: 60000 }, async () => {
  await browser.ensure('b6');
  const tab = await browser.openTab('b6', 'data:text/html,' + encodeURIComponent(`<style>body{margin:0}a{display:block;height:200px;font-size:40px}</style><a href="#x">link</a><div id=d style="height:200px"></div><script>let n=0;(function f(){d.style.background='hsl('+(n++%360)+',70%,50%)';requestAnimationFrame(f)})()</script>`));
  const sent: any[] = [];
  let frames = 0, report = false;
  const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => {
    if (typeof d === 'string') { sent.push(JSON.parse(d)); return; }
    frames++;
    if (report) setTimeout(() => client.emit('message', JSON.stringify({ type: 'drawn' })), 5);
  } });
  const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 100)); assert.ok(ok(), what); };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  browser.attachViewer(client as unknown as WebSocket, 'b6', false);
  client.emit('message', JSON.stringify({ type: 'hello', acks: true }));
  client.emit('message', JSON.stringify({ type: 'select', id: tab.id }));
  await until(() => frames >= 2, `the first two frames arrive (got ${frames})`);
  await wait(300); const held = frames; await wait(1500);
  assert.ok(held <= 3, `at most two frames (and one in the start) without a report (got ${held})`);
  assert.ok(frames - held <= 4, `about one frame each second without a report (got ${frames - held} in 1.5 s)`);
  // hidden while frames wait for a report: after the stop and the new start of the screencast, frames flow again
  client.emit('message', JSON.stringify({ type: 'visible', on: false }));
  await wait(500); const hidden = frames; await wait(1000);
  assert.equal(frames - hidden, 0, 'no frames while the view is hidden');
  report = true;
  client.emit('message', JSON.stringify({ type: 'visible', on: true }));
  client.emit('message', JSON.stringify({ type: 'drawn' })); client.emit('message', JSON.stringify({ type: 'drawn' }));
  await until(() => frames > hidden, 'a frame arrives when the view shows again');
  const flowing = frames; await wait(1000);
  assert.ok(frames - flowing >= 10, `frames flow again when the view reports them (got ${frames - flowing} in 1 s)`);
  client.emit('message', JSON.stringify({ type: 'mouse', event: 'mouseMoved', x: 20, y: 300, button: 'none' }));
  client.emit('message', JSON.stringify({ type: 'mouse', event: 'mouseMoved', x: 20, y: 20, button: 'none' }));
  await until(() => [...sent].reverse().find(m => m.type === 'cursor')?.cursor === 'pointer', 'the view gets the pointer cursor over the link');
  client.emit('close');
});
