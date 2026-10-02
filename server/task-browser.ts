// One headless Chrome for each task (and one for the template profile that new task browsers copy).
// Each browser has its own profile folder, ~/.taskboard/browsers/<task id>/profile, and a debugging port that Chrome
// picks (--remote-debugging-port=0) and writes to DevToolsActivePort in that folder. browser.json next to it records
// the process id, the port and, after a stop, the open tab addresses (so a resume opens the same pages). It also
// records sound: a browser starts with --mute-audio until the user turns its sound on (setSound).
// Agents reach their task's browser through the Taskboard server: /ws/cdp/<task id>?key=<key> forwards the DevTools
// connection to the browser and starts the browser first when it is not running. The key is derived from the
// Taskboard token, so another local user cannot guess it. The dashboard shows the browser with a screencast
// (Page.startScreencast) over /ws/browser and sends mouse and key input back with Input.dispatch*Event.
// Nothing starts a browser when a task starts. chrome-devtools-mcp opens its DevTools connection at the agent's first
// tool call, so the browser starts then (or when the user starts it on the dashboard). stopIdle() stops a task browser
// that got no command from an agent and had no dashboard viewer and no screencast for the time set on the Settings
// page. It closes the agent connections first: chrome-devtools-mcp connects again at the agent's next tool call.
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import WebSocket from 'ws';
import { PORT, ROOT, TB_DIR, TOKEN } from './config.ts';
import * as machine from './machine.ts';
import * as memory from './memory.ts';

export const DIR = join(TB_DIR, 'browsers');
export const TEMPLATE = 'template';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

export interface Meta { pid?: number; port?: number; started?: string; startMs?: number; tabs?: string[]; suspended?: boolean; idleStopped?: boolean; stoppedAt?: string; error?: string; copiedFromTemplate?: string; sound?: boolean; muted?: boolean }
export interface Tab { id: string; title: string; url: string; faviconUrl?: string }

const folder = (id: string) => { if (!ID.test(id)) throw new Error('Invalid browser id.'); return join(DIR, id); };
export const profileDir = (id: string) => join(folder(id), 'profile');
const metaFile = (id: string) => join(folder(id), 'browser.json');
export function readMeta(id: string): Meta { try { return JSON.parse(readFileSync(metaFile(id), 'utf8')); } catch { return {}; } }
function writeMeta(id: string, m: Meta) { mkdirSync(folder(id), { recursive: true }); writeFileSync(metaFile(id), JSON.stringify(m, null, 2)); }

// The key that lets the agents of one task use that task's browser through the Taskboard server.
export const cdpKey = (taskId: string) => createHmac('sha256', TOKEN).update(`cdp:${taskId}`).digest('hex').slice(0, 32);
export const cdpUrl = (taskId: string) => `ws://127.0.0.1:${PORT}/ws/cdp/${encodeURIComponent(taskId)}?key=${cdpKey(taskId)}`;

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary']
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
export function chromePath(): string | null {
  const set = machine.get().browser?.chromePath;
  if (set) return existsSync(set) ? set : null;
  return CHROME_CANDIDATES.find(p => existsSync(p)) || null;
}

const pidAlive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function version(port: number, timeout = 3000): Promise<{ webSocketDebuggerUrl: string } | null> {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeout) }); return r.ok ? await r.json() as { webSocketDebuggerUrl: string } : null; } catch { return null; }
}
// the browser of this id is running and answers on its port
async function live(id: string): Promise<(Meta & { ws: string }) | null> {
  const m = readMeta(id);
  if (!m.port || !pidAlive(m.pid)) return null;
  // a busy Mac can answer slowly: ask twice before treating a live process as not running (a second Chrome on the
  // same profile would hand over to the first one and exit)
  const v = await version(m.port) || await version(m.port);
  return v ? { ...m, ws: v.webSocketDebuggerUrl } : null;
}
export const isRunning = async (id: string) => !!(await live(id));
// the template's Chrome process exists (checked by process, so a slow answer cannot hide an open template)
const templateOpen = () => { const m = readMeta(TEMPLATE); return !!m.port && pidAlive(m.pid); };

export async function tabs(id: string): Promise<Tab[]> {
  const m = await live(id); if (!m) return [];
  return await pageList(m.port!) || [];
}
// The pages of a running browser, or null when Chrome does not answer in `timeout` ms.
async function pageList(port: number, timeout = 1500): Promise<Tab[] | null> {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeout) })).json() as { id: string; type: string; title: string; url: string; faviconUrl?: string }[];
    return list.filter(t => t.type === 'page').map(t => ({ id: t.id, title: t.title, url: t.url, ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}) }));
  } catch { return null; }
}

// Copy the template profile, without the files that lock a running profile and without caches.
const SKIP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'component_crx_cache']);
function copyTemplate(id: string) {
  const from = profileDir(TEMPLATE);
  if (!existsSync(from)) return false;
  cpSync(from, profileDir(id), { recursive: true, filter: src => !SKIP.has(basename(src)) });
  return true;
}

const starting = new Map<string, Promise<Meta & { ws: string }>>();
// Start the browser of this id if it is not running. A task browser without a profile gets a copy of the template.
export function ensure(id: string): Promise<Meta & { ws: string }> {
  folder(id);
  const pending = starting.get(id);
  if (pending) return pending;
  const p = (async () => {
    await stopping.get(id)?.catch(() => {}); // an idle stop that is running ends first, then the browser starts again
    const running = await live(id);
    if (running) return running;
    const t0 = Date.now();
    const bin = chromePath();
    if (!bin) throw new Error('No Chrome found. Install Google Chrome, or set the Chrome path on the Settings page.');
    const meta = readMeta(id);
    mkdirSync(folder(id), { recursive: true });
    if (!existsSync(profileDir(id)) && id !== TEMPLATE) {
      if (templateOpen()) throw new Error('The template browser is open. Close it on the Settings page, then try again. A copy of an open profile can lose its sign-ins.');
      if (copyTemplate(id)) meta.copiedFromTemplate = new Date().toISOString();
    }
    mkdirSync(profileDir(id), { recursive: true });
    const portFile = join(profileDir(id), 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const urls = (meta.tabs || []).filter(u => /^(https?|file):/.test(u)).slice(0, 20);
    const args = ['--headless=new', `--user-data-dir=${profileDir(id)}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--window-size=1280,800', '--disable-features=Translate,MediaRouter',
      ...(meta.sound ? [] : ['--mute-audio']), // headless Chrome plays on the Mac's speakers, so sound is off until the user turns it on
      'about:blank']; // headless Chrome takes one start page; the saved pages open below
    const log = openSync(join(folder(id), 'chrome.log'), 'a');
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    let port = 0;
    for (let i = 0; i < 300 && !port; i++) { // up to 30 s: a busy Mac can take more than 15 s to start Chrome
      await new Promise(r => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch { /* not yet */ }
    }
    const v = port ? await version(port) : null;
    if (!v) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ended */ }
      writeMeta(id, { ...meta, pid: undefined, port: undefined, error: 'Chrome did not start. See chrome.log in the browser folder.' });
      throw new Error(`Chrome did not start for ${id}. See ${join(folder(id), 'chrome.log')}.`);
    }
    const next: Meta = { ...meta, pid: child.pid, port, started: new Date().toISOString(), muted: !meta.sound, suspended: undefined, idleStopped: undefined, error: undefined, stoppedAt: undefined };
    if (urls.length) await openSaved(port, v.webSocketDebuggerUrl, urls);
    next.startMs = Date.now() - t0;
    writeMeta(id, next);
    lastUse.set(id, Date.now());
    changed(id);
    return { ...next, ws: v.webSocketDebuggerUrl };
  })();
  starting.set(id, p);
  p.finally(() => starting.delete(id)).catch(() => {});
  return p;
}

// Open the saved pages in a browser that just started, then close its blank start page. Each page is created blank,
// and this connection attaches to it before it navigates, then waits up to 10 s for its load event. A DevTools client
// that attaches to a page while its navigation commits can see that page at about:blank for good, and
// chrome-devtools-mcp then lists no pages. So the agent's connection, which waits for ensure(), finds loaded pages.
// Chrome closes a page after /json/close returns, so this waits until the blank page is gone (an agent would select it).
async function openSaved(port: number, browserWs: string, urls: string[]) {
  const list = () => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json() as Promise<{ id: string; type: string }[]>).catch(() => []);
  const blank = (await list()).filter(t => t.type === 'page').map(t => t.id);
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  let next = 0;
  const waiting = new Map<number, (m: any) => void>(), events = new Set<(m: any) => void>();
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } else for (const fn of events) fn(m); });
  const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const n = ++next; waiting.set(n, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await Promise.all(urls.map(async url => {
      const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
      await call('Page.enable', {}, sessionId);
      const loaded = new Promise<void>(resolve => {
        const fn = (m: any) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { events.delete(fn); resolve(); } };
        events.add(fn); setTimeout(() => { events.delete(fn); resolve(); }, 10000);
      });
      await call('Page.navigate', { url }, sessionId).catch(() => {});
      await loaded;
      await call('Target.detachFromTarget', { sessionId }).catch(() => {});
    }));
  } catch { /* the pages that opened stay open; the agent can open the others */ } finally { ws.close(); }
  for (const t of blank) await fetch(`http://127.0.0.1:${port}/json/close/${t}`).catch(() => {});
  for (let i = 0; i < 50 && (await list()).some(t => blank.includes(t.id)); i++) await new Promise(r => setTimeout(r, 100));
}

// One DevTools command over a new connection (for the few calls that are not on a long-lived connection).
function once(wsUrl: string, method: string, params: object = {}, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${method} timed out`)); }, timeout);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id === 1) { clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Stop the browser. The tab addresses are kept, so the next start opens them again. suspended marks a stop by the
// idle suspend of the task: resume starts the browser again. idle marks a stop by stopIdle(): the next use starts it.
// A start that comes while a stop runs waits for the stop (ensure() reads this map).
const stopping = new Map<string, Promise<boolean>>();
export function stop(id: string, opts: { suspended?: boolean; idle?: boolean } = {}): Promise<boolean> {
  const pending = stopping.get(id);
  if (pending) return pending;
  const p = stopNow(id, opts);
  stopping.set(id, p);
  p.finally(() => { if (stopping.get(id) === p) stopping.delete(id); }).catch(() => {});
  return p;
}
async function stopNow(id: string, opts: { suspended?: boolean; idle?: boolean }): Promise<boolean> {
  const m = readMeta(id);
  if (!m.pid && !m.port) return false;
  const running = await live(id);
  // a busy Chrome can answer slowly: wait up to 5 s, and keep the saved pages when it does not answer
  const listed = running ? await pageList(running.port!, 5000) : null;
  const open = listed ? listed.map(t => t.url).filter(u => /^(https?|file):/.test(u)) : m.tabs;
  if (running) await once(running.ws, 'Browser.close').catch(() => {});
  // Chrome writes cookies to disk when it closes: wait up to 10 s before the kill, so a busy Chrome keeps its sign-ins
  for (let i = 0; i < 100 && pidAlive(m.pid); i++) await new Promise(r => setTimeout(r, 100));
  if (m.pid && pidAlive(m.pid)) { try { process.kill(-m.pid, 'SIGKILL'); } catch { try { process.kill(m.pid, 'SIGKILL'); } catch { /* ended */ } } }
  writeMeta(id, { ...readMeta(id), pid: undefined, port: undefined, tabs: open, stoppedAt: new Date().toISOString(), suspended: opts.suspended || undefined, idleStopped: opts.idle || undefined });
  changed(id);
  return !!running;
}

// Turn the sound of one browser on or off. Chrome reads --mute-audio only at start, and the DevTools protocol has no
// command that mutes or unmutes, so a running browser restarts (stop keeps its tabs, the start opens them again).
// The restart ends the agents' DevTools connections, so it needs force while an agent is connected.
export class AgentConnected extends Error {}
export async function setSound(id: string, on: boolean, opts: { force?: boolean } = {}): Promise<{ restarted: boolean }> {
  folder(id);
  const running = await live(id);
  const restart = !!running && !!running.muted === on;
  if (restart && agentCount(id) && !opts.force) throw new AgentConnected('An agent is connected to this browser. The restart ends its connection.');
  writeMeta(id, { ...readMeta(id), sound: on || undefined });
  if (restart) { await stop(id); await ensure(id); } else changed(id);
  return { restarted: restart };
}

// Copy the template again: the task browser loses its own sign-ins and gets the template's.
export async function resetFromTemplate(id: string) {
  if (id === TEMPLATE) throw new Error('The template cannot be reset from itself.');
  if (!existsSync(profileDir(TEMPLATE))) throw new Error('There is no template profile yet. Open the template browser on the Settings page and sign in first.');
  if (templateOpen()) throw new Error('The template browser is open. Close it on the Settings page first.');
  await stop(id);
  rmSync(profileDir(id), { recursive: true, force: true });
  copyTemplate(id);
  writeMeta(id, { ...readMeta(id), copiedFromTemplate: new Date().toISOString() });
  changed(id);
}
// The task was removed from Taskboard: stop its browser and delete its profile (it holds copied sign-ins).
export async function remove(id: string) { await stop(id).catch(() => {}); rmSync(folder(id), { recursive: true, force: true }); }

export interface Status { id: string; running: boolean; port?: number; tabs: Tab[]; profile: boolean; copiedFromTemplate?: string; suspended?: boolean; idleStopped?: boolean; idleStopMinutes: number; startMs?: number; started?: string; stoppedAt?: string; error?: string; memMb?: number | null; rssMb?: number | null; agents: number; viewers: number; chrome: string | null; sound: boolean; muted: boolean }
// a running browser has the mute flag it started with (none for a browser started before this setting existed); a
// stopped browser gets the saved choice at its next start
const mutedNow = (m: Meta, running: boolean) => running ? !!m.muted : !m.sound;
export async function status(id: string): Promise<Status> {
  const m = readMeta(id), running = await live(id);
  const mem = running ? await memory.groupMb(m.pid) : null;
  return { id, running: !!running, port: running?.port, tabs: running ? await tabs(id) : (m.tabs || []).map((url, i) => ({ id: `saved-${i}`, title: url, url })),
    profile: existsSync(profileDir(id)), copiedFromTemplate: m.copiedFromTemplate, suspended: m.suspended, idleStopped: m.idleStopped, idleStopMinutes: idleStopMs() / 60000,
    startMs: m.startMs, started: running ? m.started : undefined, stoppedAt: m.stoppedAt, error: m.error,
    // memMb is the footprint of the browser's processes (memory.ts). rssMb has the same value for older callers.
    memMb: mem, rssMb: mem, agents: agentCount(id), viewers: viewers.get(id) || 0, chrome: chromePath(), sound: !!m.sound, muted: mutedNow(m, !!running) };
}

export async function openTab(id: string, url: string): Promise<Tab> {
  if (!/^(https?|file|about|data):/i.test(url)) url = 'http://' + url;
  const m = await ensure(id);
  const r = await fetch(`http://127.0.0.1:${m.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json() as { id: string; title: string; url: string };
  changed(id);
  return { id: t.id, title: t.title, url: t.url };
}
export async function closeTab(id: string, tabId: string) {
  const m = await live(id); if (!m) return;
  await fetch(`http://127.0.0.1:${m.port}/json/close/${encodeURIComponent(tabId)}`).catch(() => {});
  changed(id);
}

// A still frame of the first tab for the group view, cached for 3 s.
const shots = new Map<string, { at: number; data: Buffer }>();
export async function shot(id: string): Promise<Buffer | null> {
  const c = shots.get(id); if (c && Date.now() - c.at < 3000) return c.data;
  const m = await live(id); if (!m) return null;
  const page = (await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[]).find(t => t.type === 'page');
  if (!page) return null;
  const r = await once(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'jpeg', quality: 50 }).catch(() => null);
  if (!r?.data) return null;
  const data = Buffer.from(r.data, 'base64'); shots.set(id, { at: Date.now(), data });
  return data;
}

const listeners = new Set<(id: string) => void>();
export const onChange = (fn: (id: string) => void) => { listeners.add(fn); };
const changed = (id: string) => { for (const fn of listeners) try { fn(id); } catch { /* listener failed */ } };

// ---------- what uses a browser now, and the stop of a browser that nothing used for a set time ----------
// agentConnections: open /ws/cdp connections, each with the time of its last command from the agent and a function that
// closes it. viewers: open /ws/browser views. screencasts: views that stream a tab. lastUse: when the last connection or
// view ended, or when the browser started. stopIdle() reads all four.
interface AgentConn { last: number; close: () => void }
const agentConnections = new Map<string, Set<AgentConn>>();
export const agentCount = (id: string) => agentConnections.get(id)?.size || 0;
const viewers = new Map<string, number>();
const screencasts = new Map<string, number>();
const lastUse = new Map<string, number>();
const loadedAt = Date.now();
const count = (m: Map<string, number>, id: string, d: number) => { m.set(id, Math.max(0, (m.get(id) || 0) + d)); lastUse.set(id, Date.now()); changed(id); };
const viewed = (id: string) => !!(viewers.get(id) || screencasts.get(id));
// The time without use after which a task browser stops (Settings page, in minutes; 0 turns the stop off).
export function idleStopMs(): number {
  const min = machine.get().browser?.idleStopMinutes;
  return (typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : 10) * 60000;
}
// Stop each running task browser that got no agent command and had no viewer and no screencast for idleStopMs(). An
// open agent connection that sent no command for that time does not keep the browser: chrome-devtools-mcp keeps its
// connection open until the agent session ends. The open tab addresses are saved, so the next start opens the same
// pages. The template browser is not stopped here.
// A browser that was running before this server started gets the full time from the server start.
export async function stopIdle(now = Date.now()): Promise<string[]> {
  const ms = idleStopMs(), done: string[] = [];
  if (!ms) return done;
  let ids: string[] = [];
  try { ids = readdirSync(DIR); } catch { return done; }
  for (const id of ids) {
    if (id === TEMPLATE || !ID.test(id)) continue;
    const m = readMeta(id);
    if (!m.pid || !pidAlive(m.pid)) { lastUse.delete(id); continue; }
    if (viewed(id) || starting.has(id) || stopping.has(id)) { lastUse.set(id, now); continue; }
    const conns = [...(agentConnections.get(id) || [])];
    const since = Math.max(lastUse.get(id) || 0, Date.parse(m.started || '') || 0, loadedAt, ...conns.map(c => c.last));
    if (now - since < ms) continue;
    lastUse.delete(id);
    console.log(`${new Date().toISOString()} task browser ${id}: stopped after ${Math.round((now - since) / 60000)} min without an agent command or a viewer (${conns.length} quiet agent connection(s) closed)`);
    done.push(id);
    for (const c of conns) c.close(); // stop() below runs before the agent's next tool call, and ensure() waits for it
    await stop(id, { idle: true }).catch(e => console.error(`task browser ${id}: idle stop failed: ${(e as Error).message}`));
  }
  return done;
}
// Check every 30 s, or more often when the set time is short.
let idleTimer: NodeJS.Timeout | undefined;
export function watchIdle() {
  if (idleTimer) return;
  const tick = () => { idleTimer = setTimeout(() => { void stopIdle().finally(tick); }, Math.min(30000, Math.max(1000, idleStopMs() / 3 || 30000))); idleTimer.unref(); };
  tick();
}

// ---------- agents: DevTools connections forwarded to the task's browser ----------
export function proxyAgent(client: WebSocket, id: string) {
  const queue: (string | Buffer)[] = [];
  let up: WebSocket | null = null, closed = false;
  const conn: AgentConn = { last: Date.now(), close: () => done() };
  let set = agentConnections.get(id);
  if (!set) agentConnections.set(id, set = new Set());
  set.add(conn); lastUse.set(id, Date.now()); changed(id);
  const done = () => { if (closed) return; closed = true; set.delete(conn); lastUse.set(id, Date.now()); changed(id); try { up?.close(); } catch { /* closed */ } try { client.close(); } catch { /* closed */ } };
  client.on('message', (d, binary) => { conn.last = Date.now(); const msg = binary ? d as Buffer : d.toString(); if (up?.readyState === WebSocket.OPEN) up.send(msg); else if (queue.length < 1000) queue.push(msg); else done(); });
  client.on('close', done); client.on('error', done);
  ensure(id).then(m => {
    if (closed) return;
    up = new WebSocket(m.ws, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    up.on('open', () => { for (const q of queue) up!.send(q); queue.length = 0; });
    up.on('message', (d, binary) => { if (client.readyState === WebSocket.OPEN) client.send(binary ? d : d.toString()); });
    up.on('close', done); up.on('error', done);
  }).catch(e => { console.error(`task browser ${id}: ${(e as Error).message}`); try { client.close(1011, String((e as Error).message).slice(0, 120)); } catch { /* closed */ } done(); });
}

// ---------- the dashboard: screencast of one tab, with mouse and key input ----------
interface PageConn { ws: WebSocket; target: string; next: number; pending: Map<number, (r: any) => void>; casting?: boolean }
export function attachViewer(client: WebSocket, id: string, autostart: boolean) {
  let page: PageConn | null = null, active = '', known = new Set<string>(), chosen = false, closed = false;
  count(viewers, id, 1);
  let size = { w: 1280, h: 800 };
  const send = (m: object) => { if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) client.send(JSON.stringify(m)); };
  const call = (method: string, params: object = {}) => new Promise<any>(resolve => {
    if (!page || page.ws.readyState !== WebSocket.OPEN) return resolve(null);
    const n = ++page.next; page.pending.set(n, resolve); page.ws.send(JSON.stringify({ id: n, method, params }));
  });
  const closePage = () => { if (page) { try { page.ws.close(); } catch { /* closed */ } page = null; } };
  // The shown tab's loading state and history, for the back, forward, reload and stop buttons of the dashboard.
  let mainFrame = '', loading = false, history: { currentIndex: number; entries: { id: number }[] } | null = null;
  const navState = async () => {
    history = await call('Page.getNavigationHistory');
    const i = history?.currentIndex ?? 0, n = history?.entries.length ?? 0;
    send({ type: 'nav', loading, canBack: i > 0, canForward: i < n - 1 });
  };
  const viewport = () => call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
  async function open(target: string) {
    const m = await live(id); if (!m || closed) return;
    const list = await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { id: string; type: string; webSocketDebuggerUrl: string }[];
    const t = list.find(x => x.id === target && x.type === 'page'); if (!t) return;
    closePage();
    active = target;
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    const conn: PageConn = { ws, target, next: 0, pending: new Map() };
    page = conn;
    ws.on('message', d => {
      const msg = JSON.parse(d.toString());
      if (msg.id && conn.pending.has(msg.id)) { conn.pending.get(msg.id)!(msg.result); conn.pending.delete(msg.id); return; }
      if (page !== conn) return;
      const frame = msg.params?.frameId ?? msg.params?.frame?.id;
      if (msg.method === 'Page.frameStartedLoading' && frame === mainFrame) { loading = true; void navState(); }
      else if ((msg.method === 'Page.frameStoppedLoading' && frame === mainFrame) || msg.method === 'Page.loadEventFired') { loading = false; void navState(); }
      else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) { mainFrame = msg.params.frame.id; void navState(); }
      else if (msg.method === 'Page.navigatedWithinDocument' && frame === mainFrame) void navState();
      if (msg.method === 'Page.screencastFrame') {
        ws.send(JSON.stringify({ id: ++conn.next, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }));
        send({ type: 'frame', data: msg.params.data, w: msg.params.metadata.deviceWidth, h: msg.params.metadata.deviceHeight });
      }
    });
    ws.on('close', () => { if (page === conn) page = null; if (conn.casting) { conn.casting = false; count(screencasts, id, -1); } });
    ws.on('error', () => {});
    await new Promise(r => ws.once('open', r));
    await fetch(`http://127.0.0.1:${m.port}/json/activate/${target}`).catch(() => {});
    await call('Page.enable');
    const tree = await call('Page.getFrameTree');
    mainFrame = tree?.frameTree?.frame?.id || ''; loading = false;
    await navState();
    await viewport();
    await call('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1920, maxHeight: 1920, everyNthFrame: 1 });
    if (ws.readyState === WebSocket.OPEN && !conn.casting) { conn.casting = true; count(screencasts, id, 1); }
    send({ type: 'active', id: target });
  }
  async function poll() {
    if (closed) return;
    const running = await isRunning(id);
    if (!running) { closePage(); active = ''; known = new Set(); send({ type: 'state', ...(await status(id)) }); return; }
    const list = await tabs(id);
    const fresh = list.filter(t => !known.has(t.id));
    const first = !known.size;
    known = new Set(list.map(t => t.id));
    send({ type: 'tabs', tabs: list, active, agents: agentCount(id), muted: mutedNow(readMeta(id), true) });
    // follow the agent: a tab that opens later becomes the shown tab, unless the user picked a tab in the last minute
    let target = active;
    if (!list.some(t => t.id === active)) target = list[0]?.id || '';
    else if (!first && fresh.length && !chosen) target = fresh[fresh.length - 1].id;
    if (target && (target !== active || !page)) await open(target);
  }
  const timer = setInterval(() => { void poll(); }, 1000);
  let chosenTimer: NodeJS.Timeout | undefined;
  client.on('close', () => { if (closed) return; closed = true; count(viewers, id, -1); clearInterval(timer); clearTimeout(chosenTimer); closePage(); });
  client.on('message', async d => {
    let m: any; try { m = JSON.parse(d.toString()); } catch { return; }
    try {
      if (m.type === 'start') { await ensure(id); await poll(); }
      else if (m.type === 'stop') { await stop(id); await poll(); }
      else if (m.type === 'select' && typeof m.id === 'string') { chosen = true; clearTimeout(chosenTimer); chosenTimer = setTimeout(() => { chosen = false; }, 60000); await open(m.id); }
      else if (m.type === 'size' && m.w > 100 && m.h > 100) { size = { w: Math.min(3840, Math.round(m.w)), h: Math.min(2160, Math.round(m.h)) }; await viewport(); }
      else if (m.type === 'mouse') await call('Input.dispatchMouseEvent', { type: m.event, x: m.x, y: m.y, button: m.button || 'none', buttons: m.buttons || 0, clickCount: m.clickCount || 0, modifiers: m.modifiers || 0, ...(m.event === 'mouseWheel' ? { deltaX: m.dx || 0, deltaY: m.dy || 0 } : {}) });
      else if (m.type === 'key') await key(m);
      else if (m.type === 'text' && typeof m.text === 'string') await call('Input.insertText', { text: m.text.slice(0, 100000) });
      else if (m.type === 'copy') {
        // the selected text of the page, or of the focused text field; the dashboard puts it on the Mac's clipboard
        const r = await call('Runtime.evaluate', { returnByValue: true, expression: COPY });
        send({ type: 'copied', peek: !!m.peek, text: typeof r?.result?.value === 'string' ? r.result.value : '' });
        if (m.cut && !m.peek) await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 4, commands: ['cut'] });
      }
      else if (m.type === 'nav') {
        if (m.action === 'go' && typeof m.url === 'string') { const url = /^(https?|file|about|data):/i.test(m.url) ? m.url : 'http://' + m.url; await call('Page.navigate', { url }); }
        else if (m.action === 'reload') await call('Page.reload');
        else if (m.action === 'stop') { await call('Page.stopLoading'); loading = false; await navState(); }
        else if (m.action === 'back' || m.action === 'forward') {
          const h = await call('Page.getNavigationHistory') as typeof history;
          const entry = h?.entries[h.currentIndex + (m.action === 'back' ? -1 : 1)];
          if (entry) await call('Page.navigateToHistoryEntry', { entryId: entry.id });
        }
      }
      else if (m.type === 'new') { const t = await openTab(id, typeof m.url === 'string' && m.url ? m.url : 'about:blank'); chosen = true; await open(t.id); }
      else if (m.type === 'close' && typeof m.id === 'string') await closeTab(id, m.id);
    } catch (e) { send({ type: 'error', message: (e as Error).message }); }
  });
  async function key(m: { down: boolean; key: string; code: string; keyCode: number; modifiers: number }) {
    const commands = m.down ? editCommands(m.key, m.modifiers || 0) : [];
    const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: m.modifiers || 0, ...(commands.length ? { commands } : {}) };
    if (!m.down) return call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    const printable = m.key.length === 1 && !(m.modifiers & (2 | 4)); // no Ctrl, no Meta
    if (printable) return call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: m.key, unmodifiedText: m.key });
    if (m.key === 'Enter') return call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' });
    return call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  }
  void (async () => {
    if (!(await isRunning(id)) && autostart) { try { await ensure(id); } catch (e) { send({ type: 'error', message: (e as Error).message }); } }
    await poll();
  })();
}

// The text that a copy takes: the selection in a focused text field, else the selection of the page.
const COPY = `(() => { const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && typeof a.selectionStart === 'number') return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() || ''); })()`;
// Chrome on macOS runs editing shortcuts as commands. A key event from DevTools carries no command by itself, so
// Cmd+A, Cmd+Z, Option+Arrow and the other usual text shortcuts would do nothing in the page without this list.
// Modifier bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
export function editCommands(key: string, mod: number): string[] {
  const meta = !!(mod & 4), alt = !!(mod & 1), shift = !!(mod & 8), sel = shift ? 'AndModifySelection' : '';
  if (meta && !alt) {
    const k = key.toLowerCase();
    if (k === 'a') return ['selectAll'];
    if (k === 'z') return [shift ? 'redo' : 'undo'];
    if (key === 'ArrowLeft') return ['moveToBeginningOfLine' + sel];
    if (key === 'ArrowRight') return ['moveToEndOfLine' + sel];
    if (key === 'ArrowUp') return ['moveToBeginningOfDocument' + sel];
    if (key === 'ArrowDown') return ['moveToEndOfDocument' + sel];
    if (key === 'Backspace') return ['deleteToBeginningOfLine'];
  }
  if (alt && !meta) {
    if (key === 'ArrowLeft') return ['moveWordLeft' + sel];
    if (key === 'ArrowRight') return ['moveWordRight' + sel];
    if (key === 'Backspace') return ['deleteWordBackward'];
    if (key === 'Delete') return ['deleteWordForward'];
  }
  return [];
}

// ---------- the browser MCP server that agents use ----------
// chrome-devtools-mcp (a Taskboard dependency) needs Node 20.19+ or 22.12+. Taskboard itself may run on an older
// Node, so use the first Node that is new enough: the one running Taskboard, then the usual install places.
let nodeCache: string | null | undefined;
const okVersion = (v: string) => { const [a, b] = v.replace(/^v/, '').split('.').map(Number); return a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) || a === 21; };
export function mcpNode(): string | null {
  if (nodeCache !== undefined) return nodeCache;
  const candidates = [process.execPath, '/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try { if (okVersion(c === process.execPath ? process.version : execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim())) return (nodeCache = c); } catch { /* not runnable */ }
  }
  return (nodeCache = null);
}
export function mcpScript(root: string) { return join(root, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js'); }
// The command and arguments of the MCP server "task-browser" for one task, or null when it cannot run here.
export function mcpServer(root: string, taskId: string): { command: string; args: string[] } | null {
  const node = mcpNode(), script = mcpScript(root);
  if (!node || !existsSync(script)) return null;
  return { command: node, args: [script, '--wsEndpoint', cdpUrl(taskId), '--no-usage-statistics', '--no-performance-crux'] };
}
export async function check(): Promise<{ chrome: string | null; node: string | null; mcp: boolean }> {
  return { chrome: chromePath(), node: mcpNode(), mcp: existsSync(mcpScript(ROOT)) };
}
