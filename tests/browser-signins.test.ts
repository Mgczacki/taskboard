// Shared sign-ins of task browsers (server/browser-signins.ts) with real headless Chrome in a temporary Taskboard
// folder and a local test site (site-a.localhost, site-b.localhost and so on, which Chrome sends to 127.0.0.1). The
// cookies are fake. Covers the template copy, the opt-out, save as template, sync from the template, the removal of a
// site, live sharing, sign out of all, and the safety rules (no cookie value in a response, in a log or in plain text on
// disk; only the dashboard calls the routes). Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-signins-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-signins-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'signins-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const signins = await import('../server/browser-signins.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
const IDS = ['template', 'c1', 'o1', 's1', 's2', 'y1', 'l1', 'l2', 'l3', 'z1'];
after(async () => { signins.stopLive(); for (const id of IDS) await browser.stop(id).catch(() => {}); server.close(); });

// Every value starts with SECRET-, so a search for that text finds a leak.
const SECRET = (n: string) => `SECRET-${n}-${Math.random().toString(36).slice(2)}`;
const logged: string[] = [];
for (const k of ['log', 'error', 'warn'] as const) { const orig = console[k]; console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); orig(...a); }; }

const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>site</title>'); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const PORT = (server.address() as { port: number }).port;
const url = (site: string) => `http://${site}:${PORT}/`;

function cdp(wsUrl: string, method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
    ws.on('error', reject);
  });
}
const ws = async (id: string) => (await browser.ensure(id)).ws;
const setCookie = async (id: string, site: string, name: string, value: string) =>
  cdp(await ws(id), 'Storage.setCookies', { cookies: [{ name, value, url: url(site), expires: Date.now() / 1000 + 3600 }] });
const cookies = async (id: string) => (await cdp(await ws(id), 'Storage.getCookies')).cookies as { name: string; value: string; domain: string }[];
const has = async (id: string, name: string, value?: string) => (await cookies(id)).some(c => c.name === name && (value === undefined || c.value === value));
// run JavaScript in a page of the site, in a new tab that closes after
async function inPage(id: string, site: string, js: string) {
  const t = await browser.openTab(id, url(site));
  try {
    const list = await (await fetch(`http://127.0.0.1:${browser.readMeta(id).port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
    const page = list.find(p => p.id === t.id)!;
    await waitFor(async () => (await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'document.readyState + location.host', returnByValue: true,
    })).result.value === `complete${site}:${PORT}`, {
      description: `${site} to finish loading in ${id}`, timeoutMs: 60_000,
      state: () => `expected complete${site}:${PORT}; browser: ${JSON.stringify(browser.readMeta(id))}`,
    });
    const r = await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: js, returnByValue: true });
    return r.result.value;
  } finally { await browser.closeTab(id, t.id); }
}

test('siteOf groups subdomains under the registrable name', () => {
  assert.equal(signins.siteOf('.google.com'), 'google.com');
  assert.equal(signins.siteOf('mail.google.com'), 'google.com');
  assert.equal(signins.siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(signins.siteOf('site-a.localhost'), 'site-a.localhost');
  assert.equal(signins.siteOf('localhost'), 'localhost');
  assert.equal(signins.siteOf('127.0.0.1'), '127.0.0.1');
});

const A = 'site-a.localhost', B = 'site-b.localhost', C = 'site-c.localhost', D = 'site-d.localhost';
const values = { a: SECRET('a'), b: SECRET('b'), own: SECRET('own'), d: SECRET('d'), s: SECRET('s') };

test('a new task browser copies the template, and an opted-out one starts empty', { skip, timeout: 120000 }, async () => {
  await setCookie('template', A, 'a_sid', values.a);
  await setCookie('template', B, 'b_sid', values.b);
  await browser.stop('template');
  assert.equal(await has('c1', 'a_sid', values.a), true);
  assert.ok(browser.readMeta('c1').copiedFromTemplate);
  signins.setShared('o1', false);
  assert.equal(await has('o1', 'a_sid'), false, 'the opted-out browser did not copy the template');
  assert.equal(browser.readMeta('o1').copiedFromTemplate, undefined);
  await assert.rejects(signins.syncFromTemplate('o1', [A]), /does not get shared sign-ins/);
  // the status of the panel: the opt-out, and the number of sites in the template for the other browsers
  assert.equal((await browser.status('o1')).noShared, true);
  assert.equal((await browser.status('c1')).templateSites, 2);
});

test('sites() lists site names and counts, never values', { skip, timeout: 60000 }, async () => {
  const running = await signins.sites('c1');
  assert.deepEqual(running?.map(s => s.site), [A, B]);
  await browser.stop('c1');
  assert.equal(await browser.isRunning('c1'), false);
  const stopped = await signins.sites('c1');
  assert.deepEqual(stopped?.map(s => s.site), [A, B], 'a stopped profile is read from its database');
  assert.ok(stopped?.every(s => s.lastUsed), 'the last use comes from the database');
  assert.ok(!JSON.stringify([running, stopped]).includes('SECRET-'));
});

test('save as template copies sign-ins and site data, without history', { skip, timeout: 180000 }, async () => {
  await setCookie('s1', C, 'c_sid', values.s);
  assert.equal(await inPage('s1', C, `localStorage.setItem('token', 'ls-value'); 'ok'`), 'ok');
  const tabsBefore = (await browser.tabs('s1')).length;
  const r = await signins.saveAsTemplate('s1');
  assert.ok(r.sites.some(s => s.site === C));
  assert.ok(!JSON.stringify(r).includes('SECRET-'));
  // the template started once after the copy (for the cookies read before the stop), and Chrome made a new History then
  const visited = execFileSync('sqlite3', ['-readonly', join(browser.profileDir('template'), 'Default', 'History'), "select count(*) from urls where url like '%site-c%'"], { encoding: 'utf8' }).trim();
  assert.equal(visited, '0', 'no history of the saved browser in the template');
  assert.equal(await browser.isRunning('template'), false, 'the template is closed again');
  assert.equal(browser.readMeta('template').savedFrom?.task, 's1');
  // s1 starts again with its pages
  await waitFor(async () => (await browser.isRunning('s1')) && (await browser.tabs('s1')).length === tabsBefore, {
    description: 's1 to restart with its saved tabs', timeoutMs: 90_000,
    state: async () => `expected ${tabsBefore} restored tabs; tabs: ${JSON.stringify(await browser.tabs('s1'))}; browser: ${JSON.stringify(browser.readMeta('s1'))}`,
  });
  assert.equal((await browser.tabs('s1')).length, tabsBefore);
  // a new task browser gets the cookie and the local storage of the saved browser
  assert.equal(await has('s2', 'c_sid', values.s), true);
  assert.equal(await inPage('s2', C, `localStorage.getItem('token')`), 'ls-value');
});

test('sync adds the template cookies of the chosen sites and keeps the browser state', { skip, timeout: 120000 }, async () => {
  // the template now is the profile of s1: put cookies for two sites into it
  const t = await browser.ensure('template');
  await cdp(t.ws, 'Storage.setCookies', { cookies: [{ name: 'a_sid', value: values.a, url: url(A), expires: Date.now() / 1000 + 3600 }, { name: 'b_sid', value: values.b, url: url(B), expires: Date.now() / 1000 + 3600 }] });
  await browser.stop('template');
  signins.setShared('y1', false);
  await browser.ensure('y1'); // empty profile
  signins.setShared('y1', true);
  await setCookie('y1', D, 'own', values.own);
  const r = await signins.syncFromTemplate('y1', [A]);
  assert.deepEqual(r, { sites: [A], cookies: 1 });
  assert.equal(await has('y1', 'a_sid', values.a), true);
  assert.equal(await has('y1', 'b_sid'), false, 'a site that was not chosen is not synced');
  assert.equal(await has('y1', 'own', values.own), true, 'the browser keeps its own cookies');
  assert.ok(browser.readMeta('y1').syncedAt);
});

test('remove a site from the template keeps the other sites', { skip, timeout: 120000 }, async () => {
  await signins.removeSite(A);
  const left = (await signins.sites('template'))!.map(s => s.site);
  assert.ok(!left.includes(A));
  assert.ok(left.includes(B));
  assert.equal(await has('y1', 'a_sid'), true, 'a task browser keeps the copy it has');
  await assert.rejects(signins.removeSite('../x'), /Not a site name/);
});

test('live sharing copies new, changed and deleted cookies of the chosen sites', { skip, timeout: 180000 }, async () => {
  signins.setLive({ live: true, liveSites: [D] });
  signins.stopLive(); // the test calls liveTick() itself
  await browser.ensure('l1'); await browser.ensure('l2');
  await signins.liveTick();
  await setCookie('l1', D, 'd_sid', values.d);
  await setCookie('l1', C, 'not_shared', SECRET('x'));
  await signins.liveTick();
  assert.equal(await has('l2', 'd_sid', values.d), true, 'a new cookie reached the other browser');
  assert.equal(await has('l2', 'not_shared'), false, 'a site that is not selected is not shared');
  assert.equal(await has('o1', 'd_sid'), false, 'an opted-out browser gets nothing');
  const changed = SECRET('d2');
  await setCookie('l2', D, 'd_sid', changed);
  await signins.liveTick();
  assert.equal(await has('l1', 'd_sid', changed), true, 'a changed cookie goes the other way too');
  // a browser that starts later gets the store's cookies before ensure() returns
  assert.equal(await has('l3', 'd_sid', changed), true);
  // the store: mode 0600, and no value in plain text
  const file = signins.STORE_FILE();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file).toString('latin1').includes('SECRET-'));
  assert.equal(Object.values(signins.readStore().cookies).some(e => e.c.value === changed), true);
  // a sign-out (deleted cookie) in one browser reaches the others
  await cdp(await ws('l1'), 'Storage.setCookies', { cookies: [{ name: 'd_sid', value: '', url: url(D), expires: 1 }] });
  assert.equal(await has('l1', 'd_sid'), false, 'an expired cookie deletes the cookie');
  await signins.liveTick();
  assert.equal(await has('l2', 'd_sid'), false);
  assert.equal(await has('l3', 'd_sid'), false);
});

test('sign out of all clears the template, running browsers now, and stopped browsers at their next start', { skip, timeout: 180000 }, async () => {
  signins.setLive({ live: false, liveSites: [] });
  await setCookie('y1', B, 'b_sid', values.b); // y1 runs and has a template site
  await setCookie('z1', B, 'b_sid', values.b);
  await browser.stop('z1');
  const r = await signins.signOutAll();
  assert.ok(r.sites.includes(B));
  assert.ok(r.now.includes('y1'));
  assert.ok(r.later.includes('z1'));
  assert.equal(existsSync(browser.profileDir('template')), false);
  assert.equal(await has('y1', 'b_sid'), false);
  assert.equal(await has('y1', 'own', values.own), true, 'cookies of other sites stay');
  assert.deepEqual(browser.readMeta('z1').clearSites?.includes(B), true);
  assert.equal(await has('z1', 'b_sid'), false, 'the next start signed it out');
  assert.equal(browser.readMeta('z1').clearSites, undefined);
  assert.equal(existsSync(signins.STORE_FILE()), false);
});

test('no cookie value appears in a log line', { skip }, () => {
  assert.ok(logged.length > 0);
  assert.ok(!logged.some(l => l.includes('SECRET-')));
});

test('only the dashboard can call the sign-in routes', async () => {
  const express = (await import('express')).default;
  const routes = await import('../server/runtime-routes.ts');
  const app = express(); app.use(express.json());
  routes.mount(app, (res, e) => res.status(400).json({ error: String((e as Error)?.message || e) }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    for (const path of ['/api/browser-signins/overview', '/api/browser-signins/sign-out-all', '/api/browser-signins/live', '/api/browser-signins/remove', '/api/tasks/x/browser/signins/sync', '/api/tasks/x/browser/signins/save-template', '/api/tasks/x/browser/signins/shared', '/api/browser-template/window']) {
      for (const headers of [{ 'x-tb-actor': 'some-task' }, { 'x-taskboard-token': 'x' }, {}] as Record<string, string>[]) {
        const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
        assert.equal(r.status, 403, `${path} with ${JSON.stringify(headers)}`);
      }
    }
    const ok = await fetch(base + '/api/browser-signins/overview', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.ok(!(await ok.text()).includes('SECRET-'));
  } finally { srv.close(); }
});
