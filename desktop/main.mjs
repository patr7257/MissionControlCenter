// Claude Mission Control desktop shell (Electron main process).
// Wraps the existing zero-dependency backend unchanged: ensures the feeder
// hooks are installed, ensures the server is running as a detached process
// (so it survives closing this window, same model as start.mjs), then shows
// the dashboard in a native window instead of a browser tab.

import { app, BrowserWindow, Menu, dialog, shell, Notification } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findNewerRelease, RELEASES_URL } from './update-check.mjs';

const DEFAULT_PORT = 4317;
const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');

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
    }
    const mod = await import(pathToFileURL(path.join(BACKEND, 'install-hooks.mjs')).href);
    return mod.addHooks();
  } catch (e) {
    console.error('mission-control desktop: hook install failed:', e.message);
    return 0;
  }
}

function ensureServer() {
  if (runningLock()) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  runAsNode(path.join(BACKEND, 'server.mjs'), ['--port', String(DEFAULT_PORT)], {
    detached: true,
  }).unref();
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = runningLock();
    const port = (lock && lock.port) || DEFAULT_PORT;
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        dashUrl = url;
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function stopServerAndRemoveHooks() {
  const child = runAsNode(path.join(BACKEND, 'stop.mjs'));
  child.on('close', () => app.quit());
  child.on('error', () => app.quit());
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
    detail: 'Download the new MSI from the GitHub releases page and run it. It upgrades in place.',
    buttons: ['Open releases page', 'Later'],
    defaultId: 0,
  });
  if (response === 0) shell.openExternal(RELEASES_URL);
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
      var link = document.createElement('a');
      link.href = '${RELEASES_URL}';
      link.target = '_blank';
      link.textContent = 'Open releases';
      link.style.color = '#93c5fd';
      var close = document.createElement('span');
      close.textContent = 'x';
      close.style.cssText = 'cursor:pointer;opacity:.7;padding:0 4px;';
      close.onclick = function () { b.remove(); };
      b.appendChild(text); b.appendChild(link); b.appendChild(close);
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
    title: `Claude Mission Control: ${label}`,
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
async function subscribeNotifications(port) {
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
      label: 'Fleet',
      submenu: [
        { label: 'Check for updates', click: () => checkUpdatesInteractive() },
        {
          label: 'Open in browser',
          click: () => shell.openExternal(dashUrl),
        },
        { type: 'separator' },
        {
          label: 'Stop server and remove hooks',
          click: () => stopServerAndRemoveHooks(),
        },
        { role: 'quit' },
      ],
    },
    { role: 'viewMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function errorPage() {
  const html = `<body style="background:#111827;color:#f9fafb;font:15px system-ui;padding:40px">
    <h2>Server did not start</h2>
    <p>The mission control server did not answer at ${dashUrl} within 8 seconds.</p>
    <p>Check ~/.claude/agent-fleet-monitor/log.jsonl, or run the backend by hand:
    <code>node start.mjs</code> in the claude-mission-control folder.</p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function startApp() {
  buildMenu();
  await ensureHooks();
  ensureServer();

  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Claude Mission Control',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });

  const up = await waitForServer(8000);
  if (mainWin === null) return; // window closed while waiting
  if (up) {
    await mainWin.loadURL(dashUrl);
    notifyUpdateBanner(mainWin);
    const port = Number(new URL(dashUrl).port) || DEFAULT_PORT;
    subscribeNotifications(port);
  } else {
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
  // Closing the window quits the shell; the detached server keeps running,
  // exactly like closing the browser tab today. Stopping for real is the
  // explicit menu action (or node stop.mjs).
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(startApp);
}
