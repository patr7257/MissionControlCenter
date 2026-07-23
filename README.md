# Mission Control Center

A local, zero-dependency command center for Claude Code: a machine-wide view of every running
Claude Code session across all your projects, with drill-in to a live per-session subagent
monitor.

Runs entirely offline: a tiny Node server (Node built-ins only, no npm install, no CDN) serves a
self-contained browser dashboard and receives Claude Code hook events over a local port.

## What works today

**Sessions board (machine-wide).** A top-level board of every Claude Code session running
anywhere on the machine, not just the current project. Each session card shows a live status
(working / awaiting input / needs permission / idle-recent / ended), fed by user-level session
hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`) plus a backfill
scan on startup so already-running sessions show up too. The board can be filtered by state
(active vs closed), time (today vs all), and repo. A repo picker launches a new session in
a chosen repo, and each card's Open button focuses or reattaches that session's terminal through
a single managed Windows Terminal window named "cmc" (`terminal.mjs`). Focus is reliable for
sessions the dashboard itself launched; sessions started elsewhere reattach into a fresh "cmc"
tab via `claude --resume` instead of focusing an existing one, best effort only.

**Per-session subagent monitor.** Click Details on a session to drill into one combined view of
just that session's subagents (never a global mix across sessions or repos). Both dashboards render
together in the same area:

- **Professional lanes** - Working / Done / Errors cards: agent type, task, the tool it is using
  right now, elapsed time, steps, and token totals on completion.
- **Office** - a playful 2.5D office where each subagent is an illustrated character (Humaaans)
  that walks in, works at a desk, and moves to a lounge when finished.

It installs a small set of Claude Code hooks while active and removes them when you stop, so
there is zero footprint when it is not running.

## Roadmap

See `docs/` for the design and plan on further polish and additional session-management
features.

## Run it

```
node start.mjs
```

Then open http://localhost:4317 and dispatch some parallel subagents. Stop with:

```
node stop.mjs
```

`start.mjs` installs the hooks and launches the server; `stop.mjs` removes the hooks and stops
the server. Runtime data (a lock file and an event log) lives under
`~/.claude/agent-fleet-monitor/`, outside this repo.

## Desktop app (Windows MSI)

There is also an Electron desktop build that wraps this same backend and installs as a Windows
MSI, with native notifications when a session needs your input. See
[`desktop/README.md`](desktop/README.md) for building, releasing, and installing. Note: the MSI
is unsigned, so Windows SmartScreen shows an "unknown publisher" warning on first run; the
install steps (More info, then Run anyway) are in that README.

## How it is wired as a Claude Code skill

This repo is the source of truth. It is linked into `~/.claude/skills/agent-fleet-monitor` with a
Windows directory junction, so Claude Code loads it as a skill while the code stays here under
version control. The skill activates when you are about to run multiple parallel agents or when
you ask to watch the fleet.

## Credits and license

MIT licensed (see `LICENSE`). Character illustrations use Humaaans by Pablo Stanley (CC-BY); see
`NOTICE`.
