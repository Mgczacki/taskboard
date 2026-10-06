// One headless Chrome for each task (and one for the template profile that new task browsers copy).
// Each browser has its own profile folder, ~/.taskboard/browsers/<task id>/profile, and a debugging port that Chrome
// picks (--remote-debugging-port=0) and writes to DevToolsActivePort in that folder. browser.json next to it records
// the process id, the port and, after a stop, the open tab addresses (so a resume opens the same pages). It also
// records sound: a browser is muted until the user turns its sound on (setSound, muteTabs, checkSound).
// Agents reach their task's browser through the Taskboard server: /ws/cdp/<task id>?key=<key> forwards the DevTools
// connection to the browser and starts the browser first when it is not running. The key is derived from the
// Taskboard token, so another local user cannot guess it. The dashboard shows the browser with a screencast
// (Page.startScreencast) over /ws/browser and sends mouse and key input back with Input.dispatch*Event.
// Nothing starts a browser when a task starts. chrome-devtools-mcp opens its DevTools connection at the agent's first
// tool call, so the browser starts then (or when the user starts it on the dashboard). stopIdle() stops a task browser
// that got no command from an agent and had no dashboard viewer and no screencast for the time set on the Settings
// page. It closes the agent connections first: chrome-devtools-mcp connects again at the agent's next tool call.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import WebSocket from 'ws';
import { PORT, ROOT, TB_DIR, TOKEN } from './config.ts';
import * as machine from './machine.ts';
import * as memory from './memory.ts';
import { TabSwitch } from './tab-switch.ts';

export const DIR = join(TB_DIR, 'browsers');
export const TEMPLATE = 'template';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

// sound: the user's choice for this browser. muted: the state of the running browser. muteFlag: the running browser
// started with --mute-audio (every start with the sound off, see start). soundCheck: what the last check of the running
// browser read back from Chrome (checkSound): 'muted' (the --mute-audio flag on the Chrome process, or every tab muted),
// 'on' (the sound is on), or 'unverified' (Taskboard could not confirm the mute), with the reason.
// error: why the last start failed or why Chrome ended by itself (exited), with the useful lines of chrome.log
// (errorLines) and the time (errorAt). The next start that works removes them.
export interface Meta { pid?: number; port?: number; started?: string; startMs?: number; tabs?: string[]; suspended?: boolean; idleStopped?: boolean; stoppedAt?: string; error?: string; errorLines?: string[]; errorAt?: string; exited?: boolean; copiedFromTemplate?: string; sound?: boolean; muted?: boolean; muteFlag?: boolean; soundCheck?: SoundCheck; sharp?: boolean; scale?: number;
  // sign-in sharing (browser-signins.ts): noShared is the opt-out of this task browser, syncedAt the last sync from the
  // template, clearSites the sites whose cookies the next start deletes (sign out of all), liveSyncAt the last live sync.
  // headed: the template runs in a normal Chrome window (openTemplateWindow). savedFrom: the task whose profile became the template.
  noShared?: boolean; syncedAt?: string; clearSites?: string[]; liveSyncAt?: string; headed?: boolean; savedFrom?: { task: string; at: string };
  // ask: the agent asked the user for help in this browser (tb browser ask), until the user answers with Done
  ask?: Ask;
  // window: the task browser runs as a normal Chrome window on this computer (Open in a window, setWindow), with its
  // debugging port, so the agent keeps working in the window that the user sees
  window?: boolean;
  // autoSwitch: the dashboard view switches to a new tab or popup (tab-switch.ts); unset follows the Settings choice
  autoSwitch?: boolean;
  // signinWindow: the user signs in for this task browser in the template's normal Chrome window (browser-signins.ts
  // signinWindow). state 'open' while that window is open, 'copying' while cookies or the profile move after it closes,
  // then 'done' or 'failed'.
  signinWindow?: SigninWindow }
export interface SoundCheck { state: SoundState; at: string; how?: 'flag' | 'tabs'; reason?: string }
export type SoundState = 'muted' | 'on' | 'unverified';
export interface SigninWindow { sites: string[]; at: string; state: 'open' | 'copying' | 'done' | 'failed'; cookies?: number; error?: string; profile?: boolean }
export interface Ask { reason: string; at: string }
export interface Tab { id: string; title: string; url: string; faviconUrl?: string; dialog?: Dialog }
// A box that a page opened with alert(), confirm(), prompt() or onbeforeunload. Headless Chrome draws no box, and the
// page waits until a DevTools client answers it (Page.handleJavaScriptDialog).
export interface Dialog { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string }

const folder = (id: string) => { if (!ID.test(id)) throw new Error('Invalid browser id.'); return join(DIR, id); };
export const profileDir = (id: string) => join(folder(id), 'profile');
const metaFile = (id: string) => join(folder(id), 'browser.json');
export function readMeta(id: string): Meta { try { return JSON.parse(readFileSync(metaFile(id), 'utf8')); } catch { return {}; } }
function writeMeta(id: string, m: Meta) { mkdirSync(folder(id), { recursive: true }); writeFileSync(metaFile(id), JSON.stringify(m, null, 2)); }
export function updateMeta(id: string, patch: Partial<Meta>) { writeMeta(id, { ...readMeta(id), ...patch }); changed(id); }

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
  // a busy computer can answer slowly: ask twice before treating a live process as not running (a second Chrome on the
  // same profile would hand over to the first one and exit)
  const v = await version(m.port) || await version(m.port);
  return v ? { ...m, ws: v.webSocketDebuggerUrl } : null;
}
export const isRunning = async (id: string) => !!(await live(id));
// the DevTools address of a running browser, or null
export const browserWs = async (id: string) => (await live(id))?.ws ?? null;
// the template's Chrome process exists (checked by process, so a slow answer cannot hide an open template). A template
// in a normal Chrome window (headed) has no port.
export const templateOpen = () => { const m = readMeta(TEMPLATE); return (!!m.port || !!m.headed) && pidAlive(m.pid); };
export const templateWindowOpen = () => { const m = readMeta(TEMPLATE); return !!m.headed && pidAlive(m.pid); };
// A short use of the template by the sign-in sharing (browser-signins.ts withTemplate): the template starts, gives or
// takes cookies, and stops. A new task browser waits for that use to end before it copies the template.
let templateUse: Promise<unknown> | null = null;
export function holdTemplate<T>(p: Promise<T>): Promise<T> {
  const mine = p.finally(() => { if (templateUse === mine) templateUse = null; });
  templateUse = mine; mine.catch(() => {});
  return p;
}

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
export const SKIP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'component_crx_cache']);
export function copyProfile(from: string, to: string, skip: Set<string> = SKIP) {
  cpSync(from, to, { recursive: true, filter: src => !skip.has(basename(src)) });
}
function copyTemplate(id: string) {
  const from = profileDir(TEMPLATE);
  if (!existsSync(from)) return false;
  copyProfile(from, profileDir(id));
  return true;
}

// ---------- the start of a browser ----------
// A start waits for Chrome while its process lives, up to startLimitMs(). A busy computer can take 20 s or more: on
// 2 October 2026 one start took 21.5 s, and a limit of 30 s reported such starts as failures. A start ends early only
// when the Chrome process exits. Only one Chrome may use a profile: a second Chrome on the same profile either hands
// over to the first one and exits at once, or (when the first one does not answer) waits 20 s and then ends the first
// one. So a start first looks for a Chrome that holds the profile (profileHolder) and waits for that one.
// TASKBOARD_BROWSER_START_LIMIT_MS changes the limit for tests.
export const startLimitMs = () => Number(process.env.TASKBOARD_BROWSER_START_LIMIT_MS) || 90000;
export class StartError extends Error { constructor(message: string, public lines: string[] = []) { super(message); } }
const starting = new Map<string, Promise<Meta & { ws: string }>>();
// The start that runs now, for the dashboard: when it began and the Chrome process it waits for.
const progress = new Map<string, { since: number; pid?: number }>();

// The process id that Chrome wrote into the profile lock. SingletonLock is a symbolic link to "<host name>-<pid>".
function lockPid(id: string): number | undefined {
  try { const t = readlinkSync(join(profileDir(id), 'SingletonLock')); return Number(t.slice(t.lastIndexOf('-') + 1)) || undefined; } catch { return undefined; }
}
// A live Chrome process that runs on the profile of this browser: the process in browser.json, or the process in the
// profile lock (a Chrome that browser.json lost, for example after a start that failed). Checked with ps, because a
// process id that the system gave to another program after Chrome ended must not count.
function profileHolder(id: string): number | undefined {
  for (const pid of new Set([readMeta(id).pid, lockPid(id)])) {
    if (!pid || !pidAlive(pid)) continue;
    try { if (execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).includes(`--user-data-dir=${profileDir(id)}`)) return pid; } catch { /* ended */ }
  }
  return undefined;
}
// End a Chrome process and its helpers (its process group), and wait up to 5 s until the main process is gone.
async function killChrome(pid: number) {
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
}
// Wait until this Chrome process writes DevToolsActivePort and answers on that port. The result is 'exited' as soon as
// the process ends, and 'timeout' at the deadline.
async function waitReady(id: string, pid: number, deadline: number, exited: () => boolean = () => !pidAlive(pid)): Promise<{ port: number; ws: string } | 'exited' | 'timeout'> {
  const portFile = join(profileDir(id), 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (exited()) return 'exited';
    let port = 0;
    try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch { /* not yet */ }
    const v = port ? await version(port, 2000) : null;
    if (v) return { port, ws: v.webSocketDebuggerUrl };
    await new Promise(r => setTimeout(r, 200));
  }
  return exited() ? 'exited' : 'timeout';
}

// The lines of chrome.log that can explain a failure. Chrome also writes lines that do not: the Google updater and its
// crash reporter (Chrome starts them in the background), display link errors of headless Chrome on macOS, and GCM
// registration errors. These are left out.
const NOISE = /chrome\/updater\/|crashpad|cv_display_link|gcm\/engine|Trying to load the allocator|TensorFlow Lite|^DevTools listening|:VERBOSE\d:/;
export function usefulLines(text: string, max = 8): string[] {
  return text.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !NOISE.test(l)).slice(-max).map(l => l.length > 300 ? l.slice(0, 300) + '…' : l);
}
// The part of chrome.log after this byte offset (at most the last 64 KB).
function logSince(id: string, offset: number): string {
  try { const b = readFileSync(join(folder(id), 'chrome.log')); return b.subarray(Math.max(offset, b.length - 65536)).toString('utf8'); } catch { return ''; }
}
const logSize = (id: string) => { try { return statSync(join(folder(id), 'chrome.log')).size; } catch { return 0; } };

// Start the browser of this id if it is not running. A task browser without a profile gets a copy of the template.
export function ensure(id: string): Promise<Meta & { ws: string }> {
  folder(id);
  const pending = starting.get(id);
  if (pending) return pending;
  const p = (async () => {
    await stopping.get(id)?.catch(() => {}); // an idle stop that is running ends first, then the browser starts again
    const running = await live(id);
    if (running) return running;
    // the template in a normal Chrome window holds the profile and has no debugging port
    if (id === TEMPLATE && templateWindowOpen()) throw new Error('The template is open in a Chrome window. Close that window first (Chrome menu, Quit Google Chrome).');
    const t0 = Date.now();
    progress.set(id, { since: t0 }); changed(id);
    try { return await start(id, t0); }
    catch (e) {
      const lines = e instanceof StartError ? e.lines : [];
      writeMeta(id, { ...readMeta(id), pid: undefined, port: undefined, exited: undefined, error: (e as Error).message, errorLines: lines.length ? lines : undefined, errorAt: new Date().toISOString() });
      console.error(`${new Date().toISOString()} task browser ${id}: ${(e as Error).message}${lines.length ? `\n  ${lines.join('\n  ')}` : ''}`);
      problem(id, (e as Error).message, lines);
      throw e;
    } finally { progress.delete(id); changed(id); }
  })();
  starting.set(id, p);
  p.finally(() => starting.delete(id)).catch(() => {});
  return p;
}
// The start flags of a task browser. A window (windowed, Open in a window) is a normal Chrome with the same profile and
// the debugging port. Chrome sets navigator.webdriver to true when the debugging port is open, and sign-in pages
// (Google among them) refuse such a browser. AutomationControlled off makes it false again in a window (observed with
// Chrome 154 on 3 October 2026). Headless Chrome keeps navigator.webdriver true with that flag (observed with the same
// Chrome) and names itself HeadlessChrome in its user agent. Taskboard does not change these values: a site sees a
// headless task browser as what it is. For a sign-in that a site refuses there, the user signs in in the template's
// normal Chrome window (openTemplateWindow, templateWindowArgs), and the cookies go to the task browsers.
export function launchArgs(o: { profile: string; windowed: boolean; muteFlag?: boolean; scale?: number }): string[] {
  return [...(o.windowed ? ['--disable-blink-features=AutomationControlled', '--window-size=1280,900'] : ['--headless=new', '--window-size=1280,800']), `--user-data-dir=${o.profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--disable-features=Translate,MediaRouter',
    // some Chrome versions allow Extensions.loadUnpacked (the sound extension, muteTabs) only with this flag
    '--enable-unsafe-extension-debugging',
    ...(o.muteFlag ? ['--mute-audio'] : []),
    // Settings → Task browsers → Picture: only this start flag makes screencast frames larger than the CSS size
    ...(o.scale && o.scale > 1 ? [`--force-device-scale-factor=${o.scale}`] : []),
    'about:blank']; // headless Chrome takes one start page; the saved pages open below
}
// The start flags of the template in a normal Chrome window: no headless mode, no debugging port, no automation flag.
// muted: --mute-audio, because Taskboard cannot load the sound extension into a Chrome without a debugging port.
export function templateWindowArgs(profile: string, url: string, muted = true): string[] {
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(muted ? ['--mute-audio'] : []), /^https:\/\//.test(url) ? url : 'about:blank'];
}
async function start(id: string, t0: number): Promise<Meta & { ws: string }> {
  const bin = chromePath();
  if (!bin) throw new Error('No Chrome found. Install Google Chrome, or set the Chrome path on the Settings page.');
  const meta = readMeta(id);
  mkdirSync(folder(id), { recursive: true });
  // a task browser that opted out of shared sign-ins (noShared) starts with an empty profile
  if (!existsSync(profileDir(id)) && id !== TEMPLATE && !meta.noShared) {
    await templateUse?.catch(() => {});
    if (templateOpen()) throw new Error('The template browser is open. Close it on the Settings page, then try again. A copy of an open profile can lose its sign-ins.');
    if (copyTemplate(id)) meta.copiedFromTemplate = new Date().toISOString();
  }
  mkdirSync(profileDir(id), { recursive: true });
  cleanFiles(id);
  const portFile = join(profileDir(id), 'DevToolsActivePort');
  const urls = (meta.tabs || []).filter(u => /^(https?|file):/.test(u)).slice(0, 20);
  // a task browser in a window draws at the screen's own pixel density, so it gets no scale flag
  const windowed = !!meta.window && id !== TEMPLATE;
  const scale = windowed ? 1 : startScale(), sharp = scale > 1;
  // A Chrome that holds the profile but did not answer live() (a busy computer answers slowly) gets the full time.
  // When it answers, it is the browser. When it does not, it is ended before a new Chrome starts.
  let b: { pid: number; port: number; ws: string; child?: ChildProcess } | null = null;
  const holder = profileHolder(id);
  if (holder) {
    progress.set(id, { since: t0, pid: holder }); changed(id);
    const r = await waitReady(id, holder, t0 + startLimitMs());
    if (typeof r === 'object') { b = { pid: holder, ...r }; console.log(`${new Date().toISOString()} task browser ${id}: Chrome ${holder} holds the profile and answered after ${Math.round((Date.now() - t0) / 1000)} s, so no second Chrome started`); }
    else if (r === 'timeout') { console.error(`${new Date().toISOString()} task browser ${id}: Chrome ${holder} holds the profile and did not answer in ${startLimitMs() / 1000} s, so it was ended`); await killChrome(holder); }
  }
  const launch = async (muteFlag: boolean) => {
    rmSync(portFile, { force: true });
    const args = launchArgs({ profile: profileDir(id), windowed, muteFlag, scale: sharp ? scale : undefined });
    const offset = logSize(id), began = Date.now();
    const log = openSync(join(folder(id), 'chrome.log'), 'a');
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    child.unref();
    let how = '';
    child.once('exit', (code, signal) => { how = code !== null ? `exit code ${code}` : `signal ${signal}`; });
    child.once('error', e => { how = e.message; });
    progress.set(id, { since: t0, pid: child.pid }); changed(id);
    const r = child.pid ? await waitReady(id, child.pid, began + startLimitMs(), () => !!how) : 'exited';
    if (typeof r === 'object') return { pid: child.pid!, ...r, child };
    const lines = usefulLines(logSince(id, offset));
    if (r === 'timeout') {
      await killChrome(child.pid!);
      throw new StartError(`Chrome did not answer within ${startLimitMs() / 1000} s, so Taskboard ended it. The computer can be too busy. Try again.`, lines);
    }
    throw new StartError(`Chrome ended ${Math.round((Date.now() - began) / 100) / 10} s after its start (${how || 'no exit code'}). It did not open its debugging port.`, lines);
  };
  // A browser with the sound off starts with --mute-audio. The flag mutes all sound of that Chrome from its first
  // moment, also in tabs that the extension cannot mute: a tab in another browser context (chrome-devtools-mcp
  // new_page with isolatedContext, Target.createBrowserContext) is not in the tab list of the extension, and its sound
  // plays (observed with Chrome on 4 October 2026). A browser with the sound on starts without the flag, and the
  // extension loads, so the switch can mute its tabs later without a restart (setSound).
  // A Chrome that held the profile keeps the start flags it has (Sharp view, --mute-audio): the flag is read from its
  // process (hasMuteFlag). When it does not match the choice and the extension cannot fix it, that Chrome restarts.
  let reused = !!b;
  const muted = !readMeta(id).sound;
  if (!b) b = await launch(muted);
  let muteFlag = hasMuteFlag(b.pid), check: SoundCheck;
  if (muted && muteFlag) check = { state: 'muted', how: 'flag', at: new Date().toISOString() };
  else {
    const r = await muteTabs(b.ws, muted).catch(e => ({ error: (e as Error).message }) as TabsReport);
    check = judge(muted, muteFlag, r);
    if (r.error) console.error(`task browser ${id}: the sound extension did not load: ${r.error}`);
    // a reused Chrome without the flag that could not be muted, or a Chrome with the flag and the sound on
    if ((muted && check.state !== 'muted') || (!muted && muteFlag)) {
      console.log(`${new Date().toISOString()} task browser ${id}: Chrome starts again ${muted ? 'with' : 'without'} --mute-audio (${check.reason || 'the sound is on'})`);
      await closeChrome(b.ws, b.pid); b = await launch(muted); reused = false;
      muteFlag = hasMuteFlag(b.pid);
      check = muted ? (muteFlag ? { state: 'muted', how: 'flag', at: new Date().toISOString() } : { state: 'unverified', at: new Date().toISOString(), reason: 'Chrome started without --mute-audio.' })
        : judge(false, muteFlag, await muteTabs(b.ws, false).catch(e => ({ error: (e as Error).message }) as TabsReport));
    }
  }
  const port = b.port;
  const next: Meta = { ...meta, pid: b.pid, port, started: new Date().toISOString(), muted, muteFlag: muteFlag || undefined, soundCheck: check, sharp: (reused ? meta.sharp : sharp) || undefined, scale: (reused ? meta.scale : sharp ? scale : undefined), suspended: undefined, idleStopped: undefined, error: undefined, errorLines: undefined, errorAt: undefined, exited: undefined, stoppedAt: undefined };
  const v = { webSocketDebuggerUrl: b.ws };
  if (urls.length) await openSaved(port, v.webSocketDebuggerUrl, urls);
  next.startMs = Date.now() - t0;
  writeMeta(id, next);
  lastUse.set(id, Date.now());
  watchExit(id, b.pid, b.child);
  watchDialogs(id, v.webSocketDebuggerUrl);
  // sign-in sharing: the deferred sign-out and the live cookies reach the browser before an agent uses it
  for (const fn of started) { try { await Promise.race([fn(id, v.webSocketDebuggerUrl), new Promise(r => setTimeout(r, 10000))]); } catch (e) { console.error(`task browser ${id}: sign-in sharing at the start failed: ${(e as Error).message}`); } }
  return { ...readMeta(id), ws: v.webSocketDebuggerUrl };
}

// ---------- the pixel density of a task browser ----------
// A browser view reports the device pixel ratio of its screen ('hello' with dpr). The last one is kept in
// browsers/screen.json, so a browser that an agent starts later gets it too. startScale() gives the factor for
// --force-device-scale-factor at a start: the screen's ratio ('screen'), 1 ('one') or 2 ('two'), from 1 to 3, in steps
// of 0.25. A running browser keeps its factor until its next start (the view offers a restart when they differ).
const screenFile = () => join(DIR, 'screen.json');
let screenDpr: number | undefined;
export function noteScreen(dpr: unknown) {
  const n = Math.round(Math.min(3, Math.max(1, Number(dpr) || 1)) * 4) / 4;
  if (n === screenDpr) return;
  screenDpr = n;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(screenFile(), JSON.stringify({ dpr: n, at: new Date().toISOString() })); } catch { /* read-only */ }
}
export function startScale(): number {
  const s = machine.get().browser?.scale ?? (machine.get().browser?.sharp ? 'two' : 'screen');
  if (s === 'one') return 1;
  if (s === 'two') return 2;
  if (screenDpr === undefined) { try { screenDpr = Number(JSON.parse(readFileSync(screenFile(), 'utf8')).dpr) || 1; } catch { screenDpr = 1; } }
  return screenDpr;
}

// ---------- a Chrome that ends by itself after its start ----------
// Each running browser has a check: the 'exit' event of the Chrome process that this server started, and a check of
// the process id every 2 s (also for a Chrome that was running before this server started; stopIdle() adds those).
// A Chrome that ends while no stop and no start of that browser runs is recorded in browser.json (error, exited, the
// useful lines of chrome.log) and in the task log. The next use starts it again: ensure() finds no live process.
const exitChecks = new Map<string, { pid: number; timer: NodeJS.Timeout }>();
function watchExit(id: string, pid: number, child?: ChildProcess) {
  const had = exitChecks.get(id);
  if (had?.pid === pid) return;
  if (had) clearInterval(had.timer);
  const offset = logSize(id);
  const gone = (how: string) => {
    const c = exitChecks.get(id);
    if (c?.pid !== pid) return;
    clearInterval(c.timer); exitChecks.delete(id);
    markExited(id, pid, how, offset);
  };
  const timer = setInterval(() => { if (!pidAlive(pid)) gone(''); }, 2000);
  timer.unref();
  exitChecks.set(id, { pid, timer });
  child?.once('exit', (code, signal) => gone(code !== null ? `exit code ${code}` : `signal ${signal}`));
}
function markExited(id: string, pid: number, how: string, offset = Math.max(0, logSize(id) - 16384)) {
  const m = readMeta(id);
  // the user quit the Chrome of a task browser in a window: the browser goes back to the panel with its pages
  if (m.window && m.pid === pid && !stopping.has(id) && !starting.has(id)) { writeMeta(id, { ...m, pid: undefined, port: undefined, window: undefined, tabs: windowTabs.get(id) || m.tabs, stoppedAt: new Date().toISOString() }); windowTabs.delete(id); changed(id); return; }
  // the user closed the template's Chrome window: that is not a failure
  if (m.headed && m.pid === pid) { writeMeta(id, { ...m, pid: undefined, headed: undefined, stoppedAt: new Date().toISOString() }); changed(id); windowEnded(); return; }
  // a stop or a start of this browser ended this process on purpose, or browser.json names another process now
  if (m.pid !== pid || stopping.has(id) || starting.has(id)) return;
  const lines = usefulLines(logSince(id, offset));
  const at = new Date();
  const error = `Chrome ended by itself at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${how ? ` (${how})` : ''}. It starts again at the next use.`;
  writeMeta(id, { ...m, pid: undefined, port: undefined, stoppedAt: at.toISOString(), error, errorLines: lines.length ? lines : undefined, errorAt: at.toISOString(), exited: true });
  console.error(`${at.toISOString()} task browser ${id}: ${error}${lines.length ? `\n  ${lines.join('\n  ')}` : ''}`);
  dialogWatch.get(id)?.ws.terminate();
  changed(id);
  problem(id, error, lines);
}

// Listeners for a start that failed and for a Chrome that ended by itself (runtime-routes.ts writes the task log).
// Listeners that run after each start, before ensure() returns (browser-signins.ts).
const started = new Set<(id: string, ws: string) => Promise<void> | void>();
export const onStarted = (fn: (id: string, ws: string) => Promise<void> | void) => { started.add(fn); };
// Listeners for the end of the template's normal Chrome window (browser-signins.ts copies the new sign-ins then).
const windowClosed = new Set<() => void>();
export const onTemplateWindowClosed = (fn: () => void) => { windowClosed.add(fn); };
// markExited (the user quit the window) and stop (Close the Chrome window in Settings) both call this; a listener that
// has nothing left to do returns at once
const windowEnded = () => { for (const fn of windowClosed) try { fn(); } catch { /* listener failed */ } };
const problems = new Set<(id: string, message: string, lines: string[]) => void>();
export const onProblem = (fn: (id: string, message: string, lines: string[]) => void) => { problems.add(fn); };
const problem = (id: string, message: string, lines: string[]) => { for (const fn of problems) try { fn(id, message, lines); } catch { /* listener failed */ } };

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
export function once(wsUrl: string, method: string, params: object = {}, timeout = 5000): Promise<any> {
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
export function stop(id: string, opts: { suspended?: boolean; idle?: boolean; keepTabs?: boolean } = {}): Promise<boolean> {
  const pending = stopping.get(id);
  if (pending) return pending;
  const p = stopNow(id, opts);
  stopping.set(id, p);
  p.finally(() => { if (stopping.get(id) === p) stopping.delete(id); }).catch(() => {});
  return p;
}
async function stopNow(id: string, opts: { suspended?: boolean; idle?: boolean; keepTabs?: boolean }): Promise<boolean> {
  // a start that runs ends first, so a stop (for example the archive of the task) does not leave its Chrome running
  await starting.get(id)?.catch(() => {});
  const m = readMeta(id);
  // the template in a normal Chrome window: SIGTERM lets Chrome close its profile and write its cookies
  if (m.headed && m.pid) {
    if (pidAlive(m.pid)) { try { process.kill(m.pid, 'SIGTERM'); } catch { /* ended */ } }
    await closeChrome(undefined, m.pid, 30000);
    writeMeta(id, { ...readMeta(id), pid: undefined, headed: undefined, stoppedAt: new Date().toISOString() });
    changed(id);
    windowEnded();
    return true;
  }
  // a Chrome that holds the profile but is not in browser.json (a start that failed before this version lost it)
  const holder = m.pid ? undefined : profileHolder(id);
  if (!m.pid && !m.port && !holder) return false;
  const running = await live(id);
  // a busy Chrome can answer slowly: wait up to 5 s, and keep the saved pages when it does not answer
  const listed = running ? await pageList(running.port!, 5000) : null;
  // keepTabs: the saved pages stay (a window that the user closed has no pages left)
  const open = listed && !opts.keepTabs ? listed.map(t => t.url).filter(u => /^(https?|file):/.test(u)) : m.tabs;
  // The template waits up to 30 s: new task browsers copy its cookies. On a busy Mac (load average 140 on 10 cores,
  // 2 October 2026) Chrome took more than 10 s to close, and the end of the wait lost cookies that it had not written.
  await closeChrome(running?.ws, m.pid || holder, id === TEMPLATE ? 30000 : 10000);
  writeMeta(id, { ...readMeta(id), pid: undefined, port: undefined, tabs: open, stoppedAt: new Date().toISOString(), suspended: opts.suspended || undefined, idleStopped: opts.idle || undefined });
  changed(id);
  return !!running;
}

// Close Chrome with Browser.close. Chrome writes cookies to disk when it closes: wait up to 10 s before the kill, so a
// busy Chrome keeps its sign-ins.
async function closeChrome(ws: string | undefined, pid: number | undefined, waitMs = 10000) {
  if (ws) await once(ws, 'Browser.close').catch(() => {});
  for (let i = 0; i < waitMs / 100 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
  if (pid && pidAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } } }
}

// ---------- sound: --mute-audio, and Chrome's own tab mute, set by a small extension ----------
// Two ways mute a browser:
// - --mute-audio, a start flag. It mutes every sound of that Chrome, in every browser context. Chrome then reports no
//   tab as audible. It works only from the start of Chrome, so a change of it restarts the browser.
// - The tab mute. The DevTools protocol has no command that mutes a tab. An extension can mute a tab with
//   chrome.tabs.update({ muted }), the same mute as the speaker icon of a tab in Chrome. Chrome keeps that mute over
//   reloads and navigations, and it covers every frame of the tab and every kind of sound (audio and video elements,
//   Web Audio). It does not work for a tab in another browser context (see start): such a tab stays audible.
// A browser with the sound off starts with the flag (start). The tab mute lets the switch mute a running browser at
// once, without a restart, and checkSound uses the extension to read the state of each tab back from Chrome.
// Each browser loads the extension below at every start (ensure), from one folder in the Taskboard folder, so the
// extension has the same id in every browser and after every release. Chrome does not keep it over a restart.
// The extension saves the state in chrome.storage.local and mutes each new tab (a popup too) at tabs.onCreated. The
// server calls setMuted() in the extension's service worker. It sets the state, applies it, and returns each tab's
// mutedInfo.muted and audible (Chrome marks a tab that played sound in the last seconds as audible, also when the tab
// is muted). Chrome stops an idle service worker after about 30 s, so muteTabs() then loads the extension again to
// start it. A tab keeps its mute over that new load.
const EXT_DIR = join(TB_DIR, 'browser-extension');
const EXT_FILES: Record<string, string> = {
  'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Taskboard sound', version: '2', description: 'Mutes or unmutes the tabs of this browser for the Taskboard sound switch.', permissions: ['tabs', 'storage'], background: { service_worker: 'background.js' } }, null, 2),
  'background.js': `// Taskboard: the sound switch of this browser. The Taskboard server calls setMuted() over DevTools.
let muted = null;
const stored = chrome.storage.local.get('muted');
async function want() { if (muted === null) { const m = (await stored).muted !== false; if (muted === null) muted = m; } return muted; }
// one change at a time, so the last call wins
let chain = Promise.resolve();
const run = fn => (chain = chain.then(fn, fn));
const set = (tab, m) => !!tab.mutedInfo?.muted === m ? null : chrome.tabs.update(tab.id, { muted: m }).catch(() => null);
const apply = () => run(async () => { const m = await want(); await Promise.all((await chrome.tabs.query({})).map(t => set(t, m))); });
chrome.tabs.onCreated.addListener(tab => run(async () => { await set(tab, await want()); }));
chrome.tabs.onReplaced.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.runtime.onInstalled.addListener(apply);
// the state of each tab as Chrome reports it now
const report = async () => (await chrome.tabs.query({})).map(t => ({ muted: !!t.mutedInfo?.muted, audible: !!t.audible, incognito: !!t.incognito }));
globalThis.setMuted = async m => {
  muted = !!m;
  await chrome.storage.local.set({ muted });
  await apply();
  return report();
};
apply();
`,
};
export function writeExtension() {
  mkdirSync(EXT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(EXT_FILES)) {
    const f = join(EXT_DIR, name);
    if (!existsSync(f) || readFileSync(f, 'utf8') !== text) writeFileSync(f, text);
  }
}
// What muteTabs read back: each tab's state, or why it could not set and read it (error). otherContexts: the number of
// pages in other browser contexts (Target.getBrowserContexts). The extension does not see those pages at all (observed
// with Chrome on 4 October 2026), so the extension cannot mute them, and the DevTools protocol counts them.
export interface TabsReport { tabs?: { muted: boolean; audible: boolean; incognito?: boolean }[]; otherContexts?: number; error?: string }
// The start flags of a running Chrome process include --mute-audio (read from the process, not from browser.json).
export function hasMuteFlag(pid: number | undefined): boolean {
  if (!pid) return false;
  try { return / --mute-audio( |$)/m.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })); } catch { return false; }
}
// The state of the sound from the wanted state, the flag and the read back of the tabs. A tab that is audible and not
// muted while the sound is off is heard. A tab that is not muted while the sound is off can be heard at any moment.
export function judge(muted: boolean, flag: boolean, r: TabsReport, at = new Date().toISOString()): SoundCheck {
  if (!muted) return { state: 'on', at };
  if (flag) return { state: 'muted', how: 'flag', at };
  if (r.error || !r.tabs) return { state: 'unverified', at, reason: `The sound extension did not answer: ${r.error || 'no tab list'}` };
  const open = r.tabs.filter(t => !t.muted);
  if (r.otherContexts) return { state: 'unverified', at, reason: `${r.otherContexts} ${r.otherContexts === 1 ? 'page is' : 'pages are'} in another browser context, where the extension cannot mute ${r.otherContexts === 1 ? 'it' : 'them'}.` };
  if (!open.length) return { state: 'muted', how: 'tabs', at };
  const heard = open.filter(t => t.audible).length;
  return { state: 'unverified', at, reason: `${open.length} ${open.length === 1 ? 'tab is' : 'tabs are'} not muted${heard ? `, ${heard} of them audible` : ''}${open.some(t => t.incognito) ? ' (a tab in another browser context, which the extension cannot mute)' : ''}.` };
}
// Load the sound extension into a running browser, mute or unmute all its tabs, and read their state back. Throws
// when it cannot.
async function muteTabs(browserWs: string, muted: boolean): Promise<TabsReport> {
  writeExtension();
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  let next = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } });
  // a closed connection (also by the time limit below) ends each call that waits
  ws.on('close', () => { for (const fn of waiting.values()) fn({ error: { message: 'The connection to Chrome closed.' } }); waiting.clear(); });
  const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('The connection to Chrome closed.'));
    const n = ++next; waiting.set(n, m => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  // A stopped service worker takes several seconds to start on a busy computer: a read of a running browser on
  // 4 October 2026 waited more than 4 s. The limit was 10 s, and 7 starts that day ended at it with "The connection to
  // Chrome closed." The limit is now 20 s.
  const timer = setTimeout(() => ws.terminate(), 20000);
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('The connection to Chrome closed.'))); });
    // The extension is loaded when it is missing or its service worker is not running. A load of a loaded extension
    // starts a new service worker, and Chrome can list the old one for a moment: a failed call tries again.
    let ext = ((await call('Extensions.getExtensions').catch(() => null))?.extensions as { id: string; path: string }[] | undefined)?.find(e => e.path === EXT_DIR || e.path === realpathSync(EXT_DIR))?.id;
    let loaded = false, failed: Error | null = null;
    for (let i = 0; i < 100; i++) {
      const worker = ext && ((await call('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[]).find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ext}/`));
      if (!worker && !loaded) { ext = (await call('Extensions.loadUnpacked', { path: EXT_DIR })).id; loaded = true; continue; }
      if (worker) {
        try {
          const { sessionId } = await call('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
          const r = await call('Runtime.evaluate', { expression: `setMuted(${muted})`, awaitPromise: true, returnByValue: true }, sessionId);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          await call('Target.detachFromTarget', { sessionId }).catch(() => {});
          // an extension of an older release returns true or false instead of the tab list
          if (!Array.isArray(r.result?.value)) { loaded = false; ext = undefined; throw new Error('An older sound extension answered.'); }
          const contexts = new Set(((await call('Target.getBrowserContexts')).browserContextIds || []) as string[]);
          const otherContexts = ((await call('Target.getTargets')).targetInfos as { type: string; browserContextId?: string }[]).filter(t => t.type === 'page' && t.browserContextId && contexts.has(t.browserContextId)).length;
          return { tabs: r.result.value, otherContexts };
        } catch (e) { failed = e as Error; loaded = false; } // the worker can stop at this moment: load it again
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw failed || new Error('The sound extension did not start.');
  } finally { clearTimeout(timer); ws.close(); }
}

// Turn the sound of one browser on or off. A stopped browser gets the choice at its next start.
// - Sound on: a browser with --mute-audio restarts without it (stop keeps its tabs, and the start opens them again).
//   Any other running browser unmutes its tabs at once, with its tabs and its agent connections.
// - Sound off: the tabs are muted at once (muteTabs), and the state is read back (judge). When a tab stays unmuted or
//   the extension does not answer, the browser restarts with --mute-audio.
// The template in a normal Chrome window (openTemplateWindow) keeps its flag until that window opens again: Taskboard
// does not close a window in which the user can be in the middle of a sign-in.
// Calls for one browser run one at a time, with the checks of checkSound.
const soundCalls = new Map<string, Promise<unknown>>();
function inSoundQueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const p = (soundCalls.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  soundCalls.set(id, p);
  p.finally(() => { if (soundCalls.get(id) === p) soundCalls.delete(id); }).catch(() => {});
  return p;
}
export function setSound(id: string, on: boolean): Promise<{ restarted: boolean }> {
  folder(id);
  return inSoundQueue(id, () => setSoundNow(id, on));
}
// The time of the last restart of each browser for its sound: a second restart by checkSound within SOUND_RESTART_MS
// does not run, and the browser shows 'unverified' instead, so a Chrome that cannot be muted does not restart again and
// again. A click on the switch (setSound) always restarts when it must.
const soundRestarts = new Map<string, number>();
const SOUND_RESTART_MS = 60000;
async function restartForSound(id: string, reason: string, force = false): Promise<boolean> {
  if (!force && Date.now() - (soundRestarts.get(id) || 0) < SOUND_RESTART_MS) return false;
  soundRestarts.set(id, Date.now());
  console.log(`${new Date().toISOString()} task browser ${id}: restarts for the sound switch: ${reason}`);
  await stop(id); await ensure(id);
  return true;
}
function setCheck(id: string, check: SoundCheck, patch: Partial<Meta> = {}) {
  writeMeta(id, { ...readMeta(id), ...patch, soundCheck: check });
  changed(id);
}
async function setSoundNow(id: string, on: boolean): Promise<{ restarted: boolean }> {
  await starting.get(id)?.catch(() => {}); // a start that runs reads the choice when it ends
  writeMeta(id, { ...readMeta(id), sound: on || undefined });
  const m = readMeta(id);
  if (id === TEMPLATE && m.headed && pidAlive(m.pid)) { setCheck(id, templateWindowCheck()); return { restarted: false }; }
  const running = await live(id);
  if (!running) { changed(id); return { restarted: false }; }
  const flag = hasMuteFlag(running.pid);
  if (on && flag) return { restarted: await restartForSound(id, 'the sound is on, and Chrome runs with --mute-audio', true) };
  // muted is written first, so a dashboard view that asks in the meantime shows the new state
  writeMeta(id, { ...readMeta(id), muted: !on });
  const r = await muteTabs(running.ws, !on).catch(e => ({ error: (e as Error).message }) as TabsReport);
  const check = judge(!on, flag, r);
  setCheck(id, check, { muteFlag: flag || undefined });
  if (check.state === 'unverified') {
    console.error(`task browser ${id}: the mute is not confirmed: ${check.reason}`);
    if (await restartForSound(id, check.reason || '', true)) return { restarted: true };
  }
  return { restarted: false };
}

// ---------- the check of the sound of each running browser ----------
// checkSound reads the state back from Chrome and fixes it: the flag of the Chrome process, then (without the flag)
// the mute of each tab, set again and read back with muteTabs. A browser with the sound off and a tab that stays
// unmuted (a tab in another browser context) restarts with --mute-audio. checkSounds() runs it every 30 s for each
// running browser with the sound off and without the flag, and for each browser with an open view. A new tab or a
// change of a tab (Target.targetCreated, Target.targetInfoChanged in watchDialogs) runs it after SOUND_SOON_MS.
// The result is in browser.json (soundCheck), and the dashboard shows it (status().soundState).
export function checkSound(id: string): Promise<SoundCheck | null> {
  return inSoundQueue(id, async () => {
    if (starting.has(id) || stopping.has(id)) return null;
    const m = readMeta(id);
    if (id === TEMPLATE && m.headed && pidAlive(m.pid)) { const c = templateWindowCheck(); setCheck(id, c); return c; }
    const running = await live(id);
    if (!running) return null;
    const muted = !m.sound, flag = hasMuteFlag(running.pid);
    if (!muted || flag) { const c = judge(muted, flag, {}); if (m.soundCheck?.state !== c.state || m.soundCheck?.how !== c.how) setCheck(id, c, { muteFlag: flag || undefined }); return c; }
    const r = await muteTabs(running.ws, true).catch(e => ({ error: (e as Error).message }) as TabsReport);
    const c = judge(true, false, r);
    setCheck(id, c, { muteFlag: undefined });
    if (c.state === 'unverified') {
      console.error(`task browser ${id}: the mute is not confirmed: ${c.reason}`);
      await restartForSound(id, c.reason || '');
      return readMeta(id).soundCheck || c;
    }
    return c;
  });
}
// The template in a normal Chrome window: only its start flag mutes it.
const templateWindowCheck = (): SoundCheck => hasMuteFlag(readMeta(TEMPLATE).pid)
  ? { state: 'muted', how: 'flag', at: new Date().toISOString() }
  : readMeta(TEMPLATE).sound ? { state: 'on', at: new Date().toISOString() } : { state: 'unverified', at: new Date().toISOString(), reason: 'The Chrome window of the template runs without --mute-audio. It is muted from its next opening.' };
// Each event moves the check to SOUND_SOON_MS after it, so a tab that opens while a check waits is in that check. A check
// waits at most SOUND_SOON_MAX_MS after the first event, so a page that changes all the time does not stop the checks.
const SOUND_SOON_MS = 1500, SOUND_SOON_MAX_MS = 5000;
const soundSoon = new Map<string, { timer: NodeJS.Timeout; first: number }>();
function checkSoundSoon(id: string) {
  if (readMeta(id).sound) return;
  const had = soundSoon.get(id), first = had?.first ?? Date.now();
  if (had) clearTimeout(had.timer);
  const timer = setTimeout(() => { soundSoon.delete(id); void checkSound(id).catch(() => {}); }, Math.max(0, Math.min(SOUND_SOON_MS, first + SOUND_SOON_MAX_MS - Date.now())));
  timer.unref(); soundSoon.set(id, { timer, first });
}
export async function checkSounds(): Promise<void> {
  let ids: string[] = [];
  try { ids = readdirSync(DIR); } catch { return; }
  for (const id of ids) {
    if (!ID.test(id)) continue;
    const m = readMeta(id);
    if (!m.pid || !pidAlive(m.pid)) continue;
    const risky = !m.sound && !(m.soundCheck?.how === 'flag' && hasMuteFlag(m.pid));
    if (risky || viewers.get(id)) await checkSound(id).catch(e => console.error(`task browser ${id}: the sound check failed: ${(e as Error).message}`));
  }
}
let soundTimer: NodeJS.Timeout | undefined;
export function watchSounds(everyMs = 30000) {
  if (soundTimer) return;
  const tick = (ms: number) => { soundTimer = setTimeout(() => { void checkSounds().finally(() => tick(everyMs)); }, ms); soundTimer.unref(); };
  tick(5000); // soon after the server starts: a Chrome that ran before has no check from this server yet
}

// Copy the template again: the task browser loses its own sign-ins and gets the template's. A task browser that opted
// out of shared sign-ins (noShared) gets an empty profile instead.
export async function resetFromTemplate(id: string) {
  if (id === TEMPLATE) throw new Error('The template cannot be reset from itself.');
  if (readMeta(id).noShared) {
    await stop(id);
    rmSync(profileDir(id), { recursive: true, force: true });
    writeMeta(id, { ...readMeta(id), copiedFromTemplate: undefined, syncedAt: undefined, clearSites: undefined });
    changed(id);
    return;
  }
  if (!existsSync(profileDir(TEMPLATE))) throw new Error('There is no template profile yet. Open the template browser on the Settings page and sign in first.');
  if (templateOpen()) throw new Error('The template browser is open. Close it on the Settings page first.');
  await stop(id);
  rmSync(profileDir(id), { recursive: true, force: true });
  copyTemplate(id);
  writeMeta(id, { ...readMeta(id), copiedFromTemplate: new Date().toISOString(), syncedAt: undefined, clearSites: undefined });
  changed(id);
}
// Open the template profile in a normal Chrome window, without headless mode, without a debugging port and without
// any automation flag. Google and some other sites refuse a sign-in in a browser that a program controls (the headless
// task browser reports HeadlessChrome and navigator.webdriver). The user signs in in this window and closes it. Task
// browsers then copy the profile. Taskboard cannot see or control this window: it only records its process.
export async function openTemplateWindow(url = 'https://accounts.google.com/') {
  if (templateWindowOpen()) return;
  const bin = chromePath();
  if (!bin) throw new Error('No Chrome found. Install Google Chrome, or set the Chrome path on the Settings page.');
  await stop(TEMPLATE);
  await templateUse?.catch(() => {});
  mkdirSync(profileDir(TEMPLATE), { recursive: true });
  const log = openSync(join(folder(TEMPLATE), 'chrome.log'), 'a');
  const child = spawn(bin, templateWindowArgs(profileDir(TEMPLATE), url, !readMeta(TEMPLATE).sound), { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  if (!child.pid) throw new Error('Chrome did not start.');
  writeMeta(TEMPLATE, { ...readMeta(TEMPLATE), pid: child.pid, port: undefined, headed: true, started: new Date().toISOString(), error: undefined, errorLines: undefined, errorAt: undefined, exited: undefined });
  writeMeta(TEMPLATE, { ...readMeta(TEMPLATE), soundCheck: templateWindowCheck() });
  watchExit(TEMPLATE, child.pid, child);
  changed(TEMPLATE);
}

// ---------- a task browser in a normal Chrome window (Open in a window) ----------
// Chrome cannot change between headless and a window while it runs, and two Chrome processes cannot use one profile.
// So setWindow() stops the browser (its pages are saved, Browser.close writes the cookies) and starts it again in the
// other mode with the same profile and pages. Each change reloads the pages: text that the user typed and did not send
// is lost, so the view asks first when unsent() finds such text. The agent's connection closes at the change, and
// chrome-devtools-mcp connects again at its next tool call. While the window is open, watchWindow() keeps the page
// addresses: when the user closes the last tab or quits that Chrome, the browser goes back to the panel with them.
const windowTabs = new Map<string, string[]>();
const windowWatch = new Map<string, NodeJS.Timeout>();
export async function setWindow(id: string, on: boolean) {
  if (id === TEMPLATE) throw new Error('The template opens in a window from the Settings page.');
  if (!!readMeta(id).window === on && await isRunning(id)) { if (on) await showWindow(id); return; }
  await stop(id);
  updateMeta(id, { window: on || undefined });
  await ensure(id);
  if (on) { watchWindow(id); await showWindow(id); }
  else { windowTabs.delete(id); clearInterval(windowWatch.get(id)); windowWatch.delete(id); }
}
// Bring the window of a task browser to the front (Show the window).
export async function showWindow(id: string) {
  const m = await live(id); if (!m || !readMeta(id).window) return;
  const page = (await pageList(m.port!))?.[0]; if (!page) return;
  const r = await once(m.ws, 'Browser.getWindowForTarget', { targetId: page.id }).catch(() => null);
  if (r?.windowId) await once(m.ws, 'Browser.setWindowBounds', { windowId: r.windowId, bounds: { windowState: 'normal' } }).catch(() => {});
  const t = (await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[]).find(x => x.id === page.id);
  if (t) await once(t.webSocketDebuggerUrl, 'Page.bringToFront').catch(() => {});
}
function watchWindow(id: string) {
  clearInterval(windowWatch.get(id));
  const timer = setInterval(async () => {
    const m = readMeta(id);
    if (!m.window || stopping.has(id) || starting.has(id)) { if (!m.window) { clearInterval(timer); windowWatch.delete(id); } return; }
    const r = await live(id); if (!r) return; // a Chrome that quit: markExited() handles it
    const list = await pageList(r.port!); if (!list) return;
    const urls = list.map(t => t.url).filter(u => /^(https?|file):/.test(u));
    if (urls.length) { windowTabs.set(id, urls); return; }
    if (list.length) return; // only blank tabs: the window is still open
    // the user closed the window (Chrome on macOS keeps running without one): back to the panel with the pages
    clearInterval(timer); windowWatch.delete(id);
    updateMeta(id, { tabs: windowTabs.get(id) || m.tabs, window: undefined });
    windowTabs.delete(id);
    await stop(id, { keepTabs: true }).catch(() => {});
    void ensure(id).catch(() => {});
  }, 2000);
  timer.unref();
  windowWatch.set(id, timer);
}
// The number of text fields on the open pages with text that is not sent yet (value changed from the page's own), so
// the view can ask before a change of mode reloads them. Passwords count; their text is never read here.
const UNSENT = `[...document.querySelectorAll('input, textarea')].filter(e => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color'].includes(e.type) && e.value !== e.defaultValue).length + [...document.querySelectorAll('[contenteditable=""], [contenteditable="true"]')].filter(e => e.textContent.trim()).length`;
export async function unsent(id: string): Promise<number> {
  const m = await live(id); if (!m) return 0;
  const list = await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  let n = 0;
  for (const t of list.filter(x => x.type === 'page').slice(0, 20)) {
    const r = await once(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: UNSENT, returnByValue: true }, 2000).catch(() => null);
    n += Number(r?.result?.value) || 0;
  }
  return n;
}

// The task was removed from Taskboard: stop its browser and delete its profile (it holds copied sign-ins).
export async function remove(id: string) { await stop(id).catch(() => {}); rmSync(folder(id), { recursive: true, force: true }); }

// starting: a start runs (seconds since it began, the limit, and the Chrome process it waits for). systemMemory: the
// free memory of the computer, sent while the browser is not running, so the dashboard can warn before a start.
export interface Status { id: string; running: boolean; port?: number; tabs: Tab[]; profile: boolean; copiedFromTemplate?: string; suspended?: boolean; idleStopped?: boolean; idleStopMinutes: number; startMs?: number; started?: string; stoppedAt?: string; error?: string; errorLines?: string[]; errorAt?: string; exited?: boolean; starting?: { seconds: number; limitSeconds: number; pid?: number }; systemMemory?: memory.SystemMemory | null; memMb?: number | null; rssMb?: number | null; agents: number; viewers: number; chrome: string | null; sound: boolean; muted: boolean; sharp: boolean;
  // soundState: the real state of the sound (checkSound): 'muted' (confirmed), 'on', or 'unverified' (soundReason says
  // why). A stopped browser shows the state of its next start.
  soundState: SoundState; soundReason?: string;
  // sign-in sharing: noShared (opt-out), syncedAt, headed (the template in a Chrome window), and from statusExtra:
  // templateSites, the number of sites with cookies in the template (null: unknown)
  noShared: boolean; syncedAt?: string; headed?: boolean; templateSites?: number | null; window?: boolean;
  // signinWindow: the last sign-in in the template's Chrome window for this task browser (an 'open' one only while that window is open)
  signinWindow?: SigninWindow }
// More status fields from another module (browser-signins.ts adds templateSites).
let statusExtra: (id: string) => Promise<Partial<Status>> = async () => ({});
export const setStatusExtra = (fn: (id: string) => Promise<Partial<Status>>) => { statusExtra = fn; };
// a running browser has the state that muteTabs set (none for a browser started before this setting existed); a
// stopped browser gets the saved choice at its next start
const mutedNow = (m: Meta, running: boolean) => running ? !!m.muted : !m.sound;
// a running browser without a check from this release has not been confirmed yet (checkSounds runs within 5 s)
export const soundStateOf = (m: Meta, running: boolean): { soundState: SoundState; soundReason?: string } => !running ? { soundState: m.sound ? 'on' : 'muted' }
  : m.soundCheck ? { soundState: m.soundCheck.state, soundReason: m.soundCheck.reason } : { soundState: 'unverified', soundReason: 'Taskboard has not checked this browser yet.' };
const startingNow = (id: string) => { const s = progress.get(id); return s ? { seconds: Math.floor((Date.now() - s.since) / 1000), limitSeconds: startLimitMs() / 1000, pid: s.pid } : undefined; };
export async function status(id: string): Promise<Status> {
  // a start that runs is reported without asking Chrome: its port does not answer yet
  const m = readMeta(id), running = progress.has(id) ? null : await live(id);
  const mem = running ? await memory.groupMb(m.pid) : null;
  return { id, running: !!running, port: running?.port, tabs: running ? await tabs(id) : (m.tabs || []).map((url, i) => ({ id: `saved-${i}`, title: url, url })),
    profile: existsSync(profileDir(id)), copiedFromTemplate: m.copiedFromTemplate, suspended: m.suspended, idleStopped: m.idleStopped, idleStopMinutes: idleStopMs() / 60000,
    startMs: m.startMs, started: running ? m.started : undefined, stoppedAt: m.stoppedAt, error: running ? undefined : m.error, errorLines: running ? undefined : m.errorLines, errorAt: running ? undefined : m.errorAt, exited: running ? undefined : m.exited,
    starting: startingNow(id), systemMemory: running ? undefined : await memory.systemMemory(),
    // memMb is the footprint of the browser's processes (memory.ts). rssMb has the same value for older callers.
    memMb: mem, rssMb: mem, agents: agentCount(id), viewers: viewers.get(id) || 0, chrome: chromePath(), sound: !!m.sound, muted: mutedNow(m, !!running), ...soundStateOf(m, !!running || (id === TEMPLATE && templateWindowOpen())), sharp: !!(running && m.sharp),
    noShared: !!m.noShared, syncedAt: m.syncedAt, headed: id === TEMPLATE && templateWindowOpen() ? true : undefined, window: m.window || undefined,
    signinWindow: m.signinWindow && (m.signinWindow.state !== 'open' || templateWindowOpen()) ? m.signinWindow : undefined, ...(await statusExtra(id).catch(() => ({}))) };
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
// Each call also checks every browser (the template too) for a Chrome that ended by itself (watchExit, markExited).
// Stop each running task browser that got no agent command and had no viewer and no screencast for idleStopMs(). An
// open agent connection that sent no command for that time does not keep the browser: chrome-devtools-mcp keeps its
// connection open until the agent session ends. The open tab addresses are saved, so the next start opens the same
// pages. The template browser is not stopped here.
// A browser that was running before this server started gets the full time from the server start.
export async function stopIdle(now = Date.now()): Promise<string[]> {
  const ms = idleStopMs(), done: string[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(DIR); } catch { return done; }
  for (const id of ids) {
    if (!ID.test(id)) continue;
    const m = readMeta(id);
    // a Chrome that ended while this server did not watch it (watchExit), and a Chrome that this server did not start
    if (m.pid && !pidAlive(m.pid)) markExited(id, m.pid, '');
    else if (m.pid && !starting.has(id)) { watchExit(id, m.pid); if (m.window && !windowWatch.has(id)) watchWindow(id); }
    if (id === TEMPLATE || !ms) continue;
    if (!m.pid || !pidAlive(m.pid)) { lastUse.delete(id); continue; }
    // a browser in a window is in the user's hands: it stops only when the user closes the window
    if (viewed(id) || starting.has(id) || stopping.has(id) || m.window) { lastUse.set(id, now); continue; }
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
// The connection waits for ensure() up to AGENT_WAIT_MS. Most slow starts end in that time, and the agent's tool call
// then works. When the start takes longer or fails, the server answers each DevTools command of the agent with an error
// that says why, then closes the connection. chrome-devtools-mcp shows the agent "Could not connect to Chrome" with
// that text as the cause, and connects again at the next tool call. The start goes on without the agent.
export const AGENT_WAIT_MS = 40000;
export function agentRefusal(id: string, e?: Error): string {
  if (!e) {
    const s = startingNow(id);
    return `Taskboard: the task browser is still starting (Chrome has run for ${s?.seconds ?? Math.round(AGENT_WAIT_MS / 1000)} s; the computer is slow). Call the browser tool again in about 20 s. Taskboard waits up to ${startLimitMs() / 1000} s for Chrome.`;
  }
  return `Taskboard: the task browser did not start. ${e.message} The Browser tab of the task shows the details. Call the browser tool again to try once more.`;
}
export function proxyAgent(client: WebSocket, id: string, waitMs = AGENT_WAIT_MS) {
  const queue: (string | Buffer)[] = [];
  let up: WebSocket | null = null, closed = false, refusal = '';
  const conn: AgentConn = { last: Date.now(), close: () => done() };
  let set = agentConnections.get(id);
  if (!set) agentConnections.set(id, set = new Set());
  set.add(conn); lastUse.set(id, Date.now()); changed(id);
  const done = () => { if (closed) return; closed = true; clearTimeout(timer); set.delete(conn); lastUse.set(id, Date.now()); changed(id); try { up?.close(); } catch { /* closed */ } try { client.close(); } catch { /* closed */ } };
  // answer one DevTools command with an error (the agent's client rejects the call with this text)
  const refuse = (msg: string | Buffer) => {
    let m: { id?: number; sessionId?: string }; try { m = JSON.parse(msg.toString()); } catch { return; }
    if (typeof m.id === 'number' && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), error: { code: -32000, message: refusal } }));
  };
  const giveUp = (text: string) => {
    if (closed || up || refusal) return;
    refusal = text;
    for (const q of queue) refuse(q);
    queue.length = 0;
    // a short time for the commands that the client sends after its first one failed
    setTimeout(done, 1000).unref();
  };
  const watch = agentWatch(id);
  client.on('message', (d, binary) => {
    conn.last = Date.now(); const msg = binary ? d as Buffer : d.toString();
    if (typeof msg === 'string') watch.command(msg);
    if (refusal) refuse(msg);
    else if (up?.readyState === WebSocket.OPEN) up.send(msg); else if (queue.length < 1000) queue.push(msg); else done();
  });
  client.on('close', done); client.on('error', done);
  const timer = setTimeout(() => giveUp(agentRefusal(id)), waitMs);
  timer.unref();
  ensure(id).then(m => {
    if (closed || refusal) return;
    clearTimeout(timer);
    up = new WebSocket(m.ws, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    up.on('open', () => { for (const q of queue) up!.send(q); queue.length = 0; });
    up.on('message', (d, binary) => { if (!binary) watch.answer(d.toString()); if (client.readyState === WebSocket.OPEN) client.send(binary ? d : d.toString()); });
    up.on('close', done); up.on('error', done);
  }).catch(e => giveUp(agentRefusal(id, e as Error)));
}

// ---------- what the agent does, for the dashboard ----------
// The proxy reads each DevTools command of the agent before it forwards it (agentWatch), and turns the commands that
// act on a page into short events: a click (with its point in CSS pixels of the page), typed text (only its length),
// a scroll, a navigation, a new tab, a file upload, and a look at the page (a screenshot or a snapshot). The dashboard
// views of the browser show the last event and draw the agent's pointer (attachViewer). Nothing is held or refused:
// the user and the agent both act at any time. The commands carry a session id; the target of each session comes from
// Target.attachedToTarget events and from the answers to Target.attachToTarget.
export interface AgentEvent { kind: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'newTab' | 'upload' | 'look' | 'drag'; target?: string; x?: number; y?: number; url?: string; chars?: number; at: number }
const activity = new Map<string, Set<(e: AgentEvent) => void>>();
export function onAgentEvent(id: string, fn: (e: AgentEvent) => void) {
  let set = activity.get(id); if (!set) activity.set(id, set = new Set());
  set.add(fn);
  return () => { set.delete(fn); };
}
const lastAgent = new Map<string, AgentEvent>();
export const lastAgentEvent = (id: string) => lastAgent.get(id);
const LOOK = new Set(['Page.captureScreenshot', 'Accessibility.getFullAXTree', 'Accessibility.queryAXTree', 'DOMSnapshot.captureSnapshot']);
export function agentWatch(id: string) {
  const sessions = new Map<string, string>(), attaching = new Map<number, string>();
  // typed characters wait up to TYPE_MS, so a burst of keys is one event
  let typed: AgentEvent | null = null, typeTimer: NodeJS.Timeout | undefined;
  const TYPE_MS = 300;
  const emit = (e: AgentEvent) => { lastAgent.set(id, e); for (const fn of activity.get(id) || []) { try { fn(e); } catch { /* listener failed */ } } };
  const flushTyped = () => { clearTimeout(typeTimer); typeTimer = undefined; if (typed) { const e = typed; typed = null; emit(e); } };
  const type = (target: string | undefined, chars: number) => {
    if (typed && typed.target !== target) flushTyped();
    typed = typed ? { ...typed, chars: (typed.chars || 0) + chars, at: Date.now() } : { kind: 'type', target, chars, at: Date.now() };
    typeTimer ??= setTimeout(flushTyped, TYPE_MS);
  };
  return {
    command(text: string) {
      if (text.length > 200000) return; // a large command (a script, a file) is not an action to show
      let m: { id?: number; method?: string; params?: any; sessionId?: string };
      try { m = JSON.parse(text); } catch { return; }
      const method = m.method || '', p = m.params || {}, target = m.sessionId ? sessions.get(m.sessionId) : undefined, at = Date.now();
      if (method === 'Target.attachToTarget' && typeof m.id === 'number' && typeof p.targetId === 'string') attaching.set(m.id, p.targetId);
      else if (method === 'Input.dispatchMouseEvent') {
        if (p.type === 'mousePressed') { flushTyped(); emit({ kind: 'click', target, x: Number(p.x) || 0, y: Number(p.y) || 0, at }); }
        else if (p.type === 'mouseWheel') emit({ kind: 'scroll', target, x: Number(p.x) || 0, y: Number(p.y) || 0, at });
      }
      else if (method === 'Input.insertText' && typeof p.text === 'string') type(target, p.text.length);
      else if (method === 'Input.dispatchKeyEvent' && (p.type === 'keyDown' || p.type === 'char' || p.type === 'rawKeyDown')) {
        if (typeof p.text === 'string' && p.text && p.type !== 'char' && p.text !== '\r') type(target, p.text.length);
        else if (p.type !== 'char') { flushTyped(); if (/^(Enter|Tab|Escape|Backspace|Delete|Arrow\w+|Page\w+|Home|End)$/.test(String(p.key || ''))) emit({ kind: 'key', target, url: String(p.key), at }); }
      }
      else if (method === 'Input.dispatchDragEvent' && p.type === 'drop') emit({ kind: 'drag', target, x: Number(p.x) || 0, y: Number(p.y) || 0, at });
      else if (method === 'Page.navigate' && typeof p.url === 'string') { flushTyped(); emit({ kind: 'navigate', target, url: p.url.slice(0, 300), at }); }
      else if (method === 'Page.reload') emit({ kind: 'navigate', target, url: '', at });
      else if (method === 'Target.createTarget') emit({ kind: 'newTab', url: String(p.url || '').slice(0, 300), at });
      else if (method === 'DOM.setFileInputFiles') emit({ kind: 'upload', target, chars: Array.isArray(p.files) ? p.files.length : 0, at });
      else if (LOOK.has(method)) emit({ kind: 'look', target, at });
    },
    answer(text: string) {
      // only the attach events, and the answers to an attach command that waits, are read (the answer has no method)
      if (!text.includes('attach') && !(attaching.size && text.includes('sessionId'))) return;
      let m: { id?: number; method?: string; params?: any; result?: any };
      try { m = JSON.parse(text); } catch { return; }
      if (m.method === 'Target.attachedToTarget' && m.params?.sessionId && m.params?.targetInfo?.targetId) sessions.set(m.params.sessionId, m.params.targetInfo.targetId);
      else if (m.method === 'Target.detachedFromTarget' && m.params?.sessionId) sessions.delete(m.params.sessionId);
      else if (typeof m.id === 'number' && attaching.has(m.id)) { if (m.result?.sessionId) sessions.set(m.result.sessionId, attaching.get(m.id)!); attaching.delete(m.id); }
    },
  };
}

// ---------- the agent asks the user for help (tb browser ask) ----------
// The agent names what it needs, for example a sign-in or a captcha. The browser view shows the reason with a Done
// button and a note field, and the task list shows a chip. Done clears the request and types the note into the
// agent's session (onAskDone, runtime-routes.ts). Nothing waits on the request: the agent decides itself whether it
// waits. askOf() keeps the request in memory, so the task list does not read browser.json for each task.
const asks = new Map<string, Ask | null>();
export function askOf(id: string): Ask | null {
  if (!asks.has(id)) { let a: Ask | null = null; try { a = readMeta(id).ask ?? null; } catch { /* invalid id */ } asks.set(id, a); }
  return asks.get(id) ?? null;
}
const askDone = new Set<(id: string, ask: Ask, note: string) => void>();
export const onAskDone = (fn: (id: string, ask: Ask, note: string) => void) => { askDone.add(fn); };
const askListeners = new Set<(id: string) => void>();
export const onAsk = (fn: (id: string) => void) => { askListeners.add(fn); };
export function setAsk(id: string, reason: string | null) {
  const ask = reason ? { reason: reason.replace(/\s+/g, ' ').trim().slice(0, 300), at: new Date().toISOString() } : null;
  updateMeta(id, { ask: ask ?? undefined });
  asks.set(id, ask);
  for (const fn of askListeners) { try { fn(id); } catch { /* listener failed */ } }
  return ask;
}
export function answerAsk(id: string, note: string) {
  const ask = askOf(id);
  if (!ask) return false;
  setAsk(id, null);
  for (const fn of askDone) { try { fn(id, ask, note.replace(/\s+$/, '').slice(0, 2000)); } catch (e) { console.error(`task browser ${id}: the answer to the agent failed: ${(e as Error).message}`); } }
  return true;
}

// ---------- downloads ----------
// Headless Chrome saves a download on the server computer, where the user does not see it. Each running browser saves
// its downloads in its downloads folder (Browser.setDownloadBehavior on the watch connection, watchDialogs), named by
// the download id. The dashboard view lists them and offers each finished file with a link
// (GET /api/tasks/<id>/browser/downloads/<guid>). Files older than DOWNLOAD_KEEP_MS go at the next start.
export interface Download { guid: string; name: string; url: string; state: 'inProgress' | 'completed' | 'canceled'; bytes: number; total: number; at: number }
const DOWNLOAD_KEEP_MS = 24 * 3600000;
const downloads = new Map<string, Map<string, Download>>();
const downloadListeners = new Set<(id: string, d: Download) => void>();
export const downloadDir = (id: string) => join(folder(id), 'downloads');
function downloadEvent(id: string, method: string, p: any) {
  let list = downloads.get(id); if (!list) downloads.set(id, list = new Map());
  const guid = String(p.guid || ''); if (!/^[\w-]{1,80}$/.test(guid)) return;
  const had = list.get(guid);
  const d: Download = method === 'Browser.downloadWillBegin'
    ? { guid, name: basename(String(p.suggestedFilename || 'download')).slice(0, 200) || 'download', url: String(p.url || '').slice(0, 500), state: 'inProgress', bytes: 0, total: 0, at: Date.now() }
    : { ...(had || { guid, name: 'download', url: '', at: Date.now() }), state: p.state === 'completed' || p.state === 'canceled' ? p.state : 'inProgress', bytes: Number(p.receivedBytes) || 0, total: Number(p.totalBytes) || 0 };
  list.set(guid, d);
  // progress events come many times a second: only a new download and a change of state go to the views
  if (had && had.state === d.state) return;
  for (const fn of downloadListeners) { try { fn(id, d); } catch { /* listener failed */ } }
}
export const recentDownloads = (id: string) => [...(downloads.get(id)?.values() || [])].filter(d => Date.now() - d.at < DOWNLOAD_KEEP_MS);
export function downloadFile(id: string, guid: string): { path: string; name: string } | null {
  const d = downloads.get(id)?.get(guid);
  if (!d || d.state !== 'completed' || !/^[\w-]{1,80}$/.test(guid)) return null;
  const path = join(downloadDir(id), guid);
  return existsSync(path) ? { path, name: d.name } : null;
}
// files of earlier downloads and uploads that are older than DOWNLOAD_KEEP_MS (at each start)
function cleanFiles(id: string) {
  for (const dir of [downloadDir(id), join(folder(id), 'uploads')]) {
    let names: string[] = []; try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) { try { const f = join(dir, n); if (Date.now() - statSync(f).mtimeMs > DOWNLOAD_KEEP_MS) rmSync(f, { force: true }); } catch { /* gone */ } }
  }
}

// ---------- dialogs ----------
// The dialogs of every tab of a running browser. A dialog that a page opened before any DevTools client had the Page
// domain on is not reported later, so one browser connection for each running browser watches all pages from the
// start: ensure() starts it, and a dashboard view starts it for a browser that was running before this server.
// The connection listens for Target.targetCreated, attaches to each page (flatten sessions) and turns the Page domain
// on there. Page.javascriptDialogOpening and Page.javascriptDialogClosed keep dialogs (target id -> dialog). The
// connection ends when Chrome stops. Chrome opens the dialog of a background tab only when that tab comes to the front,
// so a dialog usually belongs to the shown tab or to a tab that the user left while its dialog was open.
// The same connection gives the dashboard views the target events (targetListeners): Target.targetCreated,
// Target.targetInfoChanged and Target.targetDestroyed, from the answer to Target.setDiscoverTargets on (ready), and
// Page.windowOpen of each page with the page's target id (openerId). Chrome reports the targets that exist already
// before that answer, and those are not new tabs.
interface DialogWatch { ws: WebSocket; dialogs: Map<string, Dialog>; sessions: Map<string, string>; listeners: Set<() => void>; targetListeners: Set<(m: { method: string; params: any }) => void>; ready: boolean; next: number }
const dialogWatch = new Map<string, DialogWatch>();
function watchDialogs(id: string, browserWs: string): DialogWatch {
  const had = dialogWatch.get(id);
  if (had && had.ws.readyState <= WebSocket.OPEN) return had;
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  const w: DialogWatch = { ws, dialogs: new Map(), sessions: new Map(), listeners: new Set(had?.listeners), targetListeners: new Set(had?.targetListeners), ready: false, next: 0 };
  dialogWatch.set(id, w);
  const cmd = (method: string, params: object = {}, sessionId?: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++w.next, method, params, ...(sessionId ? { sessionId } : {}) })); };
  const changed = () => { for (const fn of w.listeners) fn(); };
  const attach = (t: { targetId: string; type: string }) => { if (t.type === 'page' && ![...w.sessions.values()].includes(t.targetId)) cmd('Target.attachToTarget', { targetId: t.targetId, flatten: true }); };
  ws.on('open', () => {
    cmd('Target.setDiscoverTargets', { discover: true });
    // downloads go to the browser's downloads folder, named by their id, and this connection gets their events
    try { mkdirSync(downloadDir(id), { recursive: true }); cmd('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir(id), eventsEnabled: true }); } catch { /* the folder cannot be made */ }
  });
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.id === 1) w.ready = true;
    const opener = m.method === 'Page.windowOpen' && m.sessionId ? w.sessions.get(m.sessionId) : undefined;
    if (w.ready && (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged' || m.method === 'Target.targetDestroyed' || opener)) for (const fn of w.targetListeners) { try { fn(opener ? { method: m.method, params: { ...m.params, openerId: opener } } : m); } catch { /* listener failed */ } }
    if (m.method === 'Browser.downloadWillBegin' || m.method === 'Browser.downloadProgress') downloadEvent(id, m.method, m.params);
    // a new tab, a popup or a navigation: the sound check runs soon (checkSound)
    if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') && m.params.targetInfo?.type === 'page') checkSoundSoon(id);
    if (m.method === 'Target.targetCreated') attach(m.params.targetInfo);
    else if (m.method === 'Target.attachedToTarget') { w.sessions.set(m.params.sessionId, m.params.targetInfo.targetId); cmd('Page.enable', {}, m.params.sessionId); }
    else if (m.method === 'Target.detachedFromTarget' || m.method === 'Target.targetDestroyed') {
      const target = m.params.targetId ?? w.sessions.get(m.params.sessionId);
      if (m.params.sessionId) w.sessions.delete(m.params.sessionId);
      if (target && w.dialogs.delete(target)) changed();
    }
    else if (m.method === 'Page.javascriptDialogOpening' && m.sessionId) {
      const target = w.sessions.get(m.sessionId); if (!target) return;
      const p = m.params;
      w.dialogs.set(target, { type: p.type, message: String(p.message || '').slice(0, 2000), ...(p.type === 'prompt' ? { defaultPrompt: String(p.defaultPrompt || '') } : {}) });
      changed();
    }
    else if (m.method === 'Page.javascriptDialogClosed' && m.sessionId) { const target = w.sessions.get(m.sessionId); if (target && w.dialogs.delete(target)) changed(); }
  });
  ws.on('close', () => { if (dialogWatch.get(id) === w) dialogWatch.delete(id); });
  ws.on('error', () => {});
  return w;
}
function answerDialog(id: string, target: string, accept: boolean, promptText?: string) {
  const w = dialogWatch.get(id);
  const session = w && [...w.sessions].find(([, t]) => t === target)?.[0];
  if (!w || !session || !w.dialogs.has(target) || w.ws.readyState !== WebSocket.OPEN) return;
  w.ws.send(JSON.stringify({ id: ++w.next, method: 'Page.handleJavaScriptDialog', params: { accept, ...(promptText !== undefined ? { promptText } : {}) }, sessionId: session }));
}

// ---------- files from the dashboard ----------
// An image in a paste, a file that the user picks for a page's file chooser, or a file dropped on the view. The
// dashboard socket takes messages of at most 1 MB, so the dashboard posts each file first (POST
// /api/tasks/<id>/browser/upload), and the view then names it by its id. A file stays in memory for UPLOAD_MS and is
// used once. Only the view of the same browser can use it.
const UPLOAD_MS = 10 * 60000;
export const UPLOAD_MAX = 100 * 1024 * 1024;
interface Upload { browser: string; name: string; type: string; data: Buffer; at: number }
const uploads = new Map<string, Upload>();
export function addUpload(browserId: string, name: string, type: string, data: Buffer): string {
  folder(browserId);
  if (data.length > UPLOAD_MAX) throw new Error(`A file can be at most ${UPLOAD_MAX / 1024 / 1024} MB.`);
  const now = Date.now();
  for (const [k, u] of uploads) if (now - u.at > UPLOAD_MS) uploads.delete(k);
  const id = randomBytes(12).toString('hex');
  uploads.set(id, { browser: browserId, name: basename(String(name || 'file')).replace(/[^\w .()+-]/g, '_').slice(0, 120) || 'file', type: String(type || ''), data, at: now });
  return id;
}
export function takeUpload(browserId: string, uploadId: unknown): Upload | null {
  const u = typeof uploadId === 'string' ? uploads.get(uploadId) : undefined;
  if (!u || u.browser !== browserId || Date.now() - u.at > UPLOAD_MS) return null;
  uploads.delete(uploadId as string);
  return u;
}

// ---------- the dashboard: screencast of one tab, with mouse and key input ----------
const FRAME_BACKLOG = 512 * 1024;
// JPEG quality of the screencast: QUALITY_FAST while frames come less than FAST_GAP_MS apart (scroll, video,
// animation), QUALITY_STILL when no frame came for STILL_MS, so text is sharp while the page does not move. At 1000 x
// 684 px a scroll frame of the test page of scripts/browser-speed.mjs is 53 KB at quality 50 and 69 KB at quality 70.
// The quality does not change the CPU time of Chrome. Chrome refuses a second Page.startScreencast, so a change of
// quality stops the screencast and starts it again, and Chrome sends a frame within about 10 ms of the start.
// Back pressure: a view that sent 'hello' with acks reports each frame that it drew or dropped ('drawn'). The server
// sends a frame only while fewer than MAX_UNDRAWN frames wait in the view. It keeps the newest other frame (waiting)
// and holds the Page.screencastFrameAck of each frame until the view has room, so Chrome stops capturing (it sends
// a few frames without an ack, then waits). HELD_MS limits the wait: a view that stops reporting gets about one frame
// each second. A view without acks (an older dashboard) gets every frame and Chrome gets the ack at once.
const MAX_UNDRAWN = 2, HELD_MS = 1000;
const QUALITY_FAST = 50, QUALITY_STILL = 80, FAST_GAP_MS = 150, STILL_MS = 300;
// quality: the quality of the screencast that runs or that the last queued start asks for. chain: the starts and stops
// of this page's screencast, one at a time.
// world: the execution context of the view's isolated world (WIDGETS) in the main frame; chooser: the file input of a
// file chooser that the page opened and the view answers.
interface PageConn { ws: WebSocket; target: string; next: number; pending: Map<number, (r: any) => void>; casting?: boolean; quality: number; chain: Promise<void>; lastFrame: number; stillTimer?: NodeJS.Timeout; world?: number; chooser?: { backendNodeId: number; multiple: boolean } }
// The switch to a new tab or popup (Settings → Task browsers, and the override of one browser in browser.json).
export const autoSwitchOn = (id: string) => readMeta(id).autoSwitch ?? machine.get().browser?.autoSwitch ?? true;
export function attachViewer(client: WebSocket, id: string, autostart: boolean) {
  // opening: the tab of the open() that runs now, so a poll does not start a second open() of it
  let page: PageConn | null = null, active = '', seeded = false, closed = false, openSeq = 0, opening = '';
  // New tabs and popups, and the tab that closed (tab-switch.ts). A switch opens the tab and tells the view why
  // ('active' with auto), so the view shows one line with a Go back button. An offer is a badge in the view.
  const sw = new TabSwitch(d => {
    if (closed) return;
    if (d.kind === 'switch') void open(d.id, { from: d.from, reason: d.reason }).catch(() => {});
    else send({ type: 'offer', id: d.id, reason: d.reason });
    soon();
  }, () => autoSwitchOn(id));
  let frameW = 0, frameH = 0, lastFrame = 0;
  // acks: the view reports drawn frames. undrawn: frames sent to the view that it did not report yet. waiting: the
  // newest frame that the view had no room for. held: the acks that Chrome waits for.
  let acks = false, undrawn = 0, waiting: Buffer | null = null, held: (() => void)[] = [], heldTimer: NodeJS.Timeout | undefined;
  // visible: the view is on the screen ('visible' from the view). A hidden view gets no screencast, so Chrome captures
  // and encodes no frames for it. The view stays a viewer (viewers), so the idle stop does not stop the browser.
  let visible = true, helloed = false;
  const sendFrame = (jpeg: Buffer) => { lastFrame = jpeg.length; undrawn++; client.send(jpeg); };
  // the view has room: send the waiting frame, then let Chrome capture again
  const drain = () => {
    if (waiting && undrawn < MAX_UNDRAWN && client.readyState === WebSocket.OPEN) { sendFrame(waiting); waiting = null; }
    while (held.length && undrawn < MAX_UNDRAWN) held.shift()!();
    if (!held.length) { clearTimeout(heldTimer); heldTimer = undefined; }
  };
  const resetFrames = () => { undrawn = 0; waiting = null; drain(); };
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
  // deviceScaleFactor 0 keeps the factor that Chrome started with. An emulated factor does not change the size of a
  // screencast frame; only the start flag --force-device-scale-factor does (Sharp view). With the flag and a factor of
  // 1 here, the page would draw at 1x and the frame would only stretch it.
  // A browser in a window keeps the size of its window: the view does not change it.
  const viewport = () => readMeta(id).window ? call('Emulation.clearDeviceMetricsOverride') : call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 0, mobile: false });
  // Show this tab. auto: the view switched by itself (tab-switch.ts). A later open() wins over one that still runs.
  async function open(target: string, auto?: { from: string; reason: string }) {
    const seq = ++openSeq;
    opening = target;
    try { await show(seq, target, auto); } finally { if (seq === openSeq) opening = ''; }
  }
  async function show(seq: number, target: string, auto?: { from: string; reason: string }) {
    const m = await live(id); if (!m || closed || seq !== openSeq) return;
    const list = await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { id: string; type: string; webSocketDebuggerUrl: string }[];
    const t = list.find(x => x.id === target && x.type === 'page'); if (!t || seq !== openSeq) return;
    closePage();
    waiting = null; cursorBusy = false;
    active = target;
    sw.shown(target);
    // tell the view now: a page with an open dialog answers the calls below only after the dialog closes, and the
    // view must show that tab to show its question. The old frame stays in the view until the new tab's first frame.
    send({ type: 'active', id: target, ...(auto ? { auto } : {}) });
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    const conn: PageConn = { ws, target, next: 0, pending: new Map(), quality: QUALITY_STILL, chain: Promise.resolve(), lastFrame: 0 };
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
      else if (msg.method === 'Runtime.executionContextCreated' && msg.params.context.name === WORLD && msg.params.context.auxData?.frameId === mainFrame) conn.world = msg.params.context.id;
      else if (msg.method === 'Runtime.bindingCalled' && msg.params.name === 'tbWidget') widget(conn, msg.params.payload);
      else if (msg.method === 'Page.fileChooserOpened' && msg.params.backendNodeId) { conn.chooser = { backendNodeId: msg.params.backendNodeId, multiple: msg.params.mode === 'selectMultiple' }; send({ type: 'fileChooser', multiple: conn.chooser.multiple }); }
      if (msg.method === 'Page.screencastFrame') {
        const ack = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++conn.next, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } })); };
        if (!acks) ack();
        const now = Date.now();
        if (now - conn.lastFrame < FAST_GAP_MS && conn.quality !== QUALITY_FAST) cast(conn, QUALITY_FAST);
        conn.lastFrame = now;
        clearTimeout(conn.stillTimer);
        if (conn.quality === QUALITY_FAST) conn.stillTimer = setTimeout(() => cast(conn, QUALITY_STILL), STILL_MS);
        // A frame goes as one binary message (the JPEG bytes), after a 'frameSize' message when the size changes.
        // A frame is dropped while the view still has 512 KB to receive, so a slow connection shows the newest frame
        // a little later instead of every old frame in a queue.
        // the limit grows with the frames: three frames of a sharp view are about 1.3 MB
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > Math.max(FRAME_BACKLOG, 3 * lastFrame)) { if (acks) ack(); return; }
        const w = msg.params.metadata.deviceWidth, h = msg.params.metadata.deviceHeight;
        if (w !== frameW || h !== frameH) { frameW = w; frameH = h; send({ type: 'frameSize', w, h }); }
        const jpeg = Buffer.from(msg.params.data, 'base64');
        if (!acks) { lastFrame = jpeg.length; client.send(jpeg); return; }
        if (undrawn < MAX_UNDRAWN) sendFrame(jpeg); else waiting = jpeg;
        if (undrawn < MAX_UNDRAWN) ack();
        else { held.push(ack); heldTimer ??= setTimeout(() => { heldTimer = undefined; resetFrames(); }, HELD_MS); }
      }
    });
    ws.on('close', () => { clearTimeout(conn.stillTimer); if (page === conn) page = null; if (conn.casting) { conn.casting = false; count(screencasts, id, -1); } });
    ws.on('error', () => {});
    await new Promise(r => ws.once('open', r));
    await fetch(`http://127.0.0.1:${m.port}/json/activate/${target}`).catch(() => {});
    await call('Page.enable');
    const tree = await call('Page.getFrameTree');
    mainFrame = tree?.frameTree?.frame?.id || ''; loading = false;
    // the parts of a page that headless Chrome does not draw (WIDGETS): a script in an isolated world that the page
    // cannot see, a binding that it reports through, and the file chooser of the page
    await call('Runtime.enable');
    await call('Runtime.addBinding', { name: 'tbWidget', executionContextName: WORLD });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: WIDGETS, worldName: WORLD, runImmediately: true });
    const iw = await call('Page.createIsolatedWorld', { frameId: mainFrame, worldName: WORLD });
    if (iw?.executionContextId) { conn.world = iw.executionContextId; await call('Runtime.evaluate', { expression: WIDGETS, contextId: conn.world }); }
    await call('Page.setInterceptFileChooserDialog', { enabled: true });
    await navState();
    await viewport();
    cast(conn, QUALITY_STILL);
    await conn.chain;
    send({ type: 'active', id: target });
  }
  // Start the screencast of this page at this quality, or stop it (null, and always while the view is hidden). A
  // screencast that runs stops first.
  function cast(conn: PageConn, quality: number | null) {
    if (quality !== null) conn.quality = quality;
    if (!visible) { quality = null; clearTimeout(conn.stillTimer); }
    conn.chain = conn.chain.then(async () => {
      if (page !== conn) return;
      // every frame gets its ack, also a frame of the screencast that stops now
      for (const ack of held.splice(0)) ack();
      if (conn.casting) await call('Page.stopScreencast');
      if (quality !== null && page === conn) await call('Page.startScreencast', { format: 'jpeg', quality, maxWidth: 1920, maxHeight: 1920, everyNthFrame: 1 });
      const on = quality !== null && page === conn && conn.ws.readyState === WebSocket.OPEN;
      if (on !== !!conn.casting) { conn.casting = on; count(screencasts, id, on ? 1 : -1); }
    });
  }
  const dialogChanged = () => { void poll(); };
  // the target events of the browser connection (watchDialogs) go to the tab switch; a change of the tab list sends
  // the view a new list soon (soon), so the tab strip shows a new tab before the next poll
  const targetEvent = (e: { method: string; params: any }) => {
    if (!seeded) return;
    if (e.method === 'Page.windowOpen') return sw.windowOpen(e.params.openerId, String(e.params.url || ''));
    if (e.method === 'Target.targetCreated') sw.created(e.params.targetInfo);
    else if (e.method === 'Target.targetInfoChanged') { if (e.params.targetInfo.type === 'page') { sw.changed(e.params.targetInfo); soon(); } return; }
    else if (e.method === 'Target.targetDestroyed') { if (!sw.known(e.params.targetId)) return; sw.destroyed(e.params.targetId); }
    soon();
  };
  let soonTimer: NodeJS.Timeout | undefined;
  const soon = () => { soonTimer ??= setTimeout(() => { soonTimer = undefined; void poll(); }, 50); };
  // Polls can overlap (the timer, the view's messages, dialog changes and target events start them). A poll can wait
  // in open() for a long time: a page with an open dialog answers only after the dialog closes.
  // The poll is also the fallback of the target events: a tab that they did not report is a new tab for the switch.
  async function poll() {
    if (closed) return;
    const m = await live(id);
    if (!m) { closePage(); active = ''; seeded = false; send({ type: 'state', ...(await status(id)) }); return; }
    const dw = watchDialogs(id, m.ws);
    if (!dw.listeners.has(dialogChanged)) dw.listeners.add(dialogChanged);
    if (!dw.targetListeners.has(targetEvent)) dw.targetListeners.add(targetEvent);
    const asked = Date.now(), listed = await pageList(m.port!);
    if (!listed || closed) return;
    const list = listed.map(t => { const dialog = dw.dialogs.get(t.id); return dialog ? { ...t, dialog } : t; });
    // the first list after the view or the browser started: these tabs are not new
    if (!seeded) { sw.seed(list.map(t => t.id)); seeded = true; } else sw.listed(list, asked);
    const meta = readMeta(id);
    send({ type: 'tabs', tabs: list, active, agents: agentCount(id), muted: mutedNow(meta, true), ...soundStateOf(meta, true), autoSwitch: autoSwitchOn(id), autoSwitchOwn: meta.autoSwitch !== undefined, ask: askOf(id), scale: meta.scale || 1, wantScale: meta.window ? 1 : startScale(), window: !!meta.window });
    // the first tab when the view shows none; a shown tab that closed is handled by the switch (sw.destroyed)
    const target = active && list.some(t => t.id === active) ? active : sw.back() || list[0]?.id || '';
    if (target && target !== opening && (target !== active || !page)) await open(target);
  }
  const timer = setInterval(() => { void poll(); }, 1000);
  // What the agent does: each event goes to the view, with the name of the element that a click or typing hit, when
  // the event is on the shown tab (LABEL). A label question waits at most 300 ms, so the strip is not late.
  const stopAgent = onAgentEvent(id, async e => {
    let label: string | undefined;
    if ((e.kind === 'click' || e.kind === 'type') && (!e.target || e.target === active) && page) {
      const expr = `(${LABEL})(${e.kind === 'click' ? `${Number(e.x) || 0}, ${Number(e.y) || 0}` : 'null, null'})`;
      const r = await Promise.race([call('Runtime.evaluate', { returnByValue: true, expression: expr }), new Promise(r => setTimeout(() => r(null), 300))]) as any;
      if (typeof r?.result?.value === 'string') label = r.result.value;
    }
    send({ type: 'agent', ...e, ...(label ? { label } : {}), shown: !e.target || e.target === active });
  });
  const askChanged = (b: string) => { if (b === id) send({ type: 'ask', ask: askOf(id) }); };
  const downloaded = (b: string, d: Download) => { if (b === id) send({ type: 'download', ...d }); };
  downloadListeners.add(downloaded);
  for (const d of recentDownloads(id)) send({ type: 'download', ...d, old: true });
  onAsk(askChanged);
  client.on('close', () => { if (closed) return; closed = true; stopAgent(); askListeners.delete(askChanged); downloadListeners.delete(downloaded); count(viewers, id, -1); clearInterval(timer); clearTimeout(soonTimer); clearTimeout(cursorTimer); closePage(); sw.seed([]); const dw = dialogWatch.get(id); dw?.listeners.delete(dialogChanged); dw?.targetListeners.delete(targetEvent); });
  client.on('message', async d => {
    let m: any; try { m = JSON.parse(d.toString()); } catch { return; }
    try {
      // a failed start shows in the state that poll() sends (status().error), not as a second message
      if (m.type === 'hello') { acks = !!m.acks; helloed = true; if (m.dpr) noteScreen(m.dpr); }
      // a restart at the screen's pixel density (the view offers it when the running factor differs): the pages reopen
      else if (m.type === 'restartScale') { await stop(id); void ensure(id).then(() => poll(), () => poll()); await poll(); }
      // a view that shows again gets a frame at once: Chrome sends one at each start of a screencast
      else if (m.type === 'visible') { const on = !!m.on; if (on !== visible) { visible = on; if (page) cast(page, on ? QUALITY_STILL : null); } }
      else if (m.type === 'drawn') { undrawn = Math.max(0, undrawn - 1); drain(); }
      else if (m.type === 'start') { void ensure(id).then(() => poll(), () => poll()); await poll(); }
      else if (m.type === 'stop') { await stop(id); await poll(); }
      else if (m.type === 'select' && typeof m.id === 'string') await open(m.id);
      // the switch of this browser (the More menu): a choice that differs from Settings is kept for this browser, and the
      // same choice as Settings (or null) follows Settings again
      else if (m.type === 'autoSwitch') { const on = typeof m.on === 'boolean' && m.on !== (machine.get().browser?.autoSwitch ?? true) ? m.on : undefined; updateMeta(id, { autoSwitch: on }); await poll(); }
      else if (m.type === 'size' && m.w > 100 && m.h > 100) { size = { w: Math.min(3840, Math.round(m.w)), h: Math.min(2160, Math.round(m.h)) }; await viewport(); }
      else if (m.type === 'mouse') {
        if (m.event === 'mousePressed') sw.userClick(m.button, m.modifiers || 0);
        await call('Input.dispatchMouseEvent', { type: m.event, x: m.x, y: m.y, button: m.button || 'none', buttons: m.buttons || 0, clickCount: m.clickCount || 0, modifiers: m.modifiers || 0, ...(m.event === 'mouseWheel' ? { deltaX: m.dx || 0, deltaY: m.dy || 0 } : {}) });
        if (m.event === 'mouseMoved' || m.event === 'mouseReleased') cursorAt(m.x, m.y);
      }
      else if (m.type === 'key') await key(m);
      else if (m.type === 'text' && typeof m.text === 'string') await call('Input.insertText', { text: m.text.slice(0, 100000) });
      // an IME or a dead key composes text in the view: the page shows the same composition, and 'text' commits it
      else if (m.type === 'ime' && typeof m.text === 'string') { const text = m.text.slice(0, 1000); await call('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); }
      else if (m.type === 'paste') await paste(m);
      // Open in a window, or back to the panel. Without force, the view first learns how many fields have unsent text.
      else if (m.type === 'window') {
        const on = !!m.on;
        if (!m.force) { const n = await unsent(id); if (n) { send({ type: 'windowUnsent', on, fields: n }); return; } }
        send({ type: 'windowSwitching', on });
        await setWindow(id, on);
        await poll();
      }
      else if (m.type === 'showWindow') await showWindow(id);
      // the user's choice in the view's own list or picker for a select box or a date, time or color input
      else if (m.type === 'widgetSet' && page?.world) await call('Runtime.evaluate', { expression: `__tbSet(${JSON.stringify(m.value)})`, contextId: page.world });
      // files for the page's file chooser, or files dropped on the view (posted first, addUpload)
      else if (m.type === 'files' && Array.isArray(m.uploads)) await files(m);
      else if (m.type === 'openLink' && typeof m.url === 'string' && /^https?:\/\//.test(m.url)) { sw.userNewTab(); await openTab(id, m.url); }
      // Done on the agent's request for help, with the user's note
      else if (m.type === 'askDone') answerAsk(id, typeof m.note === 'string' ? m.note : '');
      else if (m.type === 'copy') {
        // the selected text of the page, or of the focused text field; the dashboard puts it on the clipboard
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
      else if (m.type === 'new') { sw.userNewTab(); const t = await openTab(id, typeof m.url === 'string' && m.url ? m.url : 'about:blank'); await open(t.id); }
      else if (m.type === 'close' && typeof m.id === 'string') await closeTab(id, m.id);
      else if (m.type === 'dialog' && typeof m.id === 'string') {
        // answer the dialog of that tab: OK or Cancel, with the text for a prompt()
        answerDialog(id, m.id, !!m.accept, typeof m.text === 'string' ? m.text.slice(0, 10000) : undefined);
      }
    } catch (e) { send({ type: 'error', message: (e as Error).message }); }
  });
  // The mouse cursor of the page. Headless Chrome reports no cursor over DevTools, so the server asks the page for the
  // cursor at the mouse position (CURSOR) at once and then at most every CURSOR_MS while the mouse moves, one question
  // at a time, and sends the view a 'cursor' message when it changes.
  let title = '', cursor = '', cursorPos: { x: number; y: number } | null = null, cursorTimer: NodeJS.Timeout | undefined, cursorBusy = false, cursorAsked = 0;
  function cursorAt(x: number, y: number) {
    cursorPos = { x, y };
    if (!cursorTimer && !cursorBusy) cursorTimer = setTimeout(askCursor, Math.max(0, cursorAsked + CURSOR_MS - Date.now()));
  }
  async function askCursor() {
    cursorTimer = undefined; cursorAsked = Date.now();
    const p = cursorPos; cursorPos = null;
    if (!p || closed) return;
    cursorBusy = true;
    try {
      // the cursor, and the title of the element there (headless Chrome draws no tooltip; the view shows the title)
      const x = Number(p.x) || 0, y = Number(p.y) || 0;
      const r = await call('Runtime.evaluate', { returnByValue: true, expression: `[(${CURSOR})(${x}, ${y}), (${TITLE})(${x}, ${y})]` });
      const [c, t] = Array.isArray(r?.result?.value) ? r.result.value : [];
      if (typeof c === 'string' && c !== cursor) { cursor = c; send({ type: 'cursor', cursor: c }); }
      // a title goes at each check (the view shows it a moment after the mouse stops), an empty one once
      if (typeof t === 'string' && (t || t !== title)) { title = t; send({ type: 'title', title: t, x, y }); }
    } finally { cursorBusy = false; }
    if (cursorPos) cursorTimer = setTimeout(askCursor, Math.max(0, cursorAsked + CURSOR_MS - Date.now()));
  }
  async function key(m: KeyMessage) {
    const e = keyEvent(m);
    if (e) await call('Input.dispatchKeyEvent', e);
  }
  // A paste from the view: plain text, HTML and a PNG image. Input.insertText would type the text without a paste
  // event, so pages that read the paste (rich text editors, code fields, image upload by paste) got nothing. The text,
  // HTML and image go on the clipboard of the task's Chrome instead, with the page's own Clipboard API (the page's
  // origin gets the write permission first), and the paste key with the 'paste' command follows. The page then gets a
  // real paste event with every type. When the write fails (a page without an origin, a blocked frame), the text is
  // typed as before.
  async function paste(m: { text?: unknown; html?: unknown; image?: unknown }) {
    const text = typeof m.text === 'string' ? m.text.slice(0, 1_000_000) : '';
    const html = typeof m.html === 'string' ? m.html.slice(0, 1_000_000) : '';
    // the image: a PNG that the dashboard posted (addUpload), named by its id
    const up = takeUpload(id, m.image);
    const image = up && up.type === 'image/png' ? up.data.toString('base64') : '';
    if (!text && !html && !image) return;
    const origin = (await call('Runtime.evaluate', { returnByValue: true, expression: 'location.origin' }))?.result?.value;
    if (typeof origin === 'string' && /^https?:\/\//.test(origin) && browserConn) await browserConn('Browser.grantPermissions', { origin, permissions: ['clipboardSanitizedWrite'] }).catch(() => null);
    const r = await call('Runtime.evaluate', { userGesture: true, awaitPromise: true, returnByValue: true, expression: `(async () => {
      const items = {};
      ${text ? `items['text/plain'] = new Blob([${JSON.stringify(text)}], { type: 'text/plain' });` : ''}
      ${html ? `items['text/html'] = new Blob([${JSON.stringify(html)}], { type: 'text/html' });` : ''}
      ${image ? `items['image/png'] = await (await fetch('data:image/png;base64,${image}')).blob();` : ''}
      await navigator.clipboard.write([new ClipboardItem(items)]); return 'ok'; })()` });
    if (r?.result?.value === 'ok') {
      const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: PASTE_MOD };
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['paste'] });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      return;
    }
    if (text) await call('Input.insertText', { text: text.slice(0, 100000) });
    else send({ type: 'error', message: 'The page did not take the pasted image. Save the image and upload it as a file.' });
  }
  // A report of the isolated world (WIDGETS): a select box or a picker input that the user pressed, or a context menu
  // that the page did not take. The view draws its own list, picker or menu.
  function widget(conn: PageConn, payload: string) {
    if (page !== conn) return;
    let w: any; try { w = JSON.parse(payload); } catch { return; }
    if (w.kind === 'contextmenu') { if (!w.prevented) send({ type: 'menu', x: w.x, y: w.y, href: String(w.href || '').slice(0, 2000), src: String(w.src || '').slice(0, 2000), selection: !!w.selection }); }
    else if (w.kind === 'select' || w.kind === 'input') send({ type: 'widget', ...w });
  }
  // The files that the user chose or dropped: written to the browser's uploads folder (DOM.setFileInputFiles and drag
  // events take paths), then given to the file input of the chooser, or dropped at the point.
  async function files(m: { uploads: unknown[]; drop?: boolean; x?: number; y?: number }) {
    const dir = join(folder(id), 'uploads'); mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    for (const u of m.uploads.slice(0, 20)) {
      const up = takeUpload(id, u); if (!up) continue;
      const p = join(dir, `${Date.now()}-${paths.length}-${up.name}`);
      writeFileSync(p, up.data); paths.push(p);
    }
    const conn = page; if (!conn || !paths.length) return;
    if (m.drop) {
      const at = { x: Number(m.x) || 0, y: Number(m.y) || 0 };
      const data = { items: [], files: paths, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await call('Input.dispatchDragEvent', { type, ...at, data });
    } else if (conn.chooser) {
      await call('DOM.setFileInputFiles', { files: conn.chooser.multiple ? paths : paths.slice(0, 1), backendNodeId: conn.chooser.backendNodeId });
      conn.chooser = undefined;
    }
  }
  // one command on the browser connection (Browser.* commands are not on a page connection)
  const browserConn = async (method: string, params: object) => { const m = await live(id); return m ? once(m.ws, method, params) : null; };
  // the start runs while the view polls, so the view shows its progress (status().starting) and then its result
  void (async () => {
    // a start waits up to 1 s for the view's 'hello', so the browser starts at the pixel density of its screen
    if (autostart && !(await isRunning(id))) { for (let i = 0; i < 20 && !helloed; i++) await new Promise(r => setTimeout(r, 50)); void ensure(id).then(() => poll()).catch(() => poll()); }
    await poll();
  })();
}

// The script of the view's isolated world "tb" in each page (attachViewer). The page cannot see it. Headless Chrome
// does not draw the popup of a select box, the picker of a date, time or color input, or its context menu, so the
// script reports them through the binding tbWidget, and the view draws its own list, picker or menu. A select box
// with several rows (multiple, size) is drawn by the page and stays with it. __tbSet() sets the choice and sends the
// input and change events. Only the main frame has the script.
const WORLD = 'tb';
const WIDGETS = `(() => {
  if (window.__tbReady) return; window.__tbReady = true;
  const PICK = ['date', 'time', 'datetime-local', 'month', 'week', 'color'];
  const send = m => { try { tbWidget(JSON.stringify(m)); } catch {} };
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const el = e.target.closest && e.target.closest('select');
    if (!el || el.disabled || el.multiple || el.size > 1) return;
    e.preventDefault(); el.focus(); window.__tbEl = el;
    send({ kind: 'select', rect: box(el), selectedIndex: el.selectedIndex, options: [...el.options].slice(0, 500).map(o => ({ text: o.text.slice(0, 200), disabled: o.disabled, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' })) });
  }, true);
  addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('input');
    if (!el || !PICK.includes(el.type) || el.disabled || el.readOnly) return;
    e.preventDefault(); el.focus(); window.__tbEl = el;
    send({ kind: 'input', inputType: el.type, value: el.value, min: el.min, max: el.max, step: el.step, rect: box(el) });
  }, true);
  addEventListener('contextmenu', e => setTimeout(() => {
    const a = e.target.closest && e.target.closest('a[href]'), img = e.target.closest && e.target.closest('img');
    send({ kind: 'contextmenu', prevented: e.defaultPrevented, x: e.clientX, y: e.clientY, href: a ? a.href : '', src: img ? img.currentSrc || img.src : '', selection: !!String(getSelection()) });
  }), false);
  window.__tbSet = v => {
    const el = window.__tbEl; if (!el || !el.isConnected) return false;
    if (el.tagName === 'SELECT') el.selectedIndex = v; else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
})()`;
// A short name for the element at a point of the page, or for the focused element (x null): its label, its text or its
// placeholder, for the line that says what the agent did ("Clicked Next", "Typed into Email"). A password field gives
// its label only, never its value.
const LABEL = `(x, y) => { let e = x === null ? document.activeElement : document.elementFromPoint(x, y);
  if (!e || e === document.body) return '';
  const pick = n => { const t = (n.getAttribute?.('aria-label') || (n.labels && n.labels[0] && n.labels[0].innerText) || n.getAttribute?.('placeholder') || n.getAttribute?.('title') || (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' ? n.getAttribute('name') : n.innerText) || '').replace(/\\s+/g, ' ').trim(); return t.length > 40 ? t.slice(0, 39) + '…' : t; };
  for (let i = 0; e && i < 4; i++, e = e.parentElement) { const t = pick(e); if (t) return t; }
  return ''; }`;
// The modifier of the paste key in the task's Chrome: Cmd on macOS, Ctrl elsewhere (bits: 2 Ctrl, 4 Meta).
const PASTE_MOD = process.platform === 'darwin' ? 4 : 2;
// The cursor that Chrome would show at a point of the page: the CSS cursor of the element there, and for "auto" the
// text cursor over text and in a text field, else the arrow. Only the keyword is used (a cursor image is not sent).
const CURSOR_MS = 100;
const CURSOR = `(x, y) => { const e = document.elementFromPoint(x, y); if (!e) return 'default';
  const css = getComputedStyle(e).cursor.split(',').pop().trim();
  if (css !== 'auto') return css;
  if (e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test(e.type))) return 'text';
  const r = document.caretRangeFromPoint?.(x, y), n = r?.startContainer;
  if (n?.nodeType === 3 && n.textContent.trim()) { const t = document.createRange(); t.selectNodeContents(n);
    for (const b of t.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return 'text'; }
  return 'default'; }`;
// The title (tooltip text) of the element at a point of the page, or of the nearest element above it that has one.
const TITLE = `(x, y) => { const e = document.elementFromPoint(x, y); const t = e && e.closest('[title]'); return t ? String(t.title).slice(0, 300) : ''; }`;
// The text that a copy takes: the selection in a focused text field, else the selection of the page.
const COPY = `(() => { const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'password')) && typeof a.selectionStart === 'number') return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() || ''); })()`;
// The Input.dispatchKeyEvent parameters for a key of the dashboard's browser view, or null when the key does not go
// to the page. The event has no nativeVirtualKeyCode. The view knows only the Windows key code, and Chrome on macOS
// reads a native code as a Mac key code: 91 (the Windows code of Meta) is keypad 8 there. A Meta or Shift key down
// with a native code made headless Chrome repeat that key without end (thousands of keydown events with metaKey set,
// after the key up too). With that code, Cmd+V in the view made the task's Chrome run a macOS menu key equivalent
// that opened the window About This Mac (macOS log, task 200).
// A Meta key alone does not go to the page: the Cmd shortcuts that the page gets carry the Meta bit in modifiers.
// AltGr (Windows and Linux) reports Ctrl and Alt together with the character it makes, for example @ on a German
// layout. altGraph is the view's getModifierState('AltGraph'). Without it, Ctrl and Alt with a character that is not a
// letter or a digit counts as AltGr too. Such a key types its character, and Ctrl and Alt are taken out of the event,
// so the page does not see a Ctrl+Alt shortcut.
export interface KeyMessage { down: boolean; key: string; code: string; keyCode: number; modifiers: number; altGraph?: boolean }
export function keyEvent(m: KeyMessage): Record<string, unknown> | null {
  if (m.key === 'Meta') return null;
  let mod = m.modifiers || 0;
  const altGr = m.key.length === 1 && !(mod & 4) && (!!m.altGraph || ((mod & 3) === 3 && !/^[a-z0-9]$/i.test(m.key)));
  if (altGr) mod &= ~3;
  const commands = m.down ? editCommands(m.key, mod) : [];
  const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: mod, ...(commands.length ? { commands } : {}) };
  if (!m.down) return { type: 'keyUp', ...base };
  const printable = m.key.length === 1 && !(mod & (2 | 4)); // no Ctrl, no Meta
  if (printable) return { type: 'keyDown', ...base, text: m.key, unmodifiedText: m.key };
  if (m.key === 'Enter') return { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' };
  return { type: 'rawKeyDown', ...base };
}
// Chrome runs some editing shortcuts as commands. A key event from DevTools carries no command by itself, so
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
