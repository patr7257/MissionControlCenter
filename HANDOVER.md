# HANDOVER

## Date, branch, PR, CI
- Date: 2026-08-03
- Branch: `main`, clean at `5c19a56`. This handover is a docs-only commit straight to `main`, as
  agreed for handover docs.
- PRs this session, all merged: **#28** (`a440847`, issue #27), **#30** (`946c62e`, issue #29) and
  **#32** (`5c19a56`, issue #31). Every board card Done, no open PRs, no open issues, `main` is the
  only branch local and remote.
  `https://github.com/patr7257/MissionControlCenter/pull/28`
  `https://github.com/patr7257/MissionControlCenter/pull/30`
  `https://github.com/patr7257/MissionControlCenter/pull/32`
- CI green on every branch commit and on `main` after each merge. The CI gate is now FIVE steps: the
  `.mjs` syntax sweep, `smoke-server.mjs`, `check-desktop-package.mjs`, `check-installer-launch.mjs`
  and the new `check-flag-resume.mjs`.
- Releases published automatically by those merges: `fleet-v0.1.14`, `fleet-v0.1.15` and
  **`fleet-v0.1.16`**, each with its MSI attached (111 MB).
  `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.16`
- **Patrick installed 0.1.15 mid-session and confirmed the Resume button works**, which is the first
  time anything from this session ran in a packaged install. **0.1.16 is now out and NOT yet
  installed**: it adds only `--find` (a CLI change), so the UI is identical to 0.1.15.
- **GitHub auth was repaired and then made self-diagnosing.**
  `~/.config/gh-personal/hosts.yml` had drifted to `user: przrm`, which is why issue #27 and PR #28
  were authored by the work account and why `gh pr ready` and `git push` failed. All three configs are
  now correct with the full scope set, `przrm` is a collaborator here (so a wrong-account session
  degrades to "works anyway"), and the whole class is one command: see the new
  `~/.claude/scripts/gh-auth.ps1` below.

## READ THIS FIRST: two traps that cost real time
1. **A spawn shape can be provably correct and still do nothing.** Three separate bugs in the VS Code
   feature passed every syntax check, every dry run and every static review, and were only exposed by
   spawning for real and then ENUMERATING WINDOW TITLES (`EnumWindows` + `GetWindowText` via
   `Add-Type`, read-only, no focus stealing). `Get-Process | MainWindowTitle` is NOT enough: extra
   Electron windows live in the same process, so a second VS Code window never appears there.
2. **`pkill -f` from Git Bash does not kill native Windows processes.** Three "restarts" of a preview
   server therefore hit `EADDRINUSE` and died silently, leaving the OLD pre-fix server serving, so two
   correct fixes looked broken because they were never loaded. Kill by PID through PowerShell
   (`Get-CimInstance Win32_Process | Where CommandLine -like ... | Stop-Process -Force`).

## TLDR of session outcome
Shipped in `fleet-v0.1.14` (PR #28, issue #27): **open and close a repo's VS Code window from
Mission Control**, with no terminal involved at any point.
- `VS Code` button on every card (opens that session's cwd) and in the New session popup (opens the
  picked folder without launching a session). `Close VS Code` appears only while the app has a record
  of opening an editor for that folder, and a session ending offers the same thing in-app.
- Deliberately never through `wt`, and `Code.exe` spawned directly rather than `code.cmd`.
- The New session popup is 760px wide and its folder chain no longer wraps.

Shipped in `fleet-v0.1.15` (PR #30, issue #29): **runtime ring, quota bars, and resume-later**.
- **Runtime ring** on every card, styled as the context ring: minutes this run has been going, full
  circle at 300 (the same 5 hours as the quota window), amber at 180, red at 255.
- **5 hour quota is a full-width bar** above the filters, all one type size, always showing the
  reading's age. **7 day quota is a header bar** filling the gap between Resume session and the icon
  buttons, reporting its reset with a weekday.
- **`/resume-later`** flags the session you are in; an amber **Resume session** button lists flagged
  sessions with per-row Resume and Unflag. Resuming reattaches AND clears the flag in one call.

Shipped in `fleet-v0.1.16` (PR #32, issue #31): **flag an earlier session by NAME**.
- `flag-resume.mjs --find "<session name>"` resolves a name to that session's id AND cwd, because a
  name is what Claude Code leaves you with when a session ends (`claude --resume "<name>"`). Plus
  `--cwd` for the manual case. Refuses on 0 or 2+ matches rather than guessing.
- Prompted by Patrick pasting five ended sessions and asking for them to be flagged. All five are
  flagged now (see Environment state).

Not started (carried over):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so quota meters and context rings populate in a
  packaged install. **Still the top remaining item, and it now matters more**: the 5 hour bar is the
  most prominent thing on the board and it stays blank in an MSI install without it.
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- `public/demo.js` knows nothing about the new rings/bars/flags, so `?demo=1` shows the old shape.

## Prioritized next steps
1. **Add `desktop/assets/statusline-feed.mjs.cmd`** and set `CMC_STATUSLINE_COMMAND` in
   `desktop/main.mjs`. This is now the clear top item: 0.1.15 is installed, so the 5 hour bar and the
   context rings are visibly blank in the running app until this exists.
2. **Install 0.1.16 via Mission Control Center -> Check for updates.** It only adds the `--find` CLI,
   so nothing visual changes, but it keeps the installed copy current and exercises the
   download-and-install path again (0.1.15 was the first time that path ran for real).
3. Resume one of the five flagged sessions from the button and confirm the tab opens in the RIGHT
   folder. The cwd is resolved per flag, and for the four flagged by name it came from the board's
   `sessions.json` rather than from being observed live, so this is the one part proven only by
   construction and not yet by a real reattach.
4. Say whether the picker wants more: a "resume in a new window" option, sorting, an age cutoff.
4. Decide whether `scripts/render-check.mjs` should run in CI. It is now 131 assertions and the only
   automated cover for the rings, the bars, the picker, the popups and the shortcuts, and it skips
   with exit 0 without a browser, so it needs a browser step on the runner.
5. Teach `public/demo.js` the new rings and bars so `?demo=1` still represents the app.
6. Confirm the two remaining best-effort behaviours by hand: `wt focus-tab` against a COLD managed
   window, and whether the `SetForegroundWindow` nudge raises the window or only flashes the taskbar.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
The full CI gate, all five steps, exactly as the runner does it:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs; node scripts\check-desktop-package.mjs; node scripts\check-installer-launch.mjs; node scripts\check-flag-resume.mjs
```
Real-browser check plus all six screenshots (board, Take Control, Settings, New session, session
ended, resume picker) on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
A design-review preview that CANNOT disturb the running app (reads real sessions and real usage,
writes nothing, never takes the hook lock). **Do not use 4318: that is the smoke suite's port.**
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node server.mjs --port 4319
```
Check which GitHub account every gh config is really using, and what is wrong (run this FIRST for any
gh auth, scope or permission problem; `-Mode fix` repairs account drift with no browser, and
`-Mode refresh -Target personal|work|default` prints the line to paste in your OWN terminal):
```
powershell -File "C:\Users\pr\.claude\scripts\gh-auth.ps1"
```
Flag an EARLIER session by the name Claude Code printed when it ended:
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --find "FORSIA DOCS UPDATE"
```
See what is flagged for resume, and flag or unflag the session you are in:
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --list
```
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --unflag
```
See which VS Code executable would be used, without opening anything:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(t=>console.log(JSON.stringify(t.openInVsCode(process.cwd()),null,1)));"; Remove-Item Env:\CMC_DRY_RUN
```
Inspect exactly what a launch would run, without opening a tab:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(t=>{const r=t.launchSession('C:/Users/pr/repos/2-ZRM/customers','customers','probe',null);console.log(r.command);console.log(r.script);});"; Remove-Item Env:\CMC_DRY_RUN
```
Check the lock file agrees with what is listening (the hook-delivery failure mode):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; Get-Content "$env:USERPROFILE\.claude\agent-fleet-monitor\server.lock"; Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
```
Force a specific release version instead of the auto patch bump:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git tag fleet-v0.2.0; git push origin fleet-v0.2.0
```

## Gotchas discovered this session
- **`ELECTRON_RUN_AS_NODE` is inherited and poisons any Electron app you spawn.** `Code.exe` becomes a
  bare Node interpreter that tries to `require` the folder path and exits 1 silently. `desktop/main.mjs`
  sets it on the server on purpose, so every packaged install would have been affected.
- **`detached: true` is needed for a handoff-style child**, not just long-lived ones. A second
  `Code.exe` only forwards the folder to the running instance over a named pipe; killed mid-handoff,
  nothing happens at all.
- **`windowsHide` and `detached` conflict on Windows** (`CREATE_NO_WINDOW` is ignored with
  `DETACHED_PROCESS`), which only matters for a console-subsystem exe. Read the PE subsystem byte
  before agonising: `Code.exe` is subsystem 2 (GUI), so it has no console either way.
- **NTFS file tunneling makes `birthtime` unreliable** for a file being rewritten: it restores the
  original creation time when a file is recreated under the same name within ~15s. One transcript
  reported 10:24 and then 13:22 minutes apart. `mtime` is worse (it is the LAST write). The real
  source for "when did this run start" is Claude Code's own `startedAt` in
  `~/.claude/sessions/<pid>.json`.
- **`~/.claude/sessions/<pid>.json` is a goldmine**: `sessionId`, `cwd`, `name` (what `/rename` sets),
  `status`, `waitingFor`, `startedAt`, `version`. `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` are both in
  a session's environment, so a script running inside a session can identify itself exactly.
- **Round before comparing and your thresholds move.** Severity from a rounded percentage made 179 min
  turn amber a minute early; computing it from the unrounded ratio makes 180 and 255 exact.
- **`stdio: 'ignore'` on a spawned server hides its crashes**, including in CI. A port clash produced a
  wall of unexplained FAILs with no stack trace anywhere. Inherit stderr.
- **The smoke suite owns port 4318.** Never park a preview there.
- **A flex `<select>` needs `min-width: 0`**, or its `min-width: auto` resolves to the content width
  and forces the row wider than its panel.
- **`git worktree remove` can half-succeed**: it deleted the contents but left the empty directory with
  "Permission denied" because a VS Code window held it. Close the editor, then `rmdir`.
- **After a squash merge, `git log origin/main..<branch>` is NOT empty**, and that is expected. Prove
  parity with `git diff --stat main <branch>` before deleting a branch.
- **`~/.config/gh-personal` can drift to the wrong active user.** Symptoms: `gh pr ready` fails with
  "przrm does not have the correct permissions" on a personal repo, `gh project item-list` fails on a
  missing `read:project` scope, and `git push` 403s. Per-process fixes that touch no shared config:
  `GH_TOKEN="$(gh auth token --user patr7257)" gh <command>`, and
  `GH_TOKEN=... git -c credential.helper="" -c credential.helper="!gh auth git-credential" push`.
  The durable fix is `GH_CONFIG_DIR=~/.config/gh-personal gh auth switch --user patr7257`, which
  rewrites ONLY that directory. Never the machine-wide `gh auth switch`.
- **GitHub refuses self-approval**, so `gh pr review --approve` cannot be used on your own PR. Merging
  works because nothing requires a review.
- **A resume flag needs a cwd, not just a session id.** The flag's cwd becomes the reattached tab's
  working directory, so `process.cwd()` as a fallback is only ever right for "flag the session I am
  in". Flagging someone else's session by id alone silently recorded the script's own directory.
- **`gh auth refresh` cannot run inside a Claude session at all.** It is an OAuth device flow (prints
  a one-time code, waits for Enter, needs a browser), and through the `!` prefix it fails outright
  with "--hostname required when not running interactively". Never attempt it: hand over the line.
  `~/.claude/scripts/gh-auth.ps1 -Mode refresh` now refuses when `CLAUDECODE` is set and prints the
  exact line instead, which is what stops the "I ran it and nothing changed" loop.
- **`gh auth refresh -s <scope>` can REDUCE a token**, resetting it to gh's default minimum and
  dropping `project` and `workflow`. Always pass the full list. Confirmed twice on 2026-08-03, in two
  different sessions.
- Still true from before: `wt` splits on `;` even inside one quoted argument; an updater only fixes
  FUTURE hops; a packaged app is a separate allowlist from the repo; `server.lock` can be hijacked by a
  test server (always `CMC_DRY_RUN=1` plus a temp HOME); PowerShell 5.1 `-Encoding utf8` writes a BOM
  that `JSON.parse` rejects; `chrome --dump-dom` never returns on this page.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI now that it is the only cover for this much UI?
- Does the end-of-session "close VS Code" offer need a Settings toggle to silence it?
- Does the resume picker want more (resume in a new window, sorting, an age cutoff)?
- Should the `Close VS Code` button also appear for windows opened by hand, accepting the
  basename-collision risk? Today it is scoped to windows this app opened.
- Anything else for the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` and `skills/` currently DO trigger a release.
- Still open: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should the tab title
  stop being what `bringToForeground()` matches on? Check `VibeTraderAI` for the same `\"` updater bug?
  PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **The installed Mission Control Center 0.1.15 is RUNNING** on port 4317 (pid 40760, started 20:16 by
  Patrick when he installed it). Never touched by this session, which started no long-lived server of
  its own. Its hooks and statusline wrap are registered in `~/.claude/settings.json`, which is normal
  while the app is open, and `server.lock` correctly points at that pid.
- Every preview and test server this session is stopped. Ports 4318 to 4322 are free.
- **FIVE sessions are flagged for resume**, all verified through the running app's `/resume-flags`:
  `Samberg VIBE Extension` (repos\claude-setup), `ZRM DOCS: Fix zeptomail send` (zrm-docs),
  `FORSIA DOCS UPDATE` (zrm-docs-customer-forsia), `TimetrackerProjects` (2-ZRM\customers) and
  `MCC vscode open button` (this session). Each cwd was resolved per flag and matches the shell prompt
  Patrick pasted. Unflag any of them from the app.
- **A stray `node server.mjs` (pid 30892) is listening on port 3001**, orphaned since 17:23 with a dead
  parent. It is NOT this project: this server defaults to 4317, so 3001 belongs to another repo's dev
  server. Deliberately left alone under the never-kill-another-project's-server rule. Kill it yourself
  if it is not wanted: `Stop-Process -Id 30892 -Force`.
- **Two junctions now exist** under `~/.claude/skills`: `agent-fleet-monitor` (pre-existing) and
  `resume-later` -> `<repo>/skills/resume-later`, which is what makes `/resume-later` work from any
  repo.
- **New machine tooling**: `~/.claude/scripts/gh-auth.ps1`, and the global `CLAUDE.md` gh section now
  leads with "run the script, do not improvise a diagnosis". All three gh configs verified correct with
  the full scope set at session end.
- `main` is the ONLY worktree and the ONLY branch, local and remote. All three session worktrees and
  all three feature branches are gone. No Docker (engine down, no Claude marker), no keep-awake, no
  cron or scheduled jobs.
- Exactly ONE VS Code window is open (`MW_service_tool`, Patrick's own, untouched). Every probe window
  created this session was closed again, confirmed by enumerating window titles.
- Screenshots and probe scripts stayed in the session scratchpad; nothing landed in the repo.
