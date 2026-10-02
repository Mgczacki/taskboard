// Taskboard for macOS: a window onto the local Taskboard server (http://127.0.0.1:4317).
// The server runs on its own (launchd); this app only shows it. Quitting the app stops neither the server nor agents.
//
// What the app adds to the web dashboard:
// - a Dock badge and a menu-bar item with the number of tasks waiting on you; the menu lists them, a click opens one
// - a system-wide shortcut that shows or hides the window (default Control-Option-Command-T)
// - its own menus, which leave Taskboard's shortcuts (⌘K, ⌘S, ⌘/, ⌃⌥ keys) to the page
// - pop-out group windows as app windows; links to other sites open in your browser
// - a waiting page while the server does not answer, which reconnects by itself
// - every open window (where it is, and where you are in it) comes back after quitting, a Taskboard update or a
//   restart of the Mac; opens at login by default
// - no title bar: the window buttons appear when the pointer is near the top edge, and hide again after
// - New Window (⌘N), New Window for a group, in the File menu, the Dock menu and the menu-bar item
// - window see-through while the controller view is open (Settings, off at first)
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

// A test app shows a test Taskboard (TASKBOARD_APP_SERVER, TASKBOARD_APP_TOKEN) and keeps its windows in its own data
// folder (TASKBOARD_APP_DATA). It does not register the global shortcut or the login item, so the installed app is not
// changed. TASKBOARD_APP_DEBUG_PORT opens the DevTools protocol on that port for the browser tests.
const TEST_SERVER = process.env.TASKBOARD_APP_SERVER || '';
const SERVER = TEST_SERVER || 'http://127.0.0.1:4317';
const TOKEN_FILE = process.env.TASKBOARD_APP_TOKEN || join(homedir(), '.taskboard', 'token');
if (process.env.TASKBOARD_APP_DATA) app.setPath('userData', process.env.TASKBOARD_APP_DATA);
if (process.env.TASKBOARD_APP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.TASKBOARD_APP_DEBUG_PORT);
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
const webPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: join(__dirname, 'preload.cjs') };
// every window: no title bar; the traffic-light buttons sit inside the page and are shown only near the top edge
const chrome = { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 }, backgroundColor: '#0d1117', webPreferences };
let groups = [];
let lastDockMenuKey = '';
let lastTrayMenuKey = '';

function guard(contents) {
  // pop-out windows of the dashboard stay in the app; everything else opens in the default browser
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) openWindow(url, { width: 1500, height: 950 });
    else if (/^https?:/.test(url)) shell.openExternal(url);
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

// ---------- windows, and restoring them ----------
// Every window has a target: the dashboard address it shows, including where you are in it (page, canvas view, open
// task: the page keeps these in its address). While the server does not answer, a window shows the waiting page and
// keeps its target; when the server answers again, it goes back to the target.
// The list of open windows (targets and positions) is saved in settings.windows whenever something changes, so after
// quitting, a crash, a Taskboard update or a restart of the Mac, the app reopens every window where it was.
const targets = new WeakMap();
const OFFLINE = join(__dirname, 'offline.html');
function loadInto(w, url) {
  targets.set(w, sameOrigin(url) ? url : `${SERVER}/`);
  if (serverUp) w.loadURL(targets.get(w)); else w.loadFile(OFFLINE);
}
function backOnline() { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().startsWith('file:')) w.loadURL(targets.get(w) || `${SERVER}/`); }

let saveTimer = null;
function saveSessionNow() {
  settings.windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && targets.has(w)).map(w => ({
    url: targets.get(w), bounds: w.isMaximized() || w.isFullScreen() || w.isMinimized() ? (w.__normal || w.getBounds()) : w.getBounds(),
    main: w === win, visible: w.isVisible(), fullScreen: w.isFullScreen(), maximized: w.isMaximized(),
  }));
  saveSettings();
}
function saveSession() {
  if (quitting) return; // windows closing during quit must not erase the list
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessionNow, 400);
}

function track(w) {
  const keep = () => { if (!w.isMaximized() && !w.isFullScreen() && !w.isMinimized()) w.__normal = w.getBounds(); saveSession(); };
  w.on('resize', keep); w.on('move', keep); w.on('show', saveSession); w.on('hide', saveSession);
  w.on('enter-full-screen', saveSession); w.on('leave-full-screen', saveSession); w.on('maximize', saveSession); w.on('unmaximize', saveSession);
  w.on('closed', saveSession);
  // the page moved (another view, a task opened): remember its address, not the waiting page's
  const nav = (_e, url) => { if (sameOrigin(url)) { targets.set(w, url); saveSession(); } };
  w.webContents.on('did-navigate', nav); w.webContents.on('did-navigate-in-page', nav);
  // a new page in the main frame starts opaque (window see-through, below); in-page and frame loads do not count
  w.webContents.on('did-start-navigation', (e, _url, inPlace, mainFrame) => {
    const main = e.isMainFrame ?? mainFrame, same = e.isSameDocument ?? inPlace;
    if (main && !same && !w.isDestroyed() && w.getOpacity() !== 1) w.setOpacity(1);
  });
  // the server went away (restart, release) or the page failed: waiting page, which the poll replaces when it is back
  w.webContents.on('did-fail-load', (_e, code, _d, url) => { if (code !== -3 && sameOrigin(url)) w.loadFile(OFFLINE); });
  w.webContents.on('render-process-gone', () => setTimeout(() => loadInto(w, targets.get(w) || `${SERVER}/`), 1000));
}

function place(w, s) { if (s?.maximized) w.maximize(); if (s?.fullScreen) w.setFullScreen(true); }

// The main window: closing it hides it (the Dock badge, menu-bar item and shortcut keep working).
function createWindow(saved) {
  const b = saved?.bounds || settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1600, height: b.height || 1000, x: b.x, y: b.y, minWidth: 700, minHeight: 450,
    title: 'Taskboard', show: false, ...chrome,
  });
  win.setWindowButtonVisibility(false);
  win.once('ready-to-show', () => { if (saved?.visible !== false && !settings.startHidden) { win.show(); place(win, saved); } settings.startHidden = false; });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  track(win);
  loadInto(win, saved?.url || `${SERVER}/`);
}

// Another window: the whole dashboard, or one canvas view on its own (?solo=1, like the page's pop-out windows).
// Extra windows close for real.
function openWindow(url, size, saved) {
  const from = BrowserWindow.getFocusedWindow() || win;
  const at = from ? from.getBounds() : { x: 80, y: 80, width: 1500, height: 950 };
  const b = saved?.bounds || { x: at.x + 28, y: at.y + 28, width: size?.width || at.width, height: size?.height || at.height };
  const w = new BrowserWindow({ ...b, minWidth: 600, minHeight: 400, title: 'Taskboard', show: !saved, ...chrome });
  w.setWindowButtonVisibility(false);
  if (saved) w.once('ready-to-show', () => { if (saved.visible !== false) { w.show(); place(w, saved); } });
  track(w);
  loadInto(w, url);
  return w;
}
const newWindow = view => openWindow(view ? `${SERVER}/?solo=1#canvas:${encodeURIComponent(view)}` : `${SERVER}/`);
ipcMain.on('new-window', (_e, view) => newWindow(view));
// Window see-through (Settings): the page asks for an opacity while its controller view is open, and 1 when it closes.
// A reload or a new page starts opaque again (track below).
ipcMain.on('window-opacity', (e, v) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed() && Number.isFinite(v)) w.setOpacity(Math.min(1, Math.max(0.4, v)));
});

// Reopen the windows of the last session (the main one first), or one main window the first time.
function restoreSession() {
  const saved = Array.isArray(settings.windows) ? settings.windows.filter(x => x && sameOrigin(x.url)) : [];
  createWindow(saved.find(x => x.main));
  for (const x of saved.filter(x => !x.main)) openWindow(x.url, null, x);
}

// Show the window buttons while the pointer is within 40 px of a window's top edge (or the window is full screen).
const buttonsShown = new WeakMap();
function trackButtons() {
  const p = screen.getCursorScreenPoint();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible()) continue;
    const b = w.getBounds();
    const near = w.isFullScreen() || (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + 40);
    if (buttonsShown.get(w) === near) continue;
    buttonsShown.set(w, near);
    w.setWindowButtonVisibility(near);
    w.webContents.send('chrome', { buttons: near });
  }
}

function show() { if (!win || win.isDestroyed()) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function toggle() { if (win && win.isVisible() && win.isFocused()) win.hide(); else show(); }

// Ask the page to open a task, triage, the controller or the New task dialog (App.tsx listens for 'taskboard:open'),
// in the window you are using (the main window when the call comes from the menu bar or Dock).
function openInPage(detail) {
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused && !focused.isDestroyed() ? focused : (show(), win);
  if (!serverUp || !target) return;
  target.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('taskboard:open', { detail: ${JSON.stringify(detail)} }))`).catch(() => {});
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
  if (serverUp && !wasUp) backOnline(); // came back: every window leaves the waiting page for where it was
  waiting = (tasks || []).filter(t => ATTN.includes(t.status) && t.role !== 'controller').sort((a, b) => (b.waitMin || 0) - (a.waitMin || 0));
  const unread = (tasks || []).filter(t => t.status === 'unread' && t.role !== 'controller').length;
  app.dock?.setBadge(waiting.length ? String(waiting.length) : '');
  // groups for the New Window menus (rebuilt only when they change)
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    const r = serverUp && await fetch(SERVER + '/api/groups', { headers: { 'x-taskboard-token': token }, signal: AbortSignal.timeout(3000) });
    const next = r && r.ok ? (await r.json()).map(g => ({ id: g.id, name: g.name })) : groups;
    if (JSON.stringify(next) !== JSON.stringify(groups)) { groups = next; Menu.setApplicationMenu(appMenu()); }
  } catch { /* keep the old list */ }
  // Dock menu (right-click the Dock icon): new windows and what is waiting
  const dockMenuKey = JSON.stringify([groups, waiting.map(t => [t.id, t.status, t.waitMin])]);
  if (dockMenuKey !== lastDockMenuKey) { lastDockMenuKey = dockMenuKey; app.dock?.setMenu(Menu.buildFromTemplate([
    { label: 'New Window', click: () => newWindow() },
    ...(groups.length ? [{ label: 'New Window for Group', submenu: groupItems() }] : []),
    ...(waiting.length ? [{ type: 'separator' }, ...waiting.slice(0, 8).map(t => ({ label: `#${t.num} ${t.title.slice(0, 40)} — ${STATUS_WORDS[t.status] || t.status}`, click: () => openInPage({ task: t.id }) }))] : []),
  ])); }
  if (tray) {
    tray.setTitle(!serverUp ? ' off' : waiting.length ? ` ${waiting.length}` : '');
    tray.setToolTip(!serverUp ? 'Taskboard: server not answering' : `Taskboard: ${waiting.length} waiting on you · ${unread} done, unread`);
    const trayMenuKey = JSON.stringify([serverUp, waiting.map(t => [t.id, t.status, t.waitMin]), unread, groups]);
    if (trayMenuKey !== lastTrayMenuKey) { lastTrayMenuKey = trayMenuKey; tray.setContextMenu(trayMenu(unread)); }
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
    { label: 'New Task…', enabled: serverUp, click: () => { show(); openInPage({ newTask: true }); } },
    { label: 'New Window', click: () => newWindow() },
    ...(groups.length ? [{ label: 'New Window for Group', submenu: groupItems() }] : []),
    { label: 'Triage (everything waiting)', enabled: serverUp, click: () => openInPage({ triage: true }) },
    { label: 'Controller', enabled: serverUp, click: () => openInPage({ controller: true }) },
    { label: 'Restart Taskboard Server…', enabled: serverUp, click: () => { show(); openInPage({ settings: 'server' }); } },
    { type: 'separator' },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }); } },
    { label: `Show/hide shortcut: ${accel()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit the app (the server and agents keep running)', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

const groupItems = () => groups.map(g => ({ label: g.name, click: () => newWindow('g:' + g.id) }));

// ---------- menus: standard ones, without ⌘K / ⌘S so those reach the page ----------
function appMenu() {
  return Menu.buildFromTemplate([
    { label: 'Taskboard', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Hide Taskboard', accelerator: 'Command+H', click: () => win && win.hide() }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      // the server runs under launchd, not in this app: Settings → Taskboard server restarts it (scripts/restart.mjs)
      // after a confirmation that lists the running agents, and shows its start history
      { label: 'Restart Taskboard Server…', click: () => { show(); openInPage({ settings: 'server' }); } },
      { type: 'separator' },
      { label: 'Quit (the server and agents keep running)', accelerator: 'Command+Q', click: () => app.quit() },
    ] },
    { label: 'File', submenu: [
      // menu shortcuts are handled before the page, so ⌘T works while a terminal has the keyboard
      { label: 'New Task…', accelerator: 'Command+T', click: () => openInPage({ newTask: true }) },
      { type: 'separator' },
      { label: 'New Window', accelerator: 'Command+N', click: () => newWindow() },
      { label: 'New Window for Group', enabled: groups.length > 0, submenu: groups.length ? groupItems() : [{ label: 'No groups yet', enabled: false }] },
      { label: 'New Canvas Window', accelerator: 'Shift+Command+N', click: () => newWindow('live') },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'Command+R', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) loadInto(w, targets.get(w) || `${SERVER}/`); } },
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
// save the final window list before quitting (while windows still exist), then stop saving
app.on('before-quit', () => { clearTimeout(saveTimer); quitting = false; saveSessionNow(); quitting = true; });
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
  if (!TEST_SERVER && !globalShortcut.register(settings.shortcut, toggle)) console.error(`Shortcut ${settings.shortcut} is taken by another app; change "shortcut" in ${settingsFile()}`);
  // open at login by default (the windows come back after a restart of the Mac); the menu-bar menu can turn it off
  if (!TEST_SERVER && settings.loginDefaultApplied !== true) { app.setLoginItemSettings({ openAtLogin: true }); settings.loginDefaultApplied = true; saveSettings(); }
  serverUp = false;
  serverAnswers().then(up => { serverUp = up; restoreSession(); });
  poll(); setInterval(poll, 3000);
  setInterval(trackButtons, 120);
});
