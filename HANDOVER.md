# HANDOVER

## Date, branch, PR, CI
- Date: 2026-08-09
- Branch: `main`, clean at the merge of **#45**. This handover is a docs-only commit straight to
  `main` (Patrick approved it explicitly this time; a `*.md`-only commit mints no release).
- Two PRs this session, both merged:
  - **#42** (`5553f66`), closing **#39**, **#40**, **#41**. Released as `fleet-v0.1.19`.
  - **#45** (`371030f`), closing **#43**, **#44**. Released as `fleet-v0.1.20`.
- CI green on both branches (39s and 38s). The gate is now **SIX** steps: the `.mjs` syntax sweep,
  `smoke-server.mjs`, `check-desktop-package.mjs`, `check-installer-launch.mjs`,
  `check-flag-resume.mjs`, and the new `check-statusline-feed.mjs`.
- Latest release: **`fleet-v0.1.20`**, MSI attached (112 MB). The tag points at the merge commit
  itself (`fleet-v0.1.20` -> `371030f`, verified), so the work really is in that MSI.
  `https://github.com/patr7257/MissionControlCenter/releases/download/fleet-v0.1.20/Mission.Control.Center.0.1.20.msi`
- **0.1.20 is INSTALLED and everything this session shipped is confirmed working from it**
  (2026-08-09, screenshot reviewed): the in-app update check reports "You are on the latest version
  (0.1.20)", there is no terminal-window flashing, the tune plays, and the usage feed populates. That
  last one closes an item that had been the top carried-over gap for four sessions. Details in
  "Confirmed live" below.
- Board: both cards Done, no open issues, no open PRs, `main` is the only branch local and remote.

## Confirmed live from the installed 0.1.20 (2026-08-09)
Everything below was seen working on Patrick's machine, not inferred:
- **No terminal windows.** The #43 regression is genuinely fixed in a packaged install, and the
  statusline feed still works at the same time, which is the pair that matters: hiding the console
  must not cost the feed.
- **The usage feed populates in a packaged install.** The 5 hour bar (15%), the 7 day bar, and the
  per-card context rings (8 / 17 / 38 CTX) all render with real numbers. **This is the first time
  this has ever been seen working outside the repo copy**, and it was the top carried-over item for
  four sessions.
- **The tune plays and it is the right song.**
- The runtime rings work with real values, including the red severity band (a 487 MIN session, past
  the 255 red threshold).
- The in-app update check answers correctly ("You are on the latest version (0.1.20)") via the `gh`
  CLI, so the self-update path is healthy on this install.

One thing to look at, low confidence because it comes from a single cropped screenshot rather than a
measurement: **the header's 7 day bar showed no percentage or reset text beside it**, where the
design (and `render-check.mjs`) expects something like `68% resets Thu 12:35`. It may simply have
been clipped by the window edge in that capture. Reproduce at a known window width before treating it
as a bug, and note CLAUDE.md's standing rule that a layout claim from a resized or cropped view is
not evidence.

## READ THIS FIRST: this session shipped a bad regression and then fixed it
1. **0.1.19 flooded the desktop with terminal windows until it crashed.** #41 packaged the statusline
   wrapper, and packaged means `statusline-feed.mjs` runs inside the **Electron binary, which is
   GUI-subsystem and owns no console**. Its `shell: true` child therefore had no console to inherit,
   so Windows created one, and on Windows 11 the default console host is Windows Terminal, so that is
   a whole terminal WINDOW per statusline render, which is roughly every message and tool result.
   Under `node.exe` (the repo copy) the same child silently borrowed the terminal's existing console,
   which is exactly why nothing showed up in testing. **The general rule: any spawn added to code
   that can run under the packaged binary inherits no console, so a console child always needs
   `windowsHide: true`.**
2. **`windowsHide` now has TWO OPPOSITE rules in this repo. Never apply one by analogy.** It is
   MANDATORY in `statusline-feed.mjs` (console child, no console to inherit) and BANNED in
   `terminal.mjs editorSpawnOptions()` (GUI child whose own first window would be swallowed, issue
   #33). Both CLAUDE.md notes now cross-reference each other and both say to decide from the CHILD'S
   SUBSYSTEM. Applying either by habit produces the other bug.
3. **A verification that would reproduce the bug must not be run.** Proving a console window appears
   needs window enumeration DURING a spawn, i.e. spawning the very windows that crashed the machine.
   `check-statusline-feed.mjs` therefore splits honestly: the stdout and exit-code assertions are
   behavioural and now run WITH the flag, proving hiding the console does not disturb stdio; the
   "does a window appear" half is a labelled STATIC read of the spawn options, negative-tested to
   fail if the flag is removed or set to `false`.
4. **Deliver the literal ask.** #39 asked for "Claude's Plan" by Jeff Guo and shipped a melody
   invented for the occasion. It was disclosed as "an original hook" in the plan and the PR, but that
   was buried under a Spotify-versus-synth framing, so the one thing that mattered (it is not the
   song) did not land. When a request names a specific artifact, say plainly whether you are
   delivering that artifact or a substitute.
5. **Never quote a release version from CLAUDE.md.** Every version in those notes is frozen history.
   Reading the "0.1.9 through 0.1.12" line as current produced a claim that a merge would ship 0.1.13
   while the repo was already on 0.1.18. Resolve it with `gh release view --json tagName --jq .tagName`
   every time; CLAUDE.md now says so explicitly.

## TLDR of session outcome
**`fleet-v0.1.19` (PR #42), three issues.**
- **#41, packaged installs feed the statusline.** `desktop/assets/statusline-feed.mjs.cmd` (ends
  `exit /b %ERRORLEVEL%`, not `exit /b 0`, because it runs the user's real statusline and must report
  its code), an `extraResources` entry, `CMC_STATUSLINE_COMMAND` set in `desktop/main.mjs`, and
  `ELECTRON_RUN_AS_NODE` stripped from the wrapped command's env. New `check-statusline-feed.mjs`
  really spawns the wrapper against a hermetic HOME. `check-desktop-package.mjs` now asserts every
  `desktop/assets/*.cmd` is mapped and every mapped source exists. **This is the change that
  introduced the regression above.**
- **#40, the New session popup is a fixed size.** `width: 920px` instead of a `max-width: 760px` cap
  (a cap is what let it grow with its content), and `.chain` is a grid of exactly five tracks, one
  per `MAX_SELECTORS`, so level 1 renders at the width it still has at level 5 and a new level fills
  the next track. Trailing empty tracks are the price of nothing moving and are the point. Tinted
  with `--go` plus a two-layer highlight so it stands out against the dimmed board.
- **#39, the Claude mark.** The header bullet is an inline-SVG starburst button that plays a tune.

**`fleet-v0.1.20` (PR #45), two issues.**
- **#43, the regression fix.** `windowsHide: true` on the wrapper's shell child, plus the guard and
  the paired CLAUDE.md notes described above.
- **#44, the real song.** `public/claudes-plan.mp3` (192 kbps stereo, ~39s, 912 KB) played by a plain
  `<audio>` element, replacing the oscillators. Still offline and zero-dependency. **`server.mjs`
  `CONTENT_TYPES` had no audio entry at all**, which is the non-obvious half: the fallback serves the
  clip as `application/octet-stream`, the browser refuses to decode it, and the mark looks correctly
  wired while doing nothing. `tune.js` kept its exact API (`toggle`/`stop`/`isPlaying`/`onChange`) so
  `index.html` did not move.
- Verification: `render-check.mjs` is now **160** assertions (was 152), all pass.

Not started (carried over, unchanged by these sessions):
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- `public/demo.js` knows nothing about the rings, bars, flags, the card buttons, the ended panel, the
  fixed popup or the Claude mark. It has now drifted through five features.
- `wt focus-tab` against a COLD managed window, and whether the `SetForegroundWindow` nudge really
  raises the window rather than only flashing the taskbar icon. Both best effort by design.

## Prioritized next steps
The three verification items that used to head this list are all done, see "Confirmed live" above.
1. **Check the header's 7 day bar at a known window width** and confirm its percentage and reset text
   are actually rendered rather than clipped. See the caveat above; this is an observation from one
   cropped screenshot, not a measurement, so establish whether there is a bug before fixing one.
2. Walk the New session folder chain to its deepest level and confirm nothing on screen moves. The
   geometry is asserted, but the feel of it is not, and the reserved empty tracks are a deliberate
   trade that Patrick has not passed judgement on yet.
3. Decide whether `scripts/render-check.mjs` should run in CI. It is now 160 assertions and the only
   automated cover for this much UI, and it skips with exit 0 without a browser, so it needs a
   browser step on the runner. Open since three sessions.
4. Teach `public/demo.js` the newer UI so `?demo=1` still represents the app. It has now drifted
   through five features and is the largest piece of visible rot in the repo.
5. Pick up the smaller carried-over items: the patrickrobelweb embed of the `?demo=1` showcase, the
   Humaaans CC-BY credit line, and the demo confetti beat.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317).
**Safe even before 0.1.20 is installed**: the repo copy runs under `node.exe`, which has a console to
lend its children, so it never had the window bug.
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
The full CI gate, all six steps, exactly as the runner does it:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs; node scripts\check-desktop-package.mjs; node scripts\check-installer-launch.mjs; node scripts\check-flag-resume.mjs; node scripts\check-statusline-feed.mjs
```
Real-browser check, 160 assertions, plus all screenshots on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
See what `settings.statusLine` currently points at, i.e. whether the packaged wrapper is installed
(read-only, and the fastest way to tell whether the window bug is armed):
```
node -e "const fs=require('fs'),os=require('os'),p=require('path');console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude','settings.json'),'utf8')).statusLine,null,1))"
```
Confirm the statusline wrapper still hides its console (the #43 guard, run on its own):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\check-statusline-feed.mjs
```
A design-review preview that CANNOT disturb the running app (reads real sessions and real usage,
writes nothing, never takes the hook lock). **Do not use 4318: that is the smoke suite's port.**
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node server.mjs --port 4319
```
Read the current release version from GitHub (NEVER from CLAUDE.md, see lesson 5 above):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; gh release view --json tagName --jq .tagName
```
See which folders the app currently believes have an OPEN VS Code window (runs the real probe, opens
and closes nothing):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node -e "import('./terminal.mjs').then(async t=>{await t.refreshOpenEditors();console.log(JSON.stringify({recorded:t.openedEditors.map(e=>e.folder),open:t.openEditorFolders()},null,1));});"
```
Which pid belongs to which session (Claude Code's own live registry, the same files the server reads):
```
Get-ChildItem "$env:USERPROFILE\.claude\sessions\*.json" | ForEach-Object { $j = Get-Content $_ -Raw | ConvertFrom-Json; "{0}`t{1}`t{2}" -f $j.pid, $j.status, $j.name }
```
Check which GitHub account every gh config is really using (run FIRST for any gh auth problem):
```
powershell -File "C:\Users\pr\.claude\scripts\gh-auth.ps1"
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
- **A GUI-subsystem parent has no console to lend a child.** This is the whole 0.1.19 bug and the
  single most transferable thing here. `node.exe` is console-subsystem; the Electron binary is not.
  Identical code, opposite behaviour.
- **On Windows 11 a new console is a Windows Terminal WINDOW**, class `CASCADIA_HOSTING_WINDOW_CLASS`,
  not a conhost `ConsoleWindowClass` box. A window probe that counts only `ConsoleWindowClass` sees
  nothing and reads as a clean result. This cost a wrong "no window appeared" conclusion.
- **Diff windows by HANDLE, never by `handle|class|title`.** A terminal animating a spinner changes
  its title constantly, so a triple-keyed diff reports it as a brand new window every time. This
  produced two confident false positives in a row.
- **`color-mix()` computes to `color(srgb ...)` in Chromium**, so counting box-shadow layers by
  matching `rgba(` silently reads as one layer. Match colour FUNCTIONS instead.
- **`audio.paused` flips synchronously inside `play()`**, before the `play` event fires. A test that
  settles on the audio state resolves before the UI has repainted and passes while proving nothing
  about the binding. Settle on the BUTTON.
- **A CDP `el.click()` is an untrusted event**, so Chrome's autoplay policy blocks playback and the
  failure looks like an app bug. `render-check.mjs` now passes
  `--autoplay-policy=no-user-gesture-required`.
- **`server.mjs` serves unknown extensions as `application/octet-stream`**, so any new asset type
  needs a `CONTENT_TYPES` entry or it loads as bytes the browser refuses to use.
- **With `shell: true`, a nonexistent command does NOT reach `child.on('error')`.** The shell spawns
  fine and reports the failure itself, so the right behaviour is passing its non-zero code through
  rather than masking a broken command as healthy. An assertion expecting "fail open, exit 0" was
  wrong, not the code.
- **`@'...'@` is PowerShell here-string syntax and silently corrupts a Bash heredoc.** Run through the
  Bash tool it left a literal `@` as the first and last line of two GitHub issue bodies and a commit
  message. Use `-F <file>` / `--body-file` for anything multi-line.
- **A merged PR's remote branch is not always auto-deleted.** #42's was, #45's was not; check
  `git ls-remote --heads origin` rather than assuming.
- Still true from before: `wt` splits on `;` even inside one quoted argument; `ELECTRON_RUN_AS_NODE`
  is inherited and turns any spawned Electron app into a bare Node; NTFS file tunneling makes
  `birthtime` unreliable; the smoke suite owns port 4318; a test server without `CMC_DRY_RUN` hijacks
  `server.lock`; PowerShell 5.1 `-Encoding utf8` writes a BOM that `JSON.parse` rejects;
  `chrome --dump-dom` never returns on this page; `gh auth refresh` cannot run inside a Claude
  session at all.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI now that it is 160 assertions? Open for three sessions.
- The New session popup reserves all five folder-chain slots up front, so a shallow chain leaves
  visible empty space to the right. That is what makes nothing move as the chain deepens. Keep it, or
  hug the selects and accept the reflow?
- Should the tune have a Settings toggle to mute it, or a volume? Today it is full volume, one clip,
  click to stop.
- Should the clip loop? It plays once and the button clears on `ended`. The oscillator version looped.
- Is 20s the right `CMC_EDITOR_POLL_MS`?
- Should `Close VS Code` also work for windows opened by hand, accepting the basename-collision risk?
- Anything else for the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` and `skills/` currently DO trigger a release.
- Still open: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should the tab title
  stop being what `bringToForeground()` matches on? PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **0.1.20 is installed.** At the moment this handover was written no server was running:
  `~/.claude/agent-fleet-monitor/server.lock` is absent, nothing listens on 4317, and
  `settings.statusLine` is back on Patrick's own `python "C:\Users\pr\.claude\statusline-command.py"`,
  restored when the app was last quit. That is the normal quiet state; opening the app re-installs
  the wrapper and the hooks, and on 0.1.20 that is now safe.
- Every test server this session ran under `CMC_DRY_RUN` with a hermetic temp HOME and is stopped.
  Nothing was ever parked on 4318.
- **Window probes were run against the live desktop and are deleted.** Two diagnostic scripts
  deliberately spawned console windows while the machine was already being flooded; they were removed
  from the scratchpad at session end and nothing that spawns a window remains.
- `main` is the ONLY worktree and the ONLY branch, local and remote. `feat/tune-popup-statusline` and
  `fix/statusline-window-spam` are deleted locally and on GitHub.
- Nothing is flagged for resume (the five flags noted in the previous handover are all cleared).
- No Docker (engine down, not started by this session), no keep-awake, no cron or scheduled jobs.
- Two junctions still exist under `~/.claude/skills`: `agent-fleet-monitor` and `resume-later`.
- Screenshots stayed in the session scratchpad and were deleted; nothing landed in the repo. The one
  binary that WAS committed is `public/claudes-plan.mp3`, deliberately, because it must ship.
