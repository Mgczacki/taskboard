// Taskboard for macOS: a window onto the local Taskboard server (http://127.0.0.1:4317).
// The server runs on its own (launchd); this app only shows it. Quitting the app stops neither the server nor agents.
//
// What the app adds to the web dashboard:
// - a Dock badge and a menu-bar item with the number of tasks waiting on you; the menu lists them, a click opens one
// - a system-wide shortcut that shows or hides the window (default Control-Option-Command-T)
// - its own menus, which leave Taskboard's shortcuts (⌘K, ⌘S, N, C, T…) to the page
// - pop-out group windows as app windows; links to other sites open in your browser
// - a waiting page while the server does not answer, which reconnects by itself
// - window size and position kept between launches; optional opening at login
const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, shell } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const SERVER = 'http://127.0.0.1:4317';
const TOKEN_FILE = join(homedir(), '.taskboard', 'token');
const ATTN = ['needs-you', 'stopped', 'review'];   // same as web/src/api.ts ATTN
const STATUS_WORDS = { 'needs-you': 'needs you', stopped: 'stopped', review: 'review' };

if (!app.requestSingleInstanceLock()) app.exit(0);

// ---------- settings (window bounds, shortcut, open at login) in the app's own data folder ----------
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
let settings = { shortcut: 'Control+Alt+Command+T' };
function loadSettings() { try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) }; } catch { /* first launch */ } }
function saveSettings() { try { writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only */ } }

let win = null, tray = null, quitting = false, serverUp = false, waiting = [];

const sameOrigin = url => { try { return new URL(url).origin === SERVER; } catch { return false; } };
const webPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };

function guard(contents) {
  // pop-out windows of the dashboard stay in the app; everything else opens in the default browser
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1500, height: 950, backgroundColor: '#0d1117', webPreferences } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (sameOrigin(url) || url.startsWith('file:')) return;
    e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url);
  });
}
app.on('web-contents-created', (_e, contents) => guard(contents));

async function serverAnswers() {
  try { const r = await fetch(SERVER + '/', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

// Show the dashboard when the server answers, otherwise the waiting page (which is replaced as soon as it answers).
async function load() {
  if (!win) return;
  serverUp = await serverAnswers();
  if (serverUp) win.loadURL(SERVER + '/');
  else win.loadFile(join(__dirname, 'offline.html'));
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1600, height: b.height || 1000, x: b.x, y: b.y, minWidth: 700, minHeight: 450,
    title: 'Taskboard', backgroundColor: '#0d1117', show: false, webPreferences,
  });
  win.once('ready-to-show', () => { if (!settings.startHidden) win.show(); settings.startHidden = false; });
  let t = null;
  const remember = () => { clearTimeout(t); t = setTimeout(() => { if (win && !win.isMinimized() && !win.isFullScreen()) { settings.bounds = win.getBounds(); saveSettings(); } }, 500); };
  win.on('resize', remember); win.on('move', remember);
  // closing the window hides it: the Dock badge, menu-bar item and shortcut keep working
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // the server went away (restart, release) or the page failed: go to the waiting page, which retries
  win.webContents.on('did-fail-load', (_e, code, _d, url) => { if (code !== -3 && sameOrigin(url)) win.loadFile(join(__dirname, 'offline.html')); });
  win.webContents.on('render-process-gone', () => setTimeout(load, 1000));
  load();
}

function show() { if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function toggle() { if (win && win.isVisible() && win.isFocused()) win.hide(); else show(); }

// Ask the page to open a task, triage or the controller (App.tsx listens for 'taskboard:open').
function openInPage(detail) {
  show();
  if (!serverUp) return;
  win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('taskboard:open', { detail: ${JSON.stringify(detail)} }))`).catch(() => {});
}

// ---------- waiting count: Dock badge and menu bar, from the server's task list ----------
async function poll() {
  let tasks = null;
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    const r = await fetch(SERVER + '/api/tasks', { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(3000) });
    if (r.ok) tasks = await r.json();
  } catch { /* server down */ }
  const wasUp = serverUp;
  serverUp = !!tasks;
  if (serverUp && !wasUp && win && win.webContents.getURL().startsWith('file:')) load(); // came back: leave the waiting page
  waiting = (tasks || []).filter(t => ATTN.includes(t.status) && t.role !== 'controller').sort((a, b) => (b.waitMin || 0) - (a.waitMin || 0));
  const unread = (tasks || []).filter(t => t.status === 'unread' && t.role !== 'controller').length;
  app.dock?.setBadge(waiting.length ? String(waiting.length) : '');
  if (tray) {
    tray.setTitle(!serverUp ? ' off' : waiting.length ? ` ${waiting.length}` : '');
    tray.setToolTip(!serverUp ? 'Taskboard: server not answering' : `Taskboard: ${waiting.length} waiting on you · ${unread} done, unread`);
    tray.setContextMenu(trayMenu(unread));
  }
}

const accel = () => settings.shortcut.replace('Control', 'Ctrl').replace('Alt', 'Option').replace('Command', 'Cmd');
function trayMenu(unread) {
  const items = [];
  if (!serverUp) items.push({ label: 'Taskboard server is not answering', enabled: false }, { label: 'It restarts by itself if the login service is installed', enabled: false });
  else {
    items.push({ label: waiting.length ? `${waiting.length} waiting on you` : 'Nothing waiting on you', enabled: false });
    for (const t of waiting.slice(0, 12)) items.push({ label: `#${t.num} ${t.title.slice(0, 48)} — ${STATUS_WORDS[t.status] || t.status}${t.waitMin ? `, ${t.waitMin} min` : ''}`, click: () => openInPage({ task: t.id }) });
    if (unread) items.push({ label: `${unread} done, unread`, enabled: false });
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Taskboard', accelerator: settings.shortcut.replace('Command', 'Cmd'), click: show },
    { label: 'Triage (everything waiting)', enabled: serverUp, click: () => openInPage({ triage: true }) },
    { label: 'Controller', enabled: serverUp, click: () => openInPage({ controller: true }) },
    { type: 'separator' },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }); } },
    { label: `Show/hide shortcut: ${accel()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit the app (the server and agents keep running)', click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}

// ---------- menus: standard ones, without ⌘K / ⌘S / ⌘N so those reach the page ----------
function appMenu() {
  return Menu.buildFromTemplate([
    { label: 'Taskboard', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Hide Taskboard', accelerator: 'Command+H', click: () => win && win.hide() }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { label: 'Quit (the server and agents keep running)', accelerator: 'Command+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'Command+R', click: () => load() },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: 'Go', submenu: [
      { label: 'Triage', click: () => openInPage({ triage: true }) },
      { label: 'Controller', click: () => openInPage({ controller: true }) },
    ] },
    { role: 'windowMenu' },
  ]);
}

app.on('second-instance', show);
app.on('activate', show);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  loadSettings();
  // opened at login: start hidden (the badge and menu-bar item are there)
  if (app.getLoginItemSettings().wasOpenedAsHidden) settings.startHidden = true;
  Menu.setApplicationMenu(appMenu());
  const icon = nativeImage.createFromPath(join(__dirname, 'build', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => tray.popUpContextMenu());
  if (!globalShortcut.register(settings.shortcut, toggle)) console.error(`Shortcut ${settings.shortcut} is taken by another app; change "shortcut" in ${settingsFile()}`);
  createWindow();
  poll(); setInterval(poll, 3000);
});
