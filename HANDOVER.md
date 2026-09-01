# HANDOVER

## Date, branch, PR, CI
- Date: 2026-09-01
- Branch: `main`, clean, at the merge of **#47**. This handover is a docs-only commit straight to
  `main` (Patrick approved it explicitly; a `*.md`-only commit mints no release).
- One PR this session, merged: **#47** (`8976ad7`), CI green in 41s on the now **SEVEN** step gate:
  the `.mjs` syntax sweep, `smoke-server.mjs`, `check-desktop-package.mjs`,
  `check-installer-launch.mjs`, `check-flag-resume.mjs`, the new `check-server-ready.mjs`, and
  `check-statusline-feed.mjs`.
- Latest release: **`fleet-v0.1.21`**, MSI attached (117 MB), published automatically by the merge.
- **The installed app was still 0.1.20 when this session closed.** Patrick said he would update it
  himself. So the fix below is released but NOT yet confirmed running from an installed MSI, and the
  first thing the next session should ask is whether the update happened and whether the window
  loaded the board (that is the exact path this PR touched).

## TLDR of session outcome
Patrick reported that the app "sometimes takes more than 8 seconds and crashes" after a long period
of not using it. Investigated, found the real shape of it, fixed it, plus one unrelated disk problem
found on the way.

**#47, two fixes.**
- **The 8 second startup dead end.** `desktop/main.mjs` skipped spawning the backend whenever
  `server.lock` named a pid that was merely ALIVE. Windows recycles pids, so a lock left behind by a
  non-graceful exit can name an unrelated running process, and then nothing ever starts: the shell
  polled that port for 8 seconds and loaded an error page with no retry, no auto retry and no log
  line. The same 8 seconds was also too tight for a first launch after a reboot, which pages a
  232 MB Electron binary in past Defender's real-time scan. The decision now lives in
  `desktop/server-ready.mjs` with every dependency injected: the lock is only a HINT about which port
  to try, an HTTP answer is the ONLY proof anything serves, the budget is 30s, the spawn happens
  exactly once per attempt, a Retry button on the error page and a Fleet menu item give the user the
  second attempt, and every attempt is logged to `desktop-debug.log` with the lock contents on a
  failure. `subscribeNotifications()` gained a guard, because the retry path is a second caller into
  a loop that reconnects forever.
- **`log.jsonl` grew forever.** One line per hook event, so one per tool call, read by NOTHING.
  **131 MB** on Patrick's machine. It now rotates to `log.jsonl.1` past `LOG_MAX_BYTES` (32 MB,
  overridable via `CMC_LOG_MAX_BYTES`), keeping exactly one generation, with the size tracked in
  memory because that append sits on the request path.

**Measured, not assumed** (packaged 0.1.20 backend, `CMC_DRY_RUN`, port 4319): 304ms to "listening",
441ms to the first HTTP 200, ~50ms for the startup filesystem work across 233 transcripts totalling
581 MB, and 244 to 486ms to start the Electron binary as node. Warm, the old 8s budget was 18x over,
which is what proved the budget was never about a slow backend.

**Both new test bodies were break-tested.** Re-introducing the trust-the-pid line fails three
assertions in `check-server-ready.mjs`; removing the rotation branch fails two in
`smoke-server.mjs`.

Not started (carried over, unchanged):
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- `public/demo.js` knows nothing about the rings, bars, flags, the card buttons, the ended panel, the
  fixed popup or the Claude mark. It has now drifted through five features.
- `wt focus-tab` against a COLD managed window, and whether the `SetForegroundWindow` nudge really
  raises the window rather than only flashing the taskbar icon. Both best effort by design.
- The header 7 day bar's percentage and reset text, still only ever observed on one cropped
  screenshot. Reproduce at a known window width before treating it as a bug.

## Prioritized next steps
1. **Confirm 0.1.21 is installed and the window loads the board.** This is the regression check for
   #47: the startup path is the code that changed. If it fails, the error page now names its own
   cause and `~/.claude/agent-fleet-monitor/desktop-debug.log` has a line per attempt, so read that
   first rather than guessing.
2. **Optional, one click: force the "Server did not start" page and press Retry.** Whether a button
   on a `data:` URL page really reaches the main process is the one thing #47 could not verify (it
   needs Electron, which is not installed locally, and launching the shell while the app ran would
   have torn down the running server on close). Only the channel name is checked, statically. Forcing
   it needs something silent holding 4317 plus a 30s wait, so it is cheap only if a real startup
   failure happens anyway. The Fleet menu item is the guaranteed path either way.
3. Check the header's 7 day bar at a known window width and settle whether the percentage and reset
   text are rendered or were merely clipped in that old screenshot.
4. Decide whether `scripts/render-check.mjs` should run in CI. It is 160 assertions and the only
   automated cover for this much UI, and it skips with exit 0 without a browser, so it needs a
   browser step on the runner. Open since four sessions.
5. Teach `public/demo.js` the newer UI so `?demo=1` still represents the app. Largest piece of
   visible rot in the repo.
6. Pick up the smaller carried-over items: the patrickrobelweb embed, the Humaaans CC-BY line, the
   demo confetti beat.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317).
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
The full CI gate, all seven steps, exactly as the runner does it:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs; node scripts\check-desktop-package.mjs; node scripts\check-installer-launch.mjs; node scripts\check-flag-resume.mjs; node scripts\check-server-ready.mjs; node scripts\check-statusline-feed.mjs
```
Just the new startup check (fake clock, no Electron, runs in milliseconds):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\check-server-ready.mjs
```
Real-browser check, 160 assertions, plus a screenshot on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
Read the current release version from GitHub (NEVER from CLAUDE.md, every version there is history):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; gh release view --json tagName --jq .tagName
```
What the desktop shell logged about its own startup attempts (new in 0.1.21):
```
Get-Content "$env:USERPROFILE\.claude\agent-fleet-monitor\desktop-debug.log" -Tail 20
```
How big the hook event log is now, and whether it has rotated (cap is 32 MB):
```
Get-ChildItem "$env:USERPROFILE\.claude\agent-fleet-monitor\log.jsonl*" | Select-Object Name,Length
```
Check the lock file agrees with what is listening (the hook-delivery failure mode):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; Get-Content "$env:USERPROFILE\.claude\agent-fleet-monitor\server.lock"; Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
```
See what `settings.statusLine` currently points at, i.e. whether our wrapper is installed:
```
node -e "const fs=require('fs'),os=require('os'),p=require('path');console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude','settings.json'),'utf8')).statusLine,null,1))"
```
A design-review preview that CANNOT disturb the running app (reads real sessions and real usage,
writes nothing, never takes the hook lock). **Do not use 4318: that is the smoke suite's port.**
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node server.mjs --port 4319
```
See what is flagged for resume:
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --list
```
Check which GitHub account every gh config is really using (run FIRST for any gh auth problem):
```
powershell -File "C:\Users\pr\.claude\scripts\gh-auth.ps1"
```
Force a specific release version instead of the auto patch bump:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git tag fleet-v0.2.0; git push origin fleet-v0.2.0
```

## Gotchas discovered this session
- **A live pid is not a live service.** The whole startup bug. `process.kill(pid, 0)` proves a
  process exists, nothing more, and Windows hands pids out again. Any "is it running" check that
  matters must ask the service, not the OS.
- **A hard timeout with no retry and no log is the expensive part, not the timeout value.** The 8s
  budget was wrong, but what made it undiagnosable across weeks was that nothing recorded the
  failure and the only recovery was to relaunch the app and hope.
- **Rewriting a file with python's `io.open` flips CRLF to LF.** The default read translates
  `\r\n` to `\n`, so writing back with `newline=''` silently converts the whole file. `core.autocrlf`
  is `true` here, so the git diff stayed clean and hid it: only `file server.mjs` showed it. Restore
  the endings deliberately, or use the Edit tool for a file this repo keeps in CRLF.
- **A bash heredoc is the wrong tool for a document this size.** Writing this file through
  `cat <<'EOF'` failed with an unmatched-quote parse error and wrote nothing; the Write tool plus a
  `mv` is the reliable route, and it also sidesteps the CRLF trap above.
- **A test written after the code proves nothing until it has been seen to fail.** Both new bodies
  were break-tested by re-introducing the exact bug, and both failed for the right reasons.
- **Some verification is only honest as a labelled static check.** Whether an Electron `data:` URL
  page can reach the main process cannot be proven without Electron, so `check-server-ready.mjs`
  asserts the CHANNEL NAME matches across the page, the preload bridge and the handler, under a
  comment saying that is all it does. That is the half that silently breaks.
- **Deleting the event log while the app runs works**, because the server opens and closes the file
  per append rather than holding a handle. The running app recreated it within a second.
- Still true from before: `wt` splits on `;` even inside one quoted argument; `windowsHide` has two
  OPPOSITE rules in this repo (mandatory in `statusline-feed.mjs`, banned in
  `terminal.mjs editorSpawnOptions()`) and must be decided from the child's subsystem, never by
  analogy; `ELECTRON_RUN_AS_NODE` is inherited and turns any spawned Electron app into a bare Node;
  NTFS file tunneling makes `birthtime` unreliable; the smoke suite owns port 4318; a test server
  without `CMC_DRY_RUN` hijacks `server.lock`; PowerShell 5.1 `-Encoding utf8` writes a BOM that
  `JSON.parse` rejects; `chrome --dump-dom` never returns on this page; `gh auth refresh` cannot run
  inside a Claude session at all.

## Open decisions waiting on Patrick
- New: should the 30s startup budget be an env override (`CMC_STARTUP_TIMEOUT_MS`) rather than a
  constant, for a machine where even 30s is not enough?
- New: `desktop-debug.log` is now written on every launch and has no cap. Rotate it like
  `log.jsonl`, or leave it (it grows by a line or two per app start)?
- New: is 32 MB the right `LOG_MAX_BYTES`, and is one kept generation enough?
- Should `scripts/render-check.mjs` run in CI now that it is 160 assertions? Open for four sessions.
- The New session popup reserves all five folder-chain slots up front, so a shallow chain leaves
  visible empty space to the right. That is what makes nothing move as the chain deepens. Keep it, or
  hug the selects and accept the reflow?
- Should the tune have a Settings toggle to mute it, or a volume? Should the clip loop?
- Is 20s the right `CMC_EDITOR_POLL_MS`?
- Should `Close VS Code` also work for windows opened by hand, accepting the basename-collision risk?
- Anything else for the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` and `skills/` currently DO trigger a release.
- Still open: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should the tab title
  stop being what `bringToForeground()` matches on? PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **The installed 0.1.20 app was still RUNNING at close, deliberately left alone**: pid 50116 serving
  4317, with hooks and the statusline wrapper installed. Patrick is updating to 0.1.21 himself, and
  the updater does its own teardown. Nothing in this session stopped or started that app.
- `log.jsonl` was **deleted at Patrick's request** (131 MB reclaimed). The running app recreated it
  immediately, about 1 KB. Rotation only starts once 0.1.21 is the version running.
- Every test server this session ran under `CMC_DRY_RUN` on port 4319 with the packaged backend, and
  all of them exited. Nothing was ever parked on 4318, and the real `server.lock` was never touched.
- `main` is the ONLY worktree and the ONLY branch, local and remote.
  `fix/desktop-startup-and-log-rotation` was deleted in both places at Patrick's request.
- Docker: `sg-lease-dev-postgres-1` and `sg-lease-dev-azurite-1` were up for hours, belong to another
  project, were NOT started by this session, and were left running.
- No keep-awake, no cron, no scheduled tasks, nothing flagged for resume.
- Two junctions still exist under `~/.claude/skills`: `agent-fleet-monitor` and `resume-later`.
- Scratchpad only: three measurement scripts and two file backups, none of them in the repo.
