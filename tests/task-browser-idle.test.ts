// When a task browser runs: a test Taskboard server (own port, folders and tmux socket) with one Claude Code task, and
// the real chrome-devtools-mcp server that the task's agent gets, driven over stdio as Claude Code and Codex drive it.
// Checked: no browser at task start or after the MCP handshake, a start at the first tool call, no idle stop while an
// agent connection or a dashboard viewer is open, the idle stop after the set time, and a restart with the same pages.
// The idle time is 0.05 minutes (3 s), so the test takes about a minute. Skipped when Chrome or the MCP server is missing.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p));
const SCRIPT = join(process.cwd(), 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
// chrome-devtools-mcp needs Node 20.19+ or 22.12+ (the same rule as mcpNode() in server/task-browser.ts)
const NODE = [process.execPath, '/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node'].find(n => {
  try { const [a, b] = execFileSync(n, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.').map(Number); return a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) || a === 21; } catch { return false; }
});
const skip = !CHROME ? 'Chrome is not installed' : !existsSync(SCRIPT) ? 'chrome-devtools-mcp is not installed' : !NODE ? 'no Node 20.19+ or 22.12+' : false;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-browser-idle-')));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), work = join(root, 'work');
const ID = 'idle-task';
const profile = join(tbdir, 'browsers', ID, 'profile');
mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true }); mkdirSync(work);
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'browser-idle-test', controller: { autostart: false, remoteControl: false }, browser: { claude: 'task', codex: 'task', chromePath: CHROME || '', idleStopMinutes: 0.05 } }));
writeFileSync(join(vault, 'tasks', `${ID}.md`), `---\nid: ${ID}\nnum: 1\ntitle: Idle browser test\nagent: claude\nstatus: idle\ncwd: ${work}\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Idle browser test\n`);
const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); }); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let server: ChildProcess | undefined, base = '', token = '', port = 0, output = '';
// a web page that the browser keeps open, so the restart can show the same page again
const page = createHttpServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>kept page</title><p>kept</p>'); });
let pageUrl = '';

before(async () => {
  if (skip) return;
  await new Promise<void>(r => page.listen(0, '127.0.0.1', () => r()));
  const a = page.address(); pageUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/kept`;
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  server = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), ['server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: `tb-browser-idle-${port}`, TASKBOARD_MACHINE_NAME: 'browser-idle-test' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', b => { output += b.toString(); }); server.stderr!.on('data', b => { output += b.toString(); });
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(base + '/api/info')).ok) break; } catch { /* the server starts */ }
    await sleep(100);
  }
  token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
});
after(async () => {
  for (const c of clients) c.close();
  if (token) await fetch(`${base}/api/tasks/${ID}/browser/stop`, { method: 'POST', headers: { 'x-taskboard-token': token } }).catch(() => {});
  server?.kill(); page.close();
  try { execFileSync('tmux', ['-L', `tb-browser-idle-${port}`, 'kill-server'], { stdio: 'ignore' }); } catch { /* no tmux server */ }
  rmSync(root, { recursive: true, force: true });
});

const status = async () => await (await fetch(`${base}/api/tasks/${ID}/browser`, { headers: { 'x-taskboard-token': token } })).json() as { running: boolean; agents: number; viewers: number; idleStopped?: boolean; startMs?: number; rssMb?: number | null; tabs: { url: string }[] };
// a Chrome process that uses this task's profile folder
const chromeForTask = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some(l => l.includes(`--user-data-dir=${profile}`));
async function until(what: string, fn: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(250); }
  assert.fail(`${what} did not happen within ${ms} ms\n${output.slice(-2000)}`);
}

// The MCP server "task-browser" as the agent CLIs start it: the same command and arguments as mcpServer().
const clients: Mcp[] = [];
class Mcp {
  proc: ChildProcess; next = 0; buf = ''; waiting = new Map<number, (m: any) => void>();
  constructor() {
    const key = createHmac('sha256', token).update(`cdp:${ID}`).digest('hex').slice(0, 32);
    this.proc = spawn(NODE!, [SCRIPT, '--wsEndpoint', `ws://127.0.0.1:${port}/ws/cdp/${ID}?key=${key}`, '--no-usage-statistics', '--no-performance-crux'],
      { env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', b => {
      this.buf += b.toString();
      let i; while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m.id !== undefined && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id); } } catch { /* not JSON */ }
      }
    });
    this.proc.stderr!.on('data', () => {});
    clients.push(this);
  }
  request(method: string, params: object = {}): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
      this.waiting.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  // what a client sends at session start: the handshake and the tool list
  async start() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'idle-test', version: '1' } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return (await this.request('tools/list')).tools as { name: string }[];
  }
  async call(name: string, args: object = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    return { error: !!r.isError, text: (r.content || []).map((c: { text?: string }) => c.text || '').join('\n') || JSON.stringify(r) };
  }
  close() { if (this.proc.exitCode === null) this.proc.kill(); }
}
// The agent's first list_pages after a start with saved pages. Taskboard reopens the pages in Chrome (the tests check
// status().tabs). chrome-devtools-mcp sometimes lists none of them, without an error: in about 1 of 4 runs here, more
// often on a busy Mac. chrome-devtools-mcp leaves out a page whose puppeteer address is empty, and puppeteer alone gave
// an empty address to a page that Chrome opened from its command line. That is a likely cause, not a confirmed one.
// So the test requires no error and logs what the agent saw.
async function firstList(agent: Mcp, url: string) {
  const r = await agent.call('list_pages');
  assert.equal(r.error, false, r.text);
  if (!r.text.includes(url)) console.log(`list_pages did not show the reopened page: ${JSON.stringify(r.text)}`);
  return r;
}
const closed = (c: Mcp) => new Promise<void>(r => { if (c.proc.exitCode !== null) r(); else c.proc.once('exit', () => r()); });

test('no browser starts at task start or at the MCP handshake; the first tool call starts it', { skip, timeout: 120000 }, async () => {
  assert.equal((await status()).running, false);
  assert.equal(chromeForTask(), false, 'no Chrome for the task after the server start');
  const agent = new Mcp();
  const tools = await agent.start();
  assert.ok(tools.some(t => t.name === 'list_pages'));
  await sleep(3000);
  const s = await status();
  assert.equal(s.running, false, 'the handshake and the tool list did not start the browser');
  assert.equal(s.agents, 0, 'the MCP server did not connect to /ws/cdp');
  assert.equal(chromeForTask(), false);
  const t0 = Date.now();
  const r = await agent.call('list_pages');
  console.log(`first tool call with a browser start: ${Date.now() - t0} ms (Chrome start ${(await status()).startMs} ms)`);
  assert.equal(r.error, false, r.text);
  const s2 = await status();
  assert.equal(s2.running, true);
  assert.equal(s2.agents, 1);
  assert.ok((s2.rssMb || 0) > 0, 'status reports the memory');
  // the page that the restart must open again (the route of `tb browser open`, which does not wait for the page load)
  const opened = await fetch(`${base}/api/tasks/${ID}/browser/open`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': ID }, body: JSON.stringify({ url: pageUrl }) });
  assert.equal(opened.status, 200);
  await until('the page is open', async () => (await status()).tabs.some(t => t.url === pageUrl), 20000);
});

test('no idle stop while an agent connection or a dashboard viewer is open; then the idle stop saves the pages', { skip, timeout: 120000 }, async () => {
  const agent = clients[0];
  await sleep(6000); // twice the idle time
  assert.equal((await status()).running, true, 'an open agent connection keeps the browser');
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?id=${ID}&token=${token}`);
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  agent.close(); await closed(agent);
  await until('the agent connection closed', async () => (await status()).agents === 0, 10000);
  assert.equal((await status()).viewers, 1);
  await sleep(6000);
  assert.equal((await status()).running, true, 'an open viewer (with its screencast) keeps the browser');
  viewer.close();
  // Chrome closes first; browser.json gets idleStopped when the process has ended
  await until('the idle stop', async () => { const x = await status(); return !x.running && x.idleStopped === true; }, 15000);
  const s = await status();
  assert.ok(s.tabs.some(t => t.url === pageUrl), `the open page was saved: ${JSON.stringify(s.tabs)}`);
  assert.equal(chromeForTask(), false, 'no Chrome process is left');
});

test('the next tool call starts the browser again with the same pages, without an error', { skip, timeout: 120000 }, async () => {
  const agent = new Mcp();
  await agent.start();
  const t0 = Date.now();
  await firstList(agent, pageUrl);
  console.log(`first tool call after the idle stop: ${Date.now() - t0} ms (Chrome start ${(await status()).startMs} ms)`);
  const s = await status();
  assert.equal(s.running, true);
  assert.deepEqual(s.tabs.map(t => t.url), [pageUrl], 'Chrome has the same page again, and no blank start page');
  assert.equal(s.idleStopped, undefined);
});

test('a stop while an agent is connected: the same MCP server reconnects at its next tool call, without an error', { skip, timeout: 120000 }, async () => {
  const agent = clients[clients.length - 1];
  const stopped = await fetch(`${base}/api/tasks/${ID}/browser/stop`, { method: 'POST', headers: { 'x-taskboard-token': token } });
  assert.equal(stopped.status, 200);
  await until('the agent connection closed', async () => (await status()).agents === 0, 10000);
  const t0 = Date.now();
  await firstList(agent, pageUrl);
  console.log(`tool call of a connected agent after a stop: ${Date.now() - t0} ms`);
  const s = await status();
  assert.equal(s.agents, 1);
  assert.deepEqual(s.tabs.map(t => t.url), [pageUrl]);
});
