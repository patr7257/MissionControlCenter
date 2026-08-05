# HANDOVER

## Date, branch, PR, CI
- Date: 2026-08-05
- Branch: `main`, clean at the merge of **#38**. This handover is a docs-only commit straight to
  `main`, as agreed for handover docs (and a `*.md`-only commit mints no release).
- One PR this session, merged: **#38** (`5f6c508`), closing issues **#36** and **#37**.
  `https://github.com/patr7257/MissionControlCenter/pull/38`
- CI green on the branch (37s) and on `main` after the merge. The gate is still FIVE steps: the
  `.mjs` syntax sweep, `smoke-server.mjs`, `check-desktop-package.mjs`, `check-installer-launch.mjs`,
  `check-flag-resume.mjs`.
- Release published automatically by the merge: **`fleet-v0.1.18`**, MSI attached (111 MB). The tag
  points at the merge commit itself (`fleet-v0.1.18` -> `5f6c508`, verified), so the work really is in
  that MSI.
  `https://github.com/patr7257/MissionControlCenter/releases/download/fleet-v0.1.18/Mission.Control.Center.0.1.18.msi`
- **0.1.18 is NOT yet installed.** Patrick was still running the previously installed build at session
  end, so on his machine the one-button VS Code toggle, the `Close session` button and the new
  end-of-session panel are not there until he installs.
- Board: both cards Done, both issues closed, no open PRs, `main` is the only branch local and remote.

## READ THIS FIRST: the trap that cost this session
1. **A persisted record of having done something is not evidence of the current state.**
   `openedEditors` (7 day TTL) only ever meant "we opened this folder once", yet `editorOpen` was
   derived from it alone, so the board offered a `Close VS Code` for windows closed hours earlier and
   the end-of-session popup asked about editors that were not there. The fix reads the DESKTOP instead
   (one read-only `EnumWindows` pass) and treats the record as scope, not as truth. Any future
   "the button lies about X" report deserves the same question first: is that field a memory or a
   measurement?
2. **The one thing that must never regress here: `WindowsTerminal.exe` is never killed.** ONE process
   hosts every tab of a window, so ending it would take down every other running session. The new
   `Close session` kills the tab's own `powershell.exe` subtree, and only after proving the
   grandparent is Windows Terminal. `scripts/smoke-server.mjs` asserts the generated script as TEXT
   for exactly that reason.
3. Still true from before: **`windowsHide: true` hides the WINDOW of a GUI app, not just a console**
   (issue #33), and **a spawn shape can be provably correct and still show nothing**, so window-level
   claims get settled by enumerating handles, never by review.

## TLDR of session outcome
Shipped in `fleet-v0.1.18` (PR #38), four changes across two issues.
- **#36.1, one VS Code button.** The card's two buttons became ONE that swaps between `VS Code` and
  `Close VS Code`, the same shape as the `Resume later` / `Unflag` toggle beside it.
- **#36.2, a `Close session` button** on every running session's card, the only footer button behind a
  confirm because it is the only destructive one. There is no `wt close-tab` (checked against WT 1.24)
  and no Claude Code CLI that ends another session, so it ends the process that OWNS the tab: WT
  closes a tab when its hosted process exits. Verified chain `claude.exe -> powershell.exe ->
  WindowsTerminal.exe`, so the kill is `taskkill /T` on the tab's own PowerShell, and only after
  confirming the parent is a shell AND the grandparent is `WindowsTerminal.exe`. Anything else falls
  back to ending only Claude and the toast says so. The pid comes from Claude Code's live registry,
  resolved server side fresh per request (a page can never name a process to kill), and the process
  CreationDate is compared across the kill so a recycled pid cannot read as "still running".
- **#37.1, `editorOpen` is the real state.** Cross-checked against the actual windows with the same
  read-only `EnumWindows` pass and the same title rule the close uses (`titleMatchesBaseName()` is the
  JS twin of `closeWindowScript`'s regex, so "the button is offered" and "the close can find the
  window" are ONE rule). Cached and polled every 20s (`CMC_EDITOR_POLL_MS`) rather than probed per
  serialize, because the query costs ~0.6s and `serializeSession` runs once per session per broadcast;
  skipped entirely when nothing has been opened, so an idle board spawns nothing. It fails OPEN in
  every uncertain case (never probed, probe errored, or within a 30s grace window after an open): a
  wrong "open" costs one toast, a wrong "closed" hides the only button that can close the editor.
- **#37.2, the end-of-session panel.** Always offers `Resume later` now, and offers `Close VS Code`
  only when a window really is open. Buttons `Resume later` / `Close VS Code` / `OK`; only OK
  dismisses, the other two act and flip to their opposite, so it is a small live control panel rather
  than a one-shot yes/no (Patrick chose this shape). It fires however a session ended: the
  `SessionEnd` hook, the registry watcher seeing the session's registry file vanish (the ONLY signal
  when the terminal window is closed outright, held one poll so a `--resume` cannot announce itself as
  an ending), or `POST /close-session`. All three go through one deduped `pushSessionEnded()`.
- Verification: `smoke-server.mjs` +22 assertions plus a long-lived SSE listener (`streamFrames`) so a
  broadcast that is not a session update can be asserted at all; `render-check.mjs` is now **152**
  assertions (was 140), all pass. Both new dialogs were looked at in a real render.

Not started (carried over, unchanged by this session):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so the quota meters and context rings populate in
  a packaged install. **Still the top remaining item**, and still the most visible gap: the 5 hour bar
  is the most prominent thing on the board and stays blank in an MSI install.
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- `public/demo.js` knows nothing about the rings, bars, flags, the card buttons or the new panel, so
  `?demo=1` shows the old shape. It has now drifted through three features.

## Prioritized next steps
1. **Install 0.1.18 and exercise the two new controls for real.** Everything below the UI was proven
   headlessly or under `CMC_DRY_RUN`; the one thing no automated check can cover is the actual kill.
   Open two tabs in the managed `cmc` window, click `Close session` on ONE card, and confirm the other
   tab survives. That is the assertion that matters most in this release.
2. Confirm the VS Code toggle flips on its own: open an editor from a card, close that window BY HAND,
   and watch the button go back to `VS Code` within about 20 seconds (the `CMC_EDITOR_POLL_MS` tick).
3. **Add `desktop/assets/statusline-feed.mjs.cmd`** and set `CMC_STATUSLINE_COMMAND` in
   `desktop/main.mjs`, mirroring `send-event.mjs.cmd`. Unchanged top item from the last three sessions.
4. Close a terminal window outright (the X, not `/exit`) and confirm the end-of-session panel appears
   about 2.5s later. That path has no hook at all and is only covered by the registry watcher.
5. Decide whether `scripts/render-check.mjs` should run in CI. It is now 152 assertions and the only
   automated cover for the rings, bars, picker, popups, shortcuts, both VS Code states, the new
   `Close session` confirm and the new panel, and it skips with exit 0 without a browser, so it needs
   a browser step on the runner.
6. Teach `public/demo.js` the rings, bars, the card buttons and the panel so `?demo=1` still
   represents the app.

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
Real-browser check, 152 assertions, plus all screenshots on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
A design-review preview that CANNOT disturb the running app (reads real sessions and real usage,
writes nothing, never takes the hook lock). **Do not use 4318: that is the smoke suite's port.**
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node server.mjs --port 4319
```
See which folders the app currently believes have an OPEN VS Code window (runs the real probe, opens
and closes nothing):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node -e "import('./terminal.mjs').then(async t=>{await t.refreshOpenEditors();console.log(JSON.stringify({recorded:t.openedEditors.map(e=>e.folder),open:t.openEditorFolders()},null,1));});"
```
See the exact PowerShell a `Close session` would run for one pid, WITHOUT killing anything (dry run
prints the script and touches no process). It asks for the pid at a prompt, so paste this as-is:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; $p = Read-Host "Claude pid to inspect"; node -e "import('./terminal.mjs').then(t=>t.closeSession(process.argv[1])).then(r=>console.log(r.script))" $p; Remove-Item Env:\CMC_DRY_RUN
```
Which pid belongs to which session (Claude Code's own live registry, the same files the server reads):
```
Get-ChildItem "$env:USERPROFILE\.claude\sessions\*.json" | ForEach-Object { $j = Get-Content $_ -Raw | ConvertFrom-Json; "{0}`t{1}`t{2}" -f $j.pid, $j.status, $j.name }
```
Walk a Claude pid up to its terminal, i.e. the chain `Close session` depends on:
```
powershell -NoProfile -Command "$t = Read-Host 'Claude pid'; $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $t\"; while ($p) { \"$($p.ProcessId) $($p.Name)\"; $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $($p.ParentProcessId)\" -ErrorAction SilentlyContinue }"
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
- **Windows Terminal has no `close-tab` verb** (1.24 checked). Its CLI is `new-tab`, `split-pane`,
  `focus-tab`, `move-focus`, `move-pane`, `swap-pane`, `focus-pane`. So closing a tab is only ever a
  process question, never a `wt` question.
- **One `WindowsTerminal.exe` hosts every tab.** That is why the kill targets the tab's own
  `powershell.exe` subtree and why the grandparent check is not optional. It is also why
  `bringToForeground()` has to match on title: there is no per-tab pid to target either.
- **`$pid` is read-only in PowerShell**, so the target pid in a generated script must be called
  something else (`$target` here) or it throws "Cannot overwrite variable PID". Bitten before, encoded
  in a comment now.
- **Windows recycles pids**, so "did the process go away" cannot be answered by pid alone. Capture
  `CreationDate` before the kill and compare after.
- **A stub that answers a constant makes a working toggle look broken.** The panel's flag button
  repaints from a re-read of `/resume-flags` after every toggle (deliberately, so a failed write shows
  the truth on disk), so the render-check stub has to MIRROR state. Cost about 20 minutes of chasing a
  fake bug.
- **A test that clicks `document.querySelector('.session-card')` silently depends on the sort order.**
  Once one button had two states, "the first card" was whichever state the sort happened to put first.
  Pick the card by its title.
- **The board opens filtered to Active**, so a test about an ENDED session's card has to widen the
  filter first and put it back afterwards, or the card is not in the DOM at all.
- **Seed an ended session BEFORE the page navigates.** Its `session-ended` broadcast then goes out
  with nobody listening; seed it later and the panel pops over the rest of the run.
- **`readSnapshot()` cannot see a non-snapshot broadcast**: it takes the first frame and hangs up,
  which is by definition before anything the test does. A separate long-lived `/stream` listener is
  needed, and now exists (`streamFrames`).
- **`gh pr merge --delete-branch` fails AFTER merging** when `main` is checked out in another worktree
  ("'main' is already used by worktree at ..."). The merge really happened; only gh's local checkout
  step failed. Verify with `gh pr view --json state,mergeCommit` rather than assuming it did not merge.
- **A promise-returning toggle must not flip its own state on a failed call** unless the failure means
  the same thing. Closing an editor is safe to flip on `no-window` (there is nothing there either way)
  but not on `ambiguous`; accepted, since the same button flips it back.
- Still true from before: `wt` splits on `;` even inside one quoted argument; `ELECTRON_RUN_AS_NODE` is
  inherited and turns any spawned Electron app into a bare Node; `windowsHide` hides a GUI app's first
  window; NTFS file tunneling makes `birthtime` unreliable; the smoke suite owns port 4318; a test
  server without `CMC_DRY_RUN` hijacks `server.lock`; PowerShell 5.1 `-Encoding utf8` writes a BOM that
  `JSON.parse` rejects; `chrome --dump-dom` never returns on this page; `gh auth refresh` cannot run
  inside a Claude session at all.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI now that it is 152 assertions and the only cover for
  this much UI?
- Is 20s the right `CMC_EDITOR_POLL_MS`? It is the delay before a hand-closed VS Code flips the card's
  button back, traded against a 0.6s PowerShell spawn.
- Should `Close session` also offer to flag the session for resume in the same confirm (it was one of
  the options considered and not taken; the end-of-session panel offers it a moment later instead)?
- Does the card's `Resume later` want a note field after all (the skill supports notes; the card and
  the panel deliberately do not)?
- Does the end-of-session panel need a Settings toggle to silence it, now that it appears for EVERY
  session ending rather than only ones with an editor open?
- Should `Close VS Code` also work for windows opened by hand, accepting the basename-collision risk?
  Today it is scoped to windows this app opened.
- Does the resume picker want more (resume in a new window, sorting, an age cutoff)?
- Anything else for the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` and `skills/` currently DO trigger a release.
- Still open: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should the tab title
  stop being what `bringToForeground()` matches on? Check `VibeTraderAI` for the same `\"` updater bug?
  PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **The previously installed Mission Control Center is still RUNNING** on port 4317, started by
  Patrick before this session. It was never stopped by this session, which started no long-lived
  server of its own. Its hooks and statusline wrap are registered in `~/.claude/settings.json`, which
  is normal while the app is open. **Installing 0.1.18 replaces it**; the updater tears the old
  backend down first, which is the order that has to be right.
- Every test server this session ran under `CMC_DRY_RUN` with a hermetic temp HOME and is stopped.
  Nothing was ever parked on 4318 (the smoke suite's port).
- The window probe added this session really did run against the live desktop during the smoke suite,
  read-only: `EnumWindows` plus `Get-Process`, no focus taken, no window touched.
- `main` is the ONLY worktree and the ONLY branch, local and remote. `MissionControlCenter-36` was
  removed cleanly and `feat/session-controls` is deleted locally and on GitHub.
- FIVE sessions were flagged for resume at the start of this session and none were resumed or
  unflagged, so all five remain: `Samberg VIBE Extension`, `ZRM DOCS: Fix zeptomail send`,
  `FORSIA DOCS UPDATE`, `TimetrackerProjects` and `MCC vscode open button`.
- No Docker, no keep-awake, no cron or scheduled jobs.
- Two junctions still exist under `~/.claude/skills`: `agent-fleet-monitor` and `resume-later`.
- Screenshots stayed in the session scratchpad and were deleted; nothing landed in the repo.
