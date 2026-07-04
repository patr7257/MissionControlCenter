---
name: agent-fleet-monitor
description: Use when about to dispatch 2 or more parallel subagents (especially alongside superpowers:dispatching-parallel-agents), when the user asks to "keep an overview of the agents", "show what the agents are doing", "watch the fleet", "monitor the subagents", or mentions a fleet/agent dashboard, or when the user asks to "show all my running Claude sessions", "mission control", or "manage my sessions across projects". Offers to launch a live localhost dashboard that shows every running Claude Code session machine-wide plus, per session, an animated card view of its subagents (type, task, current tool, elapsed time, steps, tokens, status).
---

# Agent Fleet Monitor (Claude Mission Control)

A live, localhost "mission control" view of your Claude Code work. At the top level it is a
machine-wide board of every running session across all your projects; drilling into a session
shows a live, animated card view of that session's subagents: agent type, its task, the tool it
is using right now, an elapsed timer, step count, tokens (when finished), and status. It
complements the built-in FleetView with a richer at-a-glance board in a browser tab.

## How it works (one paragraph)

A tiny zero-dependency Node server (`server.mjs`, Node built-ins only) serves one
self-contained HTML page and a Server-Sent Events stream. Claude Code **hooks**
(`SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`) POST
their payloads to the server via `send-event.mjs`, which updates the live board. The hooks
are added to `~/.claude/settings.json` only while monitoring is active and removed when you
stop. When the server is not running, the hooks no-op instantly, so there is zero overhead
and nothing can slow down or break a normal session.

## Sessions view (machine-wide board)

The dashboard's top level is a Sessions board covering every Claude Code session running
anywhere on the machine, across all repos and projects, not just the current one. Each
session shows as a card with a status: working, awaiting input, needs permission, idle
(recently ended activity), or ended. The board is fed by user-level session hooks
(`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`) plus a backfill
scan on startup, so sessions that were already running before the dashboard launched still
show up.

Clicking a session card drills into that session's Pro/Office subagent detail view (the
same live card/office views described below, scoped to that one session). A repo picker at
the top of the Sessions board launches a new Claude Code session in a chosen repo, and each
card has an Open button that focuses or reattaches that session's terminal.

Terminal focus/launch goes through a single managed Windows Terminal window named "cmc"
(see `terminal.mjs`). Sessions the dashboard itself launched can be focused reliably by tab
index. Sessions started outside the dashboard (an existing terminal, a different tool) are
not bound to a known tab, so Open reattaches them by opening a new "cmc" tab and running
`claude --resume <sessionId>` in the session's working directory. In short: precise tab
focus is reliable only for dashboard-launched tabs; externally started sessions reattach
into a fresh tab instead of focusing an existing one.

## Activation procedure (what you, Claude, should do)

This skill cannot pop up a dialog on its own (hooks do not ask questions). The prompt is
**you** asking the user. Follow this:

1. **Trigger.** When you are about to dispatch 2 or more parallel subagents in one turn (for
   example via `superpowers:dispatching-parallel-agents`, or a fan-out of Explore/Plan/
   general-purpose agents), or when the user explicitly asks for an overview, briefly ask:

   > You are about to run N agents. Want me to launch the Agent Fleet Monitor at
   > http://localhost:4317 so you can watch them live? (yes / no)

   Ask **once**. If the user says no, do not ask again for the rest of the session. If the
   user has a standing preference (in memory or CLAUDE.md), honor it without asking.

2. **On yes, start it.** Run the launcher (it installs the hooks, starts the server only if
   not already running, and opens the browser):

   ```
   node "C:/Users/pr/.claude/skills/agent-fleet-monitor/start.mjs"
   ```

   Then dispatch the parallel agents exactly as you normally would. Cards appear as each
   subagent spawns and update live as they work.

3. **Stop / clean up.** When the batch of agents is done, or the user asks to stop, or the
   session is winding down, remove the hooks and stop the server:

   ```
   node "C:/Users/pr/.claude/skills/agent-fleet-monitor/stop.mjs"
   ```

4. **If nothing shows up**, point the user to `references/troubleshooting.md`.

## Notes

- The dashboard has two live views, switchable in the header: "Pro" (professional cards) and
  "Office" (an isometric Sims-style office where each subagent is an animated character that
  walks in, works at a desk, and moves to a lounge when done). The choice is remembered per
  browser. Both views render from the same live data.
- Live updates require the localhost server; a Claude artifact cannot receive hook data (its
  sandbox blocks all localhost/network calls), so the live view is always a local page.
- Tokens are read from each subagent's transcript when it finishes; while a subagent is
  running the card shows live steps (tool calls) and elapsed time.
- Port defaults to 4317. To use another port, pass `--port <n>` to `start.mjs` (for example
  if 4317 is busy). `stop.mjs` needs no port: it reads the running port from the lock file.
- Hook payload fields and the matcher details are documented in
  `references/hook-payloads.md`.
