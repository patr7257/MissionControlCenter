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
  orchestrate. `removeHooks()` returns `{ hooks, statusline }`, not a bare count, because a run
  can restore the statusLine while removing zero hooks; use `describeRemoval()` to report it.
- Statusline wrap (the SECOND thing we mutate in `~/.claude/settings.json`, see "Usage feed"):
  `install-hooks.mjs` also repoints `settings.statusLine` at `statusline-feed.mjs`, recording the
  user's real value verbatim in `~/.claude/agent-fleet-monitor/statusline-original.json` first
  (`{had:false}` when there was none, so uninstall can tell "there was nothing" from "there was
  this"). Idempotent: a second install never re-records over its own wrapper. Honours
  `CMC_STATUSLINE_COMMAND` exactly as hooks honour `CMC_HOOK_COMMAND`. Uninstall only acts when
  the current command still contains `STATUSLINE_MARK`, so a statusLine changed by hand while we
  were installed is never clobbered.
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
(`wt -w cmc ...` for a managed window; `claude --resume <id>` to reattach). Every tab is hosted by
`powershell.exe -NoExit -Command <claude ...>` rather than running `claude` as the tab's own
process, so the developer's PowerShell profile loads and the tab survives Claude exiting (prompt
plus scrollback intact) instead of vanishing. Session labels derive from project + branch + last
prompt, unless the session was named at launch (see "Named sessions" below).

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
- **Packaged desktop installs cannot feed the statusline yet.** The quota meters and the
  context-window rings stay blank in an MSI install until a `statusline-feed.mjs.cmd`
  Electron-as-node wrapper exists in `desktop/assets/`, mirroring `send-event.mjs.cmd`, and
  `desktop/main.mjs` sets `CMC_STATUSLINE_COMMAND` to it the way it already sets
  `CMC_HOOK_COMMAND`. Running the repo copy (`node start.mjs`) is unaffected and does feed it.
- **Live focus/reattach validation on the real machine.** Launching is confirmed by hand
  (2026-07-30): a real tab opened in the managed `cmc` window, hosted by
  `powershell.exe -NoExit -Command "claude --name '<name>'"` with `claude.exe --name "<name>"`
  as its child and the name as the tab title, and a named `POST /launch` reached the board as
  `session.title`. Still unconfirmed by hand: `wt focus-tab`, the `claude --resume` reattach path,
  and whether the `SetForegroundWindow` nudge really raises the window versus just flashing the
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

## Usage feed: context window and 5h/7d quota (`statusline-feed.mjs`)
The 5-hour and 7-day rate-limit windows and the true context-window percentage are in NO hook
payload, in NO transcript, and there is no `claude usage` subcommand. The only local source is the
JSON Claude Code pipes on stdin to the configured `statusLine` command, which carries
`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` (`resets_at` in unix SECONDS),
`context_window.{used_percentage,total_input_tokens,context_window_size}`,
`model.{id,display_name}` (`display_name` is the human readable "Opus 5") and `session_name`.
Do not go looking for another source; the OAuth usage endpoint would break the
zero-network-at-runtime rule.

`statusline-feed.mjs` wraps the user's real statusline: it reads stdin once, spawns the recorded
original command with `shell: true` (it is a command STRING, not argv) piping the same stdin in and
its stdout straight out, exits with the child's code, and IN PARALLEL fire-and-forget POSTs the
payload to `/statusline`. It must never `process.exit(0)` eagerly the way `send-event.mjs` does,
since that would kill the child before it prints, and it deliberately has NO safety-net timeout
because killing the child early would truncate the statusline. Three record outcomes are distinct
on purpose: a real command runs it, `{had:false}` prints nothing (correct, the user had no
statusline), and a missing or unreadable record prints a one-line "record missing" hint rather than
silently blanking a statusline the user does have.

Wire additions: sessions carry `modelDisplay`, `ctxPct`, `ctxTokens`, `ctxSize`, `usageAt`; the
snapshot carries `usage: { fiveHour:{pct,resetsAt}, sevenDay:{pct,resetsAt}, at }` (ms epoch) and
there is a new `{ type:'usage' }` SSE frame. Known and accepted: the statusline only re-runs when a
session renders, so with everything idle the quota freezes; the UI dims the meters and shows an age
once `usage.at` is over 5 minutes old rather than implying the number is current. A `refreshInterval`
was deliberately NOT added (it would boot a node process per session every N seconds). Packaged
desktop installs still need a `statusline-feed.mjs.cmd` Electron-as-node wrapper, mirroring
`send-event.mjs.cmd`, before the meters populate there.

## Status freshness: why a card used to lie about needing input
Claude Code notifies when it ASKS for permission and never when you ANSWER, and `PreToolUse` for
the main session used to be dropped (`if (!agentId) return`). So after an approval the session
worked for minutes while the board still said `NEEDS PERMISSION`, clearing only on the next `Stop`
or prompt. Two layers now fix it:
- **Instant:** main-session tool events (no `agent_id`) move `awaiting`/`needs-permission` to
  `working` via `unblockMainSessionOnToolActivity()`. These fire on every tool call, so broadcasts
  happen only on real change and pure activity refreshes are throttled (4s).
- **Authoritative:** `reconcileSessionRegistry()` polls `~/.claude/sessions/<pid>.json`, Claude
  Code's own live registry (`status`, `waitingFor`, `statusUpdatedAt`, `name`, `sessionId`, `cwd`),
  every 2500ms (`CMC_REGISTRY_POLL_MS`, measured ~3.7ms per tick over 5 files). `busy`/`running`
  map to working, `waiting`/`idle`/`blocked` to waiting-ish, anything unrecognised changes nothing
  and logs once. Precedence matters: `busy` always wins (this is what kills the stale badge), but
  `waiting` must NOT overwrite the more specific `needs-permission`. A present file with a live pid
  (`process.kill(pid, 0)`, treating `EPERM` as alive) means `live:true`; a vanished file clears
  `live` and degrades an in-flight status to `recent`, never to `ended` (`SessionEnd` owns that). A
  `statusUpdatedAt` older than 5 minutes still proves the session runs but its status is not
  trusted. This registry is also strictly better than the old `ide/*.lock` `isCwdLive` heuristic and
  hands over each session's name for free.

## Startup defaults of the Sessions board (fixed, deliberately not remembered)
The board always opens in the same state, so a launch never needs the controls re-set by hand:
- Repos picker (now inside the New session popup, not a permanent bar): `DEFAULT_REPO_CHAIN` in
  `view-sessions.js` (`['2-ZRM', 'customers']`) is preselected
  level by level, matching folder NAMES case-insensitively; a missing name just stops the walk and
  leaves "Not selected". `loadRepos()` refetches `/repos` only when no real chain is on screen, so
  reopening the popup no longer wipes the current selection.
- Show filters: fixed `{ state: 'active', time: 'today', repo: '' }`. The three former
  `fleetFlt*` localStorage keys are gone on purpose: a stale stored value silently overrode the
  default. In-session changes still work, they just do not carry to the next app open. The state
  dropdown also offers `needs-input` and the time dropdown a 7 day window.

## Sessions board UI (the "Editorial" card, chosen from 5 rendered candidates)
Design record: `https://claude.ai/code/artifact/d611c0ef-2208-4da3-90fb-4334b3d49e40` (variant 05).
- **Card layout**, one concern per line, nothing overlapping: uppercase mono status line with a
  glowing pip, 18px title (the session name, else the project), a mono line underneath that never
  repeats the heading (named cards show `project / branch`, unnamed cards show the branch alone), the
  prompt as a 2-line-clamped pull quote, and a hairline footer with mono meta left and the action
  buttons right. `.sc-details`/`.sc-reopen` are NOT absolutely positioned any more; that overlay was
  the original overlap bug.
- **CSS GOTCHA, do not undo:** `.session-card` sets `grid-template-columns: minmax(0, 1fr)`. A bare
  implicit `auto` column takes its growth limit from max-content and free-space distribution only
  ever GROWS tracks, so a long session name sized the column past the card (measured: a 538px track
  in a 432px card), pushing the context ring and buttons outside the card where `overflow:hidden` ate
  them, at every window width. The `min-width:0` on `.sc-h` and the ellipsis on `.sc-title` only work
  once the track is clamped. This was invisible to static review and only showed up under a real
  render.
- **Status colour is CSS-owned** via the `status-*` class and a `--sc` custom property. The old
  inline `dot.style.background` write is gone; reintroducing it would beat every stylesheet rule.
  `needs-permission` is coral `--perm` (`#ff8a5c`), no longer sharing amber with `working`, since the
  one state that demands action must not look like the one that does not.
- **Severity ramp** (`.lo`/`.mid`/`.hi` setting `--sev`) is shared by the card's context ring and the
  top-bar quota rings: under 60 accent blue, 60 to 85 amber, 85 and over `--error`. Semantic colour,
  deliberately separate from the accent.
- **New session is a green button in `.nav`** next to Sessions, opening a modal (`#newSessionBackdrop`
  holds the visibility, the panel inside does not) with the cascading repo picker, Name and Launch.
  Esc and backdrop close it, focus goes to the Name field on open and back to the opener on close.
  The picker functions were MOVED, not rewritten; only the host element and `ns-select` -> `sel`
  changed.
- **The attention pill is a filter control**, not a badge: clicking it calls
  `ViewSessions.setStateFilter('needs-input')` and syncs the visible `<select>`. When the blocked
  count hits zero the filter self-heals back to `active`, but it leaves a manual choice alone.
  `Store.needsInput(s)` is the single shared predicate behind the counter and the filter.
- **Resume on closed cards** POSTs `/reopen` with NO confirm (there is no duplicate-tab risk for a
  closed session); `Reopen` keeps its confirm and only appears on an active card whose focus attempt
  came back `unmanaged` (gated by the `is-active` class). `terminal.reopenSession(id, cwd, title)`
  titles the resumed tab with the session name.
- `Store.fmt.model(session)` prettifies `claude-opus-5[1m]` to `Opus 5 (1M)`, preferring the
  server's `modelDisplay`, unknown ids passing through unchanged.
- The four header stat tiles (`working`/`done`/`steps`/`elapsed`) are still subagent-scoped, so they
  read 0 on the board itself. Pre-existing, untouched, and worth revisiting.

## GitHub account per session (why `gh auth switch` must never be used here)
Patrick runs several sessions at once across two GitHub accounts, `patr7257` (personal) and `przrm`
(ZRM work). `gh auth switch` writes the active account to ONE machine-wide file
(`%AppData%\Roaming\GitHub CLI\hosts.yml`), and `~/.gitconfig` routes github.com credentials through
`gh auth git-credential`, so concurrent sessions fought over it and pushes authenticated as the
wrong account. Do not "fix" an account problem with `gh auth switch`; it corrupts every other
running session.

The isolation primitive is `GH_CONFIG_DIR`, which is per process. Two config dirs exist, each with
its own login: `~/.config/gh-personal` and `~/.config/gh-work`.

Two layers, so the right account is used whether or not anything sets an env var:
- **Machine default, by directory.** `~/.gitconfig` pins the credential helper to the personal
  config dir, and an `includeIf "gitdir/i:C:/Users/pr/repos/2-ZRM/"` at the END of the file pulls in
  `~/.gitconfig-zrm`, which resets the helper list and pins the work dir plus the `pr@zrm.dk`
  identity. The include must stay last: `credential.helper` is MULTI-valued and accumulates, so an
  empty `helper =` line is what resets the inherited list. Without the reset the personal helper
  answers first and wins. So: `~/repos/2-ZRM/**` is work, everything else is personal, with no
  session awareness at all.
- **Per session, at launch.** `terminal.mjs` owns `GH_ACCOUNTS` (derived from `os.homedir()`,
  overridable via `CMC_GH_DIR_PERSONAL` / `CMC_GH_DIR_WORK`), `defaultAccountForPath()` (matches
  `matchPath` on path-segment boundaries, case-insensitively, so a repo named `my-2-ZRMish` does not
  match) and `resolveAccount()`. `launchSession(repo, title, name, accountKey)` prepends
  `$env:GH_CONFIG_DIR` plus the four `GIT_AUTHOR_*`/`GIT_COMMITTER_*` vars to the hosted PowerShell
  command, so that tab alone is pinned. Setting the identity vars too is deliberate: otherwise an
  overridden session would authenticate as one account and commit as the other. `reopenSession`
  applies the same prefix, resolved from the session's cwd. `resolveAccount()` is the security
  boundary: only a fixed registry key is ever accepted, since the value lands in a shell command.
  `GET /repos` exposes `accounts` (never the config dir paths) and the New session popup renders a
  GitHub account dropdown that auto-follows the selected folder and can be overridden per launch.

Note `~/.gitconfig` also has `url."https://github.com/".insteadOf = git@github.com:`, which rewrites
SSH remotes to HTTPS. Any future SSH-key-per-account idea has to account for that rewrite, or it
silently ends up back on the shared HTTPS credential path.

## Verification tooling
- `node scripts/smoke-server.mjs` - hermetic temp HOME, boots the server, checks the endpoints, hook
  ingestion, statusline ingestion, registry reconciliation and launch command shapes. Runs in CI.
- `node scripts/render-check.mjs` - drives a REAL Chromium over the Chrome DevTools Protocol using
  Node's built-in global `WebSocket` (no dependencies, nothing installed), asserting card geometry
  across viewport widths, the filters, the popup and the account picker, and collecting console
  errors. SKIPS with exit 0 when no browser is present, so it is deliberately not in CI.
  `--shot <file>` saves a screenshot. This exists because a CSS grid blowout (see the card notes
  above) was invisible to code review and took one real measurement to find. Two traps it encodes:
  `chrome --dump-dom` never returns on this page because the open SSE connection means load never
  completes, and the popup's visibility lives on `#newSessionBackdrop`, not on the panel.

## Named sessions (`claude --name`)
The New session popup has an optional Name field. A name is sanitized in `terminal.mjs`
(`sanitizeSessionName`: strips `" \` ; & | < >`, collapses whitespace, drops a trailing backslash,
caps at 60 chars) and then used twice: as the Windows Terminal tab title, and as
`claude --name '<name>'` inside the PowerShell command, so Claude shows it in the prompt box, the
`/resume` picker and the terminal title. Renaming later is a plain `/rename` inside that session;
Mission Control has no rename-after-the-fact affordance on purpose (there is no way to push a name
into a live session without keystroke injection).

The name reaches the board through the existing deferred join: `/launch` has no session id yet, so
the sanitized name is stored as `launchName` on the `managedTabs` entry, `terminal.bindSession()`
returns it when the session's first hook binds the tab (cwd match inside `BIND_WINDOW_MS`), and
`server.mjs applyLaunchName()` writes it to the previously unused `session.title`, which already
serialized and persisted. `view-sessions.js` renders `s.title` as the card heading (`.sc-name`,
`has-name` demotes the project to the muted line) and the drill-in breadcrumb prefixes it.

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
  (`patr7257/MissionControlCenter`, since the 2026-07-15 monorepo split) and
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
