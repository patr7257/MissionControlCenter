// Mission Control Center desktop shell (Electron main process).
// Wraps the existing zero-dependency backend unchanged: ensures the feeder
// hooks are installed, ensures the server is running as a detached process
// (so it survives closing this window, same model as start.mjs), then shows
// the dashboard in a native window instead of a browser tab.

import { app, BrowserWindow, Menu, dialog, shell, Notification, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findNewerRelease, downloadReleaseMsi, RELEASES_URL } from './update-check.mjs';
import { installerSpawnArgs } from './installer-cmd.mjs';
import { ensureServerReady, STARTUP_TIMEOUT_MS, PROBE_TIMEOUT_MS } from './server-ready.mjs';

const DEFAULT_PORT = 4317;
const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const DEBUG_LOG = path.join(DATA_DIR, 'desktop-debug.log');

// The dashboard URL follows the lock file (a running server may sit on a
// non-default port), falling back to the default while nothing is running yet.
let dashUrl = `http://127.0.0.1:${DEFAULT_PORT}`;

// Packaged: backend ships under resources/backend (see electron-builder.yml).
// Dev: the backend is simply the parent folder of desktop/.
const BACKEND = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.join(app.getAppPath(), '..');

let mainWin = null;
// Set on before-quit so the SSE notification loop stops retrying during shutdown.
let quitting = false;

// One append-only line per notable shell event. The startup failure this exists
// for is intermittent, so without a record on disk the next occurrence is just
// as undiagnosable as the last one. Best effort, never throws: a shell that
// cannot log must still start.
function logDesktop(message) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging is best effort
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not signalable
  }
}

function runningLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock && lock.pid && pidAlive(lock.pid)) return lock;
  } catch {
    // not running
  }
  return null;
}

// Run a backend .mjs script with the bundled Electron binary acting as plain
// Node (no Chromium), so the installed app needs no system Node.
function runAsNode(script, args = [], opts = {}) {
  return spawn(process.execPath, [script, ...args], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    ...opts,
  });
}

async function ensureHooks() {
  try {
    if (app.isPackaged) {
      // install-hooks.mjs honours this override so the recorded hook command
      // points at the shipped shim wrapper instead of "node <repo path>".
      process.env.CMC_HOOK_COMMAND = `"${path.join(BACKEND, 'send-event.mjs.cmd')}"`;
      // Same idea for the statusLine command, which is the ONLY local source of
      // the 5h/7d rate-limit windows and the true context-window percentage.
      // Without this a packaged install leaves settings.statusLine pointing at
      // "node <path>", so the quota bars and the context rings stay blank.
      process.env.CMC_STATUSLINE_COMMAND = `"${path.join(BACKEND, 'statusline-feed.mjs.cmd')}"`;
    }
    const mod = await import(pathToFileURL(path.join(BACKEND, 'install-hooks.mjs')).href);
    return mod.addHooks();
  } catch (e) {
    console.error('mission-control desktop: hook install failed:', e.message);
    return 0;
  }
}

// The raw lock, WITHOUT the pid-liveness test runningLock() applies. For the
// startup decision the lock is only a hint about which port to try: whether
// anything serves is settled by an HTTP answer, never by a pid. See
// server-ready.mjs for why (recycled pids used to stop the backend starting at
// all, and the app then failed on an 8 second dead end).
function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function startBackend() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  runAsNode(path.join(BACKEND, 'server.mjs'), ['--port', String(DEFAULT_PORT)], {
    detached: true,
  }).unref();
}

async function probeServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Probe, spawn if needed, wait until it answers. Sets dashUrl on success, so the
// window and the SSE notification subscriber follow the port that really served.
async function ensureDashboard() {
  const result = await ensureServerReady({
    readLock: readLockFile,
    probe: probeServer,
    spawnServer: startBackend,
    defaultPort: DEFAULT_PORT,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  if (result.ok) dashUrl = `http://127.0.0.1:${result.port}`;
  return result;
}

// Full teardown: stop the detached server (via its lock file) and remove the
// Claude Code hooks, then quit. Runs once per session (guarded) so the window-X
// path, the menu action, and the menu Quit never trigger it twice or race. Sets
// `quitting` so the SSE notification loop stops retrying during shutdown. Always
// quits even if stop.mjs fails, so the app never hangs on close.
let tearingDown = false;

// The teardown itself, awaitable, WITHOUT quitting. The update path needs to
// know the detached server is really gone before it hands over to msiexec, and
// a fire-and-forget callback cannot express that.
function runTeardown() {
  return new Promise((resolve) => {
    quitting = true;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const child = runAsNode(path.join(BACKEND, 'stop.mjs'));
      child.on('close', done);
      child.on('error', done);
    } catch {
      done();
    }
    // Never hang the app on a wedged stop.mjs.
    setTimeout(done, 8000);
  });
}

// Polls until nothing is serving the dashboard port any more, so we know the
// detached backend process has actually exited rather than merely been asked to.
async function waitForServerGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // Remember the port while the lock still exists: once it is removed we would
  // otherwise lose track of which port to prove is silent.
  const startLock = runningLock();
  const port = (startLock && startLock.port) || DEFAULT_PORT;
  while (Date.now() < deadline) {
    if (!runningLock()) {
      try {
        await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(600) });
        // Something still answers on that port, so keep waiting.
      } catch {
        return true; // no live lock and nothing listening: the backend is gone
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function stopServerAndRemoveHooks() {
  if (tearingDown) return;
  tearingDown = true;
  runTeardown().then(() => app.quit());
}

// Hands the MSI to a detached helper that waits a few seconds BEFORE starting
// msiexec, so this app (and the backend process it spawned) are fully gone by
// the time the installer inventories locked files. The command shape, and why it
// needs windowsVerbatimArguments, live in desktop/installer-cmd.mjs.
//
// Returns false when there is nothing installable, so the caller can fall back to
// the releases page instead of quitting into a dead end. The existsSync check is
// the cheap guard for "the download vanished between fetching and launching":
// msiexec's own failure is a modal dialog we cannot observe from here.
function launchInstaller(msiPath) {
  try {
    if (!msiPath || !fs.existsSync(msiPath)) return false;
    const { file, args, options } = installerSpawnArgs(msiPath);
    spawn(file, args, options).unref();
    return true;
  } catch {
    return false;
  }
}

// Download the MSI for `tag` via the gh CLI, then launch it and quit. On any
// failure, fall back to the manual releases page rather than leaving the user
// stuck after they opted in.
async function downloadAndInstall(tag) {
  const msi = await downloadReleaseMsi(tag);

  // Download failure: nothing has been torn down yet, so the app stays fully
  // usable and we just offer the manual page.
  if (!msi) {
    const { response } = await dialog.showMessageBox(mainWin, {
      type: 'error',
      message: 'Could not download the update automatically.',
      detail: 'The gh CLI may be missing, offline, or not authenticated. You can download the MSI by hand from the releases page.',
      buttons: ['Open releases page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(RELEASES_URL);
    return false;
  }

  // Shut the backend down and WAIT for it before the installer is scheduled.
  // Order matters: tear down, confirm it is gone, only then hand over to
  // msiexec. Doing it the other way round is what produced the "Files in Use"
  // dialog and left an old backend serving the new UI.
  tearingDown = true;
  await runTeardown();
  await waitForServerGone(10000);

  if (!launchInstaller(msi)) {
    // We have already stopped the backend and removed the hooks, so the window
    // behind this dialog is a shell with nothing serving it. Quitting is the
    // honest outcome; pretending the app still works would be worse.
    await dialog.showMessageBox(mainWin, {
      type: 'error',
      message: 'Could not start the installer.',
      detail:
        'Mission Control Center has already shut its backend down to make way for the upgrade, so it will close now. The MSI was downloaded to:\n\n' +
        msi +
        '\n\nRun it by hand to finish updating.',
      buttons: ['Close'],
    });
    app.quit();
    return false;
  }

  app.quit();
  return true;
}

async function checkUpdatesInteractive() {
  const tag = await findNewerRelease(app.getVersion());
  if (!tag) {
    dialog.showMessageBox(mainWin, {
      type: 'info',
      message: `You are on the latest version (${app.getVersion()}).`,
      detail: 'Checked GitHub releases via the gh CLI. If gh is missing or offline, no newer release could be seen.',
    });
    return;
  }
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'info',
    message: `Update available: ${tag}`,
    detail: 'Download and install now (the app closes while the installer runs, then reopens), or open the releases page to do it by hand.',
    buttons: ['Download and install', 'Open releases page', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) await downloadAndInstall(tag);
  else if (response === 1) shell.openExternal(RELEASES_URL);
}

async function notifyUpdateBanner(win) {
  try {
    const tag = await findNewerRelease(app.getVersion());
    if (!tag || win.isDestroyed()) return;
    const js = `(function () {
      if (document.getElementById('cmc-update-banner')) return;
      var b = document.createElement('div');
      b.id = 'cmc-update-banner';
      b.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;' +
        'background:#1f2937;color:#f9fafb;padding:10px 14px;border-radius:8px;' +
        'font:13px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);' +
        'display:flex;gap:12px;align-items:center;';
      var text = document.createElement('span');
      text.textContent = 'Update available: ${tag}';
      var install = document.createElement('button');
      install.textContent = 'Download & install';
      install.style.cssText = 'cursor:pointer;border:0;border-radius:6px;' +
        'background:#2563eb;color:#fff;padding:6px 10px;font:13px system-ui,sans-serif;';
      install.onclick = function () {
        if (!window.cmcUpdate) return;
        install.textContent = 'Downloading...';
        install.disabled = true;
        install.style.opacity = '.7';
        window.cmcUpdate.install();
      };
      var link = document.createElement('a');
      link.href = '${RELEASES_URL}';
      link.target = '_blank';
      link.textContent = 'Open releases';
      link.style.color = '#93c5fd';
      var close = document.createElement('span');
      close.textContent = 'x';
      close.style.cssText = 'cursor:pointer;opacity:.7;padding:0 4px;';
      close.onclick = function () { b.remove(); };
      b.appendChild(text); b.appendChild(install); b.appendChild(link); b.appendChild(close);
      document.body.appendChild(b);
    })();`;
    win.webContents.executeJavaScript(js).catch(() => {});
  } catch {
    // update notice is best effort, never bother the user with failures
  }
}

// ---------------------------------------------------------------------------
// Native desktop notifications
// ---------------------------------------------------------------------------
// Only these session statuses are worth interrupting the user for: the two that
// mean "this session is blocked waiting on you". This lives only in the desktop
// shell; the zero-dependency server just broadcasts status on its SSE stream.
const ALERT_STATUSES = new Set(['needs-permission', 'awaiting']);
// sessionId -> the last status we observed, so one state change is one toast and
// a stream of same-status events does not re-fire.
const lastSeenStatus = new Map();

function postFocus(port, sessionId) {
  fetch(`http://127.0.0.1:${port}/focus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}

// Decide whether a session update warrants a toast, and raise it. `seedOnly`
// records the status without notifying: used for the initial snapshot (and after
// a reconnect) so pre-existing blocked sessions do not all fire at once.
function maybeNotify(port, s, seedOnly) {
  if (!s || !s.id) return;
  const prev = lastSeenStatus.get(s.id);
  lastSeenStatus.set(s.id, s.status);
  if (seedOnly) return;
  if (!ALERT_STATUSES.has(s.status)) return;
  if (prev === s.status) return; // not a transition; already alerted
  if (!Notification.isSupported()) return;
  const label = s.status === 'needs-permission' ? 'Needs permission' : 'Waiting for input';
  const where = s.project || s.cwd || 'a session';
  const n = new Notification({
    title: `Mission Control Center: ${label}`,
    body: s.lastPrompt ? `${where}: ${s.lastPrompt}` : where,
  });
  n.on('click', () => {
    postFocus(port, s.id);
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  n.show();
}

// Consume the server's SSE stream and raise a native notification whenever a
// session transitions into a blocked status. Reconnects on drop; stops on quit.
// Guarded because there are now two callers (startup and the retry path), and
// the loop below reconnects forever on its own: a second one would raise every
// notification twice for the rest of the session.
let subscribed = false;

async function subscribeNotifications(port) {
  if (subscribed) return;
  subscribed = true;
  const url = `http://127.0.0.1:${port}/stream`;
  while (!quitting) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error('stream not ok');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          let obj;
          try {
            obj = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }
          if (obj.type === 'snapshot' && Array.isArray(obj.sessions)) {
            for (const s of obj.sessions) maybeNotify(port, s, true);
          } else if (obj.type === 'session' && obj.session) {
            maybeNotify(port, obj.session, false);
          }
        }
      }
    } catch {
      // stream dropped or server not up yet: retry below
    }
    if (quitting) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function buildMenu() {
  const template = [
    {
      label: 'Mission Control Center',
      submenu: [
        { label: 'Check for updates', click: () => checkUpdatesInteractive() },
        {
          label: 'Open in browser',
          click: () => shell.openExternal(dashUrl),
        },
        { type: 'separator' },
        {
          label: 'Retry starting server',
          click: () => {
            retryServer();
          },
        },
        {
          label: 'Stop server and remove hooks',
          click: () => stopServerAndRemoveHooks(),
        },
        // Quit also runs the full teardown so the server + hooks never leak,
        // matching the window-close (X) behavior.
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => stopServerAndRemoveHooks() },
      ],
    },
    { role: 'viewMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The retry button is the point of this page: the failure is intermittent (a
// cold 232 MB binary, a port held by something else), so the fix is usually one
// more attempt rather than a reinstall. It reaches the main process over the
// preload bridge, and Fleet > "Retry starting server" does the same thing in
// case a page-level script ever cannot.
function errorPage() {
  const seconds = Math.round(STARTUP_TIMEOUT_MS / 1000);
  const html = `<body style="background:#111827;color:#f9fafb;font:15px system-ui;padding:40px">
    <h2>Server did not start</h2>
    <p>The mission control server did not answer at ${dashUrl} within ${seconds} seconds.</p>
    <p><button id="retry" style="font:15px system-ui;padding:8px 16px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer">Retry</button>
    <span id="msg" style="margin-left:12px;color:#9ca3af"></span></p>
    <p>Also in the menu: Fleet &gt; Retry starting server. The shell logs every
    attempt to ~/.claude/agent-fleet-monitor/desktop-debug.log; hook events go to
    log.jsonl in the same folder. To run the backend by hand:
    <code>node start.mjs</code> in the MissionControlCenter folder.</p>
    <script>
      var b = document.getElementById('retry'), m = document.getElementById('msg');
      b.addEventListener('click', function () {
        if (!window.cmcRetry) { m.textContent = 'Use Fleet > Retry starting server.'; return; }
        b.disabled = true;
        m.textContent = 'Starting...';
        window.cmcRetry.start().then(function (r) {
          if (r && r.ok) return; // the window navigates to the dashboard
          b.disabled = false;
          m.textContent = 'Still no answer.';
        });
      });
    </script></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// Shared by the error page's button and the Fleet menu item. Loads the dashboard
// on success and leaves the error page up (re-armed) on failure.
async function retryServer() {
  const result = await ensureDashboard();
  logDesktop(`retry -> ok=${result.ok} port=${result.port} reason=${result.reason}`);
  if (!result.ok || mainWin === null) return { ok: false };
  await mainWin.loadURL(dashUrl);
  notifyUpdateBanner(mainWin);
  subscribeNotifications(Number(new URL(dashUrl).port) || DEFAULT_PORT);
  return { ok: true };
}

async function startApp() {
  buildMenu();

  // Banner "Download & install" button (renderer) invokes this in the main
  // process. Re-resolves the newest tag so it always installs the latest.
  ipcMain.handle('cmc:install-update', async () => {
    const tag = await findNewerRelease(app.getVersion());
    if (!tag) return { ok: false };
    return { ok: await downloadAndInstall(tag) };
  });

  // The renderer's Retry button (error page) invokes this.
  ipcMain.handle('cmc:retry-server', () => retryServer());

  await ensureHooks();

  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Mission Control Center',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), 'preload.cjs'),
    },
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });

  // Mouse back/forward side buttons. Windows sends WM_APPCOMMAND, which arrives
  // here as `app-command`; the renderer gets no mouse event for these buttons, so
  // forward them over the preload bridge (see desktop/preload.cjs) and let
  // public/shortcuts.js move through the app's own history. Not
  // webContents.goBack(): the window only ever loads one URL, so browser history
  // is empty and the app's navigation is board <-> session instead.
  mainWin.webContents.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    event.preventDefault();
    if (mainWin === null) return;
    mainWin.webContents.send('cmc:nav', command === 'browser-backward' ? 'back' : 'forward');
  });

  const result = await ensureDashboard();
  if (mainWin === null) return; // window closed while waiting
  if (result.ok) {
    if (result.spawned) logDesktop(`startup -> started backend on port ${result.port}`);
    await mainWin.loadURL(dashUrl);
    notifyUpdateBanner(mainWin);
    const port = Number(new URL(dashUrl).port) || DEFAULT_PORT;
    subscribeNotifications(port);
  } else {
    const lock = readLockFile();
    logDesktop(
      `startup FAILED after ${STARTUP_TIMEOUT_MS}ms: no answer on port ${result.port}` +
        ` (lock=${lock ? JSON.stringify(lock) : 'absent'})`
    );
    await mainWin.loadURL(errorPage());
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  // Closing the window (the X) now shuts everything down: it stops the detached
  // server and removes the hooks before quitting, so nothing is left running in
  // the background. (Previously the shell quit but the server kept running like
  // a closed browser tab.)
  app.on('window-all-closed', () => stopServerAndRemoveHooks());
  app.whenReady().then(startApp);
}
