// Sign-in in a normal Chrome window for a task browser (signinWindow in server/browser-signins.ts), the start flags of task
// browsers and of the template window (launchArgs, templateWindowArgs in server/task-browser.ts), and the sign-in pages
// that the view knows (web/src/signinPages.ts). The window test uses a stand-in for Chrome: with --headless it runs the
// real Chrome, and without it (the template window) it waits 2 s and ends, as when the user quits the window. No window
// appears. The cookie is fake. The window test is skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';
import { signinPage } from '../web/src/signinPages.ts';
import { waitFor } from './helpers/wait-for.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-signin-window-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-signin-window-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
const fake = join(root, 'chrome.sh');
writeFileSync(fake, `#!/bin/sh\ncase "$*" in *--headless*) exec "${CHROME}" "$@";; esac\necho "$@" > "${root}/window-args"\nsleep 2\n`);
chmodSync(fake, 0o755);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'signin-window-test', controller: { autostart: false, remoteControl: false }, browser: { chromePath: fake } }));
const browser = await import('../server/task-browser.ts');
const signins = await import('../server/browser-signins.ts');
const { existsSync, readFileSync } = await import('node:fs');
const skip = existsSync(CHROME) ? false : 'Chrome is not installed';
// ---------- the sign-in window with a stand-in for Chrome ----------
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/start') return res.end('<script>sessionStorage.setItem("oauth-state", "pending"); location.replace("/handler")</script>');
  if (req.url === '/handler') return res.end('<script>document.title = sessionStorage.getItem("oauth-state") === "pending" ? "signed in" : "missing initial state"; if (document.title === "signed in") localStorage.setItem("firebase-test", "signed-in")</script>');
  res.end('<title>site</title>');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const PORT = (server.address() as { port: number }).port;
function cdp(wsUrl: string, method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
    ws.on('error', reject);
  });
}
after(async () => { signins.stopLive(); for (const id of ['template', 'w1', 'w2']) await browser.stop(id).catch(() => {}); server.close(); });

test('a headless task browser has the headless flags and no changed user agent', () => {
  const a = browser.launchArgs({ profile: '/p', windowed: false });
  assert.ok(a.includes('--headless=new'));
  assert.ok(a.includes('--remote-debugging-port=0'));
  assert.ok(a.includes('--user-data-dir=/p'));
  // Headless Chrome keeps navigator.webdriver true with AutomationControlled off, and Taskboard does not hide it
  assert.ok(!a.some(x => x.startsWith('--disable-blink-features')));
  assert.ok(!a.some(x => x.startsWith('--user-agent')));
  assert.equal(a.at(-1), 'about:blank');
  assert.ok(!a.some(x => x.startsWith('--force-device-scale-factor')));
  assert.ok(browser.launchArgs({ profile: '/p', windowed: false, scale: 2, muteFlag: true }).includes('--force-device-scale-factor=2'));
  assert.ok(browser.launchArgs({ profile: '/p', windowed: false, muteFlag: true }).includes('--mute-audio'));
});

test('a task browser in a window turns off AutomationControlled and is not headless', () => {
  const a = browser.launchArgs({ profile: '/p', windowed: true });
  assert.ok(a.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(!a.some(x => x.startsWith('--headless')));
  assert.ok(a.includes('--remote-debugging-port=0'));
  assert.ok(browser.launchArgs({ profile: '/p', windowed: true, muteFlag: true }).includes('--mute-audio'), 'Open in a window with the sound off');
});

test('the template window has no headless mode, no debugging port and no automation flag, and is muted', () => {
  const a = browser.templateWindowArgs('/t', 'https://accounts.google.com/');
  assert.deepEqual(a, ['--user-data-dir=/t', '--no-first-run', '--no-default-browser-check', '--mute-audio', 'https://accounts.google.com/']);
  // the template with its sound on opens without the flag
  assert.ok(!browser.templateWindowArgs('/t', 'https://accounts.google.com/', false).includes('--mute-audio'));
  assert.ok(!a.some(x => /headless|remote-debugging|enable-automation|user-agent/.test(x)));
  assert.equal(browser.templateWindowArgs('/t', 'http://example.com/').at(-1), 'about:blank');
  assert.equal(browser.templateWindowArgs('/t', 'javascript:alert(1)').at(-1), 'about:blank');
});

test('the view knows the sign-in pages and the Google page of a refused sign-in', () => {
  assert.deepEqual(signinPage('https://accounts.google.com/v3/signin/challenge/pwd?continue=https://mail.google.com/mail/&flowName=GlifWebSignIn', 'Error 500 (Server Error)!!1'),
    { site: 'google.com', refused: true, target: 'https://mail.google.com/mail/' });
  assert.deepEqual(signinPage('https://accounts.google.com/v3/signin/identifier?continue=https://accounts.google.com/', 'Sign in - Google Accounts'),
    { site: 'google.com', refused: false, target: 'https://accounts.google.com/' });
  assert.equal(signinPage('https://accounts.google.com/signin/rejected?rrk=46')?.refused, true);
  assert.equal(signinPage('https://accounts.google.com/x', "Couldn't sign you in")?.refused, true);
  // a continue address on another site does not open in the window
  assert.equal(signinPage('https://accounts.google.com/x?continue=https://evil.example/', 'Error 500 (Server Error)!!1')?.target, 'https://accounts.google.com/');
  assert.equal(signinPage('https://login.microsoftonline.com/common/oauth2/authorize')?.target, 'https://login.microsoftonline.com/common/oauth2/authorize');
  assert.ok(signinPage('https://github.com/login'));
  assert.equal(signinPage('https://github.com/anthropics'), null);
  assert.ok(signinPage('https://acme.okta.com/app/x'));
  assert.equal(signinPage('http://accounts.google.com/'), null);
  assert.deepEqual(signinPage('https://sekai-399502.firebaseapp.com/__/auth/handler', 'Unable to process request due to missing initial state.'),
    { site: 'sekai-399502.firebaseapp.com', refused: true, target: '', firebase: true });
  assert.equal(signinPage('https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fsekai-399502.firebaseapp.com%2F__%2Fauth%2Fhandler')?.firebase, true);
  assert.equal(signinPage('https://example.com/'), null);
  assert.equal(signinPage('not a url'), null);
});

test('Firebase sign-in opens the app and copies browser site data after the window closes', { skip, timeout: 240000 }, async () => {
  const task = await browser.ensure('w2');
  const taskPages = await (await fetch(`http://127.0.0.1:${task.port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const taskPage = taskPages.find(p => p.type === 'page')!;
  await cdp(taskPage.webSocketDebuggerUrl, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/handler` });
  await waitFor(async () => (await cdp(taskPage.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value === 'missing initial state', { description: 'handler without state', timeoutMs: 15000 });
  await signins.withTemplate(async ws => {
    const port = browser.readMeta('template').port!;
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const page = pages.find(p => p.type === 'page')!;
    await cdp(page.webSocketDebuggerUrl, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/start` });
    await waitFor(async () => (await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value === 'signed in', { description: 'redirect with state', timeoutMs: 15000 });
  });
  await assert.rejects(signins.signinWindow('w2', 'https://sekai-399502.firebaseapp.com/__/auth/handler', true), /app page/);
  const app = 'https://stage-api.sekai.chat/sekai-agent-ts/agent-eval/';
  const state = await signins.signinWindow('w2', app, true);
  assert.equal(state.profile, true);
  assert.equal(readFileSync(join(root, 'window-args'), 'utf8').trim().split(' ').at(-1), app);
  await waitFor(() => browser.readMeta('w2').signinWindow?.state === 'done', { timeoutMs: 120000 });
  const port = browser.readMeta('w2').port!;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const page = pages.find(p => p.type === 'page')!;
  await cdp(page.webSocketDebuggerUrl, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(async () => (await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'location.origin', returnByValue: true })).result.value === `http://127.0.0.1:${PORT}`, { description: 'task app page', timeoutMs: 15000 });
  assert.equal((await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: "localStorage.getItem('firebase-test')", returnByValue: true })).result.value, 'signed-in');
});

const cookieNames = async (id: string) => ((await cdp((await browser.ensure(id)).ws, 'Storage.getCookies')).cookies as { name: string; domain: string }[]).map(c => `${c.name}@${c.domain}`);

test('after the sign-in window closes, the task browser that asked gets the cookies of that site', { skip, timeout: 240000 }, async () => {
  await browser.ensure('w1'); // the first start copies the template, which has no cookie yet
  assert.ok(!(await cookieNames('w1')).some(c => c.startsWith('sid@')));
  // the sign-in that the user makes in the window, here written into the template before the window opens
  await signins.withTemplate(ws => cdp(ws, 'Storage.setCookies', { cookies: [
    { name: 'sid', value: 'fake', url: `http://site-a.localhost:${PORT}/`, expires: Date.now() / 1000 + 3600 },
    { name: 'other', value: 'fake', url: `http://site-b.localhost:${PORT}/`, expires: Date.now() / 1000 + 3600 },
  ] }));
  const r = await signins.signinWindow('w1', 'https://site-a.localhost/login');
  assert.deepEqual(r.sites, ['site-a.localhost']);
  assert.equal(r.state, 'open');
  assert.ok(browser.templateWindowOpen());
  assert.equal((await browser.status('w1')).signinWindow?.state, 'open');
  assert.equal(readFileSync(join(root, 'window-args'), 'utf8').trim(), `--user-data-dir=${browser.profileDir('template')} --no-first-run --no-default-browser-check --mute-audio https://site-a.localhost/login`);
  assert.equal((await browser.status('template')).soundState, 'muted', 'the sign-in window is muted by its start flag');
  await waitFor(() => browser.readMeta('w1').signinWindow?.state === 'done', { description: 'the copy after the window closed', timeoutMs: 120000 });
  const got = await cookieNames('w1');
  assert.ok(got.includes('sid@site-a.localhost'), got.join(' '));
  // only the site of the sign-in page moves
  assert.ok(!got.some(c => c.startsWith('other@')), got.join(' '));
  assert.equal((await browser.status('w1')).signinWindow?.cookies, 1);
  assert.ok(!browser.templateWindowOpen());
});

test('the sign-in window refuses an http page, the template and an opted-out browser', { skip }, async () => {
  await assert.rejects(signins.signinWindow('w2', 'http://site-a.localhost/'), /https/);
  await assert.rejects(signins.signinWindow('template', 'https://site-a.localhost/'), /template/);
  browser.updateMeta('w2', { noShared: true });
  await assert.rejects(signins.signinWindow('w2', 'https://site-a.localhost/'), /shared sign-ins/);
});
