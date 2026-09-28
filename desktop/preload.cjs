// Runs in each Taskboard window before the page. Exposes a small, fixed API to the page (no Node access):
// - taskboardApp.isApp: the page is inside the Mac app (it then leaves room for the window buttons and adds drag areas)
// - taskboardApp.newWindow(view?): open another window (view: a canvas view such as "g:<group id>")
// It also forwards "window buttons shown/hidden" from the app to the page as a 'taskboard:chrome' event.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskboardApp', {
  isApp: true,
  newWindow: view => ipcRenderer.send('new-window', typeof view === 'string' ? view : ''),
});
ipcRenderer.on('chrome', (_e, detail) => window.dispatchEvent(new CustomEvent('taskboard:chrome', { detail })));
