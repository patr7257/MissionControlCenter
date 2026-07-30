# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-30
- Branch: `main` (this handover is a docs-only commit straight to `main`, as agreed)
- PR this session: #17 (`cfecdb8`), squashed and merged, branch deleted, issue #16 closed.
- CI green on the branch and on `main` after the merge.
- Release: **`fleet-v0.1.9` published automatically** by the merge, MSI attached:
  `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.9`

## READ THIS FIRST: every launch was broken until this release
Launching a session from the app opened one half-working tab plus four junk tabs
(`0x80070002`) and never started Claude. Windows Terminal treats `;` as its own command
separator and splits on it EVEN INSIDE a single quoted argument, so the
`$env:GH_CONFIG_DIR='...'; $env:GIT_AUTHOR_NAME='...'; claude` string we handed to
`powershell.exe -NoExit -Command` was read as six commands. Fixed by sending the hosted script
as base64 UTF-16LE via `-EncodedCommand`. **Do not go back to `-Command` with a `; `-joined
string.** `CLAUDE.md` has the full trap written up under the multi-session manager section.

Anything installed at 0.1.8 or older still has the bug. Install 0.1.9.

## TLDR of session outcome
Shipped in `fleet-v0.1.9` (PR #17):
- **The semicolon fix** above, in both `launchSession()` and `reopenSession()` (identical defect).
- **Hardening around it**: a repo path containing `;` is refused with a clear error instead of
  spawning junk tabs (`firstSemicolonArg()`); the FALLBACK tab title now goes through
  `sanitizeSessionName()` too (only a typed name did, so a folder name was unsanitized);
  `reopenSession()` unbinds prior `managedTabs` entries only AFTER the command is known launchable,
  so a refused reattach no longer loses the binding; both entry points return the decoded `script`
  next to `command` so a dry run and a test read what actually runs.
- **"Reopen" is now "Take Control"**, and its `window.confirm` is replaced by an in-app dialog on
  the `.pop*` chrome (Esc/backdrop cancel, Enter confirms, focus opens on the confirm button and
  returns to the opener, session name inserted with `textContent`). A native confirm cannot be
  styled and renders in the Electron shell as a bare OS dialog titled "Mission Control Center".
- **Tests that would have caught it**: `scripts/smoke-server.mjs` now asserts the decoded payload
  and that NO generated `wt` argument contains a raw `;` (named launch, plain launch, reopen);
  `scripts/render-check.mjs` drives the real Take Control dialog in Chromium and, with `--shot`,
  saves a second `<shot>-take-control.png` so a modal can actually be looked at.

Verified by hand on the machine (not just in tests):
- `launchSession()` opened EXACTLY ONE tab, `claude.exe --name "MCC fix verify"` running as the
  hosted PowerShell's child, correct tab title, no junk tabs.
- `reopenSession()` really reattached: `claude.exe --resume <id>` running in a fresh tab, that tab
  active in the window afterwards. This closes the "reattach never validated" item.

Outside this repo (machine config, no repo change):
- **Fixed a broken global SessionStart hook** in `~/.claude/settings.json`. The HANDOVER notice hook
  contained `$t=(Get-Item ...)` inside a double-quoted command, and the outer shell expanded `$t` to
  nothing before PowerShell ran it, so every session logged `The term '=' is not recognized` and the
  notice never printed. Rewritten with the timestamp inlined, no variable. Tested through both bash
  and PowerShell, silent and exit 0 when there is no HANDOVER.md. Takes effect at next session start.

Not started (carried over):
- `desktop/assets/statusline-feed.mjs.cmd` wrapper, so quota meters populate in a packaged install.
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. Launch the still-installed 0.1.8 app and accept its update banner. That upgrade (0.1.8 to 0.1.9)
   is the GENUINE test of the updater fix, since 0.1.8 is the first build whose own installer logic
   contains it. Installing the MSI by hand works too but tests nothing.
2. In the upgraded app, use **New session** for real, from the UI, against both a `1-Personal` and a
   `2-ZRM` folder. Expect one tab each, no error tabs, and the card appearing on the board. My
   verification ran `launchSession()` from node, which is not quite the same path (see gotchas).
3. In that new tab, confirm the account pinning survived the encoding change:
   `$env:GH_CONFIG_DIR`, `$env:GIT_AUTHOR_EMAIL`, `gh auth status`.
4. Exercise **Take Control** on a real unmanaged card and **Resume** on a closed one.
5. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`, so the quota meters and context rings populate in
   a packaged install instead of only when running the repo copy.
6. Judge whether the `SetForegroundWindow` nudge really raises the window or just flashes the
   taskbar icon, and check `wt focus-tab` against a cold window.

## Verbatim resume commands (PowerShell first)
Start the app from the repo (installs hooks AND the statusline wrap, serves http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
Smoke test (same checks as CI, includes the new no-semicolon assertions):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs
```
Real-browser render check plus both screenshots on the real Desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
Inspect exactly what a launch would run, without opening a tab (prints the wt line and the decoded script):
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
- **`wt` splits on `;` even inside one quoted argument.** Each `; ...` segment becomes ANOTHER tab
  whose "executable" is the segment text, so the symptom is junk tabs with `0x80070002` plus a first
  tab that only ran the fragment before the first `;`. No generated `wt` argument may ever contain a
  raw semicolon. `-EncodedCommand` (base64 UTF-16LE) removes semicolons, spaces, quotes and non-ASCII
  bytes from the payload in one move, which also protects the `Røbel` in the git identity vars from
  the console codepage.
- **A launch started from inside a Claude session is not a faithful test.** The child process inherits
  `CLAUDE_CODE_CHILD_SESSION`, so that session has transcript saving off and never appears in
  `~/.claude/sessions/<pid>.json`, which means it never reaches the board either. The terminal
  mechanics are still proven; board arrival is not. Test New session from the app UI.
- **Never `Stop-Process -Force` a `claude.exe`.** It never gets to disable xterm mouse reporting, so
  the surviving PowerShell prompt then receives every mouse move as input and the tab fills with
  `[555;61;16M`-style garbage. Close the tab or exit Claude properly.
- **Claude Code REPLACES our `--title` with the session's own name** once a resumed session loads, so
  `bringToForeground()`'s title match can miss on a reattach. It is best effort and `wt focus-tab`
  has already switched tabs by then.
- **A backtick inside a JS template literal ends the literal.** A comment written with backticks
  inside the CDP `cdp.eval(\`...\`)` string in `render-check.mjs` produced
  `SyntaxError: missing ) after argument list` at the top of the block, nowhere near the comment.
- **An assertion can read state that the action under test already changed.** The Take Control check
  first failed because a successful reattach clears `unmanaged` from the card, and the class was read
  after the confirm. Capture the value at the moment it is meant to hold.
- **A shell expands `$var` in a hook command before the inner shell sees it.** That is what broke the
  global HANDOVER hook (`$t=` became `=`). Hook commands should contain no `$` that is not meant for
  the outer shell.
- Still true from before: `server.lock` can be hijacked by a test server (always use `CMC_DRY_RUN=1`
  plus a temp HOME); PowerShell 5.1 `-Encoding utf8` writes a BOM that `JSON.parse` rejects; an
  installed app can serve a NEW UI with an OLD backend; never run `gh auth switch`; the Desktop is
  OneDrive-redirected; `chrome --dump-dom` never returns on this page; use `minmax(0, 1fr)` on cards.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI? It skips with exit 0 without a browser, so wiring it
  up needs a browser step on the runner. It is now the only automated cover for the Take Control
  dialog.
- Anything else to add to the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` currently DOES trigger a release.
- Should the tab title stop being the thing `bringToForeground()` matches on, given Claude rewrites
  it? The alternative is accepting that the nudge is best effort for resumed tabs.
- PatrickRobelWeb's `HANDOVER.md` is still stale (claims PR #160 awaits merge, no open PRs there).
  Refresh it in its own session?

## Environment state
- **Nothing left running.** `node stop.mjs` removed 9 hook groups and restored the original
  statusLine; the installed app (including its detached backend) was stopped at your request. Port
  4317 free and `server.lock` gone, both verified.
- **Hooks are currently NOT registered.** Launching the installed app, or `node start.mjs`, re-adds
  them. Until then the board receives no live events.
- `main` is clean, single worktree. The `MissionControlCenter-16` worktree was removed and
  `fix/wt-semicolon-launch` deleted locally and on the remote. No gone-upstream branches, no open PRs.
- Keep-awake NOT active; power defaults intact (lid close = sleep on AC and DC).
- No Docker (daemon not running), no cron or scheduled jobs created this session, no stray Chromium.
- Screenshots and test artifacts went to the session scratchpad only; nothing landed in the repo.
- Older icon previews may still sit on `C:\Users\pr\OneDrive\Desktop` from the previous session.
