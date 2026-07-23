# Plan: machine-wide multi-session manager

Status: approved 2026-07-02. Phase 1 (repo setup) is DONE. Phases 2-4 below remain.

## Goal
Grow this from a single-session subagent monitor into a professional browser overview of ALL
running Claude Code sessions across projects, with live status and click-to-jump to a session's
terminal, so there is no manual juggling of multiple terminal windows and tabs.

## Why custom (native gap)
Anthropic shipped `claude agents` (Agent View: machine-wide CLI/TUI list, background-session
centric, `attach` not click-to-jump, paid-only) and a Desktop app (GUI but only manages sessions
it spawns, single-project focus). Neither is a browser GUI over independently-launched Windows
Terminal tabs with click-to-jump. That gap is the target.

## Decisions
- Build the custom browser manager.
- The dashboard launches sessions into a managed Windows Terminal window (`wt -w cmc ...`) so it
  can focus the exact tab; externally-launched sessions still show and reattach via
  `claude --resume <id>`.
- Repo `MissionControlCenter` (private, patr7257), MIT + Humaaans CC-BY NOTICE. (Done in Phase 1.)

## Phase 2 - Discovery + Sessions overview (read-only, do first)
- `install-hooks.mjs`: add user-level `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`,
  `SessionEnd` hooks alongside the existing Subagent/Tool hooks, all POSTing via `send-event.mjs`.
- `server.mjs`: add a `sessions` model keyed by `session_id` (cwd/project, gitBranch, model,
  status, lastActivityAt, startedAt, subagent roll-up). Status mapping: UserPromptSubmit ->
  working; Stop / Notification idle_prompt -> awaiting-input/idle; Notification permission_prompt
  -> needs-permission; SessionEnd -> ended. Backfill running/recent sessions on startup from the
  discovery sources below. SSE stream gains a `sessions` channel.
- Front-end: new `public/view-sessions.js` (professional board: one card per session with a
  status dot, project + branch, current activity line, last-active, subagent count). Top-level
  nav Sessions | (per-session detail: Pro | Office). Reuse `store.js` + the view interface;
  drill-in filters the subagent fleet by session (`parentSession`).

## Phase 3 - Launch + focus (Windows-fiddly, isolate it)
- `terminal.mjs`: `wt` launch/focus/resume + tab tracking for a managed window named `cmc`.
  New-session: `wt -w cmc nt -d <repo> --title <name> claude` (spawn detached via `cmd /c start`
  so Node/PowerShell does not block); record tab order; bind `session_id` on the next matching
  SessionStart (cwd + time).
- `server.mjs`: `POST /launch` (open a repo session) and `POST /focus` (managed -> `wt -w cmc
  focus-tab -t <index>`; external -> reattach `wt -w cmc nt -d <cwd> claude --resume <id>` plus
  best-effort window foreground via a PowerShell SetForegroundWindow helper).
- UI: repo picker (from `~/repos` or a configured list) + click-to-open on each card. Tab-index
  tracking is best-effort; the reattach fallback is always available.

## Phase 4 - Polish + review
Professional UI pass on the Sessions board, repo-list config, README screenshots, docs update;
final whole-branch review; commit + push.

## Reuse
Hook shim, install/start/stop lifecycle, SSE + diff renderer, view interface, Humaaans factory,
desk/lounge allocation. The sessions layer sits above the existing per-session subagent layer.

## Verification
- Sessions overview: open 2-3 real sessions in different repos; each appears with correct
  project/branch/status; status flips on prompt-submit / turn-stop / permission-prompt /
  session-end; drilling in shows that session's subagents.
- Launch/focus: New session opens a WT tab in window `cmc` in the chosen repo and binds; clicking
  a managed session focuses the right tab; external session click reattaches via `--resume`.
- Cross-cutting: zero-dependency + offline; no em/en dashes; single-line PowerShell-safe commands;
  hooks removable via `stop.mjs`; runtime data stays outside the repo.
