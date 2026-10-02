#!/usr/bin/env node
// Measures how fast the task browser view of the dashboard answers. It starts a test Taskboard (own port, folders and
// tmux socket, no controller) and a second headless Chrome for the dashboard, and never touches the real Taskboard.
//
//   node scripts/browser-speed.mjs [--widths 600,1000,1600] [--load off,on] [--dpr 2] [--repeat 12] [--label name]
//                                  [--json file] [--no-build] [--chrome path] [--sharp] [--keep]
//
// The template browser of the test server shows a test page from a local HTTP server: a long page of 40 px colour
// stripes, and a box in the top left corner that changes its colour at each mouse press and each key press. The
// dashboard page is the pop-out page of that browser (/?browser=template), at each width x 800 CSS px and a pixel ratio
// of --dpr. For each width it records:
// - click, key and scroll: the time from the input event in the dashboard page to the first frame drawn on the canvas
//   in which the box (click, key) or the stripes (scroll) changed. --repeat inputs, 600 ms apart.
// - scroll: wheel events of 50 px every 16 ms for 3 s. Frames received and drawn per second, bytes per frame and per
//   second, the decode time (createImageBitmap) and the draw time (drawImage) per frame, and the CPU of the dashboard
//   renderer, the test server and the task Chrome (all processes of its process group).
// - animation: the test page moves a bar for 4 s (like a video) with no input. The same numbers as for scroll.
// - idle: 3 s without input or change on the page. Frames per second.
// - hidden: the dashboard page is hidden (Page.setWebLifecycleState frozen is too strong, so the test uses
//   Emulation.setFocusEmulationEnabled and a visibilitychange event) for 3 s while the bar moves. Frames received.
// - panel hidden: the same with the view's element at display: none.
// - cursor: the time from a mouse move to a stripe without text (default), over the box (pointer) and over the large text at the top right (text) to that cursor on the view.
// - busy and freeze: the dashboard's main thread runs 25 ms of other work every 40 ms (busy) or 150 ms every 200 ms
//   (freeze). Animation numbers and the click latency.
// --load on runs one CPU burner for each core and a memory hog of 2 GB (touched every second) during the widths.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WIDTHS = opt('--widths', '600,1000,1600').split(',').map(Number);
const LOADS = opt('--load', 'off').split(',');
const DPR = Number(opt('--dpr', 2)), REPEAT = Number(opt('--repeat', 12)), LABEL = opt('--label', 'run');
const CHROME = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOT = join(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const r1 = v => v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const median = a => pct(a, 0.5);

if (!args.includes('--no-build')) execFileSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });

// ---------- the test page ----------
const PAGE = `<!doctype html><meta charset="utf-8"><title>speed test</title>
<style>body{margin:0;font:16px sans-serif} .s{height:40px;line-height:40px;padding-left:40%} #box{position:fixed;left:0;top:0;width:30%;height:25%;background:#c00;cursor:pointer}
#txt{position:fixed;right:0;top:0;width:30%;height:25%;font:bold 60px/1 sans-serif;background:#fff}
#bar{position:fixed;left:0;bottom:0;height:30%;background:#06c;width:0}</style>
<div id="box"></div><div id="txt">Text Text Text Text</div><div id="bar"></div><div id="list"></div>
<script>
const list = document.getElementById('list'), html = [];
for (let i = 0; i < 4000; i++) html.push('<div class="s" style="background:hsl(' + (i * 47 % 360) + ',70%,' + (40 + i * 13 % 30) + '%)">Line ' + i + ': the quick brown fox jumps over the lazy dog</div>');
list.innerHTML = html.join('');
let n = 0; const colors = ['#c00', '#0a0', '#00c', '#cc0', '#0cc', '#c0c'];
const flip = () => { n++; document.getElementById('box').style.background = colors[n % colors.length]; };
addEventListener('mousedown', flip); addEventListener('keydown', flip);
window.wheels = 0; addEventListener('wheel', () => wheels++, { passive: true });
let anim = false, w = 0; window.animate = on => { anim = on; };
(function tick() { if (anim) { w = (w + 1.5) % 100; document.getElementById('bar').style.width = w + '%'; } requestAnimationFrame(tick); })();
</script>`;
const pagePort = await freePort();
const pages = httpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }).listen(pagePort, '127.0.0.1');
const TEST_URL = `http://127.0.0.1:${pagePort}/test.html`;

// ---------- the test server ----------
const S = mkdtempSync(join(tmpdir(), 'tb-browser-speed-'));
const SOCKET = `tbspeed-${process.pid}`;
for (const d of ['vault', 'tbdir']) mkdirSync(join(S, d), { recursive: true });
writeFileSync(join(S, 'tbdir', 'machine.json'), JSON.stringify({ name: 'speed', controller: { autostart: false, remoteControl: false }, browser: { chromePath: CHROME, idleStopMinutes: 0, ...(args.includes('--sharp') ? { sharp: true } : {}) } }));
const PORT = await freePort(), URL_BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, TASKBOARD_PORT: String(PORT), TASKBOARD_DIR: join(S, 'tbdir'), TASKBOARD_VAULT: join(S, 'vault'), TASKBOARD_TMUX_SOCKET: SOCKET, TASKBOARD_MACHINE_NAME: 'speed' };
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
let chrome = null, loaders = [];
const stopLoad = () => { for (const p of loaders) try { p.kill('SIGKILL'); } catch { /* gone */ } loaders = []; };
const templatePid = () => { try { return JSON.parse(readFileSync(join(S, 'tbdir', 'browsers', 'template', 'browser.json'), 'utf8')).pid; } catch { return undefined; } };
const cleanup = () => {
  stopLoad();
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  const tp = templatePid(); if (tp) { try { process.kill(-tp, 'SIGKILL'); } catch { /* gone */ } }
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions */ }
  pages.close();
  if (!args.includes('--keep')) rmSync(S, { recursive: true, force: true });
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const api = async (path, body) => {
  const r = await fetch(URL_BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: URL_BASE }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
// CPU seconds of one process or of a process group (ps prints minutes:seconds.hundredths)
const secs = t => t.split(':').reduce((a, v) => a * 60 + Number(v), 0);
const cpuOf = (pid, group = false) => {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,time='], { encoding: 'utf8' });
    return out.trim().split('\n').map(l => l.trim().split(/\s+/)).filter(([p, g]) => Number(group ? g : p) === pid).reduce((a, [, , t]) => a + secs(t), 0);
  } catch { return 0; }
};

// a DevTools client
async function devtools(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let seq = 0; const waiting = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  return { ws, send };
}

// the probe in the dashboard page: wraps drawImage and createImageBitmap, and records the input events
function probe() {
  const P = window.__bs = { draws: [], decodes: [], changes: [], inputs: [], arm: false, last: {} };
  const POINTS = [['box', 0.05, 0.05], ['content', 0.8, 0.6]];
  const read = (ctx, fx, fy) => { const c = ctx.canvas, d = ctx.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; };
  // the colours of the canvas now, so the first input of a series has a colour to compare with
  P.sample = () => { const ctx = document.querySelector('.bw-screen canvas')?.getContext('2d'); if (ctx) for (const [k, fx, fy] of POINTS) P.last[k] = read(ctx, fx, fy); };
  // A canvas change shows in the display frame after the draw, or in the same frame for a draw in a
  // requestAnimationFrame callback. A change gets the start time of that frame, so a direct draw and a draw in an
  // animation frame compare fairly. The loop below starts first, so it records the start of each frame.
  P.frameStart = 0; P.inRaf = false; const nextFrame = [];
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { P.inRaf = true; try { cb(t); } finally { P.inRaf = false; } });
  (function loop() { raf(() => { P.frameStart = performance.now(); for (const c of nextFrame.splice(0)) c.t = P.frameStart; loop(); }); })();
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) {
    const t0 = performance.now(); const r = draw.apply(this, a); const t1 = performance.now();
    const c = this.canvas;
    if (c.closest?.('.bw-screen')) {
      P.draws.push({ t: t1, ms: t1 - t0, w: c.width, h: c.height });
      if (P.arm) for (const [k, fx, fy] of POINTS) {
        const col = read(this, fx, fy);
        if (P.last[k] !== undefined && P.last[k] !== col) { const c = { k, t: P.inRaf ? P.frameStart : Infinity }; P.changes.push(c); if (!P.inRaf) nextFrame.push(c); }
        P.last[k] = col;
      }
    }
    return r;
  };
  const cib = window.createImageBitmap;
  window.createImageBitmap = function (b, ...rest) {
    const t0 = performance.now(), p = cib.call(this, b, ...rest), size = b?.size ?? 0;
    p.then(() => P.decodes.push({ t0, ms: performance.now() - t0, size }), () => {});
    return p;
  };
  for (const ev of ['mousedown', 'keydown', 'wheel']) addEventListener(ev, () => P.inputs.push({ type: ev, t: performance.now() }), true);
}

const report = { label: LABEL, started: new Date().toISOString(), cores: cpus().length, dpr: DPR, repeat: REPEAT, results: [] };
try {
  for (let i = 0; i < 150; i++) { try { await api('/api/browser-template'); break; } catch { await sleep(200); } }
  await api('/api/browser-template/start', {});
  // open the test page in the first tab of the template browser
  const meta = JSON.parse(readFileSync(join(S, 'tbdir', 'browsers', 'template', 'browser.json'), 'utf8'));
  const tabs = await (await fetch(`http://127.0.0.1:${meta.port}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page');
  const tp = await devtools(tab.webSocketDebuggerUrl);
  await tp.send('Page.enable'); await tp.send('Page.navigate', { url: TEST_URL }); await sleep(1500);
  const pageEval = expression => tp.send('Runtime.evaluate', { expression });

  // the dashboard Chrome
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(S, 'dash-chrome')}`, '--window-size=1700,900', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const dashWs = await new Promise((resolve, reject) => {
    let err = ''; chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('Chrome did not start: ' + err.slice(-500))), 20000);
  });
  const dash = await devtools(dashWs);
  const { targetId } = await dash.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await dash.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => dash.send(m, p, sessionId);
  await page('Page.enable'); await page('Runtime.enable');
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `(${probe.toString()})()` });
  const evaluate = async expression => { const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const rendererCpu = async () => { const info = await dash.send('SystemInfo.getProcessInfo'); const sum = t => info.processInfo.filter(p => p.type === t).reduce((a, p) => a + p.cpuTime, 0); return { renderer: sum('renderer'), gpu: sum('GPU') }; };
  const mouse = (type, x, y, extra = {}) => page('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseWheel' || type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseWheel' || type === 'mouseMoved' ? 0 : 1, ...extra });

  const startLoad = () => {
    for (let i = 0; i < cpus().length; i++) loaders.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    loaders.push(spawn(process.execPath, ['-e', 'const b=[];for(let i=0;i<16;i++)b.push(Buffer.alloc(128<<20,1));setInterval(()=>{for(const x of b)for(let j=0;j<x.length;j+=4096)x[j]++},1000)'], { stdio: 'ignore' }));
  };

  for (const load of LOADS) {
    if (load === 'on') { startLoad(); await sleep(3000); }
    for (const W of WIDTHS) {
      console.log(`${LABEL}: width ${W}, load ${load} (load average ${loadavg()[0].toFixed(0)})`);
      await page('Emulation.setDeviceMetricsOverride', { width: W, height: 800, deviceScaleFactor: DPR, mobile: false });
      await page('Page.navigate', { url: `${URL_BASE}/?browser=template&title=speed` });
      for (let i = 0; i < 100; i++) { if (await evaluate('window.__bs?.draws.length > 0').catch(() => false)) break; await sleep(200); }
      await pageEval('scrollTo(0, 0); animate(false)');
      await sleep(2000);
      const rect = await evaluate(`(() => { const r = document.querySelector('.bw-screen canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
      const at = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy];
      const reset = () => evaluate('(() => { const P = window.__bs; P.draws = []; P.decodes = []; P.changes = []; P.inputs = []; P.last = {}; })()');
      const res = { load, width: W, loadavg: r1(loadavg()[0]), canvasCss: [Math.round(rect.w), Math.round(rect.h)] };

      // click, key and scroll: input to the first changed frame
      const latency = async (kind, act, watch) => {
        await reset(); await evaluate('window.__bs.sample(); window.__bs.arm = true');
        await sleep(300);
        for (let i = 0; i < REPEAT; i++) { await act(i); await sleep(600); }
        const P = await evaluate('(() => { const P = window.__bs; P.arm = false; return { inputs: P.inputs, changes: P.changes }; })()');
        const ins = P.inputs.filter(e => e.type === kind), out = [];
        for (let i = 0; i < ins.length; i++) {
          const end = ins[i + 1]?.t ?? Infinity;
          const c = P.changes.find(c => c.k === watch && c.t > ins[i].t && c.t < end);
          out.push(c ? c.t - ins[i].t : null);
        }
        const ok = out.filter(v => v != null);
        return { median: r1(median(ok)), p90: r1(pct(ok, 0.9)), missed: out.length - ok.length };
      };
      const [cx, cy] = at(0.1, 0.1);
      res.click = await latency('mousedown', async () => { await mouse('mousePressed', cx, cy); await mouse('mouseReleased', cx, cy); }, 'box');
      res.key = await latency('keydown', async () => { await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 }); await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }); }, 'box');
      const [mx, my] = at(0.6, 0.6);
      res.scroll = await latency('wheel', async () => { await mouse('mouseWheel', mx, my, { deltaX: 0, deltaY: 100 }); }, 'content');

      // the cursor of the view over the box (pointer) and over the text of a stripe (text): the time from the move to
      // the cursor on the view element
      const cursorAfterMove = async (x, y, want) => {
        const t0 = performance.now();
        await mouse('mouseMoved', x, y);
        for (let i = 0; i < 40; i++) { if (await evaluate(`getComputedStyle(document.querySelector('.bw-screen')).cursor`) === want) return r1(performance.now() - t0); await sleep(25); }
        return null;
      };
      res.cursor = { defaultMs: await cursorAfterMove(...at(0.2, 0.6), 'default'), pointerMs: await cursorAfterMove(...at(0.1, 0.1), 'pointer'), textMs: await cursorAfterMove(...at(0.75, 0.04), 'text') };
      // a stream of frames: numbers for scroll and animation
      const stream = async (seconds, during) => {
        await reset();
        const c0 = await rendererCpu(), s0 = cpuOf(server.pid), t0c = cpuOf(templatePid(), true), w0 = performance.now();
        await during();
        await sleep(300);
        const wall = (performance.now() - w0) / 1000;
        const c1 = await rendererCpu(), s1 = cpuOf(server.pid), t1c = cpuOf(templatePid(), true);
        const P = await evaluate('(() => { const P = window.__bs; return { draws: P.draws, decodes: P.decodes }; })()');
        const bytes = P.decodes.reduce((a, d) => a + d.size, 0);
        return {
          receivedFps: r1(P.decodes.length / wall), drawnFps: r1(P.draws.length / wall),
          kbPerFrame: r1(P.decodes.length ? bytes / P.decodes.length / 1024 : null), kbPerSec: r1(bytes / wall / 1024),
          frame: P.draws.length ? `${P.draws.at(-1).w}x${P.draws.at(-1).h}` : '',
          decodeMs: r1(median(P.decodes.map(d => d.ms))), decodeP90: r1(pct(P.decodes.map(d => d.ms), 0.9)), drawMs: r1(median(P.draws.map(d => d.ms))),
          cpu: { dashRenderer: r1((c1.renderer - c0.renderer) / wall * 100), dashGpu: r1((c1.gpu - c0.gpu) / wall * 100), server: r1((s1 - s0) / wall * 100), chrome: r1((t1c - t0c) / wall * 100) },
        };
      };
      // a trackpad sends about 60 wheel events each second: one each 16 ms, without a wait for the one before
      const scrolled = async () => (await tp.send('Runtime.evaluate', { expression: 'scrollY + " " + wheels', returnByValue: true })).result.value.split(' ').map(Number);
      const [y0, n0] = await scrolled();
      res.scrollStream = await stream(3, async () => { const end = performance.now() + 3000; while (performance.now() < end) { void mouse('mouseWheel', mx, my, { deltaX: 0, deltaY: 50 }); await sleep(16); } });
      const [y1, n1] = await scrolled();
      Object.assign(res.scrollStream, { pageWheels: n1 - n0, scrolledPx: y1 - y0 });
      await pageEval('animate(true)');
      res.animation = await stream(4, () => sleep(4000));
      // the last frame after the page stops moving (the frame that stays on the screen)
      await pageEval('animate(false)'); await sleep(1000);
      res.stillKb = r1((await evaluate('window.__bs.decodes.at(-1)?.size || 0')) / 1024);
      await pageEval('animate(true)');
      // hidden: the dashboard page is hidden while the bar moves
      await reset();
      await page('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await page('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await evaluate(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
      await sleep(3000);
      const hidden = await evaluate('window.__bs.decodes.length');
      await evaluate(`(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); })()`);
      // the time from shown again to the next drawn frame
      const shownAt = await evaluate('(() => { const t = performance.now(); window.__bs.draws = []; return t; })()');
      await sleep(1500);
      const after = await evaluate('window.__bs.draws.map(d => d.t)');
      res.hidden = { receivedFpsWhileHidden: r1(hidden / 3), firstFrameAfterShowMs: after.length ? r1(after[0] - shownAt) : null };
      // the panel is hidden (display: none) while the bar moves
      await reset();
      await evaluate(`document.querySelector('.bw').style.display = 'none'`);
      await sleep(3000);
      const panelHidden = await evaluate('window.__bs.decodes.length');
      await evaluate(`document.querySelector('.bw').style.display = ''`);
      res.hidden.receivedFpsWhilePanelHidden = r1(panelHidden / 3);
      await sleep(1000);
      // a busy dashboard: its main thread runs other work (25 ms every 40 ms, then 150 ms every 200 ms) while the bar
      // moves, then the click latency with the same work and a still page
      for (const [name, work, every] of [['busy', 25, 40], ['freeze', 150, 200]]) {
        await pageEval('animate(true)');
        await evaluate(`window.__busy = setInterval(() => { const e = performance.now() + ${work}; while (performance.now() < e); }, ${every})`);
        await sleep(500);
        res[name] = { animation: await stream(4, () => sleep(4000)) };
        await pageEval('animate(false)'); await sleep(500);
        res[name].click = await latency('mousedown', async () => { await mouse('mousePressed', cx, cy); await mouse('mouseReleased', cx, cy); }, 'box');
        await evaluate('clearInterval(window.__busy)');
        await sleep(500);
      }
      await reset(); await sleep(1000); await reset();
      await sleep(3000);
      res.idleFps = r1(await evaluate('window.__bs.decodes.length') / 3);
      report.results.push(res);
      console.log(JSON.stringify(res));
    }
    stopLoad();
  }
} catch (e) {
  console.error(e);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  const out = opt('--json');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  if (args.includes('--server-log')) console.log(serverLog);
  cleanup();
}
