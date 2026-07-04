# Session-discovery findings (Windows, verified 2026-07-01)

Grounding for the multi-session manager (Phase 2). All paths under `C:\Users\pr\.claude\`.

## Enumerate sessions
- `projects/<ENCODED_CWD>/<SESSION_ID>.jsonl` - one folder per project, one JSONL per session.
  Encoding: `C--Users-pr-repos-korselsplaner-sundvikar` = `C:\Users\pr\repos\korselsplaner-sundvikar`.
- `history.jsonl` - timeline index, one entry per user input: `{ timestamp (unix ms), project
  (cwd), sessionId, display (prompt snippet) }`. Good for "last prompt" labels and recency.

## Per-session metadata (from the transcript's SessionStart line)
```json
{ "cwd": "C:\\Users\\pr\\repos\\...", "sessionId": "...", "timestamp": "...",
  "version": "2.1.197", "gitBranch": "main", "entrypoint": "cli" }
```
There is NO stored human tab title (the WT tab names like "SV V1 GRIND" are manual and not
recoverable). Derive a label from project name + gitBranch + latest `history.jsonl` display.

## Live vs closed
- `ide/<PID>.lock` -> `{ pid, workspaceFolders:[...], ideName, transport, runningInWindows,
  authToken }`. Presence indicates a live IDE/session; workspaceFolders maps to project paths.
- `session-env/<SESSION_ID>/.lock` and `tasks/<SESSION_ID>/.lock` exist per session (lifecycle
  markers).
- Transcript mtime = last activity; sort all `*.jsonl` by mtime for "most active now".
- Most reliable live signal for OUR sessions once running: the user-level hooks themselves
  (SessionStart .. SessionEnd). Use file scans (projects/, ide/, history.jsonl) to BACKFILL
  sessions that started before the monitor.

## Resume / focus
- Minimal to resume: session id + cwd. `claude --resume <session-id>` in the cwd reattaches.
- Windows Terminal: `wt -w <window> focus-tab -t <index>` focuses a tab in a named window;
  reliable only for tabs we launched into a managed window (`-w cmc`). Launch detached via
  `cmd /c start wt ...` to avoid blocking.

## Current settings
`~/.claude/settings.json` has no hooks block now (fleet-monitor hooks removed; a
`settings.json.fleet-monitor.bak` remains). Merge new hooks non-destructively as install-hooks.mjs
already does.
