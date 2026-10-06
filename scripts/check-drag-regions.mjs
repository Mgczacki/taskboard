#!/usr/bin/env node
// Checks the window drag area of the app (web/src/dragRegions.ts) in a real browser, for the views and drawer states
// near the top edge. It fails when a control within 40 px of the top is not no-drag or lies in the drag area.
//
//   node --import tsx scripts/check-drag-regions.mjs <Taskboard URL>            headless Chrome, the page acts as the app
//   node --import tsx scripts/check-drag-regions.mjs <Taskboard URL> --cdp 9396 a running test app (TASKBOARD_APP_DEBUG_PORT)
//   ... --browser-window                                                         only the pop-out browser window
//   ... --document-window                                                        only the HTML document window in the URL
//
// Use a test Taskboard (pnpm sandbox), never the real one: the check opens the controller and changes saved view
// settings of that page (header folded or open, transparency).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { dragBoxAt, dragBoxes, dragRegionReport, headerRegionReport } from '../web/src/dragRegions.ts';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:/.test(a));
const cdpPort = args.includes('--cdp') ? Number(args[args.indexOf('--cdp') + 1]) : 0;
const onlyBrowserWindow = args.includes('--browser-window');
const onlyDocumentWindow = args.includes('--document-window');
if (!url) { console.error('usage: node --import tsx scripts/check-drag-regions.mjs <Taskboard URL> [--cdp <port>]'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
let chrome = null, profile = null, port = cdpPort;
if (!port) {
  if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }
  profile = mkdtempSync(join(tmpdir(), 'tb-drag-'));
  port = 9500 + Math.floor(Math.random() * 400);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
}
const cleanup = () => { try { chrome?.kill(); } catch { /* gone */ } if (profile) setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300); };

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && (cdpPort ? t.url.startsWith(new URL(url).origin) : true));
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`no page on the DevTools port ${port}`);
}
const ws = new WebSocket(await target());
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let seq = 0; const waiting = new Map();
ws.on('message', m => { const d = JSON.parse(String(m)); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

// tsx may wrap named functions in __name(); the page gets a no-op copy so the source runs there
const report = (px = 40) => `(() => { var __name = f => f; return (${dragRegionReport.toString()})((${dragBoxAt.toString()}), (${dragBoxes.toString()}), ${px}); })()`;
const header = `(() => { var __name = f => f; return (${headerRegionReport.toString()})((${dragBoxAt.toString()}), (${dragBoxes.toString()}), '.bw-window-h', '.bw-window > :last-child'); })()`;
const width = w => cdpPort ? Promise.resolve() : send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
if (!cdpPort) await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.taskboardApp = { isApp: true, newWindow() {} };' });
const load = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 60; i++) { await sleep(150); if (await run('!!document.querySelector(".app, .bw-window")').catch(() => false)) break; } await sleep(600); };
const openCtl = () => run(`(async () => { if (!document.querySelector('.drawer.ctl-view')) document.querySelector('.ctl-item')?.click(); for (let i = 0; i < 40 && !document.querySelector('.drawer.ctl-view'); i++) await new Promise(r => setTimeout(r, 100)); return !!document.querySelector('.drawer.ctl-view'); })()`);
const setLs = (k, v) => run(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);

const states = [];
let failed = 0;
async function check(name, px = 40) {
  await sleep(350);
  const r = await run(report(px));
  const inApp = await run('document.body.classList.contains("in-app")');
  states.push(name);
  if (!inApp) { failed++; console.log(`FAIL ${name}: the page did not mark itself as the app (body.in-app)`); return; }
  if (r.problems.length) { failed++; console.log(`FAIL ${name}: ${new Set(r.problems.map(p => p.what + p.rect)).size} of ${r.controls} controls near the top`); for (const p of r.problems) console.log(`  ${p.what} [${p.rect}] app-region ${p.region}: ${p.problem}`); }
  else console.log(`ok   ${name}: ${r.controls} controls near the top, ${r.boxes} region boxes`);
}

try {
  const base = new URL(url); base.hash = ''; base.search = '';
  for (const w of cdpPort ? [0] : [1600, 900]) {
    await width(w);
    const at = w ? ` at ${w} px` : '';
    if (!onlyBrowserWindow && !onlyDocumentWindow) {
      for (const view of ['list', 'board', 'graph', 'canvas:live', 'waiting', 'settings']) {
        await load(`${base}#${view}`); await check(`${view}${at}`);
      }
      // the controller drawer over each view, folded and open, with and without the see-through terminal
      for (const view of ['list', 'board', 'canvas:live', 'settings']) {
        for (const [head, glass] of [['collapsed', 0], ['open', 0], ['collapsed', 85], ['open', 95]]) {
          await setLs('tb-ctl-header', head); await setLs('tb-ctl-see', JSON.stringify({ see: glass, blur: 10 }));
          await load(`${base}#${view}`);
          if (!(await openCtl())) { failed++; console.log(`FAIL ${view}${at}: the controller drawer did not open`); continue; }
          await check(`controller drawer over ${view}, header ${head}, see-through ${glass}%${at}`);
          if (head === 'collapsed' && glass) { await run(`document.querySelector('.dr-bar .glass-btn')?.click()`); await check(`see-through popover over ${view}${at}`); }
        }
      }
      // a pop-out canvas window has no top bar: its own toolbar is at the top edge
      await load(`${base}?solo=1#canvas:live`); await check(`pop-out canvas window${at}`);
    }
    // Pop-out windows have no native title bar. Their shared header moves the window, and the view gets every click.
    // The browser toolbars are below the header, so their controls are checked down to 160 px.
    if (!onlyDocumentWindow) {
      await load(`${base}?browser=template&title=Template%20browser&sub=check`); await check(`pop-out browser window${at}`, 160);
      const h = await run(header);
      states.push(`pop-out browser window header${at}`);
      for (const i of h.items) console.log(`     ${i.what}: ${i.region}${i.control ? ' (control)' : ''}`);
      if (h.problems.length) { failed++; console.log(`FAIL pop-out browser window header${at}:`); for (const p of h.problems) console.log(`  ${p}`); }
      else console.log(`ok   pop-out browser window header${at}: header drag, ${h.samples} points checked`);
    }
    if (onlyDocumentWindow) {
      await load(url); await check(`HTML document window${at}`, 100);
      const h = await run(header);
      const d = await run(`(() => { const h = document.querySelector('.bw-window-h'), f = document.querySelector('.document-window-frame'); return { height: h?.getBoundingClientRect().height, frame: !!f, sandbox: f?.getAttribute('sandbox') }; })()`);
      states.push(`HTML document window header${at}`);
      const problems = [...h.problems];
      if (d.height < 44) problems.push(`header height is ${d.height} px`);
      if (!d.frame) problems.push('no document iframe');
      if (d.sandbox !== 'allow-scripts allow-popups') problems.push(`iframe sandbox is ${d.sandbox}`);
      if (problems.length) { failed++; console.log(`FAIL HTML document window header${at}:`); for (const p of problems) console.log(`  ${p}`); }
      else console.log(`ok   HTML document window header${at}: ${d.height} px header drag, ${h.samples} points checked`);
    }
  }
  await setLs('tb-ctl-header', 'collapsed'); await setLs('tb-ctl-see', JSON.stringify({ see: 0 }));
} finally { ws.close(); cleanup(); }
console.log(failed ? `\n${failed} of ${states.length} states have controls in the drag area.` : `\nAll ${states.length} states pass.`);
process.exit(failed ? 1 : 0);
