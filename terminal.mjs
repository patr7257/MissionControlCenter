// Windows Terminal control for a managed window named 'cmc'.
// Zero dependencies beyond Node built-ins.
// Every exported function is best effort: it must never throw out to its caller.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const WT_WINDOW = 'cmc';

// Soft cap for managedTabs (see the growth comment below). Once the array
// crosses this, every push tries the safe reset first (clearStaleManagedTabsIfWindowGone,
// a no-op while the managed window is still open) and only warns if that did
// not bring it back under the cap.
const MAX_MANAGED_TABS = 500;
let warnedManagedTabsCap = false;

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
// { sessionId, cwd, title, launchName, launchedAt, tabIndex }
// Deliberately unbounded by design: `tabIndex` is each entry's position in
// this array, and it doubles as the literal `wt focus-tab -t <n>` argument, so
// it must match the real Windows Terminal tab position. Trimming old entries
// (from the front or anywhere else) would shift the indices of every entry
// after the trim point and desync them from the actual tabs, breaking focus
// for existing sessions. This process is restarted often enough (dev server,
// machine restarts) that the array never grows large in practice, so the
// unbounded growth is acceptable for a session-scoped tool.
//
// Bounded-on-safe-reset mitigation: crossing MAX_MANAGED_TABS does not trim
// the array mid-flight (that would still desync live tab indices), but it
// does trigger clearStaleManagedTabsIfWindowGone() on the next push, which
// safely wipes the whole array once zero WindowsTerminal.exe processes exist.
// The residual: if the managed window somehow stays open indefinitely while
// producing 500+ tabs without ever closing, the array keeps growing and we
// only warn once, since trimming it live is unsafe. Accepted as a known-minor
// backlog item; a genuinely bounded model would need tabIndex to stop being
// positional, which is out of scope for this mitigation.
export const managedTabs = loadManagedTabs();

// Called after every push. No-op unless the array just crossed the cap; safe
// under CMC_DRY_RUN since clearStaleManagedTabsIfWindowGone() already no-ops
// there (isWtRunning() always reports "running" under CMC_DRY_RUN).
function enforceManagedTabsCap() {
  if (managedTabs.length <= MAX_MANAGED_TABS) return;
  clearStaleManagedTabsIfWindowGone();
  if (managedTabs.length > MAX_MANAGED_TABS && !warnedManagedTabsCap) {
    warnedManagedTabsCap = true;
    console.warn(
      `managedTabs has ${managedTabs.length} entries, over the ${MAX_MANAGED_TABS} soft cap, ` +
      'and the managed Windows Terminal window is still open, so it cannot be safely reset. ' +
      'Not trimming mid-array (tabIndex is positional); this will only warn once.'
    );
  }
}

// Gates only the eager bind-on-hook path (bindSession, the SessionStart/
// UserPromptSubmit fast path): a cold `wt` window plus `claude` startup can
// take longer than a minute, so this stays generous. focusSession's lazy
// adopt (see below) has no time window at all: it is uniqueness-gated instead.
const BIND_WINDOW_MS = 180000;

// Resolves through fs.realpathSync first so a junction/symlink cwd compares
// equal to the real path Windows Terminal reports, falling back to plain
// string normalization if realpath fails (path does not exist yet, etc).
export function normalizePath(p) {
  if (!p) return '';
  let resolved = String(p);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // path may not exist (yet) or be unreadable: fall back to the raw string
  }
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

// A user-supplied session name has to survive the cmd start -> wt -> powershell
// quoting chain, and it doubles as the Windows Terminal tab title that
// bringToForeground() matches on. So strip the characters that would break that
// chain (quotes, wt's own `;` command separator, shell operators, a trailing
// backslash that would escape the closing quote) and keep it short. Returns ''
// when nothing usable is left, which every caller treats as "no name given".
export function sanitizeSessionName(name) {
  let value = String(name === undefined || name === null ? '' : name);
  value = value.replace(/["`;&|<>]/g, ' ').replace(/[\r\n\t]+/g, ' ');
  value = value.replace(/\s+/g, ' ').trim().replace(/\\+$/, '').trim();
  return value.slice(0, 60);
}

// The tab runs `claude` inside PowerShell rather than as the tab's own process:
// that loads the developer's PowerShell profile and leaves a usable prompt (with
// the scrollback intact) when Claude exits, instead of the tab vanishing.
// Single quotes are the PowerShell literal form, so a `'` inside the name is
// escaped by doubling it.
function psClaudeCommand(name) {
  if (!name) return 'claude';
  return "claude --name '" + name.replace(/'/g, "''") + "'";
}

// Synchronous check: is any WindowsTerminal.exe process running at all? Fails
// open (returns true) on any error or timeout, since the point is only to
// detect the confident-negative case below, never to block a real focus/bind.
// Always true under CMC_DRY_RUN so test runs never wipe managedTabs.
function isWtRunning() {
  if (process.env.CMC_DRY_RUN) return true;
  try {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WindowsTerminal.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.error || result.status !== 0) return true;
    const out = (result.stdout || '').toLowerCase();
    return out.includes('windowsterminal.exe');
  } catch {
    return true;
  }
}

// If zero WindowsTerminal processes exist, every entry in managedTabs points
// at a tabIndex in a window that is no longer there, so all of them are
// stale. Clears in place (never reassigns the exported array reference) and
// persists. Best effort, never throws.
function clearStaleManagedTabsIfWindowGone() {
  try {
    if (isWtRunning()) return;
    if (managedTabs.length === 0) return;
    managedTabs.length = 0;
    saveManagedTabs();
  } catch {
    // best effort only
  }
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
//
// The match is exact-first: prefer a WindowsTerminal process whose MainWindowTitle
// equals the tab title we set, and only fall back to the broad `-like '*title*'`
// wildcard when no exact match exists. The old wildcard-only match could raise an
// unrelated Windows Terminal window whose tab title merely contained this string
// (known-minor risk called out in CLAUDE.md); the exact pass removes that in the
// common case while the fallback keeps working if WT decorates the window title.
function bringToForeground(title) {
  try {
    if (!title || process.env.CMC_DRY_RUN) return;
    const quotedTitle = psQuote(title);
    const quotedWildcard = psQuote('*' + title + '*');
    const script =
      'Add-Type -Namespace CmcWin32 -Name Native -MemberDefinition ' + psQuote(FOREGROUND_HELPER_TYPE) + ' -ErrorAction SilentlyContinue; ' +
      'Start-Sleep -Milliseconds 400; ' +
      '$procs = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue; ' +
      '$p = $procs | Where-Object { $_.MainWindowTitle -eq ' + quotedTitle + ' } | Select-Object -First 1; ' +
      'if (-not $p) { $p = $procs | Where-Object { $_.MainWindowTitle -like ' + quotedWildcard + ' } | Select-Object -First 1 } ' +
      'if ($p -and $p.MainWindowHandle -ne 0) { [CmcWin32.Native]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [CmcWin32.Native]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }';
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // best effort only, never throw
  }
}

// The New session picker cascades folder by folder from ~/repos: the repos folder
// was refactored into category folders (1-Personal, 2-ZRM, ...) whose children are
// projects, and some of those (customers, INTERN PROJECTS, ...) nest further. So
// this returns a bounded folder tree the picker walks with one dropdown per level.
const REPO_TREE_MAX_DEPTH = 5;            // matches the picker's 5-selector cap
const REPO_TREE_MAX_NODES = 4000;         // backstop against a pathological scan
// Noise folders that are never a useful place to start a session; skipped (with
// all dot-folders) so the cascade stays project-shaped, not source-tree-shaped.
const REPO_TREE_SKIP = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor',
  'coverage', '__pycache__', 'venv', '.venv', '.git', '.next', '.nuxt', '.idea', '.vscode',
]);

// Returns { root, tree } where root is the repos dir and tree is an array of nodes
// { name, path, children }. children is [] at the depth cap or when a folder has no
// (non-skipped) subfolders, which is how the picker knows to stop cascading.
export function listRepos() {
  const reposDir = path.join(os.homedir(), 'repos');
  const counter = { n: 0 };
  function buildTree(dir, level) {
    if (level > REPO_TREE_MAX_DEPTH || counter.n >= REPO_TREE_MAX_NODES) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (REPO_TREE_SKIP.has(entry.name)) continue;
      if (counter.n >= REPO_TREE_MAX_NODES) break;
      counter.n += 1;
      const full = path.join(dir, entry.name);
      nodes.push({ name: entry.name, path: full, children: buildTree(full, level + 1) });
    }
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
  }
  try {
    return { root: reposDir, tree: buildTree(reposDir, 1) };
  } catch {
    return { root: reposDir, tree: [] };
  }
}

// `name` is an optional user-supplied session name. When given it becomes both the
// Claude display name (`claude --name`, shown in the prompt box, the /resume picker
// and the terminal title) and the tab title, so the tab, Claude and the session card
// all agree on one label. The sanitised value is stored on the managedTabs entry so
// bindSession() can hand it back to the server once the session id exists.
export function launchSession(repoPath, title, name) {
  try {
    clearStaleManagedTabsIfWindowGone();
    const launchName = sanitizeSessionName(name);
    const tabTitle = launchName || title;
    const psCommand = psClaudeCommand(launchName);
    const args = [
      '-w', WT_WINDOW, 'nt', '-d', repoPath, '--title', tabTitle,
      'powershell.exe', '-NoExit', '-Command', psCommand,
    ];
    // Quote the repoPath (index 4), title (index 6) and the PowerShell command
    // (index 10): the values that may contain spaces. Everything else stays bare
    // for readability.
    const command = buildReadableCommand(args, new Set([4, 6, 10]));
    const tabIndex = managedTabs.length;
    const entry = { sessionId: null, cwd: repoPath, title: tabTitle, launchName, launchedAt: Date.now(), tabIndex };

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      enforceManagedTabsCap();
      return { ok: true, command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    saveManagedTabs();
    enforceManagedTabsCap();
    return { ok: true, command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Focus the terminal window/tab hosting `sessionId`. Never spawns a tab: it
// only jumps to a tab that already exists. Two outcomes:
// - 'focused': a tab bound to this session (directly, or lazily adopted below).
// - ok:false, mode:'unmanaged': nothing to jump to, either because there is no
//   matching tab or because adopting one would require guessing. This is the
//   graceful "not spawned by, or not resolvable to, this app" case, never an
//   exception. The UI surfaces it as a toast plus an explicit Reopen button
//   (see reopenSession below), rather than silently opening a new tab.
export function focusSession(sessionId, cwd) {
  try {
    clearStaleManagedTabsIfWindowGone();

    let existing = managedTabs.find((t) => t.sessionId === sessionId);

    if (!existing && cwd) {
      // Lazy adopt: a tab we launched but never got a SessionStart/
      // UserPromptSubmit bind for (missed bind window, race, server restart
      // between launch and hook). Only adopt when exactly one unbound tab
      // matches this cwd; with 2+ candidates we cannot tell them apart, so we
      // never guess and fall through to unmanaged instead.
      const normalizedCwd = normalizePath(cwd);
      const candidates = managedTabs.filter(
        (t) => t.sessionId === null && normalizePath(t.cwd) === normalizedCwd
      );
      if (candidates.length === 1) {
        candidates[0].sessionId = sessionId;
        saveManagedTabs();
        existing = candidates[0];
      }
    }

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

    return { ok: false, mode: 'unmanaged', error: 'No known terminal tab for this session' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Explicit, user-confirmed reattach: opens a NEW tab in the managed window and
// resumes into it via `claude --resume`. This is the old auto-reattach branch
// of focusSession, moved here verbatim so it only ever runs behind a deliberate
// action (the UI's confirm-gated Reopen button), never as a side effect of a
// plain card click.
// `title`, when given, is the session's own display name (e.g. what SessionStart
// or a statusline payload learned, or what launchSession/claude --name set
// originally): sanitized and used as the tab title so a resumed session reads
// the same in the terminal as it did on the board, instead of the generic
// 'resume:<id>' placeholder. Falls back to that placeholder when there is no
// usable title. The command itself is unaffected either way: `claude --resume`
// already restores the session's own name, so --name is never added here.
export function reopenSession(sessionId, cwd, title) {
  try {
    if (!cwd) {
      return { ok: false, mode: 'unmanaged', error: 'No known working directory for this session' };
    }

    // Any prior entries bound to this session now point at a tab we are about
    // to replace: null them out so a future focus resolves to the fresh tab
    // instead of the stale one. Entries are never removed, since tabIndex is
    // each entry's position in managedTabs and removing one would desync every
    // later index from its real tab.
    for (const tab of managedTabs) {
      if (tab.sessionId === sessionId) tab.sessionId = null;
    }

    // --title lets bringToForeground() find the right window afterwards by
    // its active tab title.
    const sanitizedTitle = sanitizeSessionName(title);
    const tabTitle = sanitizedTitle || 'resume:' + sessionId;
    // PowerShell hosts the tab for the same reasons as launchSession (profile
    // loads, the tab survives Claude exiting). No --name here: the resumed
    // session already carries whatever display name it was given.
    const args = [
      '-w', WT_WINDOW, 'nt', '-d', cwd, '--title', tabTitle,
      'powershell.exe', '-NoExit', '-Command', 'claude --resume ' + sessionId,
    ];
    // Quote the cwd (index 4), title (index 6) and the PowerShell command
    // (index 10): the values that may contain spaces. Everything else, including
    // the sessionId inside that command, stays bare.
    const command = buildReadableCommand(args, new Set([4, 6, 10]));
    const tabIndex = managedTabs.length;
    const entry = { sessionId, cwd, title: tabTitle, launchName: '', launchedAt: Date.now(), tabIndex };

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      enforceManagedTabsCap();
      return { ok: true, mode: 'reattached', command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    saveManagedTabs();
    enforceManagedTabsCap();
    bringToForeground(tabTitle);
    return { ok: true, mode: 'reattached', command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Returns the name the tab was launched with ('' when the tab had no name, or when
// nothing was bound), so the caller can label the session with it now that the
// session id finally exists. Never throws.
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
      return tab.launchName || '';
    }
  } catch {
    // best effort only, never throw
  }
  return '';
}
