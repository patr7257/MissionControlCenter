# CLAUDE.md - Mission Control Center

Project instructions for Claude. Read this first each session.

## What this is
A local command center for Claude Code. Today it is a live dashboard of a single session's
subagents (professional lanes + a Humaaans "Office" scene, combined per session). It is being extended into a machine-wide
manager of all running Claude Code sessions across projects, with click-to-jump-to-terminal.
See `docs/plans/` and `docs/specs/` for the design and roadmap.

## Hard constraints (do not violate)
- **Zero runtime dependencies.** Server uses only Node built-ins (`http`, `fs`, `path`, `os`,
  `url`). Front-end is plain browser JS + CSS + inline SVG. No npm packages, no build step, no
  CDN, no external network calls at runtime. It must work fully offline.
- **Windows-first, PowerShell-safe.** The developer pastes commands into Windows PowerShell.
  Give copy-pastable single-line commands, or write a script file and give one line to run it.
  Never rely on fragile multi-line pasted blocks.
- **No em dashes or en dashes anywhere** (code, comments, UI copy, docs). Use a comma, colon,
  parentheses, or a single hyphen.
- **Danish text uses real letters** æ/ø/å (never ae/oe/aa) when any Danish appears.
- **No secrets in the repo.** Runtime data (lock file, event log) lives under
  `~/.claude/agent-fleet-monitor/`, outside this repo, and is gitignored if it ever appears here.

## Architecture
- `server.mjs` - zero-dependency Node server: serves `public/**`, a Server-Sent Events stream
  (`/stream`), and ingests Claude Code hook events (`POST /event`). Keeps an in-memory model that
  is also persisted to `~/.claude/agent-fleet-monitor/sessions.json` (debounced writes, skipped
  under `CMC_DRY_RUN`) so a restart rehydrates the board instead of starting empty. On load it
  prunes entries older than 7 days (24h for ended sessions), caps the file at 200 newest, and
  downgrades any in-flight status (`working`/`awaiting`/`needs-permission`) to `recent` + not-live
  since a persisted session was not seen live this run; hooks re-upgrade it on the next event.
  Rehydrate runs before the backfill scan (which skips ids already present) and before hooks fire.
- Hooks: `install-hooks.mjs` merges a set of hooks into `~/.claude/settings.json` while active;
  `uninstall-hooks.mjs` removes exactly those; `send-event.mjs` is the per-hook shim that POSTs
  to the server and no-ops instantly when the server is down. `start.mjs` / `stop.mjs`
  orchestrate.
- Front-end (`public/`): `store.js` (data + SSE + view registry), `view-cards.js` (professional
  lanes) and `view-office.js` (2.5D office scene), `humaaans.js` (recolorable character SVG
  templates), `style.css`, `index.html` (shell). There is no top-level Pro/Office toggle: the two
  registered views are `sessions` (the board) and `detail` (a single combined per-session view that
  renders the lanes AND the office scene together in `#viewDetail`). The combined view delegates to
  `ViewCards` and `ViewOffice` (defined in their files but no longer registered separately) and is
  only ever activated by `Store.selectSession`, so it never shows without a selected session.
- The view interface: `{ id, el, activate(snap), deactivate(), reset(snap), update(agent) }`.
  Only the active view receives updates. Both `ViewCards` and `ViewOffice` scope to the selected
  session via `Store.visibleAgents()` (agents carry `parentSession`).

## How it runs as a skill
This repo is junction-linked into `~/.claude/skills/agent-fleet-monitor` (a Windows directory
junction). Claude Code loads it as a skill from that path; the absolute path
`C:/Users/pr/.claude/skills/agent-fleet-monitor/...` is what the skill's own scripts and hook
commands reference, and the junction keeps that path valid while the code lives here under git.
Do not hardcode the repo path in skill-run code; keep using the skill path so the junction stays
transparent.

## Run / stop
- `node start.mjs` (installs hooks, starts server, opens http://localhost:4317)
- `node stop.mjs` (removes hooks, stops server)

## Multi-session manager (built; pending live validation)
Discovery uses user-level Claude Code hooks (SessionStart / UserPromptSubmit / Stop /
Notification / SessionEnd) that fire for every session, plus a backfill scan of
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, `~/.claude/history.jsonl`, and live-status
signals from `~/.claude/ide/*.lock`. Terminal launch/focus uses Windows Terminal
(`wt -w cmc ...` for a managed window; `claude --resume <id>` to reattach). Note: Claude does not
store custom terminal tab titles, so session labels derive from project + branch + last prompt.

Status: implemented and reviewed across four phases (server sessions model + discovery/backfill +
session hooks; `view-sessions.js` Sessions board with per-session drill-in; `terminal.mjs` launch/
focus/resume + `/repos` `/launch` `/focus` endpoints; polish + docs). Verified headlessly
(serve-and-check, dry-run of the `wt` commands, a final whole-branch review). Files:
`server.mjs`, `terminal.mjs`, `public/view-sessions.js` (+ `store.js`/`view-cards.js`/`view-office.js`
edits), `install-hooks.mjs`. Design and findings in `docs/plans/2026-07-02-multi-session-manager.md`
and `docs/specs/session-discovery-findings.md`.

## Click-to-focus (one click on a session card)
Clicking anywhere on a session card in the Sessions board calls `POST /focus` and jumps to that
session's terminal; a small "Details" button (top right, shown on hover) drills into the
combined per-session subagent view instead (`Store.selectSession`). `terminal.focusSession()` in
`terminal.mjs` NEVER spawns a tab: it only has two outcomes, `mode:'focused'` (a tab bound to this
session, `wt -w cmc focus-tab -t <index>`, either bound earlier by a hook or lazily adopted on
this very call) or `ok:false, mode:'unmanaged'` (nothing to jump to). Lazy adopt: if no tab is
bound to the session but exactly one unbound tab (`sessionId === null`) matches the session's cwd
(via the realpath-aware `normalizePath`), that tab is adopted and focused; with zero or 2+
candidates it falls through to unmanaged rather than guess. The frontend shows a toast ("Terminal
not managed by mission control.") for the unmanaged case and never throws a visible error either
way; it also adds an `unmanaged` class to the card, which reveals a confirm-gated "Reopen" button
in place of "Details".

Opening a brand new tab and resuming into it (`claude --resume <id>`) only happens through the
explicit `reopenSession()` export plus `POST /reopen`, wired to that Reopen button. The button
first asks `window.confirm(...)`, so a duplicate tab now requires a deliberate, confirmed action
instead of being a side effect of an ordinary card click. `reopenSession()` nulls the `sessionId`
on any prior `managedTabs` entries bound to that session first (never removes them, since
`tabIndex` is each entry's position in the array) so a later focus resolves to the fresh tab.

Binding (`bindSession()`, called from the `SessionStart` hook and retried on every
`UserPromptSubmit`) matches an unbound tab by cwd within `BIND_WINDOW_MS` (180s, generous enough
for a cold `wt` plus `claude` startup) of when it was launched; the `UserPromptSubmit` retry exists
because a single missed `SessionStart` bind used to make every later click on that card a
duplicate-tab click forever. `clearStaleManagedTabsIfWindowGone()` (via `isWtRunning()`, a
`tasklist` check for any `WindowsTerminal.exe` process) wipes `managedTabs` whenever zero WT
processes exist, so a closed-and-reopened cmc window starts clean instead of pointing at stale tab
indices; it fails open (assumes WT is running) on any error, and is a no-op that always sees
"running" under `CMC_DRY_RUN` so test runs never touch persisted state.

Known-minor limitation: `isWtRunning()` only proves the cmc window is gone when ZERO
`WindowsTerminal.exe` processes exist anywhere on the machine. With other WT windows open, a stale
`focus-tab` could still target a gone cmc window in that narrow case; a per-window-title check
would cost 300ms+ per click, so this is accepted rather than engineered around.

Because `wt` reuses a single process per named window, a background process (this Node server)
asking it to switch tabs is not always allowed by Windows to steal focus. `bringToForeground()` in
`terminal.mjs` follows every `wt focus-tab`/`wt ... --resume` call with a best-effort PowerShell
nudge: `Add-Type` the `user32.dll` `ShowWindow`/`SetForegroundWindow` signatures, find the
`WindowsTerminal` process whose active tab title (every launch/reattach sets `--title`) matches,
restore it if minimized (`SW_RESTORE`), then force it to the foreground. Best effort only, matched
by title since there is no per-tab PID to target. The match is exact-first (`MainWindowTitle -eq
<title>`) and only falls back to the broad `-like '*<title>*'` wildcard when no exact match exists,
so an unrelated WT window whose tab title merely contains the string is no longer raised in the
common case.

`managedTabs` (the tab-index bookkeeping in `terminal.mjs`) is persisted to
`~/.claude/agent-fleet-monitor/managed-tabs.json` (skipped under `CMC_DRY_RUN`) so a server
restart does not desync `tabIndex` from the real tab positions in a still-open managed window.

Still pending (not code-complete):
- **Live terminal validation on the real machine.** The `wt` launch/focus/`--resume` reattach and
  the `SetForegroundWindow` nudge were only exercised in `CMC_DRY_RUN` mode plus a headless
  serve-and-check; opening/focusing real Windows Terminal tabs must be confirmed by hand,
  including whether the foreground nudge actually raises the window versus just flashing the
  taskbar icon.

Landed 2026-07-19 (PRs #3, #4, #6, #8):
- **Demo mode.** `public/demo.js` (zero-dep) drives the whole UI through a looping scripted fake
  fleet with no server, activated by `?demo=1` (see `public/index.html` boot). `store.js` exposes
  `Store.ingest` (the shared SSE/demo dispatch) for it. Used as the offline showcase and the
  visual dev harness. The real SSE path is untouched without the flag.
- **Cinematic office.** The 2.5D office is no longer a first pass: ambient life (breathing idle,
  potted plants, wall clock, slow day/night wash), per-tool on-monitor desk FX, a head-of-room
  orchestrator with glowing connection threads, and a session-complete confetti burst. All vanilla
  CSS/SVG, gated behind `prefers-reduced-motion`. See `docs/office-humaaans-status.md`.
- **Known-minor backlog fixed.** `terminal.mjs` `managedTabs` now has a `MAX_MANAGED_TABS`
  bounded-on-safe-reset cap (positional `tabIndex` invariant kept); a subagent-only session derives
  its status from live children instead of sitting on `working` (server.mjs `sawTopLevel`); an empty
  model line is hidden in `view-sessions.js`. Covered by `scripts/smoke-server.mjs`.
- **Deep repos picker.** `~/repos` was refactored into category folders (1-Personal, 2-ZRM, ...)
  whose children (and their children) are the real projects. `terminal.listRepos()` now returns
  `{ root, tree }` (a bounded folder tree, dot-folders and noise dirs like `node_modules` excluded,
  capped at 5 levels / 4000 nodes), and the New session bar renders one dropdown per level, each
  defaulting to "Not selected", launching in the deepest folder actually selected (or the root).

## Desktop app (Electron), the sanctioned exception to zero-dependency
`desktop/` wraps the unchanged backend in an Electron window and packages it as a Windows MSI.
The zero-runtime-dependency rule still applies to the server and `public/` UI; `desktop/` is the
one place where npm devDependencies (electron, electron-builder) are allowed. Key facts:
- `desktop/main.mjs` spawns `../server.mjs` detached with `ELECTRON_RUN_AS_NODE=1` (lock file,
  `stop.mjs`, and the shim keep working unchanged) and loads `http://127.0.0.1:4317`.
- Shutdown: closing the window (X), the Fleet menu "Quit", and "Stop server and remove hooks" all
  run the same guarded teardown (`stopServerAndRemoveHooks` -> `stop.mjs`: stop the detached server
  via the lock file + remove hooks, then `app.quit()`). It runs once per session and always quits
  even if `stop.mjs` fails. A fresh launch re-installs hooks and restarts the server. (This replaced
  the old survive-close behavior where the detached server kept running after the window closed.)
- Packaged installs register hooks via `resources\backend\send-event.mjs.cmd` (Electron-as-Node
  wrapper, no system Node needed); `install-hooks.mjs` honours the `CMC_HOOK_COMMAND` env
  override for this. The filename contains `send-event.mjs` on purpose so `SHIM_MARK` matching
  still works.
- MSI via electron-builder; the `upgradeCode` GUID in `desktop/electron-builder.yml` must NEVER
  change (it is what makes a newer MSI upgrade in place).
- Native notifications: `desktop/main.mjs` subscribes to the server's `/stream` SSE and raises an
  Electron `Notification` when a session transitions into `needs-permission` or `awaiting` (one
  toast per transition; the initial snapshot and any reconnect only seed known statuses, so
  pre-existing blocked sessions do not all fire at once). Clicking the toast `POST /focus`es that
  session's terminal and raises the app window. This lives only in the desktop shell; the server
  stays zero-dependency.
- Releases: publish a GitHub release tagged `fleet-vX.Y.Z` on THIS repo
  (`patr7257/claude-mission-control`, since the 2026-07-15 monorepo split) and
  `.github/workflows/fleet-desktop-msi.yml` builds and attaches the MSI. See `desktop/README.md`.
  Installs older than the split check the former monorepo for updates and will not see new
  releases; upgrade those once by installing a fresh MSI from this repo by hand.
- Auto-update: `desktop/update-check.mjs` detects a newer `fleet-v*` tag AND downloads its MSI via
  the locally authenticated `gh` CLI (`gh release download`, no baked-in token). The banner and the
  Fleet menu offer "Download & install"; accepting downloads the MSI, launches `msiexec /i`, and
  quits so the in-place upgrade is not blocked. The banner button reaches the main process through
  `desktop/preload.cjs` (contextBridge `window.cmcUpdate.install()` -> `ipcMain` `cmc:install-update`).
  Falls back to the releases page on any gh failure. Verified end-to-end on 2026-07-13: an installed
  0.1.1 showed the banner and self-updated to 0.1.2 via "Download & install" (gh download + msiexec).

## CI
`.github/workflows/ci.yml` runs on PRs and pushes to `main` (separate from the release MSI
builder). It `node --check`s every `*.mjs` in the repo and boots the server via
`scripts/smoke-server.mjs` (hermetic temp HOME, checks `/`, `/repos`, `/stream`, one hook event).
Zero-dependency, so there is nothing to install. `scripts/smoke-server.mjs` also runs locally:
`node scripts/smoke-server.mjs`.

## Docs
- `docs/plans/` - implementation plans.
- `docs/specs/` - design specs.
- `docs/office-humaaans-status.md` - current visual-tuning status of the Office view.
