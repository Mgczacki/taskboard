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
const skip = browser.chromePath() ? false : 'Chrome is not installed';
after(async () => { for (const id of ['template', 'b1', 'b2', 'b3']) await browser.stop(id).catch(() => {}); });

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
