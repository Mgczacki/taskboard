#!/usr/bin/env node
// Checks in a real browser that no toolbar control of the Canvas page (and of the other pages) is covered or cut off.
// For each width, theme and state it moves the pointer to the center of each control and asks
// document.elementFromPoint what is there. A control passes when the answer is the control or an element inside it.
// It also opens the More menu of the Canvas toolbar and checks that it holds every item that left the toolbar.
//
//   node --import tsx scripts/check-toolbar-cover.mjs <Taskboard URL> [--shots <folder>] [--label before|after]
//        [--widths 1440,1280,1100,900,768,600] [--themes default,swiss] [--cdp <port>] [--report <file.json>]
//        [--pages | --only-pages] [--no-one-group]
//
// Use a test Taskboard (pnpm sandbox), never the real one: the check hides windows, turns focus mode on and off,
// changes saved Canvas settings of that page, and for the one-group state deletes all groups but the first and then
// restores them.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:/.test(a));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cdpPort = Number(opt('--cdp', 0));
const shots = opt('--shots', '');
const label = opt('--label', 'run');
const widths = opt('--widths', '1440,1280,1100,900,768,600').split(',').map(Number);
const themes = opt('--themes', 'default,swiss').split(',');
const reportFile = opt('--report', '');
// --pages: also the other pages, the triage view, the task panel and the controller drawer. --only-pages: just those.
const pages = args.includes('--pages') || args.includes('--only-pages'), onlyPages = args.includes('--only-pages');
// --no-one-group: leave the groups alone (the one-group state deletes all groups but the first, then restores them)
const oneGroup = !args.includes('--no-one-group');
const HEIGHT = Number(opt('--height', 800));
if (!url) { console.error('usage: node --import tsx scripts/check-toolbar-cover.mjs <Taskboard URL> [--shots <folder>] [--cdp <port>]'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (shots) mkdirSync(shots, { recursive: true });

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
let chrome = null, profile = null, port = cdpPort;
if (!port) {
  if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }
  profile = mkdtempSync(join(tmpdir(), 'tb-toolbar-'));
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
ws.on('message', m => {
  const d = JSON.parse(String(m));
  if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  // a dialog (for example "leave this page?") stops the page until it gets an answer: accept it and say so
  if (d.method === 'Page.javascriptDialogOpening') { console.log(`     (accepted a ${d.params.type} dialog: ${String(d.params.message).slice(0, 80)})`); ws.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); }
});
// a call that gets no answer in 30 s fails with its method, so a page that hangs does not stop the check without a word
const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; const t = setTimeout(() => { waiting.delete(id); j(new Error(`no answer in 30 s: ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 30000); waiting.set(id, d => { clearTimeout(t); r(d); }); ws.send(JSON.stringify({ id, method, params })); });
const run = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const mouse = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
// the app (--cdp) gets the same page size through the DevTools protocol; its window does not change
const setWidth = w => send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
const shot = async name => {
  if (!shots) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(shots, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
};

// In the page: the controls of the bars and whether each one is the element at its center.
// bar: a CSS selector. Each control inside it is checked. A control that is scrolled out of a bar that scrolls
// sideways (the group tabs) is not counted: the scroll arrows of that bar show it.
const PROBE = `(sel, scrolls) => {
  const out = [];
  for (const bar of document.querySelectorAll(sel)) {
    const br = bar.getBoundingClientRect();
    if (!br.width || !br.height || getComputedStyle(bar).visibility === 'hidden') continue;
    const controls = bar.querySelectorAll('button, [role="button"], [role="tab"], .gtab, a[href], input, select, .seg button');
    for (const el of controls) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('.menu, .more-pop, .wmenu')) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (scrolls && (x < br.left || x > br.right)) continue;
      // a tab at the end of the row, under the arrow that scrolls to it, is partly scrolled out
      if (scrolls && [...(bar.parentElement?.querySelectorAll(':scope > .gscroll') || [])].some(a => { const ar = a.getBoundingClientRect(); return x >= ar.left && x <= ar.right; })) continue;
      // a window that the Canvas scrolled out of sight (Columns layout) is not on screen
      const win = el.closest('.win'), stage = win?.closest('.stage-grid')?.getBoundingClientRect();
      if (win && stage) { const wr = win.getBoundingClientRect(); if (wr.left >= stage.right - 4 || wr.right <= stage.left + 4 || wr.top >= stage.bottom - 4) continue; }
      const name = (el.getAttribute('aria-label') || el.textContent || el.title || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
      const box = el.closest('.win') || bar;
      const cut = box.getBoundingClientRect();
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight || x > cut.right || y > cut.bottom) { out.push({ bar: sel, name, problem: 'cut off', x: Math.round(x), y: Math.round(y) }); continue; }
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) continue;
      const what = hit ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
      const under = hit?.closest('.drawer') ? 'drawer' : hit?.closest('.stage-grid') ? 'window grid' : 'other';
      out.push({ bar: sel, name, problem: 'covered by ' + what.slice(0, 60), under, x: Math.round(x), y: Math.round(y) });
    }
  }
  return out;
}`;

// Any page: every control on screen. A control that a scroll box scrolled out of sight is not counted, and a control
// under a layer that is meant to be on top (a drawer, a popup, triage, a toast, the sandbox banner) is counted apart.
// root: check only the controls inside it (the drawer, triage).
const PAGE_PROBE = `(root) => {
  const out = [], over = [];
  const scrolledOut = (el, x, y) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (/auto|scroll|hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY)) { const r = p.getBoundingClientRect(); if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true; } } return false; };
  const scope = root ? document.querySelector(root) : document;
  if (!scope) return { out: [{ name: root, problem: 'not on the page' }], over, count: 0 };
  let count = 0;
  for (const el of scope.querySelectorAll('button, [role="button"], [role="tab"], a[href], input:not([type="hidden"]), select, textarea, .gtab')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    // the hidden text box of a terminal (xterm.js) takes the keys and is not a control on screen
    if (el.classList.contains('xterm-helper-textarea')) continue;
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
    // a link that wraps to a second line: the center of its first line box is on the link, the center of its box may not be
    const b = el.getClientRects()[0] || r;
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    // past the edge of the window: a problem only when no box around it can scroll to it
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      let can = false;
      for (let p = el.parentElement; p && !can; p = p.parentElement) { const cs2 = getComputedStyle(p); can = (x < 0 || x >= innerWidth) ? /auto|scroll/.test(cs2.overflowX) && p.scrollWidth > p.clientWidth : /auto|scroll/.test(cs2.overflowY) && p.scrollHeight > p.clientHeight; }
      if (!can && !el.closest('.pop-menu, .menu, .gmenu, .tbs-menu')) out.push({ name: (el.getAttribute('aria-label') || el.textContent || el.title || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40), problem: 'outside the window, and nothing scrolls to it', x: Math.round(x), y: Math.round(y) });
      continue;
    }
    if (scrolledOut(el, x, y)) continue;
    count++;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit)) continue;
    const name = (el.getAttribute('aria-label') || el.textContent || el.title || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
    const what = hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\\s+/).join('.') : '');
    const layer = hit.closest('.drawer, .pop-menu, .menu, .gmenu, .toast, .server-bar, .sandbox-bar, .triage, .rtb-pop, .fm-bar, .tbs-menu, [role="dialog"], .modal');
    (layer && !layer.contains(el) ? over : out).push({ name, problem: 'covered by ' + what.slice(0, 60), x: Math.round(x), y: Math.round(y) });
  }
  return { out, over, count };
}`;
const pageProbe = root => run(`(${PAGE_PROBE})(${JSON.stringify(root || '')})`);
const probe = (sel, scrolls = false) => run(`(${PROBE})(${JSON.stringify(sel)}, ${scrolls})`);
const heights = () => run(`(() => { const h = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; }; return { toolbar: h('.canvas .ctool'), tabs: h('.canvas .gtabs'), canvasWidth: Math.round(document.querySelector('.canvas')?.getBoundingClientRect().width || 0), more: [...document.querySelectorAll('.canvas .ctool [data-k]')].filter(e => !e.closest('.more-pop')).length, overflow: document.querySelector('.canvas .ctool')?.dataset.overflow || '', theme: document.documentElement.dataset.theme }; })()`);

await send('Page.enable');
// a new URL that differs only in its hash does not load the page again, so go to a blank page first
const load = async u => { await send('Page.navigate', { url: 'about:blank' }); await sleep(100); await send('Page.navigate', { url: u }); for (let i = 0; i < 60; i++) { await sleep(150); if (await run('!!document.querySelector(".canvas .ctool, .app")').catch(() => false)) break; } await sleep(900); };
const base = new URL(url); base.hash = ''; base.search = '';
const setLs = (k, v) => run(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
const delLs = k => run(`localStorage.removeItem(${JSON.stringify(k)})`);
// a toolbar control by its text: in the toolbar, or in the More menu after it opens
const clickTool = text => run(`(async () => {
  const find = root => [...(root?.querySelectorAll('button') || [])].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}));
  let b = find(document.querySelector('.canvas .ctool'));
  if (b && !b.closest('.more-pop')) { b.click(); return 'toolbar'; }
  const more = document.querySelector('.canvas .ctool .ct-more > button');
  if (!more) return null;
  if (!document.querySelector('.more-pop')) { more.click(); await new Promise(r => setTimeout(r, 150)); }
  b = find(document.querySelector('.more-pop')); if (!b) return null; b.click(); return 'more';
})()`);
// the hide button of the first window: in its header, or in the menu of a narrow header
const hideFirst = () => run(`(async () => {
  const win = document.querySelector('.stage-grid .win'); if (!win) return false;
  let b = win.querySelector('[aria-label="Hide from this view"]');
  if (!b) { win.querySelector('.wh .wmore')?.click(); await new Promise(r => setTimeout(r, 150)); b = document.querySelector('.wmenu [aria-label="Hide from this view"]'); }
  b?.click(); return !!b;
})()`);
// the More menu holds each item that left the toolbar, and each of its controls is reachable
const checkMore = () => run(`(async () => {
  const tool = document.querySelector('.canvas .ctool'); const more = tool?.querySelector('.ct-more > button');
  const want = (tool?.dataset.overflow || '').split(',').filter(Boolean);
  if (!more) return { want, ok: !want.length, missing: want, problems: [] };
  more.click(); await new Promise(r => setTimeout(r, 200));
  const pop = document.querySelector('.more-pop');
  const have = [...(pop?.querySelectorAll('[data-k]') || [])].map(e => e.dataset.k);
  const problems = [];
  for (const el of pop?.querySelectorAll('button') || []) {
    const r = el.getBoundingClientRect(); if (!r.width || el.disabled) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    if (!(hit === el || el.contains(hit))) problems.push(el.textContent.trim().slice(0, 30) + (y > innerHeight ? ' (below the window)' : ' covered'));
  }
  const focusFirst = pop && document.activeElement && pop.contains(document.activeElement);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pop?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  return { want, have, missing: want.filter(k => !have.includes(k)), problems, focusFirst, closed: !document.querySelector('.more-pop') };
})()`);

const results = [];
let failed = 0;
function record(r) {
  results.push(r);
  const bad = r.problems.filter(p => p.under !== 'drawer');
  const drawer = r.problems.length - bad.length;
  const more = r.more && (r.more.missing?.length || r.more.problems?.length) ? ` · More menu: missing ${r.more.missing.join(',') || '-'}, ${r.more.problems.join('; ') || 'reachable'}` : '';
  if (bad.length || more) failed++;
  console.log(`${bad.length || more ? 'FAIL' : 'ok  '} ${r.theme}${r.heights?.theme && r.heights.theme !== r.theme ? '(page: ' + r.heights.theme + ')' : ''} ${r.width}px ${r.state}: toolbar ${r.heights?.toolbar ?? '-'} px, tabs ${r.heights?.tabs ?? '-'} px${r.heights?.overflow ? `, in More: ${r.heights.overflow}` : ''}${drawer ? `, ${drawer} under the drawer` : ''}${more}`);
  for (const p of bad) console.log(`     ${p.name} at ${p.x},${p.y}: ${p.problem}`);
}
const BARS = '.canvas .ctool';
async function state(theme, width, name, { solo = false, focus = false, shotIt = false } = {}) {
  // the bar that says the server is away covers the top of the page for a moment after a reload
  await run(`(async () => { for (let i = 0; i < 30 && document.querySelector('.server-bar.away'); i++) await new Promise(r => setTimeout(r, 100)); })()`);
  const heightsNow = await heights();
  let problems = [...await probe(BARS), ...(solo ? [] : await probe('.canvas .gtabs', true)), ...await probe('.stage-grid .win .wh')];
  if (focus) {
    // focus mode: the bars show while the pointer is at the top edge; move the pointer to each control as a person would
    problems = [];
    await mouse(400, 2); await sleep(200);
    const list = await run(`[...document.querySelectorAll('.canvas .ctool button, .canvas .gtabs .gtab')].map(b => { const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0, 30), r.left + r.width / 2, r.top + r.height / 2, r.width]; })`);
    for (const [n, x, y, w] of list) {
      if (!w) continue;
      await mouse(400, 2); await sleep(120);
      // the control's place while the bars show
      const at = await run(`(() => { const b = [...document.querySelectorAll('.canvas .ctool button, .canvas .gtabs .gtab')].find(e => e.textContent.trim().slice(0, 30) === ${JSON.stringify(n)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width]; })()`);
      if (!at || !at[2] || at[0] > width || at[0] < 0) continue;
      // a tab under a scroll arrow of the tab row is partly scrolled out
      if (await run(`[...document.querySelectorAll('.gscroll')].some(a => { const r = a.getBoundingClientRect(); return ${at[0]} >= r.left && ${at[0]} <= r.right && ${at[1]} >= r.top && ${at[1]} <= r.bottom; })`)) continue;
      await mouse(at[0], at[1]); await sleep(160);
      const ok = await run(`(() => { const b = [...document.querySelectorAll('.canvas .ctool button, .canvas .gtabs .gtab')].find(e => e.textContent.trim().slice(0, 30) === ${JSON.stringify(n)}); const h = document.elementFromPoint(${at[0]}, ${at[1]}); return b && h && (b === h || b.contains(h)) ? '' : (h ? h.tagName.toLowerCase() + '.' + String(h.className).trim().split(/\\s+/).join('.') : 'nothing'); })()`);
      if (ok) problems.push({ name: n, problem: 'hidden when the pointer moves to it; the point shows ' + ok.slice(0, 50), x: Math.round(at[0]), y: Math.round(at[1]) });
    }
    await mouse(400, 2); await sleep(150);
  }
  const more = !focus && !solo ? await checkMore() : null;
  if (shotIt) await shot(`${theme}-${width}-${name}`);
  record({ theme, width, state: name, heights: { ...heightsNow }, problems, more });
}

const groupsBefore = await (async () => { await load(`${base}#canvas:live`); return run(`fetch('/api/groups').then(r => r.json())`).catch(() => []); })();
try {
  for (const theme of onlyPages ? [] : themes) {
    await setLs('tb-theme', theme);
    for (const width of widths) {
      await setWidth(width);
      for (const k of ['tb-cv-live-perpage', 'tb-cv-live-page', 'tb-cv-live-layout']) await delLs(k);
      await setLs('tb-focus', 'false');
      await load(`${base}#canvas:live`);
      if (await run(`!!document.querySelector('.canvas.focus-mode')`)) { await clickTool('Exit'); await run(`document.querySelector('.fm-bar .btn')?.click()`); await sleep(200); }
      await state(theme, width, '8 groups, all live tasks', { shotIt: true });
      // the pager: 2 windows on each page
      await setLs('tb-cv-live-perpage', '2'); await load(`${base}#canvas:live`);
      await state(theme, width, 'pager', { shotIt: true });
      // the hidden windows link
      await hideFirst(); await sleep(250);
      await state(theme, width, 'pager and Show hidden');
      // the controller drawer open over the Canvas
      await run(`(async () => { document.querySelector('.ctl-item')?.click(); for (let i = 0; i < 30 && !document.querySelector('.drawer'); i++) await new Promise(r => setTimeout(r, 100)); })()`); await sleep(500);
      await state(theme, width, 'controller drawer open', { shotIt: true });
      await run(`(async () => { const d = document.querySelector('.drawer'); d?.querySelector('[title^="Close"], .dr-close, button[aria-label="Close"]')?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
      // focus mode, with the bars shown from the top edge
      await load(`${base}#canvas:live`);
      await clickTool('Focus mode'); await sleep(300);
      await state(theme, width, 'focus mode', { focus: true });
      await mouse(400, 2); await sleep(200); await shot(`${theme}-${width}-focus-mode`);
      await run(`document.querySelector('.fm-bar .btn')?.click()`); await sleep(200);
      // a pop-out Canvas window has no tabs: its toolbar is at the top edge
      await load(`${base}?solo=1#canvas:live`);
      await state(theme, width, 'pop-out window', { solo: true });
      await delLs('tb-cv-live-perpage');
    }
  }
  if (pages) {
    const PAGES = ['list', 'board', 'graph', 'waiting', 'inbox', 'permits', 'accounts', 'stats', 'settings'];
    for (const theme of themes) {
      await setLs('tb-theme', theme);
      for (const width of widths) {
        await setWidth(width);
        const page = async (name, root, shotIt) => {
          await run(`(async () => { for (let i = 0; i < 30 && document.querySelector('.server-bar.away'); i++) await new Promise(r => setTimeout(r, 100)); })()`);
          const r = await pageProbe(root);
          if (shotIt) await shot(`${theme}-${width}-page-${name.replace(/[^a-z0-9]+/gi, '-')}`);
          record({ theme, width, state: `${name} (${r.count} controls${r.over.length ? `, ${r.over.length} under a layer on top` : ''})`, problems: r.out });
        };
        for (const p of PAGES) { await load(`${base}#${p}`); await page(`page ${p}`, '', width === 600 || width === 1100); }
        // triage: everything waiting on you, over the page
        await load(`${base}#list`);
        await run(`dispatchEvent(new CustomEvent('taskboard:open', { detail: { triage: true } }))`); await sleep(600);
        await page('triage', '.triage', width === 600);
        // the task panel of a task, and its header
        await load(`${base}#canvas:live`);
        await run(`(async () => { const w = document.querySelector('.stage-grid .win'); let b = w?.querySelector('.wh button[title="Task panel"]'); if (!b) { w?.querySelector('.wh .wmore')?.click(); await new Promise(r => setTimeout(r, 150)); b = document.querySelector('.wmenu button[title="Task panel"]'); } b?.click(); })()`); await sleep(700);
        await page('task panel', '.drawer', width === 600);
        // the controller drawer and its bar
        await load(`${base}#list`);
        await run(`(async () => { dispatchEvent(new CustomEvent('taskboard:open', { detail: { controller: true } })); for (let i = 0; i < 30 && !document.querySelector('.drawer'); i++) await new Promise(r => setTimeout(r, 100)); })()`); await sleep(700);
        await page('controller drawer', '.drawer', width === 600);
      }
    }
  }
  // one group: the tab strip with one group tab
  if (groupsBefore.length > 1 && !onlyPages && oneGroup) {
    await setLs('tb-theme', themes[0]);
    for (const g of groupsBefore.slice(1)) await run(`fetch('/api/groups/${g.id}', { method: 'DELETE' }).then(r => r.status)`);
    for (const width of widths) {
      await setWidth(width); await load(`${base}#canvas:g:${groupsBefore[0].id}`);
      await state(themes[0], width, '1 group', { shotIt: width === widths[widths.length - 1] });
    }
  }
} finally {
  if (groupsBefore.length > 1 && !onlyPages && oneGroup) for (const g of groupsBefore.slice(1)) await run(`fetch('/api/groups/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(g)}) }).then(r => r.status)`).catch(() => {});
  await setLs('tb-theme', 'default').catch(() => {});
  ws.close(); cleanup();
}
if (reportFile) writeFileSync(reportFile, JSON.stringify(results, null, 1));
console.log(failed ? `\n${failed} of ${results.length} states have covered or cut-off controls.` : `\nAll ${results.length} states pass.`);
process.exit(failed ? 1 : 0);
