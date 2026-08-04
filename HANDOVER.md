# HANDOVER

## Date, branch, PR, CI
- Date: 2026-08-04
- Branch: `main`, clean at `920c7f8`. This handover is a docs-only commit straight to `main`, as
  agreed for handover docs (and a `*.md`-only commit mints no release).
- One PR this session, merged: **#35** (`920c7f8`), closing issues **#33** and **#34**.
  `https://github.com/patr7257/MissionControlCenter/pull/35`
- CI green on the branch (first run, 35s) and on `main` after the merge. The gate is still FIVE
  steps: the `.mjs` syntax sweep, `smoke-server.mjs`, `check-desktop-package.mjs`,
  `check-installer-launch.mjs`, `check-flag-resume.mjs`.
- Release published automatically by the merge: **`fleet-v0.1.17`**, MSI attached (111 MB). The tag
  points at the merge commit itself (`fleet-v0.1.17` -> `920c7f8`, verified), so the fix really is in
  that MSI.
  `https://github.com/patr7257/MissionControlCenter/releases/download/fleet-v0.1.17/Mission.Control.Center.0.1.17.msi`
- **0.1.17 is NOT yet installed.** Patrick was still running 0.1.16 (pid 21296, port 4317) at session
  end, so on his machine the VS Code button is still broken until he installs. Everything else about
  the app is unaffected.
- Board: both cards Done, both issues closed, no open PRs, `main` is the only branch local and remote
  (GitHub auto-deleted the feature branch on merge; the stale local tracking ref was pruned).

## READ THIS FIRST: the trap that cost this session, and the one before it
1. **`windowsHide: true` hides the WINDOW, not just a console.** Node maps it to libuv's
   `UV_PROCESS_WINDOWS_HIDE`, which sets `STARTUPINFO.wShowWindow = SW_HIDE` with
   `STARTF_USESHOWWINDOW`, and a GUI app honours that for its FIRST window. That is the whole of
   issue #33: a COLD `Code.exe` start drew its window invisibly while the process ran fine. Never put
   that flag on a GUI spawn. `CLAUDE.md` used to claim the opposite and is now corrected.
2. **Only a COLD start was affected, which is why it read as intermittent.** A warm instance forwards
   the folder over a named pipe and creates the window itself, never seeing our `STARTUPINFO`. Any
   future "it worked yesterday" report about a spawned GUI app deserves the cold/warm split as the
   first hypothesis.
3. Still true from before: **a spawn shape can be provably correct and still show nothing.** Three
   earlier VS Code bugs and this one all passed every syntax check, dry run and static review. All
   four were only settled by really spawning and then ENUMERATING WINDOW HANDLES (`EnumWindows` +
   `GetWindowTextW` via `Add-Type`, read-only, no focus stealing). `Get-Process | MainWindowTitle` is
   NOT enough, and it also only reports VISIBLE-ish windows, which is exactly how the stranded hidden
   window was missed on the first pass this session.

## TLDR of session outcome
Shipped in `fleet-v0.1.17` (PR #35): the VS Code button actually opens VS Code, and a session can be
flagged for resume from its own card.
- **Issue #33, root cause found and fixed.** `windowsHide` dropped from the editor spawn; the options
  moved into an exported `editorSpawnOptions()` so `smoke-server.mjs` asserts the flag can never come
  back (5 new assertions). `detached` stays: it is what lets the warm named-pipe handoff finish.
- **Issue #34, `Resume later` / `Unflag` on every card** plus `POST /flag-resume`. One click, no
  dialog, no note field; amber once flagged. Writes the same file in the same shape as
  `scripts/flag-resume.mjs`, so `--list` sees it and the picker clears it.
- Verification: `smoke-server.mjs` +12 assertions, `render-check.mjs` +8 (now **140**, all pass), and
  the fix was confirmed by a REAL cold start with VS Code fully closed (0 to 10 `Code.exe` processes,
  exactly one VISIBLE window, none hidden).
- Diagnosis artefacts worth knowing: the live UI was driven over CDP against the RUNNING app on 4317,
  which proved the toast and the POST were never broken, and a throwaway `--user-data-dir` was used to
  cold-start `Code.exe` without touching Patrick's real editor.

Not started (carried over, unchanged by this session):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so the quota meters and context rings populate in
  a packaged install. **Still the top remaining item**, and still the most visible gap: the 5 hour bar
  is the most prominent thing on the board and stays blank in an MSI install.
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- `public/demo.js` knows nothing about the rings, bars, flags or the new card button, so `?demo=1`
  shows the old shape.

## Prioritized next steps
1. **Install 0.1.17 and click `VS Code` on a card with VS Code fully closed.** This is the one thing
   proven only outside a packaged install: the cold-start fix was verified by calling
   `terminal.openInVsCode()` directly, not through an MSI. Expect a few seconds before the window
   appears, and remember `ok:true` only means the process started.
2. **Add `desktop/assets/statusline-feed.mjs.cmd`** and set `CMC_STATUSLINE_COMMAND` in
   `desktop/main.mjs`, mirroring `send-event.mjs.cmd`. Unchanged top item from the last two sessions.
3. Flag a session from its card in the installed app, confirm it appears under `Resume session`, then
   resume it and confirm the tab opens in the RIGHT folder. The cwd resolution is asserted in the
   smoke suite but a card-written flag has never been resumed for real.
4. Decide whether `scripts/render-check.mjs` should run in CI. It is now 140 assertions and the only
   automated cover for the rings, bars, picker, popups, shortcuts and both VS Code buttons, and it
   skips with exit 0 without a browser, so it needs a browser step on the runner.
5. Teach `public/demo.js` the rings, bars and the card's `Resume later` button so `?demo=1` still
   represents the app.
6. Confirm the two remaining best-effort behaviours by hand: `wt focus-tab` against a COLD managed
   window, and whether the `SetForegroundWindow` nudge raises the window or only flashes the taskbar.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317).
This is also the way to get the #33 fix without installing the MSI:
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
Real-browser check, 140 assertions, plus all screenshots on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
A design-review preview that CANNOT disturb the running app (reads real sessions and real usage,
writes nothing, never takes the hook lock). **Do not use 4318: that is the smoke suite's port.**
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node server.mjs --port 4319
```
See which VS Code executable would be used, without opening anything:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(t=>console.log(JSON.stringify(t.openInVsCode(process.cwd()),null,1)));"; Remove-Item Env:\CMC_DRY_RUN
```
Inspect the editor spawn options, i.e. the guard for issue #33 (must NOT contain windowsHide):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node -e "import('./terminal.mjs').then(t=>console.log(JSON.stringify(t.editorSpawnOptions({}),null,1)));"
```
List every VISIBLE and HIDDEN window whose title mentions VS Code (this is what found the stranded
hidden window; read-only, steals no focus). Paste as one line:
```
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;public class W{private delegate bool E(IntPtr h,IntPtr p);[DllImport(\"user32.dll\")]private static extern bool EnumWindows(E c,IntPtr p);[DllImport(\"user32.dll\")]private static extern bool IsWindowVisible(IntPtr h);[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]private static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);public static List<string> All(){List<string> o=new List<string>();EnumWindows(delegate(IntPtr h,IntPtr p){StringBuilder b=new StringBuilder(512);GetWindowTextW(h,b,512);if(b.Length>0)o.Add((IsWindowVisible(h)?\"V\":\"H\")+\"|\"+b.ToString());return true;},IntPtr.Zero);return o;}}' -Language CSharp; [W]::All() | Where-Object { $_ -match 'Visual Studio Code' }"
```
Check which GitHub account every gh config is really using, and what is wrong (run this FIRST for any
gh auth, scope or permission problem):
```
powershell -File "C:\Users\pr\.claude\scripts\gh-auth.ps1"
```
Flag an EARLIER session by the name Claude Code printed when it ended:
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --find "FORSIA DOCS UPDATE"
```
See what is flagged for resume:
```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --list
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
- **`windowsHide: true` sets `SW_HIDE` on a GUI app's first window.** See "READ THIS FIRST". The
  measurement that settles it: cold-start the exe into a throwaway `--user-data-dir` (so it cannot
  forward to a running instance) and enumerate handles with and without the flag. Hidden vs visible,
  same folder.
- **A hidden window is invisible to a "visible windows" enumeration, obviously, and that hid the
  evidence for an hour.** The first pass filtered on `IsWindowVisible` and therefore missed the
  stranded `Welcome - SundVikar` window sitting there since 09:33. Always list BOTH states when
  hunting a window that "did not appear".
- **`taskkill /PID <x> /T /F` prints the parent of each victim**, which is free chain-of-custody: it
  is what proved the stranded VS Code was a child of the Mission Control server (`child process of
  PID 21296`) rather than something Patrick opened.
- **The `opened-editors.json` timestamps are a usable audit log.** Matching a record's ms timestamp
  against `Get-Process Code | StartTime` to the second is what identified which click cold-started VS
  Code, before any code had been read.
- **Node's `windowsHide` cannot be tested with `notepad.exe` on Windows 11**: it is a Store app stub,
  so the window belongs to a different process and the probe reports zero windows either way. Use the
  real app under test, or a classic Win32 exe.
- **Driving the LIVE app's UI over CDP is safe and cheap when `fetch` is stubbed in the page.** That
  is what proved the toast and the `POST /open-editor` were never broken, which killed a whole branch
  of the investigation in one measurement.
- **Splitting one file's hunks across two commits, non-interactively:** back the file up, edit the
  later block out, commit, restore from the backup, commit the rest. `git add -p` is unavailable here.
  Verify with `git status` clean afterwards, and re-run the suite: a bad split loses assertions
  silently.
- **A merged PR's branch may already be gone from GitHub** (auto-delete on merge), so
  `git push origin --delete` errors with "remote ref does not exist" while `git branch -r` still shows
  it. That is a stale local tracking ref: `git fetch --prune`, not a failed delete.
- **`serializeSession` is the wrong home for anything read from a file another process owns.** It runs
  once per session per broadcast, so a `readResumeFlags()` there would be a file read per session per
  event. The card's flag state rides the 15s poll the header count already does.
- **A flex `<select>`/button row needs `min-width: 0`** to shrink, and `.sc-acts` already wrapped, so
  the fifth footer button needed no layout change. Proven by the render-check width sweep rather than
  by eye.
- Still true from before: `wt` splits on `;` even inside one quoted argument; `ELECTRON_RUN_AS_NODE`
  is inherited and turns any spawned Electron app into a bare Node; NTFS file tunneling makes
  `birthtime` unreliable; the smoke suite owns port 4318; a test server without `CMC_DRY_RUN` hijacks
  `server.lock`; PowerShell 5.1 `-Encoding utf8` writes a BOM that `JSON.parse` rejects;
  `chrome --dump-dom` never returns on this page; `gh auth refresh` cannot run inside a Claude session
  at all; `$pid` is read-only in PowerShell, so a loop variable named `$pid` throws
  "Cannot overwrite variable PID".

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI now that it is 140 assertions and the only cover for
  this much UI?
- Does the card's `Resume later` want a note field after all (the skill supports notes; the card
  deliberately does not)?
- Does the end-of-session "close VS Code" offer need a Settings toggle to silence it?
- Should the `Close VS Code` button also appear for windows opened by hand, accepting the
  basename-collision risk? Today it is scoped to windows this app opened.
- Does the resume picker want more (resume in a new window, sorting, an age cutoff)?
- Anything else for the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` and `skills/` currently DO trigger a release.
- Still open: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should the tab title
  stop being what `bringToForeground()` matches on? Check `VibeTraderAI` for the same `\"` updater bug?
  PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **The installed Mission Control Center 0.1.16 is RUNNING** on port 4317 (pid 21296, started 09:04 by
  Patrick). Never stopped by this session, which started no long-lived server of its own. Its hooks
  and statusline wrap are registered in `~/.claude/settings.json`, which is normal while the app is
  open, and `server.lock` correctly points at that pid. **Installing 0.1.17 replaces it**; the
  updater tears the old backend down first, which is the order that has to be right.
- **VS Code is fully CLOSED.** The instance holding the stranded hidden `SundVikar` window was killed
  with Patrick's go-ahead (it also owned the `MissionControlCenter` window this session's probe
  opened), and the window opened by the cold-start verification was closed again with `WM_CLOSE`,
  confirmed by re-enumerating handles.
- `~/.claude/agent-fleet-monitor/opened-editors.json` carries two records from this morning's clicks
  (`claude-setup`, `SundVikar`) whose windows no longer exist, so those cards may offer a
  `Close VS Code` that finds nothing and reports `no-window`. Harmless, and it ages out after 7 days.
- Every probe and test server this session is stopped. Ports 4318 to 4322 are free. No preview server
  was ever parked on 4318.
- `main` is the ONLY worktree and the ONLY branch, local and remote. `MissionControlCenter-33` was
  removed cleanly (`git worktree remove` succeeded outright, because the VS Code window holding it had
  been closed first, which is the failure mode from the previous session).
- FIVE sessions were flagged for resume at the start of this session and **none were resumed or
  unflagged**, so all five remain: `Samberg VIBE Extension`, `ZRM DOCS: Fix zeptomail send`,
  `FORSIA DOCS UPDATE`, `TimetrackerProjects` and `MCC vscode open button` (this one).
- No Docker (engine down, no Claude marker, so the SessionEnd hook leaves it alone), no keep-awake, no
  cron or scheduled jobs (`CronList` empty).
- Two junctions still exist under `~/.claude/skills`: `agent-fleet-monitor` and `resume-later`.
- Screenshots and probe scripts stayed in the session scratchpad and were deleted; nothing landed in
  the repo.
