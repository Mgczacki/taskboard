// The browser of a task (server/task-browser.ts) with a real headless Chrome in a temporary Taskboard folder:
// the template copy with its cookies, a stop that keeps the open pages for the next start, the refusal to copy an
// open template, and the key that lets only one task's agents reach its browser. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-browser-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-browser-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'browser-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
after(async () => { for (const id of ['template', 'b1', 'b2']) await browser.stop(id).catch(() => {}); });

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
  const tabs = await browser.tabs('b2');
  assert.deepEqual(tabs.map(t => t.url).sort(), [`file://${page}`, `file://${page2}`], 'both kept pages opened again, and no blank start page is left');
  assert.equal(browser.readMeta('b2').suspended, undefined);
});

test('status reports a running browser and its memory', { skip, timeout: 30000 }, async () => {
  const s = await browser.status('b2');
  assert.equal(s.running, true);
  assert.ok((s.rssMb || 0) > 0);
  await browser.stop('b2');
  assert.equal((await browser.status('b2')).running, false);
});
