// Open in a window (setWindow in server/task-browser.ts): a task browser changes from headless Chrome to a normal Chrome
// window with the same profile and pages, and back. The view is a stand-in for the dashboard's WebSocket. A Chrome
// window appears on the screen, so this test runs only with TASKBOARD_TEST_WINDOWS=1 (and when Chrome is installed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-window-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-window-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'window-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const skip = !browser.chromePath() ? 'Chrome is not installed' : process.env.TASKBOARD_TEST_WINDOWS !== '1' ? 'set TASKBOARD_TEST_WINDOWS=1: a Chrome window appears' : false;
const ID = 'winview';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 150000) => { const end = Date.now() + ms; let good = false; while (!(good = await ok()) && Date.now() < end) await wait(100); assert.ok(good, what); };
const seen: any[] = [];
const view = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => { if (typeof d === 'string') seen.push(JSON.parse(d)); }, close() {} });
// a local site with a form page, so the page has an address that a stop saves
const site = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>form</title><input id=a>'); });
await new Promise<void>(r => site.listen(0, '127.0.0.1', () => r()));
const PAGE = `http://127.0.0.1:${(site.address() as { port: number }).port}/form`;
const pages = async () => { const m = browser.readMeta(ID); return (await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[]).filter(t => t.type === 'page'); };
const headless = () => { const pid = browser.readMeta(ID).pid; try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('--headless'); } catch { return null; } };
after(async () => { site.close(); view.emit('close'); if (!skip) { browser.updateMeta(ID, { window: undefined }); await browser.stop(ID); } });

test('a task browser opens in a window and comes back, with its pages', { skip, timeout: 400000 }, async () => {
  await browser.ensure(ID);
  const p = (await pages())[0];
  await browser.once(p.webSocketDebuggerUrl, 'Page.navigate', { url: PAGE });
  await wait(1000);
  browser.attachViewer(view as any, ID, false);
  // typed text that is not sent: the view is asked first
  const tab = (await pages()).find(t => t.url === PAGE)!;
  await browser.once(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.getElementById("a").value = "half typed"' });
  view.emit('message', JSON.stringify({ type: 'window', on: true }));
  await until(() => seen.some(s => s.type === 'windowUnsent' && s.fields === 1), 'the view learns that one field has unsent text');
  assert.equal(browser.readMeta(ID).window, undefined, 'nothing changed yet');
  view.emit('message', JSON.stringify({ type: 'window', on: true, force: true }));
  await until(() => seen.some(s => s.type === 'tabs' && s.window === true), 'the view learns that the browser is in a window');
  assert.equal(headless(), false, 'the Chrome runs with a window');
  const urls = (await pages()).map(t => t.url);
  assert.ok(urls.includes(PAGE), `the saved page opened again (${urls.join(', ')})`);
  const w = await browser.once((await pages())[0].webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true });
  assert.equal(w.result.value, false, 'sign-in pages do not see an automated browser');
  assert.equal((await browser.status(ID)).window, true);
  // back to the panel
  view.emit('message', JSON.stringify({ type: 'window', on: false, force: true }));
  await until(() => !browser.readMeta(ID).window && !!browser.readMeta(ID).pid, 'the browser runs headless again');
  assert.equal(headless(), true);
});

test('closing the window brings the browser back to the panel with its pages', { skip, timeout: 400000 }, async () => {
  await browser.setWindow(ID, true);
  const before = (await pages()).map(t => t.url).filter(u => u.startsWith('http'));
  await wait(2500); // the window watch keeps the addresses
  for (const t of await pages()) await fetch(`http://127.0.0.1:${browser.readMeta(ID).port}/json/close/${(t as any).id}`);
  await until(async () => !browser.readMeta(ID).window && !!browser.readMeta(ID).pid && headless() === true, 'the browser runs headless again after the window closed');
  const after = (await pages()).map(t => t.url);
  for (const u of before) assert.ok(after.includes(u), `the page ${u} opened again`);
});
