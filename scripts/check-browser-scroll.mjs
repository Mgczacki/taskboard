#!/usr/bin/env node
// Checks that the wheel and the scroll keys scroll a task browser from the dashboard (task 201). It starts a test
// Taskboard (own port, folders and tmux socket) with one task that runs tests/fixtures/chatty-agent.cjs, starts the
// task's browser, and drives a headless dashboard Chrome through the DevTools protocol. Input.dispatchMouseEvent gives
// the dashboard real (trusted) wheel events at the middle of the browser view. The script reads scrollX and scrollY of
// the task browser's page over its own DevTools port. It never touches the real Taskboard.
//
//   node scripts/check-browser-scroll.mjs [--site https://en.wikipedia.org/wiki/Web_browser] [--keep] [--chrome path]
//
// The cases: a 5,000 px local page, a page with an inner scroll area, and with --site a real long website.
// - one wheel, a trackpad stream of 60 small deltas (sent as fewer messages, one for each frame), sideways, Shift
// - Page Down, Space, End, Home and the arrow keys with the focus in the view
// - the listener after the view element is created again: the browser stopped and started, the Canvas window, the
//   pop-out window
// It prints the time from a wheel event to the next frame from the server. Needs Google Chrome and `pnpm build`
// (the server serves web/dist). Exit code 1 when a case fails.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CHROME = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const SITE = opt('--site', '');
const ROOT = join(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) { console.error('Run `pnpm build` first.'); process.exit(1); }

// ---------- the test server and its task ----------
const S = mkdtempSync(join(tmpdir(), 'tb-scroll-'));
const SOCKET = `tbscroll-${process.pid}`;
for (const d of ['vault', 'tbdir', 'bin', 'work', 'claude', 'pages']) mkdirSync(join(S, d), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'fixtures', 'chatty-agent.cjs'), join(S, 'bin', 'claude'));
execFileSync('chmod', ['+x', join(S, 'bin', 'claude')]);
writeFileSync(join(S, 'tbdir', 'machine.json'), JSON.stringify({ name: 'scroll', controller: { autostart: false, remoteControl: false }, permissions: { trustWorkspaces: false } }));
writeFileSync(join(S, 'tbdir', 'accounts.json'), JSON.stringify([{ id: 'claude-scroll', agent: 'claude', name: 'Claude scroll', dir: join(S, 'claude'), maxParallel: 10, created: new Date().toISOString() }]));
// the pages log each wheel event they get (window.__wheels)
const LOG = `<script>window.__wheels=[];addEventListener('wheel',e=>__wheels.push([e.deltaX,e.deltaY]),{passive:true})</script>`;
writeFileSync(join(S, 'pages', 'long.html'), `<!doctype html><meta charset="utf-8"><title>Long page</title><style>body{margin:0;font:16px sans-serif}#wide{width:4000px;height:30px;background:linear-gradient(90deg,red,blue)}.r{height:99px;border-bottom:1px solid #ccc}</style><div id="wide"></div>${LOG}<script>for(let i=0;i<50;i++)document.body.insertAdjacentHTML('beforeend','<div class=r>Row '+i+'</div>')</script>`);
writeFileSync(join(S, 'pages', 'inner.html'), `<!doctype html><meta charset="utf-8"><title>Inner scroll</title><style>body{margin:0;height:100vh;overflow:hidden}#box{position:absolute;left:40px;top:40px;width:300px;height:200px;overflow:auto;border:2px solid #333}#box div{height:80px}</style><div id="box"></div>${LOG}<script>for(let i=0;i<40;i++)box.insertAdjacentHTML('beforeend','<div>Item '+i+'</div>')</script>`);

const PORT = await freePort(), BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PATH: `${join(S, 'bin')}:${process.env.PATH}`, TASKBOARD_PORT: String(PORT), TASKBOARD_DIR: join(S, 'tbdir'), TASKBOARD_VAULT: join(S, 'vault'),
  TASKBOARD_TMUX_SOCKET: SOCKET, TASKBOARD_MACHINE_NAME: 'scroll', CLAUDE_CONFIG_DIR: join(S, 'claude'), CHATTY_LINES: '20', CHATTY_EVERY: '0' };
const server = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
let chrome = null, task = null;
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  // the task browser's Chrome runs detached from the server: stop it by the process id in its browser.json
  try { const m = JSON.parse(readFileSync(join(S, 'tbdir', 'browsers', task?.id || '-', 'browser.json'), 'utf8')); if (m.pid) process.kill(m.pid, 'SIGTERM'); } catch { /* not started */ }
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions */ }
  if (!args.includes('--keep')) rmSync(S, { recursive: true, force: true });
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const api = async (path, body) => {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

try {
  for (let i = 0; i < 100; i++) { try { await api('/api/tasks'); break; } catch { await sleep(200); } }
  task = await api('/api/tasks', { title: 'Scroll check', desc: 'scroll', agent: 'claude', folder: join(S, 'work'), worktree: false });

  // ---------- the dashboard Chrome ----------
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(S, 'chrome')}`, '--window-size=1600,1000',
    // a Retina screen: two device pixels for each CSS pixel. Emulation.setDeviceMetricsOverride with a factor of 2 would
    // halve the deltaY of a DevTools wheel event in the page, which a real wheel does not do.
    '--force-device-scale-factor=2', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''; chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('Chrome did not start: ' + err.slice(-500))), 20000);
  });
  const cdp = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise(r => cdp.on('open', r));
  let seq = 0; const pending = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const openTab = async url => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (m, p) => send(m, p, sessionId);
    await page('Page.enable');
    // the dashboard counts the wheel messages it sends and the frames it gets
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__tb = { wheelMsgs: 0, frames: 0, wheelAt: 0, frameAfter: [] }; const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('"mouseWheel"')) { __tb.wheelMsgs++; __tb.wheelAt ||= performance.now(); } return send.call(this, d); };
      const add = WebSocket.prototype.addEventListener;
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, set(f) { add.call(this, 'message', e => { if (e.data instanceof Blob) { __tb.frames++; if (__tb.wheelAt) { __tb.frameAfter.push(Math.round(performance.now() - __tb.wheelAt)); __tb.wheelAt = 0; } } f(e); }); } }); })()` });
    await page('Page.navigate', { url });
    const evaluate = async expression => { const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    return { page, evaluate, close: () => send('Target.closeTarget', { targetId }) };
  };
  const until = async (f, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };

  // ---------- the task browser's page, over its own DevTools port ----------
  const shown = async () => {
    const m = JSON.parse(readFileSync(join(S, 'tbdir', 'browsers', task.id, 'browser.json'), 'utf8'));
    const list = (await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json()).filter(t => t.type === 'page' && t.url !== 'about:blank');
    return list[0];
  };
  const inPage = async expression => {
    const t = await shown(); if (!t) return null;
    const c = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { c.once('open', r); c.once('error', j); });
    const v = await new Promise(r => { c.on('message', d => { const m = JSON.parse(d); if (m.id === 1) r(m.result?.result?.value); }); c.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
    c.close(); return v;
  };
  const pos = async () => JSON.parse(await inPage(`JSON.stringify({x:scrollX,y:scrollY,box:document.getElementById('box')?.scrollTop??null,w:innerWidth,h:innerHeight})`) || 'null');

  // ---------- one dashboard view: wheel and keys at a point of the browser view ----------
  async function run(label, view, cases) {
    // the view element and the page point → dashboard point
    const rect = JSON.parse(await view.evaluate(`JSON.stringify([...document.querySelectorAll('.bw-screen.framed')].at(-1)?.getBoundingClientRect() ?? null)`) || 'null');
    if (!rect) { check(`${label}: the view shows the page`, false); return; }
    const p0 = await pos();
    const at = (px, py) => ({ x: rect.left + px * rect.width / p0.w, y: rect.top + py * rect.height / p0.h });
    const mid = at(p0.w / 2, p0.h / 2);
    const wheel = async (dx, dy, modifiers = 0, point = mid) => view.page('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: dx, deltaY: dy, modifiers });
    const settle = async (f, ms = 3000) => until(async () => { const p = await pos(); return f(p) ? p : null; }, ms);
    await view.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y });
    for (const c of cases) {
      await inPage(`scrollTo(0,0); document.getElementById('box')?.scrollTo(0,0); window.__wheels.length=0`); await sleep(300);
      if (c === 'wheel') {
        // the time from the wheel message to the next frame, measured in the dashboard
        await view.evaluate('__tb.wheelAt = 0; __tb.frameAfter.length = 0');
        await wheel(0, 100);
        const p = await settle(p => p.y === 100);
        const frame = await view.evaluate('__tb.frameAfter[0]');
        check(`${label}: one wheel of 100 px`, !!p, p ? `scrollY 100, next frame ${frame} ms after the message` : `scrollY ${(await pos()).y}`);
      } else if (c === 'trackpad') {
        const m0 = await view.evaluate('__tb.wheelMsgs');
        // four events in each frame of 16 ms, as a 240 Hz trackpad stream; the calls are not awaited one by one
        for (let i = 0; i < 15; i++) { await Promise.all([0, 1, 2, 3].map(() => wheel(0, 4))); await sleep(16); }
        const p = await settle(p => Math.abs(p.y - 240) <= 1);
        const msgs = (await view.evaluate('__tb.wheelMsgs')) - m0;
        check(`${label}: 60 trackpad deltas of 4 px`, !!p && msgs < 60, `scrollY ${(await pos()).y} of 240, ${msgs} messages for 60 events`);
      } else if (c === 'sideways') {
        await wheel(120, 0);
        const p = await settle(p => p.x === 120 && p.y === 0);
        check(`${label}: sideways wheel of 120 px`, !!p, `scrollX ${(await pos()).x}`);
      } else if (c === 'shift') {
        await wheel(0, 100, 8);
        const p = await settle(p => p.x === 100 && p.y === 0);
        const q = await pos();
        check(`${label}: Shift + wheel scrolls sideways`, !!p, `scrollX ${q.x}, scrollY ${q.y}`);
      } else if (c === 'inner') {
        await wheel(0, 100, 0, at(190, 140));
        const p = await settle(p => p.box === 100 && p.y === 0);
        check(`${label}: wheel over an inner scroll area`, !!p, `box scrollTop ${(await pos()).box}`);
      } else if (c === 'keys') {
        // a click focuses the view; the keys then go to the page
        for (const type of ['mousePressed', 'mouseReleased']) await view.page('Input.dispatchMouseEvent', { type, x: mid.x, y: mid.y, button: 'left', clickCount: 1 });
        await sleep(300); await inPage('scrollTo(0,0)'); await sleep(200);
        const press = async (key, code, keyCode, text) => { await view.page('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) }); await view.page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); };
        // a key scrolls smoothly: read the position when it no longer changes
        const still = async () => { let last = -1; for (let i = 0; i < 40; i++) { const p = await pos(); if (p.y === last) return p; last = p.y; await sleep(150); } return pos(); };
        await press('PageDown', 'PageDown', 34); const a = await still();
        await press(' ', 'Space', 32, ' '); const b = await still();
        await press('End', 'End', 35); const e = await still();
        await press('Home', 'Home', 36); const h = await still();
        await press('ArrowDown', 'ArrowDown', 40); const d = await still();
        const ok = a.y > p0.h / 2 && b.y > a.y && e.y > 4000 && h.y === 0 && d.y > 0;
        check(`${label}: Page Down, Space, End, Home, Down`, ok, `scrollY ${a.y}, ${b.y}, ${e.y}, ${h.y}, ${d.y}`);
      }
    }
  }
  const go = async (view, url) => {
    // type the address in the view's address field, as a user does
    await view.evaluate(`(() => { const i = [...document.querySelectorAll('.bw-url')].at(-1); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; i.focus(); set.call(i, ${JSON.stringify(url)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await until(async () => (await shown())?.url.startsWith(url.slice(0, 20)) && (await inPage('document.readyState')) === 'complete');
    await inPage(`window.__wheels ||= []`);
    await sleep(800);
  };
  const clickText = (view, re) => view.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent.trim())); b?.click(); return !!b; })()`);
  const framed = view => until(() => view.evaluate(`!!document.querySelector('.bw-screen.framed')`), 30000);

  // 1. the task panel (compact view)
  const dash = await openTab(`${BASE}/?open=${encodeURIComponent(task.id)}&tab=browser#list`);
  await until(() => clickText(dash, /^Start the browser$/), 15000);
  if (!await framed(dash)) throw new Error('the task browser did not start: ' + serverLog.slice(-800));
  const long = `file://${join(S, 'pages', 'long.html')}`, inner = `file://${join(S, 'pages', 'inner.html')}`;
  await go(dash, long);
  await run('task panel', dash, ['wheel', 'trackpad', 'sideways', 'shift', 'keys']);
  await go(dash, inner);
  await run('task panel', dash, ['inner']);
  if (SITE) {
    await go(dash, SITE);
    await run(`task panel, ${SITE}`, dash, ['wheel']);
  }

  // 2. the browser stopped and started: React creates the view element again
  await dash.evaluate(`document.querySelector('.bw-ib.danger')?.click()`);
  await until(() => clickText(dash, /^Start the browser$/), 15000);
  await framed(dash);
  await go(dash, long);
  await run('after stop and start', dash, ['wheel']);

  // 3. the Canvas window of the task, with the browser above the terminal
  await dash.evaluate(`document.querySelector('.bw-more')?.click()`); await sleep(300);
  await clickText(dash, /Show on Canvas/);
  await until(() => dash.evaluate(`!!document.querySelector('.wb-browser .bw-screen.framed')`), 15000);
  await sleep(1000);
  await run('Canvas window', dash, ['wheel', 'sideways', 'shift']);

  // 4. the pop-out window (its own page, the floating layout)
  await dash.close();
  const pop = await openTab(`${BASE}/?browser=${encodeURIComponent(task.id)}&title=Scroll`);
  await framed(pop); await sleep(800);
  await run('pop-out window', pop, ['wheel', 'trackpad', 'shift']);
} catch (e) {
  console.error(e.message);
  results.push({ name: 'run', ok: false });
} finally {
  cleanup();
}
const failed = results.filter(r => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
