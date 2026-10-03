// Runs in each Taskboard window before the page. Exposes a small, fixed API to the page (no Node access):
// - taskboardApp.isApp: the page is inside the Mac app (it then leaves room for the window buttons and adds drag areas)
// - taskboardApp.newWindow(view?): open another window (view: a canvas view such as "g:<group id>")
// - taskboardApp.windowOpacity, setWindowOpacity(v): window see-through for the controller view (v from 0.4 to 1)
// - taskboardApp.doctor(), startServer(): only for the waiting page (offline.html); the app refuses other pages.
// It also forwards "window buttons shown/hidden" from the app to the page as a 'taskboard:chrome' event.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskboardApp', {
  isApp: true,
  newWindow: view => ipcRenderer.send('new-window', typeof view === 'string' ? view : ''),
  // BrowserWindow.setOpacity works on macOS and Windows and does nothing on Linux; the page hides the option there
  windowOpacity: process.platform === 'darwin' || process.platform === 'win32',
  setWindowOpacity: v => ipcRenderer.send('window-opacity', Number(v)),
  doctor: () => ipcRenderer.invoke('doctor'),
  startServer: () => ipcRenderer.invoke('start-server'),
});
ipcRenderer.on('chrome', (_e, detail) => window.dispatchEvent(new CustomEvent('taskboard:chrome', { detail })));
