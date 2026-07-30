# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-30
- Branch: `main` (this handover is a docs-only commit straight to `main`, as agreed)
- PRs this session: #17, #19, #21, #24 squashed and merged (issues #16, #18, #20, #22, #23 closed),
  plus PR #26, the FINAL one, carrying issue #25 (the header icon-button gap) together with these docs.
- CI green on every branch and on `main` after each merge.
- Releases published automatically by those merges: `fleet-v0.1.9`, `0.1.10` (dead, see below),
  `0.1.11`, and **`fleet-v0.1.12`, which is what is installed and running**:
  `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.12`
- Installed build verified: `ProductVersion 0.1.12.0`, packaged `app/package.json` says `0.1.12`,
  app running and serving `http://localhost:4317`.

## READ THIS FIRST: three traps this session paid for in full
1. **`wt` splits on `;` even inside ONE quoted argument.** Every `; ...` segment becomes another tab
   whose "executable" is the segment text (`0x80070002`), while the first tab runs only the fragment
   before the first `;`. That is why every launch produced four junk tabs and never started Claude.
   The hosted PowerShell script now travels as base64 UTF-16LE via `-EncodedCommand`. **Never go
   back to `-Command` with a `; `-joined string.**
2. **An updater only fixes FUTURE hops.** The build performing an upgrade is the INSTALLED one, so a
   fix to the updater does nothing for the very next upgrade. Every updater change costs exactly one
   manual install to escape the old build. This cost two full round trips before it was said out
   loud; it is now the first rule in the `self-updating-desktop-app` skill.
3. **A packaged app can be dead while the repo copy is perfect.** electron-builder's `files` was an
   explicit allowlist, so a new module was imported but never packaged and 0.1.10 could not start at
   all (`ERR_MODULE_NOT_FOUND`). `scripts/check-desktop-package.mjs` now fails on exactly that, and
   it runs in CI.

## TLDR of session outcome
Shipped in `fleet-v0.1.9` (PR #17, issue #16):
- **The semicolon fix** in both `launchSession()` and `reopenSession()`, plus `firstSemicolonArg()`
  refusing a repo path that contains a `;` rather than spawning junk, the fallback tab title going
  through `sanitizeSessionName()` too, and `reopenSession()` unbinding prior `managedTabs` entries
  only once the command is known launchable.
- **"Reopen" became "Take Control"** with an in-app styled confirm replacing `window.confirm`
  (a native confirm renders in Electron as a bare OS dialog titled "Mission Control Center").

Shipped in `fleet-v0.1.11` (PRs #19 and #21, issues #18 and #20):
- **The in-app updater works.** `launchInstaller()` passed the whole `cmd /c ping ... & msiexec /i
  "<path>"` line as one argv element, so Node escaped the inner quotes as `\"`, cmd.exe passed that
  through literally, and msiexec hunted for a file whose name contained quote characters. Fixed with
  `windowsVerbatimArguments: true` in the new `desktop/installer-cmd.mjs`. A second trap found while
  writing the test: the command line must NOT start with a quote, or `cmd /c` strips the outer pair
  and a quoted program path with spaces breaks. The unquoted leading `ping` prevents it.
- **The packaging guard** (`scripts/check-desktop-package.mjs`) after 0.1.10 shipped dead, plus
  `files: ["*.mjs", "preload.cjs"]` so a new module ships automatically.
- Update temp dirs are swept (one 100+ MB MSI per attempt used to be left behind forever; 8 dirs and
  778 MB were found).

Shipped in `fleet-v0.1.12` (PR #24, issues #22 and #23):
- **`/rename` reaches the board.** `session.title` was write-once (every writer guarded on
  `!session.title`), so the first name a session ever had won forever: this repo's session kept the
  auto-generated `missioncontrolcenter-62` through two renames. New `applyLiveName()` adopts a
  CHANGED name from the registry's `name` and the statusline's `session_name`;
  `applyLaunchName()` stays fill-only on purpose.
- **Keyboard and mouse shortcuts** in `public/shortcuts.js`: mouse side buttons and `Alt+←`/`Alt+→`
  for back/forward through the app's own history, `Esc` to leave a session, `N`, `S`, `1`/`2`/`3`,
  `,`, `?`/`F1`. One `BINDINGS` registry is the single source of truth for both the handler and the
  guide.
- **A Settings popup** behind a gear button next to the stats button, holding the generated
  shortcuts guide and the first real setting (mouse navigation, persisted to
  `localStorage.cmcSettings`). This is where future settings go: add a `.set-section`.
- **Session cards are keyboard reachable** (`tabindex`, `role=button`, Enter/Space jumps to the
  terminal). Before this, Tab skipped every card and the primary action was mouse-only.

Outside this repo:
- **Fixed a broken global SessionStart hook** in `~/.claude/settings.json`: the HANDOVER notice had
  `$t=` inside a double-quoted command, which the outer shell expanded to nothing, so every session
  logged `The term '=' is not recognized` and the notice never printed. Rewritten with the timestamp
  inlined; tested through both bash and PowerShell.
- **`~/.claude/skills/self-updating-desktop-app` was rewritten** from this session's failures: it was
  124 lines, jpackage-only, release-on-tag-only, and knew nothing about Electron. Now 275 lines plus
  `references/auto-release-on-merge.md` (this repo's workflow, copyable) and
  `references/electron-packaging-guards.md` (both guard scripts), with the updater-only-fixes-future-
  hops rule, both install-launch traps, and a failure-class-to-detection-method table.

Not started (carried over):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so the quota meters and context rings populate in
  a packaged install instead of only when running the repo copy. **This is the top remaining item.**
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. Use the new shortcuts for real for a while (mouse side buttons, `Alt+←`, `1`/`2`/`3`, `?`) and say
   what is missing. Cards are focusable now, so a `j`/`k` or arrow-key selection with Enter to jump
   is the obvious next increment if Tab is not enough.
2. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`. Until then the packaged app's quota meters and
   context rings stay blank, and the installed app only shows them because system Node happens to be
   on this machine.
3. Decide whether `scripts/render-check.mjs` should run in CI. It skips with exit 0 without a
   browser, so it needs a browser step on the runner. It is the only automated cover for the Take
   Control dialog and the shortcuts.
4. Confirm the two remaining best-effort behaviours by hand: `wt focus-tab` against a COLD managed
   window, and whether the `SetForegroundWindow` nudge raises the window or only flashes the taskbar
   icon while the app is in the background.
5. Optional: two obsolete MSIs are sitting in `C:\Users\pr\Downloads`
   (`Mission.Control.Center.0.1.11.msi` and `0.1.12.msi`, 111 MB each) plus older ones. Safe to
   delete now that 0.1.12 is installed.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
Server + wire + installer-command checks (same as CI):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs; node scripts\check-desktop-package.mjs; node scripts\check-installer-launch.mjs
```
Real-browser check plus all three screenshots (board, Take Control, Settings) on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
Inspect exactly what a launch would run, without opening a tab:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(t=>{const r=t.launchSession('C:/Users/pr/repos/2-ZRM/customers','customers','probe',null);console.log(r.command);console.log(r.script);});"; Remove-Item Env:\CMC_DRY_RUN
```
Prove a release MSI really contains what it should, without installing it (administrative install to
a temp dir, the check that would have caught 0.1.10):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $ex="$env:TEMP\mcc-extract"; Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue; msiexec /a "$env:USERPROFILE\Downloads\Mission.Control.Center.0.1.12.msi" /qn TARGETDIR="$ex"; Start-Sleep -Seconds 20; Get-ChildItem -LiteralPath $ex -Recurse -Filter *.mjs | Select-Object Name
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
- **`wt` splits on `;` even inside one quoted argument.** No generated `wt` argument may contain a
  raw semicolon. `-EncodedCommand` (base64 UTF-16LE) removes semicolons, spaces, quotes and
  non-ASCII bytes from the payload in one move, which also protects the `Røbel` in the git identity
  vars from the console codepage.
- **Node quotes a `cmd /c` argument and escapes inner quotes as `\"`, which cmd passes through
  literally.** Symptom: "This installation package could not be opened" while a perfectly valid MSI
  sits in `%TEMP%`. Use `windowsVerbatimArguments: true`.
- **`cmd /c` strips the outer quote pair when the command line STARTS with a quote**, breaking a
  quoted program path containing spaces. Keep an unquoted first token.
- **An updater only fixes future hops** (see the top). Say it out loud before shipping one.
- **A packaged app is a separate allowlist from the repo.** `files` omissions only fail at runtime on
  the user's machine, after release. Prefer globs and keep the static guard.
- **Verify an installer before blaming the download**: an MSI starts with `D0 CF 11 E0 A1 B1 1A E1`,
  and `msiexec /a <msi> /qn TARGETDIR=<dir>` extracts it without installing, which is how "did my
  new file actually ship" gets answered in seconds.
- **A launch started from inside a Claude session is not a faithful test.** The child inherits
  `CLAUDE_CODE_CHILD_SESSION`, so it never registers in `~/.claude/sessions/` and never reaches the
  board. Test New session from the app UI.
- **Never `Stop-Process -Force` a `claude.exe`.** It never disables xterm mouse reporting, so the
  surviving shell fills with `[555;61;16M`-style garbage. Close the tab or exit properly.
- **A shell expands `$var` in a hook command before the inner shell sees it** (that is what broke the
  global HANDOVER hook: `$t=` became `=`).
- **A backtick inside a JS template literal ends the literal**, and the SyntaxError points at the top
  of the block, nowhere near the comment that caused it.
- **An assertion can read state the action under test already changed** (a successful take-control
  clears `unmanaged`, so reading the class afterwards always "failed"). Capture at the moment the
  value is meant to hold.
- **Give any sweep/cleanup function an explicit root parameter.** A test for the update-dir sweep ran
  against the real `%TEMP%` and deleted the developer's genuinely downloaded MSIs mid-session.
- Still true from before: `server.lock` can be hijacked by a test server (always `CMC_DRY_RUN=1` plus
  a temp HOME); PowerShell 5.1 `-Encoding utf8` writes a BOM that `JSON.parse` rejects; an installed
  app can serve a NEW UI with an OLD backend; never run `gh auth switch`; the Desktop is
  OneDrive-redirected; `chrome --dump-dom` never returns on this page; use `minmax(0, 1fr)` on cards.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI (needs a browser step on the runner)?
- Anything else to add to the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` currently DOES trigger a release.
- Do the shortcuts need card-to-card selection (`j`/`k` or arrows plus Enter), or is Tab enough now
  that cards are focusable?
- Should the tab title stop being what `bringToForeground()` matches on, given Claude Code rewrites
  it on resume? The alternative is accepting best effort for resumed tabs.
- `VibeTraderAI` has `vibe-update-*` dirs in `%TEMP%`, so its updater looks copied from this one and
  probably has the identical `\"` bug. Check it in its own session?
- PatrickRobelWeb's `HANDOVER.md` is still stale (claims PR #160 awaits merge, no open PRs there).

## Environment state
- **The installed app is running on purpose** (0.1.12, serving `http://localhost:4317`), since it is
  what this session is being driven from. Its hooks are registered.
- `main` is clean and up to date, ONE worktree (the primary checkout). All four session worktrees
  (`-16`, `-18`, `-20`, `-22`, `-23`) removed, every branch deleted local and remote, no
  gone-upstream branches, no open PRs, board all Done.
- Keep-awake NOT active; power defaults intact (lid close = sleep on AC and DC).
- No Docker (daemon not running), no cron or scheduled jobs created this session, no stray Chromium.
- Screenshots and probe scripts went to the session scratchpad only; nothing landed in the repo.
- `C:\Users\pr\Downloads` holds the 0.1.11 and 0.1.12 MSIs (111 MB each) plus older ones, left there
  deliberately so the manual install line stayed valid. Safe to delete.
