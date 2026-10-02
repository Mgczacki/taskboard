#!/usr/bin/env node
// Measures how long browser terminals take to show text. It starts a test Taskboard (own port, folders and tmux
// socket) whose tasks run tests/fixtures/chatty-agent.cjs, drives a headless Chrome through the DevTools protocol,
// and prints the times. It never touches the real Taskboard.
//
//   node scripts/terminal-timing.mjs [--tasks 12] [--runs 3] [--lines 4000] [--json file] [--keep] [--chrome path]
//   node scripts/terminal-timing.mjs --serve [--tasks 12]   only start the test server and its tasks, until Ctrl-C
//
// For each case it records, from the click (or the start of the page load) to:
// - first: the first frame where a new terminal shows text
// - full: the first frame where it shows the agent's input box ("? for shortcuts"), so the whole screen is drawn
// - settled: the last change of its text, before 1.5 s without a change (a resize redraw counts as a change)
// - the steps inside Terminal.tsx (the timing in its debug record): xterm open, fit, socket open, first output, first draw
// - the longest frame gap (requestAnimationFrame) and the long tasks of the page while it waited (a freeze)
// It also opens the terminal sockets without a browser, to time the server part (attach to tmux and first output).
// Needs Node 20.19 or later for the build (vite) and Google Chrome. Run `pnpm build` first: the server serves web/dist.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TASKS = Number(opt('--tasks', 12)), RUNS = Number(opt('--runs', 3)), LINES = Number(opt('--lines', 4000));
// --cases reload,page,group,panel,controller,server runs only those cases
const CASES = (opt('--cases', 'reload,page,group,panel,controller,server')).split(',');
const CHROME = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOT = join(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const max = a => { const s = a.filter(x => x != null); return s.length ? Math.max(...s) : null; };
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) { console.error('Run `pnpm build` first.'); process.exit(1); }

// ---------- the test server ----------
const S = mkdtempSync(join(tmpdir(), 'tb-term-timing-'));
const SOCKET = `tbtiming-${process.pid}`;
for (const d of ['vault', 'tbdir', 'bin', 'work', 'claude']) mkdirSync(join(S, d), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'fixtures', 'chatty-agent.cjs'), join(S, 'bin', 'claude'));
execFileSync('chmod', ['+x', join(S, 'bin', 'claude')]);
writeFileSync(join(S, 'tbdir', 'machine.json'), JSON.stringify({ name: 'timing', controller: { autostart: false, remoteControl: false }, permissions: { trustWorkspaces: false } }));
writeFileSync(join(S, 'tbdir', 'accounts.json'), JSON.stringify([{ id: 'claude-timing', agent: 'claude', name: 'Claude timing', dir: join(S, 'claude'), maxParallel: 100, created: new Date().toISOString() }]));
const PORT = await freePort(), URL_BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PATH: `${join(S, 'bin')}:${process.env.PATH}`, TASKBOARD_PORT: String(PORT), TASKBOARD_DIR: join(S, 'tbdir'), TASKBOARD_VAULT: join(S, 'vault'),
  TASKBOARD_TMUX_SOCKET: SOCKET, TASKBOARD_MACHINE_NAME: 'timing', CLAUDE_CONFIG_DIR: join(S, 'claude'), CHATTY_LINES: String(LINES), CHATTY_EVERY: '0' };
const server = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
let chrome = null;
const cleanup = () => {
  if (opt('--server-log')) writeFileSync(opt('--server-log'), serverLog);
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions */ }
  if (!args.includes('--keep')) rmSync(S, { recursive: true, force: true });
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { if (!args.includes('--serve')) { cleanup(); process.exit(143); } });

const api = async (path, body) => {
  const r = await fetch(URL_BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: URL_BASE }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
for (let i = 0; i < 100; i++) { try { await api('/api/tasks'); break; } catch { await sleep(200); } }

const screen = session => { try { return execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', '=' + session + ':'], { encoding: 'utf8' }); } catch { return ''; } };
try {
  const tasks = [];
  for (let i = 0; i < TASKS; i++) tasks.push(await api('/api/tasks', { title: `Timing ${i + 1}`, desc: 'timing', agent: 'claude', folder: join(S, 'work'), worktree: false }));
  for (const t of tasks) for (let i = 0; i < 100 && !screen(t.session).includes('for shortcuts'); i++) await sleep(100);
  const half = Math.ceil(TASKS / 2);
  const g1 = await api('/api/groups', { name: 'First', tasks: tasks.slice(0, half).map(t => t.id) }).catch(() => null);
  const g2 = await api('/api/groups', { name: 'Second', tasks: tasks.slice(half).map(t => t.id) }).catch(() => null);
  console.log(`Test server ${URL_BASE} (folder ${S}), ${TASKS} tasks with ${LINES} lines of history each`);
  // --serve: keep the test server for checks by hand until Ctrl-C
  if (args.includes('--serve')) { await new Promise(resolve => process.on('SIGTERM', resolve)); throw Object.assign(new Error('stopped'), { quiet: true }); }

  // ---------- the server part, without a browser ----------
  const openTerm = (id, cols = 120, rows = 40) => new Promise(resolve => {
    const t0 = performance.now(), r = { open: null, first: null, quiet: null, bytes: 0, messages: 0 };
    const ws = new WebSocket(`${URL_BASE.replace('http', 'ws')}/ws/term?task=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`, { origin: URL_BASE });
    let last = 0, timer;
    const done = () => { ws.close(); resolve({ ...r, quiet: last - t0 }); };
    ws.on('open', () => { r.open = performance.now() - t0; });
    ws.on('message', d => {
      const s = d.toString(); if (s.charCodeAt(0) === 0) return;
      r.messages++; r.bytes += s.length; last = performance.now(); if (r.first === null) r.first = last - t0;
      clearTimeout(timer); timer = setTimeout(done, 500);
    });
    setTimeout(() => { if (r.first === null) done(); }, 10000);
  });
  const serverRows = [], parallel = [];
  if (CASES.includes('server')) {
    for (let run = 0; run < RUNS; run++) for (const t of tasks.slice(0, 3)) serverRows.push(await openTerm(t.id));
    for (let run = 0; run < RUNS; run++) parallel.push(...await Promise.all(tasks.map(t => openTerm(t.id))));
  }
  const serverPart = {
    one: { open: median(serverRows.map(r => r.open)), first: median(serverRows.map(r => r.first)), complete: median(serverRows.map(r => r.quiet)), bytes: median(serverRows.map(r => r.bytes)), messages: median(serverRows.map(r => r.messages)) },
    all: { open: median(parallel.map(r => r.open)), first: median(parallel.map(r => r.first)), firstMax: max(parallel.map(r => r.first)), complete: median(parallel.map(r => r.quiet)), bytes: median(parallel.map(r => r.bytes)) },
  };

  // ---------- the browser ----------
  const profile = join(S, 'chrome');
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1680,1050', '--no-first-run', '--no-default-browser-check',
    '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''; chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('Chrome did not start: ' + err.slice(-500))), 20000);
  });
  const cdp = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise(r => cdp.on('open', r));
  let seq = 0; const pending = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => send(m, p, sessionId);
  await page('Page.enable'); await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 2, mobile: false });
  const evaluate = async (expression) => { const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  // the probe: from start() on, it looks at each terminal that was not there before, once per frame
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `(${probe.toString()})()` });

  const load = async (hash, prefs = {}) => {
    await page('Page.navigate', { url: URL_BASE + '/' });
    for (let i = 0; i < 100; i++) { if (await evaluate(`location.origin === ${JSON.stringify(URL_BASE)} && document.readyState === 'complete'`).catch(() => false)) break; await sleep(100); }
    await evaluate(`(() => { localStorage.clear(); ${Object.entries(prefs).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')} })()`);
    await page('Page.navigate', { url: `${URL_BASE}/#${hash}` });
  };
  const result = (expect) => evaluate(`window.__tt.result(${expect})`);
  const click = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('no ' + ${JSON.stringify(selector)}); window.__tt.start(); e.click(); return true; })()`);
  const cases = [];
  const record = (name, r) => { cases.push({ name, ...r }); process.stdout.write(`  ${name}: first ${fmt(r.first)} · full ${fmt(r.full)} · live ${fmt(r.live)} · settled ${fmt(r.settled)} · frame gap ${fmt(r.maxFrameGap)} (${r.count} terminals)\n`); };
  const perPage = 4;
  for (let run = 0; run < RUNS; run++) {
    console.log(`Run ${run + 1} of ${RUNS}`);
    // a browser reload of the Canvas with every window shown (Per page off)
    if (CASES.includes('reload')) {
      await load('canvas:live', { 'tb-cv-live-perpage': 'off' });
      record('reload, all windows', await result(TASKS));
      const mem = await evaluate(`({ heap: performance.memory.usedJSHeapSize, nodes: document.getElementsByTagName('*').length, terminals: document.querySelectorAll('.xterm').length })`);
      if (run === 0) cases.push({ name: 'memory, all windows', memory: mem });
    }
    // Canvas pages
    await load('canvas:live', { 'tb-cv-live-perpage': String(perPage) });
    if (CASES.includes('reload')) record(`reload, Per page ${perPage}`, await result(Math.min(perPage, TASKS)));
    else await result(Math.min(perPage, TASKS));
    await sleep(800);
    if (CASES.includes('page')) for (const dir of ['›', '›', '‹']) {
      await click(`.pager button[title^="${dir === '›' ? 'Next page' : 'Previous page'}"]`);
      record(`page change (${dir === '›' ? 'next' : 'previous'})`, await result(perPage));
      await sleep(800);
    }
    // group tabs
    if (g1 && g2 && (CASES.includes('group') || CASES.includes('panel'))) {
      await load(`canvas:${encodeURIComponent('g:' + g1.id)}`, { [`tb-cv-g:${g1.id}-perpage`]: 'off', [`tb-cv-g:${g2.id}-perpage`]: 'off' });
      await result(half); await sleep(800);
      await click(`[data-group-tab="${g2.id}"]`);
      record('group tab change', await result(TASKS - half));
      await sleep(800);
      await click(`[data-group-tab="${g1.id}"]`);
      record('group tab change', await result(half));
      await sleep(800);
      // the task panel: its terminal opens, and the tile shows a note while it is open
      await click(`[data-win="${tasks[0].id}"] button[title="Task panel"]`);
      record('task panel open', await result(1));
      await sleep(800);
      await click('aside.drawer button[title="Close"]');
      record('task panel close (tile back)', await result(1));
      await sleep(800);
    }
    // the controller (the first open starts it)
    if (CASES.includes('controller')) {
      await click('.ctl-item');
      record(run === 0 ? 'controller open (starts it)' : 'controller open', await result(1));
      await sleep(800);
      await click('aside.drawer button[title="Close"]');
      await sleep(800);
    }
  }
  const breakdown = await evaluate(`window.taskboardTerminalDebug().map(r => r.timing)`);

  // ---------- the report ----------
  const names = [...new Set(cases.filter(c => !c.memory).map(c => c.name))];
  const lines = ['| Case | Terminals | First text (median) | First text (slowest) | Full screen | Saved screen drawn | Live screen drawn (median) | Live (slowest) | Settled | Longest frame gap | Long tasks (sum) |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const n of names) {
    const c = cases.filter(x => x.name === n);
    lines.push(`| ${n} | ${c[0].count} | ${fmt(median(c.map(x => x.first)))} | ${fmt(median(c.map(x => x.firstMax)))} | ${fmt(median(c.map(x => x.full)))} | ${fmt(median(c.map(x => x.snapshot)))} | ${fmt(median(c.map(x => x.live)))} | ${fmt(median(c.map(x => x.liveMax)))} | ${fmt(median(c.map(x => x.settled)))} | ${fmt(median(c.map(x => x.maxFrameGap)))} | ${fmt(median(c.map(x => x.longTaskSum)))} |`);
  }
  const steps = ['opened', 'fitted', 'snapshotParsed', 'snapshotDrawn', 'socketOpen', 'firstOutput', 'firstParsed', 'firstDrawn'];
  const stepRows = steps.map(s => `| ${s} | ${fmt(median(cases.flatMap(c => c.steps || []).map(x => x[s])))} |`);
  const mem = cases.find(c => c.memory)?.memory;
  console.log(`\n${lines.join('\n')}\n\nSteps inside Terminal.tsx, ms after the terminal mounted (median over all cases):\n| Step | ms |\n|---|---|\n${stepRows.join('\n')}`);
  if (serverRows.length) console.log(`\nServer part (WebSocket without a browser): one terminal: open ${fmt(serverPart.one.open)}, first output ${fmt(serverPart.one.first)}, last output ${fmt(serverPart.one.complete)}, ${serverPart.one.bytes} bytes in ${serverPart.one.messages} messages.`);
  if (parallel.length) console.log(`${TASKS} terminals at once: open ${fmt(serverPart.all.open)}, first output ${fmt(serverPart.all.first)} (slowest ${fmt(serverPart.all.firstMax)}), last output ${fmt(serverPart.all.complete)}.`);
  if (mem) console.log(`Page with ${mem.terminals} terminals: JavaScript heap ${(mem.heap / 1048576).toFixed(1)} MB, ${mem.nodes} DOM elements.`);
  const out = opt('--json'); if (out) writeFileSync(out, JSON.stringify({ tasks: TASKS, lines: LINES, cases, serverPart, breakdown }, null, 2));
} catch (e) {
  if (!e.quiet) {
    console.error(e); console.error(serverLog.split('\n').slice(-30).join('\n'));
    process.exitCode = 1;
  }
} finally { cleanup(); }

function fmt(ms) { return ms == null ? '–' : `${Math.round(ms)} ms`; }

// Runs in the page. start() remembers the terminals that exist; result(n) waits for n new ones to settle.
function probe() {
  let st = null;
  const begin = (t0) => {
    if (st) st.stop = true;
    document.querySelectorAll('.xterm').forEach(x => { x.dataset.ttOld = '1'; });
    const s = st = { t0, terms: new Map(), longTasks: [], maxFrameGap: 0, stop: false };
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!s.stop) s.longTasks.push(e.duration); }).observe({ type: 'longtask' }); } catch { /* not supported */ }
    let lastFrame = performance.now();
    const tick = () => {
      if (s.stop) return;
      const now = performance.now();
      s.maxFrameGap = Math.max(s.maxFrameGap, now - lastFrame); lastFrame = now;
      document.querySelectorAll('.xterm').forEach(x => {
        if (x.dataset.ttOld) return;
        let r = s.terms.get(x);
        if (!r) { r = { first: null, full: null, last: null, text: '' }; s.terms.set(x, r); }
        const text = (x.querySelector('.term-saved-screen') || x.querySelector('.xterm-rows'))?.textContent || '';
        if (text !== r.text) { r.text = text; r.last = now; if (r.first === null && text.trim()) r.first = now; if (r.full === null && text.includes('for shortcuts')) r.full = now; }
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  begin(0);
  window.__tt = {
    start: () => begin(performance.now()),
    result: async (expect, quietMs = 1500, timeoutMs = 20000) => {
      const s = st, end = performance.now() + timeoutMs;
      for (;;) {
        const list = [...s.terms.values()];
        const ready = list.length >= expect && list.every(r => r.first !== null && r.full !== null);
        const lastChange = Math.max(0, ...list.map(r => r.last || 0));
        if ((ready && performance.now() - lastChange > quietMs) || performance.now() > end) break;
        await new Promise(r => setTimeout(r, 100));
      }
      s.stop = true;
      const list = [...s.terms.values()], rel = v => v === null ? null : v - s.t0;
      const sorted = a => a.filter(x => x !== null).sort((x, y) => x - y);
      const mid = a => { const q = sorted(a); return q.length ? q[Math.floor((q.length - 1) / 2)] : null; };
      const records = (window.taskboardTerminalDebug?.() || []).map(r => r.timing).filter(t => t && t.mount >= s.t0 - 1);
      const steps = records.map(t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'mount').map(([k, v]) => [k, v - t.mount])));
      return {
        count: list.length, first: mid(list.map(r => rel(r.first))), firstMax: Math.max(...list.map(r => rel(r.first) ?? Infinity)),
        full: mid(list.map(r => rel(r.full))), settled: Math.max(...list.map(r => rel(r.last) ?? 0)),
        maxFrameGap: s.maxFrameGap, longTaskSum: s.longTasks.reduce((a, b) => a + b, 0), longTaskMax: Math.max(0, ...s.longTasks),
        mountAfter: mid(records.map(t => t.mount - s.t0)), steps,
        snapshot: mid(records.map(t => t.snapshotDrawn ?? null).map(v => v === null ? null : v - s.t0)),
        live: mid(records.map(t => t.firstDrawn ?? null).map(v => v === null ? null : v - s.t0)),
        liveMax: Math.max(...records.map(t => (t.firstDrawn ?? Infinity) - s.t0)),
      };
    },
  };
}
