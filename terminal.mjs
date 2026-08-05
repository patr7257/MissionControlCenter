// Windows Terminal control for a managed window named 'cmc'.
// Zero dependencies beyond Node built-ins.
// Every exported function is best effort: it must never throw out to its caller.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const WT_WINDOW = 'cmc';

// Per-session GitHub account registry. `gh auth switch` writes the active
// account to one machine-wide file, so concurrent sessions fight over it;
// GH_CONFIG_DIR is per-process, so pinning it (plus the git identity vars)
// in the env of the hosted PowerShell command fully isolates a session's
// account from every other session's.
// configDir is deliberately never exposed over HTTP (see the /repos handler
// in server.mjs): only key/label/login/matchPath/isDefault are safe to send
// to the browser.
export const GH_ACCOUNTS = [
  {
    key: 'personal',
    label: 'patr7257 (personal)',
    login: 'patr7257',
    configDir: process.env.CMC_GH_DIR_PERSONAL || path.join(os.homedir(), '.config', 'gh-personal'),
    email: 'patr7257@gmail.com',
    name: 'Patrick Røbel',
    isDefault: true,
  },
  {
    key: 'work',
    label: 'przrm (ZRM work)',
    login: 'przrm',
    configDir: process.env.CMC_GH_DIR_WORK || path.join(os.homedir(), '.config', 'gh-work'),
    email: 'pr@zrm.dk',
    name: 'Patrick Røbel',
    matchPath: '2-ZRM',
  },
];

function defaultGhAccount() {
  return GH_ACCOUNTS.find((a) => a.isDefault) || GH_ACCOUNTS[0];
}

// Matches a path SEGMENT (bounded by / or \, case-insensitive) so a repo
// literally named 'my-2-ZRMish' does not match the '2-ZRM' rule. repoPath is
// normalized to forward slashes first so both separators are handled the
// same way regardless of platform.
function pathHasSegment(repoPath, segment) {
  if (!repoPath || !segment) return false;
  const normalized = String(repoPath).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const want = String(segment).toLowerCase();
  return parts.some((p) => p.toLowerCase() === want);
}

// The rule Patrick asked for: anything under ~/repos/2-ZRM/ is work, everything
// else is personal. Never trust a key from HTTP for this; this only ever
// consults the registry's own matchPath fields.
export function defaultAccountForPath(repoPath) {
  for (const account of GH_ACCOUNTS) {
    if (account.matchPath && pathHasSegment(repoPath, account.matchPath)) return account;
  }
  return defaultGhAccount();
}

// Security boundary: the only way an accountKey reaches the shell command
// built below is by matching one of these fixed registry entries. A key from
// an HTTP request body is never used for anything else.
export function resolveAccount(key) {
  if (!key) return null;
  return GH_ACCOUNTS.find((a) => a.key === key) || null;
}

// Env exports prepended to the hosted PowerShell script so the account only
// ever applies to that one tab. Git identity vars are set alongside
// GH_CONFIG_DIR on purpose: without them a session overridden to one account
// would still commit as whatever the shared global git identity is.
// Returns STATEMENTS, one per line, never a `; `-joined string: a semicolon in
// a wt argument splits the command line (see spawnWt below).
function ghEnvStatements(account) {
  if (!account) return [];
  return [
    '$env:GH_CONFIG_DIR=' + psQuote(account.configDir),
    '$env:GIT_AUTHOR_NAME=' + psQuote(account.name),
    '$env:GIT_AUTHOR_EMAIL=' + psQuote(account.email),
    '$env:GIT_COMMITTER_NAME=' + psQuote(account.name),
    '$env:GIT_COMMITTER_EMAIL=' + psQuote(account.email),
  ];
}

// Statements are separated by newlines rather than `; ` for the same reason.
function psScript(statements) {
  return statements.join('\n');
}

// PowerShell's own transport for a script that must survive an unfriendly
// command line: base64 of UTF-16LE (what powershell.exe -EncodedCommand
// expects). The encoded payload contains only base64 characters, so it has no
// semicolon for wt to split on, no space or quote for cmd/wt to regroup, and
// no non-ASCII byte for a console codepage to mangle (the git identity carries
// 'Røbel'). Exported so tests can decode the command that really runs instead
// of asserting on a prettified copy of it.
export function encodePsCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

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
//
// LOAD-BEARING INVARIANT: no argument here may contain a raw `;`. Windows
// Terminal uses `;` as its own command separator and splits on it even inside a
// single quoted argument, so a semicolon-joined PowerShell command does not run
// as one command: wt turns every `; ...` segment into ANOTHER tab whose
// "executable" is the segment text, which fails with 0x80070002 (file not
// found) while the first tab runs only the fragment before the first `;`. That
// is exactly what a `$env:X='a'; $env:Y='b'; claude` prefix produced: four junk
// error tabs plus a tab that set one variable and never started Claude. Hence
// -EncodedCommand (see encodePsCommand) rather than -Command, and hence
// sanitizeSessionName stripping `;` from user input. Asserted in
// scripts/smoke-server.mjs.
function spawnWt(args) {
  spawn('cmd', ['/c', 'start', '', 'wt', ...args], { detached: true, stdio: 'ignore' }).unref();
}

// Enforces the spawnWt invariant above at runtime instead of trusting every
// caller to have sanitized its inputs. The repo path is the one value that is
// neither sanitized (it must stay a usable directory) nor encoded, so a folder
// literally named 'a;b' would still split the wt command line. Refusing with a
// clear error beats spawning the junk tabs this fix exists to remove.
function firstSemicolonArg(args) {
  return args.find((a) => String(a).includes(';')) || null;
}

function semicolonError(arg) {
  return (
    'Cannot launch: "' + arg + '" contains a semicolon, which Windows Terminal ' +
    'treats as a command separator. Rename the folder or the session.'
  );
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
// escaped by doubling it. `account`, when given, contributes the leading env
// exports (GH_CONFIG_DIR plus the four git identity vars) so the account applies
// only to this one tab; see ghEnvStatements above. Returns the plain script text
// (newline separated); encodePsCommand is what puts it on a wt command line.
function psClaudeScript(name, account) {
  const claude = name ? "claude --name '" + name.replace(/'/g, "''") + "'" : 'claude';
  return psScript([...ghEnvStatements(account), claude]);
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

// Is `p` the repos root itself, or inside it? Used to bound the ONE path that
// arrives from the browser (the New session popup's folder chain, which can only
// ever produce a node out of listRepos()); a session's own cwd is server-owned
// data and deliberately NOT bounded this way, since a session may legitimately
// run outside ~/repos. The `root + '/'` prefix rather than a bare startsWith is
// what stops a sibling like ~/repositories-secret passing, and normalizePath's
// realpath step collapses any `..` before the comparison (so the caller must
// verify the folder EXISTS first: realpath cannot resolve a missing path).
export function isInsideReposRoot(p) {
  const root = normalizePath(path.join(os.homedir(), 'repos'));
  const target = normalizePath(p);
  if (!root || !target) return false;
  return target === root || target.startsWith(root + '/');
}

// ---- Open a folder in VS Code -------------------------------------------------
//
// LOAD-BEARING: this never goes through wt/spawnWt and never pushes to
// managedTabs. A tab that runs `code .` and then closes itself would shift every
// LATER tab down by one while managedTabs keeps its old positional tabIndex, so
// every subsequent focus click would jump to the wrong tab. VS Code detaches
// itself anyway, so there is no terminal to close: spawning the GUI exe directly
// is both simpler and the only way to guarantee no console window ever appears.
const VSCODE_EXE_ENV = 'CMC_VSCODE_EXE';
// Static, PATH-free candidates, tried after `where code`. A user-scope install is
// what this machine has; the Program Files ones cover a system-wide install and
// the Insiders pair covers the other channel.
function vsCodeCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(pf, 'Microsoft VS Code', 'Code.exe'),
    path.join(pf86, 'Microsoft VS Code', 'Code.exe'),
    path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
    path.join(pf, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
  ];
}

// `code` on PATH is a launcher script, not the app: bin/code.cmd (and an
// extensionless bash shim next to it). Node refuses to spawn a .cmd without
// shell:true, and shell:true means cmd.exe, which is both a console-window flash
// and a quoting hazard, so map the launcher to the GUI exe that sits one level up
// instead of ever spawning the script.
const VSCODE_LAUNCHER_TO_EXE = {
  'code.cmd': 'Code.exe',
  'code.bat': 'Code.exe',
  'code-insiders.cmd': 'Code - Insiders.exe',
  'code-insiders.bat': 'Code - Insiders.exe',
};

function vsCodeExeFromLauncher(launcher) {
  const base = path.basename(launcher).toLowerCase();
  const exeName = VSCODE_LAUNCHER_TO_EXE[base];
  if (!exeName) return null;
  const binDir = path.dirname(launcher);
  if (path.basename(binDir).toLowerCase() !== 'bin') return null;
  const exe = path.join(path.dirname(binDir), exeName);
  return fs.existsSync(exe) ? exe : null;
}

// Ask Windows where `code` is. Absolute System32 path first, because `where`
// itself is only reachable via PATH through System32, which is exactly the thing
// that might be missing. Bounded and fully guarded like isWtRunning(), but it
// fails CLOSED (returns null on any error) so resolution falls through to the
// static candidates rather than pretending to have found something.
function whereVsCode() {
  try {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    const exe = fs.existsSync(system32) ? system32 : 'where';
    const result = spawnSync(exe, ['code'], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    if (result.error || result.status !== 0) return null;
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => /\.(exe|cmd|bat)$/i.test(l));
    // Prefer a real .exe if one is on PATH; otherwise the launcher script, which
    // vsCodeExeFromLauncher maps to the app next to it.
    const direct = lines.find((l) => /\.exe$/i.test(l));
    if (direct && fs.existsSync(direct)) return direct;
    for (const line of lines) {
      const mapped = vsCodeExeFromLauncher(line);
      if (mapped) return mapped;
    }
    return null;
  } catch {
    return null;
  }
}

// undefined = never resolved, null = resolved to nothing, string = the exe path.
let vsCodeExeCache;
let vsCodeMissAt = 0;
// A positive result is cached for the process lifetime (the `where` spawn is the
// only blocking call in the click path). A miss is cached for 30s only, so
// installing VS Code mid-session starts working without a server restart, while a
// rapid double click still cannot spawn `where` twice.
const VSCODE_MISS_TTL_MS = 30000;

function resolveVsCodeExe() {
  if (typeof vsCodeExeCache === 'string') return vsCodeExeCache;
  if (vsCodeExeCache === null && Date.now() - vsCodeMissAt < VSCODE_MISS_TTL_MS) return null;
  const found = whereVsCode() || vsCodeCandidates().find((c) => fs.existsSync(c)) || null;
  vsCodeExeCache = found;
  if (!found) vsCodeMissAt = Date.now();
  return found;
}

// Sibling of buildReadableCommand for a non-wt exec: same readability contract
// (quote the free-form values that may contain spaces), no `wt` prefix. Nothing
// here is ever handed to a shell, so the quotes are for the reader only.
function buildReadableExec(exe, args) {
  return [exe, ...args].map((a) => '"' + a + '"').join(' ');
}

// LOAD-BEARING, and found only by really spawning it: VS Code is an Electron app,
// so an inherited ELECTRON_RUN_AS_NODE=1 turns Code.exe into a bare Node
// interpreter that tries to `require` the folder path and dies with
// "Cannot find module C:\...\<folder>". Nothing is visible when that happens
// (stdio is ignored, the process just exits 1), so it reads as "the button does
// nothing".
//
// This is not hypothetical: desktop/main.mjs spawns server.mjs with
// ELECTRON_RUN_AS_NODE=1 (that is how Electron doubles as Node), and the server
// passes its env to children, so EVERY packaged install would have hit it. It is
// also set in a Claude Code session's own environment, which is how it was caught.
// Exported so scripts/smoke-server.mjs can assert it, the same reason
// installerSpawnArgs() exists.
export function editorSpawnEnv(base) {
  const env = { ...(base || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// The spawn options for the editor, in one exported place so
// scripts/smoke-server.mjs can assert the shape without spawning anything (the
// same reason editorSpawnEnv and installerSpawnArgs are exported).
//
// LOAD-BEARING, and the whole of issue #33: there is deliberately NO
// `windowsHide` here. It reads like "do not flash a console window", but Node
// maps it to libuv's UV_PROCESS_WINDOWS_HIDE, which sets
// STARTUPINFO.wShowWindow = SW_HIDE together with STARTF_USESHOWWINDOW, and a
// GUI app honours that for its FIRST window. So `windowsHide: true` made a COLD
// VS Code start create its window INVISIBLE: the process ran, the folder loaded,
// and the button looked completely dead. Only the cold start was affected, since
// a warm instance creates the new window itself and never saw our STARTUPINFO,
// which is what made the bug read as intermittent rather than broken. Measured
// by cold-starting Code.exe into a throwaway --user-data-dir and enumerating
// window handles: hidden with the flag, visible without it.
//
// Nothing is lost by dropping it. Resolution always yields a GUI-subsystem
// Code.exe (PE subsystem 2, verified; a launcher script is mapped to the exe
// next to it by vsCodeExeFromLauncher), so there is no console to suppress, and
// Windows ignores CREATE_NO_WINDOW anyway once DETACHED_PROCESS is set.
//
// `detached` must STAY. A second Code.exe does not draw the window itself: it
// connects to the already-running instance over a named pipe, forwards the
// folder and exits, and being killed mid-handoff means nothing happens at all
// (measured: a non-detached spawn from a short-lived parent opened no window).
export function editorSpawnOptions(base) {
  return {
    detached: true,
    stdio: 'ignore',
    shell: false,
    // Without this, an inherited ELECTRON_RUN_AS_NODE makes Code.exe behave as
    // Node and never open a window. See editorSpawnEnv above.
    env: editorSpawnEnv(base),
  };
}

const MAX_FOLDER_LEN = 4096;

// ---- Which folders WE opened in VS Code ---------------------------------------
//
// The close action is deliberately scoped to windows this app opened, so it can
// never propose closing an editor the developer opened by hand. That means we have
// to remember them: the spawned Code.exe exits immediately (it only forwards the
// folder to the already-running instance), so there is no pid or window handle to
// hold on to, only the folder itself.
//
// Keyed by normalizePath so a junction, a trailing slash or different casing all
// resolve to the same entry. Persisted next to managed-tabs.json so the button
// survives a server restart, pruned by age and capped, and (like managedTabs) the
// in-memory record is kept even under CMC_DRY_RUN while the file write is skipped.
const OPENED_EDITORS_FILE = path.join(STATE_DIR, 'opened-editors.json');
const MAX_OPENED_EDITORS = 200;
const OPENED_EDITOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadOpenedEditors() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OPENED_EDITORS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - OPENED_EDITOR_TTL_MS;
    return parsed
      .filter((e) => e && typeof e.folder === 'string' && typeof e.openedAt === 'number' && e.openedAt >= cutoff)
      .slice(-MAX_OPENED_EDITORS);
  } catch {
    return [];
  }
}

function saveOpenedEditors() {
  if (process.env.CMC_DRY_RUN) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(OPENED_EDITORS_FILE, JSON.stringify(openedEditors));
  } catch {
    // best effort only
  }
}

// Entries are { folder, key, openedAt }. Unlike managedTabs nothing here is
// positional, so this one is safely trimmable.
export const openedEditors = loadOpenedEditors();

function recordOpenedEditor(folder) {
  const key = normalizePath(folder);
  if (!key) return;
  const existing = openedEditors.find((e) => e.key === key);
  if (existing) {
    existing.openedAt = Date.now();
    existing.folder = folder;
  } else {
    openedEditors.push({ folder, key, openedAt: Date.now() });
    while (openedEditors.length > MAX_OPENED_EDITORS) openedEditors.shift();
  }
  saveOpenedEditors();
}

export function hasOpenedEditor(folder) {
  const key = normalizePath(folder);
  if (!key) return false;
  return openedEditors.some((e) => e.key === key);
}

// ---- Is a VS Code window ACTUALLY open for this folder? -------------------------
//
// hasOpenedEditor() above only says we once opened it. That record is kept for 7
// days, so it long outlives the window: closing VS Code by hand leaves the record
// behind, which is how the board came to offer a `Close VS Code` that could only
// ever answer `no-window`, and how the end-of-session popup came to ask about an
// editor that was not there.
//
// The truth is on the desktop, so it is read from there: one EnumWindows pass (the
// same read-only helper closeEditor uses) returns the titles of every VS Code
// window, and a folder counts as open when a title matches it the same way
// closeWindowScript matches. Read-only, needs no focus, changes no focus.
//
// CACHED, because that pass costs about 0.6s (the Add-Type compile dominates) and
// serializeSession runs once per session per broadcast: probing there would be a
// spawn storm. The server refreshes it on a timer instead and pushes the cards
// whose answer changed.
let editorWindowTitles = [];
let editorWindowProbedAt = 0;
let editorWindowProbe = null;

// A window does not exist the instant the process is spawned: a cold VS Code start
// takes seconds, and a warm one still has to forward the folder over its named pipe.
// Inside this window of an open we answer "open" without evidence, so the button
// does not flicker back to `VS Code` right after a click.
const EDITOR_OPEN_GRACE_MS = 30000;

function editorWindowsScript() {
  return [
    "$ErrorActionPreference = 'Continue'",
    // Titles can carry non-ASCII (æ/ø/å in a folder name); without this the JSON
    // comes back in the console codepage and Node reads it as mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -TypeDefinition ' + psQuote(CLOSE_WINDOW_HELPER) + " -ErrorAction Stop | Out-Null",
    '$names = @(' + VSCODE_PROCESS_NAMES.map((n) => psQuote(n)).join(', ') + ')',
    '$titles = @()',
    'foreach ($w in [CmcCloser]::Windows()) {',
    '  $p = Get-Process -Id $w.Pid -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { continue }',
    '  if ($names -notcontains $p.ProcessName.ToLower()) { continue }',
    '  $titles += $w.Title',
    '}',
    'Write-Output (ConvertTo-Json -Compress @{ titles = @($titles) })',
  ].join('\n');
}

// The JS twin of closeWindowScript's regex, so "the button is offered" and "the
// close can find the window" are decided by exactly one rule. A folder whose own
// name contains " - " is simply never matched, which fails safe: the button offers
// to OPEN rather than to close something we could not identify anyway.
function titleMatchesBaseName(title, baseName) {
  const escaped = String(baseName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|\\ -\\ )' + escaped + '\\ -\\ Visual Studio Code(?: - Insiders)?$').test(String(title));
}

// Runs the window query once and caches its titles. Never rejects, and on any
// failure (spawn error, timeout, unparseable output) it leaves the previous cache
// and the probed-at stamp alone: an unanswerable probe must not be read as "every
// editor is closed". Concurrent callers share one spawn.
export function refreshOpenEditors() {
  if (process.env.CMC_DRY_RUN) return Promise.resolve(false);
  if (editorWindowProbe) return editorWindowProbe;
  editorWindowProbe = new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      editorWindowProbe = null;
      resolve(value);
    };
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(editorWindowsScript())],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(false);
      }, CLOSE_QUERY_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', () => {
        clearTimeout(timer);
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
        try {
          const parsed = JSON.parse(line || '');
          if (!parsed || !Array.isArray(parsed.titles)) return finish(false);
          editorWindowTitles = parsed.titles.map((t) => String(t));
          editorWindowProbedAt = Date.now();
          finish(true);
        } catch {
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
  return editorWindowProbe;
}

// Sync, cache-backed, safe to call once per session per broadcast.
//
// Fails OPEN in every uncertain case (never probed, probe failing, inside the grace
// window after an open): the cost of a wrong "open" is one `no-window` toast, while
// a wrong "closed" hides the only button that can close the editor.
export function isEditorOpen(folder) {
  if (!hasOpenedEditor(folder)) return false;
  if (process.env.CMC_DRY_RUN) return true;
  if (!editorWindowProbedAt) return true; // no reading yet: assume the record is good
  const key = normalizePath(folder);
  const record = openedEditors.find((e) => e.key === key);
  if (record && Date.now() - record.openedAt < EDITOR_OPEN_GRACE_MS) return true;
  const baseName = path.basename(path.resolve(String(folder)));
  if (!baseName) return false;
  return editorWindowTitles.some((t) => titleMatchesBaseName(t, baseName));
}

// Every folder we opened that currently counts as open. The server diffs this
// across refreshes so only the cards whose answer changed are re-pushed.
export function openEditorFolders() {
  return openedEditors.map((e) => e.folder).filter((f) => isEditorOpen(f));
}

function forgetOpenedEditor(folder) {
  const key = normalizePath(folder);
  if (!key) return;
  for (let i = openedEditors.length - 1; i >= 0; i -= 1) {
    if (openedEditors[i].key === key) openedEditors.splice(i, 1);
  }
  saveOpenedEditors();
}

// Opens `folderPath` as a folder in VS Code. Best effort like every other export
// here: never throws, always returns a result object.
//
// `reason` on a failure mirrors focusSession's `mode` so the frontend can branch
// without regexing prose, while `error` stays human because the UI prints it
// verbatim. ok:true means the process was STARTED, never that a window appeared
// (we hand off to a detached GUI app and never hear back), which is why the UI
// copy stays present continuous.
export function openInVsCode(folderPath) {
  try {
    const raw = folderPath === undefined || folderPath === null ? '' : String(folderPath);
    if (!raw.trim()) {
      return { ok: false, reason: 'bad-folder', error: 'No folder to open.' };
    }
    if (raw.length > MAX_FOLDER_LEN || /[\0\r\n]/.test(raw)) {
      return { ok: false, reason: 'bad-folder', error: 'That folder path is not usable.' };
    }
    const folder = path.resolve(raw);
    let stat;
    try {
      stat = fs.statSync(folder);
    } catch {
      return { ok: false, reason: 'bad-folder', error: 'That folder no longer exists: ' + folder };
    }
    if (!stat.isDirectory()) {
      return { ok: false, reason: 'bad-folder', error: 'That path is a file, not a folder: ' + folder };
    }

    // An override that points at nothing is a configuration mistake worth
    // reporting, not something to silently paper over by falling back to
    // discovery: the developer set it on purpose.
    const override = process.env[VSCODE_EXE_ENV];
    let exe;
    if (override) {
      if (!fs.existsSync(override)) {
        return {
          ok: false,
          reason: 'no-editor',
          error: VSCODE_EXE_ENV + ' points at a file that does not exist: ' + override,
        };
      }
      exe = override;
    } else {
      exe = resolveVsCodeExe();
    }
    if (!exe) {
      return {
        ok: false,
        reason: 'no-editor',
        error: 'Could not find VS Code. Set ' + VSCODE_EXE_ENV + ' to the full path of Code.exe.',
      };
    }

    // NOTE: firstSemicolonArg() deliberately does NOT apply here. The semicolon
    // rule is a Windows Terminal command-line invariant and this path builds no
    // command line, so a folder named 'a;b' opens fine even though /launch must
    // refuse it. normalizePath() must not be used for the spawned argument
    // either: it lowercases, so it is a comparison key only.
    const args = [folder];
    const command = buildReadableExec(exe, args);
    if (process.env.CMC_DRY_RUN) {
      recordOpenedEditor(folder);
      return { ok: true, exe, folder, command, dryRun: true };
    }

    // See editorSpawnOptions: detached + unref so the child outlives this
    // process, and NO windowsHide, which would open the window hidden.
    const child = spawn(exe, args, editorSpawnOptions(process.env));
    // MANDATORY: spawn reports ENOENT/EACCES asynchronously via 'error', which
    // the try/catch above cannot see. With no listener it becomes an uncaught
    // exception and takes the whole server down.
    child.on('error', () => {});
    child.unref();
    recordOpenedEditor(folder);
    return { ok: true, exe, folder, command };
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', error: String(error) };
  }
}

// ---- Closing a VS Code window -------------------------------------------------
//
// There is NO VS Code CLI for this: `code` can open, diff and report status, but
// nothing closes a window (`code --status` only lists window TITLES, with folder
// names as basenames and no paths, and takes ~2.6s). So the only mechanism is
// Win32: resolve the window handle and post WM_CLOSE to it.
//
// WM_CLOSE is a message addressed to ONE specific handle, not input. It needs no
// focus, changes no focus, and is the same request the window's X button makes, so
// VS Code still runs its own "save your changes?" prompt. That is what separates it
// from the banned SendKeys/SetForegroundWindow class, where the target is whatever
// happens to have focus at that instant. Approved for this use on 2026-08-03.
//
// Identification is the weak link and is handled by refusing rather than guessing:
// every VS Code window belongs to the SAME pid (the Electron main process), so a
// handle can only be matched by title, and VS Code's default title carries the
// folder BASENAME, not its path. Two open folders with the same basename are
// therefore indistinguishable, so 2+ matches means "ambiguous", not "close the
// first one". Same discipline as focusSession's lazy adopt.
const CLOSE_WINDOW_HELPER = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CmcCloser {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public class Win { public IntPtr Handle; public string Title; public uint Pid; }
  public static List<Win> Windows() {
    var list = new List<Win>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      if (sb.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new Win { Handle = h, Title = sb.ToString(), Pid = pid });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static bool Close(IntPtr h) { return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static bool Alive(IntPtr h) { return IsWindow(h) && IsWindowVisible(h); }
}
`;

// Only windows owned by a VS Code process may be closed, so a same-named window
// belonging to something else (an Explorer folder, a browser tab title) can never
// be hit by a title match.
const VSCODE_PROCESS_NAMES = ['code', 'code - insiders'];

// The base name is compared against VS Code's title format,
// `${dirty}${activeEditorShort} - ${rootName} - ${appName}`, so the folder is
// either the whole title's first segment (no editor open) or the segment right
// before the app name. Hence the (^|' - ') alternation.
function closeWindowScript(baseName) {
  return [
    "$ErrorActionPreference = 'Continue'",
    // Titles can carry non-ASCII (æ/ø/å in a folder name); without this the JSON
    // comes back in the console codepage and Node reads it as mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -TypeDefinition ' + psQuote(CLOSE_WINDOW_HELPER) + " -ErrorAction Stop | Out-Null",
    '$base = ' + psQuote(baseName),
    "$pattern = '(?:^|\\ -\\ )' + [Regex]::Escape($base) + '\\ -\\ Visual\\ Studio\\ Code(?:\\ -\\ Insiders)?$'",
    '$names = @(' + VSCODE_PROCESS_NAMES.map((n) => psQuote(n)).join(', ') + ')',
    '$hits = @()',
    'foreach ($w in [CmcCloser]::Windows()) {',
    '  if ($w.Title -notmatch $pattern) { continue }',
    '  $p = Get-Process -Id $w.Pid -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { continue }',
    '  if ($names -notcontains $p.ProcessName.ToLower()) { continue }',
    '  $hits += $w',
    '}',
    'if ($hits.Count -eq 0) { Write-Output (ConvertTo-Json -Compress @{ matched = 0 }); exit 0 }',
    'if ($hits.Count -gt 1) {',
    '  Write-Output (ConvertTo-Json -Compress @{ matched = $hits.Count; titles = @($hits | ForEach-Object { $_.Title }) })',
    '  exit 0',
    '}',
    '$target = $hits[0]',
    '$posted = [CmcCloser]::Close($target.Handle)',
    // A window with unsaved files does NOT disappear: VS Code puts up its own save
    // prompt instead, which is correct and must be reported as pending, not failed.
    'Start-Sleep -Milliseconds 700',
    '$gone = -not [CmcCloser]::Alive($target.Handle)',
    'Write-Output (ConvertTo-Json -Compress @{ matched = 1; posted = $posted; gone = $gone; title = $target.Title })',
  ].join('\n');
}

// Measured cost of the window query on this machine: about 0.6s for the Add-Type
// compile plus EnumWindows, plus the 0.7s settle wait, so a couple of seconds in
// the normal case. The cap is generous because a slow first compile (cold .NET,
// antivirus on the temp dir) must not be reported as a failure, and overridable so
// a test can shorten it.
const CLOSE_QUERY_TIMEOUT_MS = Number(process.env.CMC_CLOSE_TIMEOUT_MS) > 0
  ? Number(process.env.CMC_CLOSE_TIMEOUT_MS)
  : 25000;

// Runs the script above and parses its one JSON line. Rejects nothing: like every
// other export here it resolves to a result object.
function runCloseWindow(baseName) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      // -EncodedCommand for the same reason the wt commands use it: the payload
      // carries quotes, newlines and a C# type definition, and base64 cannot be
      // re-split or codepage-mangled on the way through.
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(closeWindowScript(baseName))],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ matched: -1, error: 'Timed out looking for the VS Code window.' });
      }, CLOSE_QUERY_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ matched: -1, error: String(error) });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
        try {
          finish(JSON.parse(line || ''));
        } catch {
          finish({ matched: -1, error: 'Could not read the window query result.' });
        }
      });
    } catch (error) {
      finish({ matched: -1, error: String(error) });
    }
  });
}

// Closes the VS Code window showing `folderPath`. Async, unlike the rest of this
// module, because the only honest answer needs the window query's result back.
//
// Refuses unless WE opened that folder (see openedEditors above), which is the
// scope boundary the developer chose: this must never propose closing an editor
// they opened by hand.
export async function closeEditor(folderPath) {
  try {
    const raw = folderPath === undefined || folderPath === null ? '' : String(folderPath);
    if (!raw.trim()) return { ok: false, reason: 'bad-folder', error: 'No folder to close.' };
    const folder = path.resolve(raw);
    if (!hasOpenedEditor(folder)) {
      return {
        ok: false,
        reason: 'not-ours',
        error: 'Mission Control did not open a VS Code window for this folder, so it will not close one.',
      };
    }
    const baseName = path.basename(folder);
    if (!baseName) return { ok: false, reason: 'bad-folder', error: 'That folder path has no name to match.' };

    if (process.env.CMC_DRY_RUN) {
      // Report the shape without touching any window, exactly as the launch paths do.
      forgetOpenedEditor(folder);
      return { ok: true, folder, baseName, closed: true, script: closeWindowScript(baseName), dryRun: true };
    }

    const result = await runCloseWindow(baseName);
    if (result.matched === 1) {
      // Forget it either way: the window is gone, or VS Code is asking about
      // unsaved files and the developer owns the outcome from here. Keeping the
      // record would leave a Close button that can no longer do anything useful.
      forgetOpenedEditor(folder);
      return { ok: true, folder, baseName, closed: !!result.gone, title: result.title || null };
    }
    if (result.matched === 0) {
      // Already closed by hand: drop the record so the button stops offering it.
      forgetOpenedEditor(folder);
      return { ok: false, reason: 'no-window', error: 'No open VS Code window for ' + baseName + ' (already closed?).' };
    }
    if (result.matched > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        error:
          result.matched + ' VS Code windows are showing a folder called "' + baseName +
          '", so Mission Control will not guess which one to close.',
      };
    }
    return { ok: false, reason: 'spawn-failed', error: result.error || 'Could not query the open windows.' };
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', error: String(error) };
  }
}

// ---- Closing a session, terminal tab and all ------------------------------------
//
// There is no `wt close-tab` in the Windows Terminal command line (checked against
// 1.24), and there is no Claude Code CLI that ends another session, so the only
// mechanism is to end the process that OWNS the tab. Windows Terminal closes a tab
// when its hosted process exits, so killing that process closes exactly that tab.
//
// The chain a Mission Control launch produces, verified live:
//   claude.exe  ->  powershell.exe  ->  WindowsTerminal.exe
// (the hosted PowerShell exists because launchSession runs `powershell -NoExit
// -EncodedCommand`, which is what makes the tab survive Claude exiting.)
//
// **The WindowsTerminal.exe process is never touched.** One process hosts every
// tab of a window, so killing it would take down all the developer's other sessions
// with it. We kill the tab's own shell subtree instead (`taskkill /T` on the
// PowerShell pid, which takes claude.exe with it), and only after confirming the
// grandparent really is WindowsTerminal.exe. Anything else (a session started from
// a VS Code integrated terminal, from an SSH shell, or nested in something we do not
// recognise) falls back to ending just the Claude process, because killing an
// unrecognised parent shell could take out a window full of unrelated work.
//
// This is a force kill: Claude Code gets no chance to run its SessionEnd hook or to
// write anything. That is why the only caller is behind an in-app confirm.
const TAB_SHELL_NAMES = ['powershell.exe', 'pwsh.exe', 'cmd.exe'];
const WT_PROCESS_NAME = 'windowsterminal.exe';

function closeSessionScript(pid) {
  return [
    "$ErrorActionPreference = 'Continue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    // `$pid` is a read-only automatic variable in PowerShell, so the target pid
    // must never be called that: assigning it throws "Cannot overwrite variable PID".
    '$target = ' + String(pid),
    '$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $target" -ErrorAction SilentlyContinue',
    'if ($null -eq $proc) { Write-Output (ConvertTo-Json -Compress @{ found = $false }); exit 0 }',
    // Captured BEFORE the kill so the "did it really go away" check below cannot be
    // fooled by Windows handing the same pid to a brand new process.
    '$born = $proc.CreationDate',
    '$parent = $null',
    '$grand = $null',
    'if ($proc.ParentProcessId) { $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue }',
    'if ($parent -and $parent.ParentProcessId) { $grand = Get-CimInstance Win32_Process -Filter "ProcessId = $($parent.ParentProcessId)" -ErrorAction SilentlyContinue }',
    '$shells = @(' + TAB_SHELL_NAMES.map((n) => psQuote(n)).join(', ') + ')',
    '$kill = $target',
    "$mode = 'session-only'",
    'if ($parent -and $grand -and ($shells -contains $parent.Name.ToLower()) -and ($grand.Name.ToLower() -eq ' + psQuote(WT_PROCESS_NAME) + ')) {',
    // The tab's own shell, never $grand: that is the Windows Terminal process, which
    // hosts every other tab in the window too.
    '  $kill = $parent.ProcessId',
    "  $mode = 'tab-closed'",
    '}',
    'taskkill /PID $kill /T /F | Out-Null',
    '$code = $LASTEXITCODE',
    'Start-Sleep -Milliseconds 400',
    '$still = Get-CimInstance Win32_Process -Filter "ProcessId = $target" -ErrorAction SilentlyContinue',
    '$gone = ($null -eq $still) -or ($still.CreationDate -ne $born)',
    'Write-Output (ConvertTo-Json -Compress @{ found = $true; mode = $mode; killed = $kill; exit = $code; gone = $gone })',
  ].join('\n');
}

// Same never-rejects contract as runCloseWindow above.
function runCloseSession(pid) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(closeSessionScript(pid))],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ error: 'Timed out closing that session.' });
      }, CLOSE_QUERY_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', (error) => { clearTimeout(timer); finish({ error: String(error) }); });
      child.on('close', () => {
        clearTimeout(timer);
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
        try {
          finish(JSON.parse(line || ''));
        } catch {
          finish({ error: 'Could not read the result of closing that session.' });
        }
      });
    } catch (error) {
      finish({ error: String(error) });
    }
  });
}

// Ends the Claude process `pid` and, when it is hosted in a Windows Terminal tab we
// can positively identify, that tab with it. `pid` comes from Claude Code's own live
// registry (~/.claude/sessions/<pid>.json), resolved server side, so a page can
// never name a process to kill.
export async function closeSession(pid) {
  try {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) {
      return { ok: false, reason: 'no-pid', error: 'No running process is known for this session.' };
    }
    if (process.env.CMC_DRY_RUN) {
      return { ok: true, pid: target, mode: 'tab-closed', closed: true, script: closeSessionScript(target), dryRun: true };
    }
    const result = await runCloseSession(target);
    if (result.error) return { ok: false, reason: 'spawn-failed', error: result.error };
    if (result.found === false) {
      // Already gone: the developer closed it between the card rendering and the
      // click. Nothing to do, and nothing went wrong.
      return { ok: true, pid: target, mode: 'already-gone', closed: true };
    }
    if (!result.gone) {
      return {
        ok: false,
        reason: 'still-running',
        error: 'That session is still running (exit code ' + result.exit + ' from taskkill).',
      };
    }
    return { ok: true, pid: target, mode: result.mode || 'session-only', killed: result.killed, closed: true };
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', error: String(error) };
  }
}

// `name` is an optional user-supplied session name. When given it becomes both the
// Claude display name (`claude --name`, shown in the prompt box, the /resume picker
// and the terminal title) and the tab title, so the tab, Claude and the session card
// all agree on one label. The sanitised value is stored on the managedTabs entry so
// bindSession() can hand it back to the server once the session id exists.
// `accountKey`, when given and valid, pins the launched session to that
// GitHub account (see GH_ACCOUNTS/resolveAccount above); otherwise the
// account is derived from repoPath (defaultAccountForPath). Never trust
// accountKey blindly: resolveAccount() only ever returns a fixed registry
// entry or null, so an invalid/garbage key silently falls back to the path
// default rather than reaching the command string.
export function launchSession(repoPath, title, name, accountKey) {
  try {
    clearStaleManagedTabsIfWindowGone();
    const account = resolveAccount(accountKey) || defaultAccountForPath(repoPath);
    const launchName = sanitizeSessionName(name);
    // The fallback title is a folder name (or anything a caller sent), so it
    // goes through the same sanitizer as a typed name: it lands on the wt
    // command line as --title and is what bringToForeground() matches on.
    const tabTitle = launchName || sanitizeSessionName(title) || 'claude';
    const script = psClaudeScript(launchName, account);
    const args = [
      '-w', WT_WINDOW, 'nt', '-d', repoPath, '--title', tabTitle,
      'powershell.exe', '-NoExit', '-EncodedCommand', encodePsCommand(script),
    ];
    // Quote the repoPath (index 4) and title (index 6): the values that may
    // contain spaces. Everything else, including the base64 payload at index 10,
    // stays bare for readability (base64 needs no quoting, and quoting it would
    // suggest the payload could contain something that does).
    const command = buildReadableCommand(args, new Set([4, 6]));
    const offender = firstSemicolonArg(args);
    if (offender) return { ok: false, error: semicolonError(offender) };
    const tabIndex = managedTabs.length;
    const entry = { sessionId: null, cwd: repoPath, title: tabTitle, launchName, launchedAt: Date.now(), tabIndex };

    // `script` is the decoded payload of `command`, returned so a log or a test
    // can read what the tab actually runs without decoding base64 by hand.
    // `command` still reflects the REAL args, so a dry run cannot look right
    // while the live command differs.
    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      enforceManagedTabsCap();
      return { ok: true, command, script, account: account.login, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    saveManagedTabs();
    enforceManagedTabsCap();
    return { ok: true, command, script, account: account.login };
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

    // --title lets bringToForeground() find the right window afterwards by
    // its active tab title.
    const sanitizedTitle = sanitizeSessionName(title);
    const tabTitle = sanitizedTitle || 'resume:' + sessionId;
    // A resumed session must not silently fall back to whatever account the
    // shared global git config happens to have: resolve it from the session's
    // own cwd, same rule as a fresh launch.
    const account = defaultAccountForPath(cwd);
    // PowerShell hosts the tab for the same reasons as launchSession (profile
    // loads, the tab survives Claude exiting). No --name here: the resumed
    // session already carries whatever display name it was given.
    const script = psScript([...ghEnvStatements(account), 'claude --resume ' + sessionId]);
    const args = [
      '-w', WT_WINDOW, 'nt', '-d', cwd, '--title', tabTitle,
      'powershell.exe', '-NoExit', '-EncodedCommand', encodePsCommand(script),
    ];
    // Quote the cwd (index 4) and title (index 6): the values that may contain
    // spaces. Everything else, including the base64 payload at index 10 that
    // carries the sessionId, stays bare.
    const command = buildReadableCommand(args, new Set([4, 6]));
    const offender = firstSemicolonArg(args);
    if (offender) return { ok: false, error: semicolonError(offender) };

    // Any prior entries bound to this session now point at a tab we are about
    // to replace: null them out so a future focus resolves to the fresh tab
    // instead of the stale one. Entries are never removed, since tabIndex is
    // each entry's position in managedTabs and removing one would desync every
    // later index from its real tab. Done only once the reattach is certain to
    // proceed, so a refused reopen leaves the existing binding alone.
    for (const tab of managedTabs) {
      if (tab.sessionId === sessionId) tab.sessionId = null;
    }

    const tabIndex = managedTabs.length;
    const entry = { sessionId, cwd, title: tabTitle, launchName: '', launchedAt: Date.now(), tabIndex };

    // `script` mirrors launchSession: the decoded payload of `command`.
    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      enforceManagedTabsCap();
      return { ok: true, mode: 'reattached', command, script, account: account.login, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    saveManagedTabs();
    enforceManagedTabsCap();
    bringToForeground(tabTitle);
    return { ok: true, mode: 'reattached', command, script, account: account.login };
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
