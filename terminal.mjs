// Windows Terminal control for a managed window named 'cmc'.
// Zero dependencies beyond Node built-ins.
// Every exported function is best effort: it must never throw out to its caller.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const WT_WINDOW = 'cmc';

// Persisted alongside the server's other runtime data, outside the repo. Survives a
// server restart (dev reload, machine reboot) so `tabIndex` (see below) does not
// desync from the real tab positions in a still-open managed Windows Terminal window,
// and so a card click still resolves to the right tab after the dashboard/server
// itself has been restarted.
const STATE_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const STATE_FILE = path.join(STATE_DIR, 'managed-tabs.json');

function loadManagedTabs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // no persisted state yet, or unreadable: start fresh
  }
  return [];
}

// Best effort, never throws. Skipped entirely under CMC_DRY_RUN so test runs never
// overwrite the real persisted state.
function saveManagedTabs() {
  if (process.env.CMC_DRY_RUN) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(managedTabs));
  } catch {
    // best effort only
  }
}

// Ordered record of tabs we have opened into the managed window.
// { sessionId, cwd, title, launchedAt, tabIndex }
// Deliberately unbounded: `tabIndex` is each entry's position in this array,
// and it doubles as the literal `wt focus-tab -t <n>` argument, so it must
// match the real Windows Terminal tab position. Trimming old entries (from
// the front or anywhere else) would shift the indices of every entry after
// the trim point and desync them from the actual tabs, breaking focus for
// existing sessions. This process is restarted often enough (dev server,
// machine restarts) that the array never grows large in practice, so the
// unbounded growth is acceptable for a session-scoped tool.
export const managedTabs = loadManagedTabs();

const BIND_WINDOW_MS = 60000;

function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Build the readable command string shown in the UI/logs. `quotedIndexes` is
// the set of positions in `args` (repoPath, title, cwd, and similar
// free-form values that may contain spaces) that should be wrapped in double
// quotes for readability; every other token (flags, subcommands, the window
// name, tab index, session id) is printed bare.
function buildReadableCommand(args, quotedIndexes) {
  const parts = ['wt'];
  args.forEach((a, i) => {
    parts.push(quotedIndexes.has(i) ? '"' + a + '"' : a);
  });
  return parts.join(' ');
}

// Fire-and-forget launch of wt.exe via cmd start, detached so Node never blocks.
function spawnWt(args) {
  spawn('cmd', ['/c', 'start', '', 'wt', ...args], { detached: true, stdio: 'ignore' }).unref();
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// user32 signatures shared by the foreground helper below. Single-quoted in the
// PowerShell command that embeds it, so the C# double quotes need no escaping.
const FOREGROUND_HELPER_TYPE =
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);';

// Best-effort nudge to bring the managed Windows Terminal window to the front and
// restore it if minimized. `wt focus-tab` / `wt ... --resume` already ask the running
// Windows Terminal process to switch tabs, but Windows does not always let a
// background process (this Node server) steal focus on its behalf, so this also
// calls user32 SetForegroundWindow directly against that process's window handle.
// Matched by window title (the active tab's title, which every launch/reattach sets
// with --title): wt.exe reuses a single process per named window, so there is no
// per-tab PID to target, only the title of whichever tab is now on top.
function bringToForeground(title) {
  try {
    if (!title || process.env.CMC_DRY_RUN) return;
    const script =
      'Add-Type -Namespace CmcWin32 -Name Native -MemberDefinition ' + psQuote(FOREGROUND_HELPER_TYPE) + ' -ErrorAction SilentlyContinue; ' +
      'Start-Sleep -Milliseconds 400; ' +
      '$p = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like ' + psQuote('*' + title + '*') + ' } | Select-Object -First 1; ' +
      'if ($p -and $p.MainWindowHandle -ne 0) { [CmcWin32.Native]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [CmcWin32.Native]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }';
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // best effort only, never throw
  }
}

export function listRepos() {
  try {
    const reposDir = path.join(os.homedir(), 'repos');
    const entries = fs.readdirSync(reposDir, { withFileTypes: true });
    const repos = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      repos.push({ name: entry.name, path: path.join(reposDir, entry.name) });
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return repos;
  } catch {
    return [];
  }
}

export function launchSession(repoPath, title) {
  try {
    const args = ['-w', WT_WINDOW, 'nt', '-d', repoPath, '--title', title, 'claude'];
    // Quote the repoPath (index 4) and title (index 6): the values that may
    // contain spaces. Everything else stays bare for readability.
    const command = buildReadableCommand(args, new Set([4, 6]));
    const tabIndex = managedTabs.length;

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push({ sessionId: null, cwd: repoPath, title, launchedAt: Date.now(), tabIndex });
      return { ok: true, command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push({ sessionId: null, cwd: repoPath, title, launchedAt: Date.now(), tabIndex });
    saveManagedTabs();
    return { ok: true, command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Focus the terminal window/tab hosting `sessionId`. Three outcomes:
// - 'focused': a tab we launched into the managed window is bound to this session.
// - 'reattached': not bound (external session, or bound tab now gone), but we know
//   its cwd, so we open a new tab in the managed window and resume into it there.
// - ok:false, mode:'unmanaged': no bound tab and no known cwd, so there is nothing to
//   jump to. This is the graceful "not spawned by the app" case, never an exception.
export function focusSession(sessionId, cwd) {
  try {
    const existing = managedTabs.find((t) => t.sessionId === sessionId);
    if (existing) {
      const args = ['-w', WT_WINDOW, 'focus-tab', '-t', String(existing.tabIndex)];
      const command = buildReadableCommand(args, new Set());
      if (process.env.CMC_DRY_RUN) {
        return { ok: true, mode: 'focused', command, dryRun: true };
      }
      spawnWt(args);
      bringToForeground(existing.title);
      return { ok: true, mode: 'focused', command };
    }

    if (!cwd) {
      return { ok: false, mode: 'unmanaged', error: 'No known working directory for this session' };
    }

    // External or not yet bound: reattach via --resume in a new tab. --title lets
    // bringToForeground() find the right window afterwards by its active tab title.
    const title = 'resume:' + sessionId;
    const args = ['-w', WT_WINDOW, 'nt', '-d', cwd, '--title', title, 'claude', '--resume', sessionId];
    // Quote the cwd (index 4) and title (index 6): the values that may contain
    // spaces. Everything else, including sessionId, stays bare.
    const command = buildReadableCommand(args, new Set([4, 6]));
    const tabIndex = managedTabs.length;
    const entry = { sessionId, cwd, title, launchedAt: Date.now(), tabIndex };

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      return { ok: true, mode: 'reattached', command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    saveManagedTabs();
    bringToForeground(title);
    return { ok: true, mode: 'reattached', command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function bindSession(cwd, sessionId) {
  try {
    const normalizedCwd = normalizePath(cwd);
    const now = Date.now();
    for (let i = managedTabs.length - 1; i >= 0; i -= 1) {
      const tab = managedTabs[i];
      if (tab.sessionId !== null) continue;
      if (normalizePath(tab.cwd) !== normalizedCwd) continue;
      if (now - tab.launchedAt > BIND_WINDOW_MS) continue;
      tab.sessionId = sessionId;
      saveManagedTabs();
      return;
    }
  } catch {
    // best effort only, never throw
  }
}
