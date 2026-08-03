# HANDOVER

## Date, branch, PR, CI
- Date: 2026-08-03
- Branch: `main`, clean and up to date at `a440847`. This handover is a docs-only commit straight to
  `main`, as agreed for handover docs.
- PR this session: **#28 merged** (squash, `a440847`), closing issue **#27**. Board card Done.
  `https://github.com/patr7257/MissionControlCenter/pull/28`
- CI green on both branch commits (`98f6af5`, `436a037`) and on `main` after the merge.
- Release published automatically by the merge: **`fleet-v0.1.14`** with its MSI attached (111.3 MB).
  `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.14`
- **The installed app is still 0.1.13 and was running throughout** (Patrick started it at 08:42, so
  it was deliberately left alone). The updater READ path was verified against the real release:
  `findNewerRelease('0.1.13')` returns `fleet-v0.1.14` and `findNewerRelease('0.1.14')` returns
  `null`. Nothing in 0.1.14 has been seen in a packaged install yet.

## READ THIS FIRST: a static-and-dry-run-clean spawn can still do nothing
Three separate bugs in this session's feature passed every `node --check`, every dry run and every
static review, and only fell out of really spawning the thing and then ENUMERATING WINDOW TITLES to
ask "did a window actually appear?". `Get-Process | MainWindowTitle` is not enough: extra Electron
windows live in the same process, so a second VS Code window never shows up there. Use
`EnumWindows` + `GetWindowText` via `Add-Type` (read-only, no focus stealing).

1. **`ELECTRON_RUN_AS_NODE=1` turns `Code.exe` into a bare Node interpreter**, which tries to
   `require` the folder path and exits 1 with nothing visible. `desktop/main.mjs` spawns
   `server.mjs` with exactly that variable, so every packaged install would have been dead.
   A Claude Code session's own env has it too, which is how it surfaced.
2. **A non-detached spawn opened no window at all.** A second `Code.exe` only forwards the folder to
   the running instance over a named pipe and exits, so being killed mid-handoff loses the request.
3. **An 8s cap on the close query reported real closes as timeouts**, because a close genuinely
   costs about 6s. That mistake left three stale VS Code windows on the desktop mid-test.

## TLDR of session outcome
Shipped in `fleet-v0.1.14` (PR #28, issue #27): open AND close a repo's VS Code window from
Mission Control, with no terminal window involved at any point.

- **Open**: a `VS Code` button in every session card footer (opens that session's `cwd`) and one in
  the New session popup footer (opens the folder the dropdowns point at, no session launched).
  `terminal.openInVsCode()` plus `POST /open-editor`. Spawns `Code.exe` directly, never `code.cmd`
  (Node needs a shell for a `.cmd`, and that shell is the console flash), never through `wt` (a
  self-closing tab would shift every later tab index and break the positional `tabIndex` invariant
  in `managedTabs`).
- **Close**: a `Close VS Code` button, shown only while this app has a record of opening an editor
  for that folder, plus an in-app offer when a session ends ("Session ended. Close the VS Code
  window Mission Control opened for it?"). `terminal.closeEditor()` plus `POST /close-editor`.
- **The New session popup is wider** (760px) and the folder chain no longer wraps, so three to four
  cascading folder selects sit on one row instead of the fourth dropping to a new line.
- Verification grew a lot: `scripts/smoke-server.mjs` covers both endpoints, the command shape, the
  env sanitising, path validation and containment, and asserts the close script posts `WM_CLOSE`
  while containing no `SendKeys`/`AppActivate`/`SetForegroundWindow`. `scripts/render-check.mjs` is
  now **109 assertions** and gained a fifth screenshot (the session-ended offer).

Not started (carried over from 2026-07-30):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so quota meters and context rings populate in a
  packaged install. **Still the top remaining item.**
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. **Install 0.1.14 and use the new buttons for real.** Accept the in-app update banner rather than
   installing by hand: that finally exercises the download-and-install path, which is STILL unproven
   from a fixed build (see 2026-07-30's step 5). Watch for a `cmc-update-*` dir under `%TEMP%`
   holding the 0.1.14 MSI, then the app quitting a few seconds later.
2. Say whether the end-of-session offer needs a Settings toggle. It currently fires whenever a
   session ends AND this app opened its editor, with no way to silence it (deliberate: only the
   in-app confirm was chosen, no native toast, no toggle).
3. Fix `~/.config/gh-personal/hosts.yml`, which has drifted to `user: przrm`. That is why issue #27
   and PR #28 were authored by the work account on a personal repo, and why `gh pr ready` failed
   with a permissions error until a per-process `GH_TOKEN` was used. One line inside that config
   dir fixes it; it must NOT be fixed with a machine-wide `gh auth switch`.
4. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`.
5. Decide whether `scripts/render-check.mjs` should run in CI. It is now the only automated cover
   for the Take Control dialog, the shortcuts, the popup geometry AND both VS Code actions, and it
   skips with exit 0 without a browser, so it needs a browser step on the runner.
6. Confirm the two remaining best-effort behaviours by hand: `wt focus-tab` against a COLD managed
   window, and whether the `SetForegroundWindow` nudge raises the window or only flashes the taskbar
   icon.

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
Real-browser check plus all five screenshots (board, Take Control, Settings, New session, session
ended) on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
See which VS Code executable would be used, without opening anything:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(t=>console.log(JSON.stringify(t.openInVsCode(process.cwd()),null,1)));"; Remove-Item Env:\CMC_DRY_RUN
```
Ask the server which VS Code window it would close for a folder, without closing it (dry run reports
the exact PowerShell it would run, including the `WM_CLOSE` call and the title pattern):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node -e "import('./terminal.mjs').then(async t=>{t.openInVsCode(process.cwd());console.log((await t.closeEditor(process.cwd())).script);});"; Remove-Item Env:\CMC_DRY_RUN
```
(To LIST real windows the way this session's three spawn bugs were found, write a throwaway
`Add-Type` + `EnumWindows` script to the scratchpad rather than pasting one: the nested quoting does
not survive a chat paste. `Get-Process code | Select-Object MainWindowTitle` is NOT a substitute, it
only ever shows one window per process.)
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
- **`ELECTRON_RUN_AS_NODE` is inherited and poisons any Electron app you spawn.** Strip it
  (`editorSpawnEnv()`), and remember `desktop/main.mjs` sets it on the server on purpose.
- **`detached: true` is required for a handoff-style child**, not just for long-lived ones. A child
  that must talk to another process before exiting dies with a short-lived parent.
- **`windowsHide` and `detached` conflict on Windows** (`CREATE_NO_WINDOW` is ignored when
  `DETACHED_PROCESS` is set), which only matters for a console-subsystem exe. Check the PE
  subsystem byte before agonising: `Code.exe` is subsystem 2 (GUI), so it has no console either way.
- **There is no VS Code CLI to close a window.** `code --status` lists window titles only, with
  folder BASENAMES and no paths, and costs 2.6s.
- **Every VS Code window shares one pid** (the Electron main process), so windows can only be told
  apart by title, and VS Code's default title carries the folder BASENAME. Two folders called `web`
  are indistinguishable: refuse, never guess (proved live with two real `web` windows).
- **`WM_CLOSE` via `PostMessage` is not desktop puppeting**: it is addressed to ONE handle, needs no
  focus and changes no focus, unlike `SendKeys`/`SetForegroundWindow`. Approved for this use on
  2026-08-03. VS Code still runs its own save prompt, so a window that stays open is PENDING, not
  failed.
- **A flex `<select>` needs `min-width: 0`** or its `min-width: auto` resolves to the content width
  and forces the row wider than its panel. Same class of bug as the `.session-card`
  `minmax(0, 1fr)` blowout, and equally invisible to review.
- **`git worktree remove` can half-succeed**: it deleted the contents but left the empty directory
  behind with "Permission denied", because a VS Code window had that folder open. Close the editor,
  then `rmdir`. The registration was already gone, so `git worktree remove` then says "not a working
  tree" and `git worktree list` looks clean while the directory still exists.
- **After a squash merge, `git log origin/main..<branch>` is NOT empty** and that is expected. Prove
  parity with `git diff --stat main <branch>` before deleting the branch.
- **`~/.config/gh-personal` can drift to the wrong active user.** Symptom: `gh pr ready` fails with
  "przrm does not have the correct permissions" on a personal repo. Per-process fix that touches no
  shared config: `GH_TOKEN="$(gh auth token --user patr7257)" gh <command>`.
- Still true from before: `wt` splits on `;` even inside one quoted argument; an updater only fixes
  FUTURE hops; a packaged app is a separate allowlist from the repo; `server.lock` can be hijacked by
  a test server (always `CMC_DRY_RUN=1` plus a temp HOME); PowerShell 5.1 `-Encoding utf8` writes a
  BOM that `JSON.parse` rejects; never run `gh auth switch`; `chrome --dump-dom` never returns on
  this page.

## Open decisions waiting on Patrick
- Should the end-of-session "close VS Code" offer get a Settings toggle so it can be silenced?
- Should `scripts/render-check.mjs` run in CI now that it covers this much (needs a browser step)?
- Fix `~/.config/gh-personal/hosts.yml` to make `patr7257` its active user? (One line, inside that
  config dir only.)
- Should the `Close VS Code` button also appear for windows opened by hand, accepting the
  basename-collision risk? Today it is deliberately scoped to windows this app opened.
- Anything else to add to the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` currently DOES trigger a release, which is why this session's test-only changes shipped
  a version.
- Still open from before: do the shortcuts need card-to-card selection (`j`/`k` or arrows)? Should
  the tab title stop being what `bringToForeground()` matches on? Check `VibeTraderAI` for the same
  `\"` updater bug? PatrickRobelWeb's `HANDOVER.md` is stale.

## Environment state
- **The installed Mission Control Center 0.1.13 is STILL RUNNING** on port 4317 (pid 8552, started
  08:42 by Patrick). It was deliberately not touched: this session started no long-lived server of
  its own. Its hooks and statusline wrap are therefore still installed in `~/.claude/settings.json`,
  which is normal while the app is open.
- Every test server this session used a hermetic temp HOME and was killed; nothing of this session
  is listening. The real `server.lock` correctly points at pid 8552 on port 4317.
- No Docker (daemon down, and no Claude session marker, so nothing to stop). Keep-awake NOT active,
  lid-close power defaults intact. No cron or scheduled jobs created.
- `main` is the ONLY worktree. The `MissionControlCenter-27` worktree is removed (registration,
  contents and the leftover empty directory), the local and remote `feat/open-in-vscode` branches
  are deleted, no gone-upstream branches remain, no open PRs, no open issues, board all Done.
- Exactly ONE VS Code window is open, `MW_service_tool`, which is Patrick's own and was never
  touched. Every probe window this session created was closed again, confirmed by enumerating window
  titles at the end.
- Screenshots and probe scripts stayed in the session scratchpad; nothing landed in the repo.
