# CLAUDE.md - Claude Mission Control

Project instructions for Claude. Read this first each session.

## What this is
A local command center for Claude Code. Today it is a live dashboard of a single session's
subagents (Pro cards + a Humaaans "Office" view). It is being extended into a machine-wide
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
  (`/stream`), and ingests Claude Code hook events (`POST /event`). Keeps an in-memory model.
- Hooks: `install-hooks.mjs` merges a set of hooks into `~/.claude/settings.json` while active;
  `uninstall-hooks.mjs` removes exactly those; `send-event.mjs` is the per-hook shim that POSTs
  to the server and no-ops instantly when the server is down. `start.mjs` / `stop.mjs`
  orchestrate.
- Front-end (`public/`): `store.js` (data + SSE + view registry), `view-cards.js` (Pro),
  `view-office.js` (Office), `humaaans.js` (recolorable character SVG templates), `style.css`,
  `index.html` (shell + header toggle).
- The view interface: `{ id, el, activate(snap), deactivate(), reset(snap), update(agent) }`.
  Only the active view receives updates.

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
Pro/Office subagent view instead (`Store.selectSession`). `terminal.focusSession()` in
`terminal.mjs` has three outcomes: `mode:'focused'` (a tab we launched is bound to this session,
`wt -w cmc focus-tab -t <index>`), `mode:'reattached'` (no bound tab but a known cwd, opens a new
tab with `claude --resume <id>`), or `ok:false, mode:'unmanaged'` (no bound tab and no known cwd,
nothing to jump to). The frontend shows a toast ("Terminal not managed by mission control.") for
the unmanaged case and never throws a visible error either way.

Because `wt` reuses a single process per named window, a background process (this Node server)
asking it to switch tabs is not always allowed by Windows to steal focus. `bringToForeground()` in
`terminal.mjs` follows every `wt focus-tab`/`wt ... --resume` call with a best-effort PowerShell
nudge: `Add-Type` the `user32.dll` `ShowWindow`/`SetForegroundWindow` signatures, find the
`WindowsTerminal` process whose active tab title (every launch/reattach sets `--title`) matches,
restore it if minimized (`SW_RESTORE`), then force it to the foreground. Best effort only, matched
by title since there is no per-tab PID to target.

`managedTabs` (the tab-index bookkeeping in `terminal.mjs`) is persisted to
`~/.claude/agent-fleet-monitor/managed-tabs.json` (skipped under `CMC_DRY_RUN`) so a server
restart does not desync `tabIndex` from the real tab positions in a still-open managed window.

Still pending (not code-complete):
- **Live terminal validation on the real machine.** The `wt` launch/focus/`--resume` reattach and
  the `SetForegroundWindow` nudge were only exercised in `CMC_DRY_RUN` mode plus a headless
  serve-and-check; opening/focusing real Windows Terminal tabs must be confirmed by hand,
  including whether the foreground nudge actually raises the window versus just flashing the
  taskbar icon.
- **Office (Humaaans) visual tuning.** The 2.5D office is a first visual pass; see
  `docs/office-humaaans-status.md` for the layout knobs to adjust.
- Known-minor backlog from the final review (all non-blocking): `terminal.mjs` `managedTabs` is
  unbounded by design (tabIndex is positional); a subagent-only session reads "working" until its
  first turn-stop; blank model line if a hook omits `model`; the foreground-nudge title match uses
  a wildcard `-like` and could in theory match an unrelated Windows Terminal window with a
  coincidentally similar tab title.

## Docs
- `docs/plans/` - implementation plans.
- `docs/specs/` - design specs.
- `docs/office-humaaans-status.md` - current visual-tuning status of the Office view.
