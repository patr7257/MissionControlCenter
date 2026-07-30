// Preload for the Mission Control Center window. Runs with contextIsolation on,
// so it uses contextBridge to expose a tiny, explicit API to the dashboard page:
// only the update-install trigger, nothing else. CommonJS (.cjs) because the
// preload runs in a sandboxed context, not as an ES module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cmcUpdate', {
  // Ask the main process to download the newest release MSI via the gh CLI and
  // launch the installer (the app then quits so the upgrade can proceed).
  install: () => ipcRenderer.invoke('cmc:install-update'),
});

// Mouse back/forward side buttons. Windows delivers them as WM_APPCOMMAND, which
// Electron raises as `app-command` in the MAIN process only: the renderer never
// sees a mouse event for them, so the page cannot handle them without this
// bridge. public/shortcuts.js subscribes and moves through the app's own history.
contextBridge.exposeInMainWorld('cmcNav', {
  onNav: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('cmc:nav', (_event, direction) => {
      if (direction === 'back' || direction === 'forward') cb(direction);
    });
  },
});
