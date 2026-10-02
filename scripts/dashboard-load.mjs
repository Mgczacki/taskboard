#!/usr/bin/env node
// Measures how much work the dashboard and the server do under a load like the user's. It starts a test Taskboard
// (own port, folders and tmux socket, no controller at start) and never touches the real Taskboard.
//
//   node scripts/dashboard-load.mjs [--tasks 25] [--groups 5] [--canvas 9] [--browsers 3] [--seconds 30]
//                                   [--hooks 2] [--archived 160] [--phases busy-panel,busy-controller,quiet]
//                                   [--json file] [--md file]
//                                   [--keep] [--no-build] [--no-profile] [--chrome path]
//
// The load:
// - --archived archived tasks with a 3 KB description each (the real vault had 170 of 190 tasks archived), written
//   as task notes before the server starts. They are in every task list that the server sends.
// - --tasks tasks with a fake agent (tests/fixtures/chatty-agent.cjs) with 4000 lines of history each, in --groups
//   groups. The first group holds --canvas tasks and is the Canvas view (Grid layout, every window on one page).
// - In the busy phases, 2 of 3 Canvas tasks print a line every 150 ms, every third task elsewhere prints every 500 ms,
//   and the controller prints every 300 ms. The other tasks are idle. In the quiet phase no agent prints.
// - --hooks Claude Code hook events per second (UserPromptSubmit and Stop) on random tasks, so task states change.
// - One Canvas task waits on a question (a question card in its window and in the notification stack).
// - --browsers task browsers, started and shown in their Canvas windows (needs Google Chrome; 0 turns them off).
// - Phase busy-panel: the task panel of a task outside the Canvas is open. Phase busy-controller: the controller panel.
//
// For each phase it records, over --seconds seconds after 8 s of settling:
// - page: long tasks and long animation frames (count, longest, the scripts and the layout time of the worst ones),
//   the longest gap between two frames, main thread time by kind (CDP Performance.getMetrics), renderer CPU,
//   the JavaScript heap, WebSocket messages and bytes per second by socket, React commits and component renders
//   per second, the delay from a key press typed into a terminal to the next frame, and a CPU profile of the page
//   (self time by function, garbage collection included; --no-profile turns it off).
// - server: event loop delay (p50, p99, max), CPU, the child process and synchronous file calls per second
//   (scripts/dashboard-load-probe.mjs), and the time and size of GET /api/tasks.
// The UI is built without minifying (vite build --minify false) so that component names show; --no-build keeps web/dist.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TASKS = Number(opt('--tasks', 25)), GROUPS = Number(opt('--groups', 5)), CANVAS = Number(opt('--canvas', 9));
const BROWSERS = Number(opt('--browsers', 3)), SECONDS = Number(opt('--seconds', 30)), HOOKS = Number(opt('--hooks', 2)), ARCHIVED = Number(opt('--archived', 160));
const PHASES = opt('--phases', 'busy-panel,busy-controller,quiet').split(',');
const PROFILE = !args.includes('--no-profile');
const CHROME = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ROOT = join(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const round = (v, d = 1) => v == null ? null : +v.toFixed(d);

if (!args.includes('--no-build')) {
  console.log('Building the interface without minifying (component names stay readable)...');
  execFileSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--minify', 'false', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
}
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) { console.error('No web/dist. Run without --no-build.'); process.exit(1); }

// ---------- the test server ----------
const S = mkdtempSync(join(tmpdir(), 'tb-dash-load-'));
const SOCKET = `tbload-${process.pid}`;
for (const d of ['vault', 'tbdir', 'bin', 'work', 'claude']) mkdirSync(join(S, d), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'fixtures', 'chatty-agent.cjs'), join(S, 'bin', 'claude'));
execFileSync('chmod', ['+x', join(S, 'bin', 'claude')]);
const PLAN = join(S, 'plan.json'), PROBE = join(S, 'probe.json');
writeFileSync(PLAN, '{}');
writeFileSync(join(S, 'tbdir', 'machine.json'), JSON.stringify({ name: 'load', controller: { autostart: false, remoteControl: false }, permissions: { trustWorkspaces: false }, browser: { claude: 'task', codex: 'task', chromePath: CHROME, idleStopMinutes: 0 } }));
writeFileSync(join(S, 'tbdir', 'accounts.json'), JSON.stringify([{ id: 'claude-load', agent: 'claude', name: 'Claude load', dir: join(S, 'claude'), maxParallel: 100, created: new Date().toISOString() }]));
// archived tasks: notes in the vault, as the server writes them (store.ts), with numbers below the live tasks
const words = 'the agent reads the server code and changes the page so that the terminal shows the screen at once'.split(' ');
for (let n = 1; n <= ARCHIVED; n++) {
  const id = `task-${n}`, at = new Date(Date.now() - (ARCHIVED - n + 2) * 3600000).toISOString();
  const desc = Array.from({ length: 480 }, (_, i) => words[(i * 7 + n) % words.length]).join(' ');
  mkdirSync(join(S, 'vault', 'tasks', id, 'inbox'), { recursive: true }); mkdirSync(join(S, 'vault', 'tasks', id, 'outbox'), { recursive: true });
  writeFileSync(join(S, 'vault', 'tasks', id, 'log.md'), `# Log: Archived ${n}\n`);
  writeFileSync(join(S, 'vault', 'tasks', id + '.md'), `---\nid: ${id}\nnum: ${n}\ntitle: Archived ${n}\nagent: claude\nstatus: archived\ncwd: ${join(S, 'work')}\nfolder: ${join(S, 'work')}\nsession: ${id}\ncreated: '${at}'\nupdated: '${at}'\nstatusAt: '${at}'\nnow: Finished the change and the tests pass.\ngoal: ${desc.slice(0, 200)}\n---\n# Archived ${n}\n\n${desc}\n`);
}
writeFileSync(join(S, 'tbdir', 'counter'), String(ARCHIVED));
const PORT = await freePort(), URL_BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PATH: `${join(S, 'bin')}:${process.env.PATH}`, TASKBOARD_PORT: String(PORT), TASKBOARD_DIR: join(S, 'tbdir'), TASKBOARD_VAULT: join(S, 'vault'),
  TASKBOARD_TMUX_SOCKET: SOCKET, TASKBOARD_MACHINE_NAME: 'load', CLAUDE_CONFIG_DIR: join(S, 'claude'), CHATTY_LINES: '4000', CHATTY_PLAN: PLAN, TB_PROBE_FILE: PROBE };
const server = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(ROOT, 'scripts', 'dashboard-load-probe.mjs')).href, 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
let chrome = null;
const cleanup = () => {
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* no sessions */ }
  if (!args.includes('--keep')) rmSync(S, { recursive: true, force: true });
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const TOKEN = () => readFileSync(join(S, 'tbdir', 'token'), 'utf8').trim();
const api = async (path, body, method) => {
  const r = await fetch(URL_BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', origin: URL_BASE }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const hook = (taskId, input) => fetch(URL_BASE + '/api/hooks/claude', { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskboard-token': TOKEN() }, body: JSON.stringify({ taskId, input }) }).catch(() => {});
const screen = session => { try { return execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', '=' + session + ':'], { encoding: 'utf8' }); } catch { return ''; } };
const readProbe = () => { try { return JSON.parse(readFileSync(PROBE, 'utf8')); } catch { return null; } };

const report = { started: new Date().toISOString(), machine: { cores: cpus().length, model: cpus()[0]?.model }, load: { TASKS, GROUPS, CANVAS, BROWSERS, SECONDS, HOOKS }, phases: {} };
try {
  for (let i = 0; i < 150; i++) { try { await api('/api/tasks'); break; } catch { await sleep(200); } }
  console.log(`Test server ${URL_BASE} (folder ${S}). Starting ${TASKS} tasks...`);
  const tasks = [];
  const launched = Date.now();
  for (let i = 0; i < TASKS; i++) tasks.push(await api('/api/tasks', { title: `Load ${i + 1}`, desc: 'load test', agent: 'claude', folder: join(S, 'work'), worktree: false }));
  for (const t of tasks) for (let i = 0; i < 150 && !screen(t.session).includes('for shortcuts'); i++) await sleep(100);
  // groups: the first holds the Canvas tasks, the others share the rest
  const canvasTasks = tasks.slice(0, CANVAS), rest = tasks.slice(CANVAS);
  const groups = [await api('/api/groups', { name: 'Canvas', tasks: canvasTasks.map(t => t.id) })];
  const per = Math.ceil(rest.length / Math.max(1, GROUPS - 1));
  for (let g = 1; g < GROUPS; g++) groups.push(await api('/api/groups', { name: `Group ${g + 1}`, tasks: rest.slice((g - 1) * per, g * per).map(t => t.id) }));
  const panelTask = rest[0] || tasks[tasks.length - 1];
  const waitingTask = canvasTasks[canvasTasks.length - 1];
  // the controller is a task too: start it so its panel can open (it runs the same fake agent)
  await api('/api/controller/start', {}).catch(e => console.log('controller start:', e.message));
  for (let i = 0; i < 150 && !screen('tb-controller').includes('for shortcuts'); i++) await sleep(100);
  // the waiting question
  await hook(waitingTask.id, { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'I found two ways to fix this. Should I change the server or the page?' });
  // task browsers in Canvas windows
  const browserTasks = BROWSERS > 0 ? canvasTasks.slice(0, BROWSERS) : [];
  for (const t of browserTasks) await api(`/api/tasks/${t.id}/browser/start`, {}).catch(e => console.log(`browser of #${t.num}: ${e.message}`));

  const busyPlan = () => {
    const p = {};
    canvasTasks.forEach((t, i) => { if (i % 3 !== 2 && t !== waitingTask) p[t.id] = 150; });
    rest.forEach((t, i) => { if (i % 3 === 0) p[t.id] = 500; });
    p.controller = 300;
    return p;
  };
  // hook events: a turn starts or ends on a random task (not the waiting one)
  let hookTimer = null;
  const startHooks = () => {
    stopHooks();
    const pool = tasks.filter(t => t !== waitingTask), turn = new Map();
    if (HOOKS > 0) hookTimer = setInterval(() => {
      const t = pool[Math.floor(Math.random() * pool.length)];
      const on = !turn.get(t.id); turn.set(t.id, on);
      void hook(t.id, on ? { hook_event_name: 'UserPromptSubmit', prompt: 'next step' } : { hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: `Finished step ${Date.now() % 1000}. The tests pass.` });
    }, 1000 / HOOKS);
  };
  const stopHooks = () => { clearInterval(hookTimer); hookTimer = null; };

  // ---------- the browser ----------
  const profile = join(S, 'chrome');
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1680,1050', '--no-first-run', '--no-default-browser-check',
    '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''; chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('Chrome did not start: ' + err.slice(-500))), 20000);
  });
  const cdp = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => cdp.on('open', r));
  let seq = 0; const waiting = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => send(m, p, sessionId);
  await page('Page.enable'); await page('Runtime.enable'); await page('Performance.enable', { timeDomain: 'timeTicks' });
  await page('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 2, mobile: false });
  const evaluate = async (expression) => { const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `(${probe.toString()})()` });
  const metrics = async () => Object.fromEntries((await page('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const rendererCpu = async () => {
    try { const info = await send('SystemInfo.getProcessInfo'); return info.processInfo.filter(p => p.type === 'renderer').reduce((a, p) => a + p.cpuTime, 0); } catch { return null; }
  };
  const load = async (search, hash, prefs) => {
    await page('Page.navigate', { url: URL_BASE + '/' });
    for (let i = 0; i < 100; i++) { if (await evaluate(`location.origin === ${JSON.stringify(URL_BASE)} && document.readyState === 'complete'`).catch(() => false)) break; await sleep(100); }
    await evaluate(`(() => { localStorage.clear(); ${Object.entries(prefs).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')} })()`);
    await page('Page.navigate', { url: `${URL_BASE}/${search}#${hash}` });
    for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelectorAll('.xterm').length`).catch(() => 0) >= Math.min(CANVAS, 1)) break; await sleep(100); }
  };
  const g = groups[0].id;
  // the server reads the screen of each task for 2 minutes after its launch (launch-limit.ts): measure after that
  const steady = launched + 130000 + TASKS * 1000 - Date.now();
  if (steady > 0) { console.log(`Waiting ${Math.round(steady / 1000)} s until the launch checks of the tasks end...`); await sleep(steady); }
  const prefs = { [`tb-cv-g:${g}-layout`]: 'grid', [`tb-cv-g:${g}-perpage`]: 'off', 'tb-view': `g:${g}`, 'tb-perf': 'off' };
  for (const t of browserTasks) prefs[`tb-split-${t.id}`] = JSON.stringify({ open: true, side: 'bottom' });

  const measure = async (name) => {
    console.log(`Phase ${name}: settling 8 s, then measuring ${SECONDS} s...`);
    await sleep(8000);
    await evaluate('window.__lp.reset()');
    try { process.kill(server.pid, 'SIGUSR2'); } catch { /* gone */ }
    await sleep(2100); // a probe sample after the reset
    if (PROFILE) { await page('Profiler.enable'); await page('Profiler.setSamplingInterval', { interval: 500 }); await page('Profiler.start'); }
    const p0 = readProbe(), m0 = await metrics(), c0 = await rendererCpu(), t0 = performance.now();
    // key presses into the focused terminal, 4 each second, while measuring (the fake agent ignores them)
    await evaluate(`(() => { const t = document.querySelector('aside.drawer .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea'); t?.focus(); return !!t; })()`);
    const typing = setInterval(() => { void page('Input.dispatchKeyEvent', { type: 'keyDown', text: 'x', key: 'x', unmodifiedText: 'x' }).then(() => page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x' })).catch(() => {}); }, 250);
    // GET /api/tasks while measuring
    const fetchTimes = []; let tasksBytes = 0;
    for (let i = 0; i < 5; i++) { const s = performance.now(); const r = await fetch(URL_BASE + '/api/tasks', { headers: { origin: URL_BASE } }); tasksBytes = (await r.text()).length; fetchTimes.push(performance.now() - s); await sleep(SECONDS * 1000 / 6); }
    await sleep(Math.max(0, SECONDS * 1000 - (performance.now() - t0)));
    clearInterval(typing);
    const wall = (performance.now() - t0) / 1000;
    const p1 = readProbe(), m1 = await metrics(), c1 = await rendererCpu();
    const pageResult = await evaluate('window.__lp.read()');
    const cpuProfile = PROFILE ? summarize((await page('Profiler.stop')).profile) : null;
    const heap = await page('Runtime.getHeapUsage');
    const dm = k => (m1[k] || 0) - (m0[k] || 0);
    const calls = {};
    for (const [k, v] of Object.entries(p1?.calls || {})) { const b = p0?.calls?.[k] || { n: 0, ms: 0 }; if (v.n - b.n) calls[k] = { perSec: round((v.n - b.n) / wall, 2), msPerSec: round((v.ms - b.ms) / wall, 2), syncMsPerSec: round(((v.syncMs || 0) - (b.syncMs || 0)) / wall, 2) }; }
    const r = {
      seconds: round(wall),
      page: {
        ...pageResult,
        mainThreadPct: { task: round(dm('TaskDuration') / wall * 100), script: round(dm('ScriptDuration') / wall * 100), layout: round(dm('LayoutDuration') / wall * 100), style: round(dm('RecalcStyleDuration') / wall * 100) },
        layoutsPerSec: round(dm('LayoutCount') / wall), styleRecalcsPerSec: round(dm('RecalcStyleCount') / wall),
        rendererCpuPct: c0 != null && c1 != null ? round((c1 - c0) / wall * 100) : null,
        cpuProfile,
        heapMb: round(heap.usedSize / 1048576), arrayBuffersMb: round((heap.backingStorageSize || 0) / 1048576), domNodes: m1.Nodes, jsListeners: m1.JSEventListeners,
      },
      server: {
        cpuPct: p0 && p1 ? round(((p1.cpu.user + p1.cpu.system) - (p0.cpu.user + p0.cpu.system)) / 1000 / (p1.at - p0.at) * 100) : null,
        rssMb: p1 ? round(p1.rss / 1048576) : null,
        eventLoopDelayMs: p1?.eld, calls,
        apiTasks: { ms: fetchTimes.map(x => round(x)), bytes: tasksBytes },
      },
    };
    report.phases[name] = r;
    const top = Object.entries(r.page.renders.perSec).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`  page: long tasks ${r.page.longTasks.count} (max ${r.page.longTasks.max} ms) · LoAF ${r.page.loaf.count} (max ${r.page.loaf.max} ms) · frame gap max ${r.page.frames.maxGap} ms · main thread ${r.page.mainThreadPct.task}% · renderer CPU ${r.page.rendererCpuPct}%`);
    console.log(`  page: commits/s ${r.page.renders.commitsPerSec} · renders/s ${top} · ws ${JSON.stringify(r.page.ws)} · key delay p50 ${r.page.keys.p50} max ${r.page.keys.max} ms`);
    if (cpuProfile) console.log(`  profile: busy ${cpuProfile.busyMsPerSec} ms/s · ${Object.entries(cpuProfile.top).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  server: CPU ${r.server.cpuPct}% · event loop p99 ${r.server.eventLoopDelayMs?.p99} max ${r.server.eventLoopDelayMs?.max} ms · /api/tasks ${tasksBytes} B in ${r.server.apiTasks.ms.join('/')} ms`);
  };

  for (const phase of PHASES) {
    const busy = phase.startsWith('busy');
    writeFileSync(PLAN, JSON.stringify(busy ? busyPlan() : {}));
    if (busy) startHooks(); else stopHooks();
    await load(phase === 'busy-controller' ? '?open=controller' : phase === 'busy-panel' ? `?open=${panelTask.id}` : '', `canvas:${encodeURIComponent('g:' + g)}`, prefs);
    await measure(phase);
  }
  stopHooks();
  writeFileSync(PLAN, '{}');
} catch (e) {
  console.error(e); console.error(serverLog.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  const out = opt('--json'); if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  const md = opt('--md'); if (md) writeFileSync(md, markdown(report));
  cleanup();
}

// self time by function (name, file:line) from a CDP CPU profile, in ms per second of the profile
function summarize(profile) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), self = new Map();
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
  const secs = (profile.endTime - profile.startTime) / 1e6, out = {};
  for (const [id, us] of self) {
    const f = byId.get(id).callFrame, file = (f.url || '').split('/').pop().replace(/-[A-Za-z0-9_]{8}\.js$/, '.js');
    const k = `${f.functionName || '(anonymous)'} ${file ? `${file}:${f.lineNumber + 1}` : ''}`.trim();
    out[k] = (out[k] || 0) + us / 1000 / secs;
  }
  const top = Object.entries(out).sort((a, b) => b[1] - a[1]);
  const busy = top.filter(([k]) => k !== '(idle)').reduce((a, [, v]) => a + v, 0);
  return { busyMsPerSec: round(busy), top: Object.fromEntries(top.filter(([k]) => k !== '(idle)').slice(0, 20).map(([k, v]) => [k, round(v, 2)])) };
}

function markdown(r) {
  const rows = [['Phase', 'Long tasks', 'Longest task', 'Longest LoAF', 'Frame gap max', 'Main thread', 'Renderer CPU', 'Commits/s', 'Component renders/s', 'Key delay p50/max', 'WS events msg/s · KB/s', 'Server CPU', 'Server loop p99/max', 'Child processes/s (blocking ms/s)', 'GET /api/tasks median']];
  for (const [name, p] of Object.entries(r.phases)) {
    const ev = p.page.ws['/ws/events'] || { msgs: 0, kb: 0 };
    const kids = Object.entries(p.server.calls).filter(([k]) => /^(execFile|spawn|exec)\b/.test(k)).map(([, v]) => v);
    const renders = Object.values(p.page.renders.perSec).reduce((a, b) => a + b, 0);
    const api = [...p.server.apiTasks.ms].sort((a, b) => a - b)[Math.floor(p.server.apiTasks.ms.length / 2)];
    rows.push([name, p.page.longTasks.count, `${p.page.longTasks.max} ms`, `${p.page.loaf.max} ms`, `${p.page.frames.maxGap} ms`, `${p.page.mainThreadPct.task}%`, `${p.page.rendererCpuPct}%`, p.page.renders.commitsPerSec, round(renders), `${p.page.keys.p50}/${p.page.keys.max} ms`, `${ev.msgs} · ${ev.kb}`, `${p.server.cpuPct}%`, `${p.server.eventLoopDelayMs?.p99}/${p.server.eventLoopDelayMs?.max} ms`, `${round(kids.reduce((a, v) => a + v.perSec, 0))} (${round(kids.reduce((a, v) => a + (v.syncMsPerSec || 0), 0))})`, `${api} ms (${Math.round(p.server.apiTasks.bytes / 1024)} KB)`]);
  }
  const table = rows.map((x, i) => `| ${x.join(' | ')} |${i === 0 ? '\n|' + x.map(() => '---').join('|') + '|' : ''}`).join('\n');
  return `# Dashboard load benchmark\n\nStarted ${r.started} on ${r.machine.cores} cores (${r.machine.model}). Load: ${JSON.stringify(r.load)}.\n\n${table}\n\n\`\`\`json\n${JSON.stringify(r.phases, null, 1)}\n\`\`\`\n`;
}

// Runs in the page before the app. window.__lp.reset() starts a measurement and window.__lp.read() returns it.
function probe() {
  let s;
  const reset = () => { s = { t0: performance.now(), longTasks: [], loaf: [], gaps: [], ws: {}, commits: 0, renders: {}, keys: [] }; };
  reset();
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) s.longTasks.push(e.duration); }).observe({ type: 'longtask' }); } catch { /* not supported */ }
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) s.loaf.push({ duration: Math.round(e.duration), blocking: Math.round(e.blockingDuration), styleAndLayout: Math.round(e.styleAndLayoutDuration || 0),
        render: Math.round(e.startTime + e.duration - (e.renderStart || e.startTime + e.duration)),
        scripts: e.scripts.map(x => ({ d: Math.round(x.duration), forced: Math.round(x.forcedStyleAndLayoutDuration), invoker: x.invoker, fn: x.sourceFunctionName, src: (x.sourceURL || '').split('/').pop(), at: x.sourceCharPosition })).sort((a, b) => b.d - a.d).slice(0, 4) });
    }).observe({ type: 'long-animation-frame' });
  } catch { /* not supported */ }
  // the time from a key press to the frame after it (the event's own time stamp, so a busy main thread counts)
  addEventListener('keydown', e => { const at = e.timeStamp; requestAnimationFrame(() => setTimeout(() => s.keys.push(performance.now() - at), 0)); }, true);
  let last = performance.now();
  const tick = () => { const now = performance.now(); s.gaps.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  // WebSocket messages and bytes by path
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(url, p) {
      super(url, p);
      const path = new URL(url, location.href).pathname;
      this.addEventListener('message', e => { const w = s.ws[path] || (s.ws[path] = { msgs: 0, bytes: 0, types: {} }); w.msgs++; const d = e.data; w.bytes += typeof d === 'string' ? d.length : d.byteLength || d.size || 0;
        if (path === '/ws/events' && typeof d === 'string') { const t = (d.match(/^\{"type":"([^"]+)"/) || [])[1] || '?'; w.types[t] = (w.types[t] || 0) + 1; } });
    }
  };
  // React commits and the components that rendered in each (the React DevTools hook; a component rendered when its
  // fiber is new or has the PerformedWork flag; a subtree whose child list did not change was not visited)
  const nameOf = f => { const t = f.type; if (!t) return null; if (typeof t === 'function') return t.displayName || t.name || 'anonymous'; if (t.type) return t.type.displayName || t.type.name || 'memo'; if (t.render) return t.render.displayName || t.render.name || 'forwardRef'; return null; };
  const walk = f => {
    while (f) {
      if ([0, 1, 11, 14, 15].includes(f.tag) && (!f.alternate || (f.flags & 1))) { const n = nameOf(f); if (n) s.renders[n] = (s.renders[n] || 0) + 1; }
      if (f.child && !(f.alternate && f.alternate.child === f.child)) walk(f.child);
      f = f.sibling;
    }
  };
  let ids = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject: () => ++ids, onCommitFiberRoot: (_id, root) => { s.commits++; try { walk(root.current.child); } catch { /* changed internals */ } }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };
  const q = (a, p) => { const x = [...a].sort((m, n) => m - n); return x.length ? Math.round(x[Math.min(x.length - 1, Math.floor(p * x.length))]) : 0; };
  window.__lp = {
    reset,
    read: () => {
      const secs = (performance.now() - s.t0) / 1000, per = v => +(v / secs).toFixed(2);
      const worst = [...s.loaf].sort((a, b) => b.duration - a.duration).slice(0, 5);
      return {
        longTasks: { count: s.longTasks.length, max: Math.round(Math.max(0, ...s.longTasks)), sum: Math.round(s.longTasks.reduce((a, b) => a + b, 0)) },
        loaf: { count: s.loaf.length, max: Math.max(0, ...s.loaf.map(x => x.duration)), styleAndLayoutSum: s.loaf.reduce((a, x) => a + x.styleAndLayout, 0), worst },
        frames: { count: s.gaps.length, perSec: per(s.gaps.length), maxGap: Math.round(Math.max(0, ...s.gaps)), over50: s.gaps.filter(x => x > 50).length, over100: s.gaps.filter(x => x > 100).length },
        ws: Object.fromEntries(Object.entries(s.ws).map(([k, v]) => [k, { msgs: per(v.msgs), kb: per(v.bytes / 1024), ...(Object.keys(v.types).length ? { types: Object.fromEntries(Object.entries(v.types).map(([t, n]) => [t, per(n)])) } : {}) }])),
        renders: { commitsPerSec: per(s.commits), perSec: Object.fromEntries(Object.entries(s.renders).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, per(v)])) },
        keys: { count: s.keys.length, p50: q(s.keys, 0.5), max: Math.round(Math.max(0, ...s.keys)) },
      };
    },
  };
}
