# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-30
- Branch: `main` (this handover update is a docs-only commit straight to `main`)
- PRs: #13 merged (`d8ddb43`) and #14 merged (`56758d2`), both squashed, both branches deleted. No
  open PRs.
- CI: green on both.
- **Releases are automatic on merge to `main` as of #14, and it is PROVEN.** Merging #14 published
  `fleet-v0.1.6` with `Mission.Control.Center.0.1.6.msi` (116 MB) attached, with no manual step, and
  the tag points at the merge commit. `fleet-v0.1.5` was the last hand-published release.
- **Install `fleet-v0.1.6`**: `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.6`

## TLDR of session outcome
Shipped in `fleet-v0.1.5` (PR #13):
- **Session cards rebuilt as variant 05 "Editorial"**, chosen from five rendered candidates. One
  concern per line, actions in a real footer row instead of an absolute overlay (the original overlap
  bug), a context-window ring, and `needs-permission` in coral instead of sharing amber with
  `working`.
- **Context window + 5h/7d quota meters**, fed by `statusline-feed.mjs` wrapping the configured
  `statusLine` command. That JSON is the ONLY local source for the rate-limit windows.
- **Status stops lying about needing input**: main-session tool activity clears a blocked status
  immediately, plus a 2500ms poll of Claude Code's own `~/.claude/sessions/<pid>.json`.
- **Resume on closed cards**, ended retention 24h -> 7d, **New session popup** replacing the
  permanent Repos bar, the **need input pill as a real filter**, and a **per-session GitHub account**
  picker.
- `scripts/render-check.mjs`: real-Chromium CDP verification, zero dependencies.

Shipped in `fleet-v0.1.6` (PR #14):
- **Auto-release on merge to `main`**, ported from `patr7257/todolist`'s `build-installers.yml`. A
  `version` job bumps the patch of the latest release; the `msi` job stamps, builds and publishes.
  Docs-only merges (`*.md` at any depth, `docs/`, `.claude/`, `.github/`) skip. Runs are queued so
  two quick merges cannot resolve to the same version. Pushing a `fleet-v*` tag still forces an exact
  version.
- **Contextual stat tiles.** The board shows `sessions` / `needs input` / `working` /
  `oldest activity`; Details keeps `working` / `done` / `steps` / `elapsed`. They used to be
  subagent-scoped in both views and sat at 0/0/0/0:00 on the board.
- **Test servers can no longer hijack `server.lock`** (skipped under `CMC_DRY_RUN`). This bit for
  real today, see gotchas.

Machine config applied outside the repo (not version controlled):
- Two gh config dirs, each independently logged in: `~/.config/gh-personal` (`patr7257`),
  `~/.config/gh-work` (`przrm`).
- `~/.gitconfig` credential helper pinned to personal, with `includeIf gitdir/i:.../repos/2-ZRM/` ->
  `~/.gitconfig-zrm` pinning work. Global `user.email` is now `patr7257@gmail.com`; 2-ZRM keeps
  `pr@zrm.dk`. Backup: `~/.gitconfig.pre-multiaccount.bak`.
- `.claude/settings.local.json` has `env.GH_CONFIG_DIR` so bare `gh` commands in THIS repo resolve to
  `patr7257`.
- `~/.claude/agent-fleet-monitor/server.lock` was repaired by hand (see gotchas).

Decisions taken this session:
- Stat tiles: contextual per view. Done.
- `3-Studie/todolist-system-studie`: deliberately stays on `patr7257@gmail.com`. No override added.
- patrickrobelweb demo embed: will be **public**, no password gate.
- Releases: automated on merge (was manual).

Not started (carried over):
- patrickrobelweb web embed of the `?demo=1` showcase, public per the decision above.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. Install `fleet-v0.1.6` from a REAL client (Fleet menu > Download & install) and confirm the in-app
   update path. This has been open since 0.1.5 and is still the only unverified part of the pipeline.
2. Run `node start.mjs` once so the statusline wrap installs, then confirm the top-bar 5h/7d rings and
   the per-card context rings populate, and that your terminal statusline still renders identically.
3. Verify the original bug is gone end to end: trigger a permission prompt, approve it, and watch the
   card leave `NEEDS PERMISSION` within about a second instead of at end of turn.
4. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`, so packaged MSI installs also feed the quota
   meters. Until then they stay blank in an installed app while working fine from `node start.mjs`.
5. Validate the focus/reattach half of the terminal integration by hand: click a card
   (`wt focus-tab`), use Resume on a closed card (`claude --resume`), and judge whether the
   `SetForegroundWindow` nudge raises the window or just flashes the taskbar icon.
6. patrickrobelweb public embed, then the remaining carried-over polish items.

## Verbatim resume commands (PowerShell first)
Start the app (installs hooks AND the statusline wrap, starts the server, opens http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES your original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
Run the smoke test (same checks as CI):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs
```
Run the real-browser render check (skips cleanly if no Chromium is installed):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs
```
Same, plus a screenshot on your desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\Desktop\mcc-board.png"
```
Check the lock file agrees with what is actually listening (the failure mode below):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; Get-Content "$env:USERPROFILE\.claude\agent-fleet-monitor\server.lock"; Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
```
Confirm which GitHub account a directory resolves to (run from inside any repo):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git config --get user.email; git config --get-all credential.https://github.com.helper | Select-Object -Last 1
```
Force a specific release version instead of the auto patch bump:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git tag fleet-v0.2.0; git push origin fleet-v0.2.0
```

## Gotchas discovered this session
- **A test server can hijack the whole machine's hook delivery.** `server.lock` is how
  `send-event.mjs` and `statusline-feed.mjs` find the one real server. `server.mjs` used to write it
  unconditionally, and cleanup only runs on a GRACEFUL exit, so a killed test server left the lock
  pointing at a dead port and every hook silently no-opped while the app looked healthy. It happened:
  a test server left port 4319 in the lock while the installed app served 4317. Fixed (skipped under
  `CMC_DRY_RUN`) and the lock was repaired by hand. Symptom to recognise: the board stops updating
  but the UI is fine.
- **PowerShell 5.1's `-Encoding utf8` writes a BOM and `JSON.parse` rejects it.** Repairing
  `server.lock` from PowerShell produced a file that parsed nowhere; write it with node instead. This
  is a general trap for any JSON that node reads.
- **NEVER run `gh auth switch` on this machine.** It writes the active account to ONE machine-wide
  file, and with several sessions open across both accounts it hijacks the others. Accounts are
  pinned by directory and by session now. If a bare `gh` command reports the wrong account, prefix it
  (`GH_CONFIG_DIR='C:/Users/pr/.config/gh-personal' gh ...`) instead of switching.
- **`credential.helper` is MULTI-valued and accumulates.** An empty `helper =` line is what resets
  the inherited list, so the `includeIf` for 2-ZRM must stay LAST in `~/.gitconfig` or the personal
  helper answers first and the override silently never applies.
- **CSS: never leave a card on a bare implicit `auto` grid column.** An `auto` track takes its growth
  limit from max-content and free space only ever GROWS tracks, so a long session name sized the
  card's column to 538px inside a 432px card, pushing the ring and buttons outside where
  `overflow:hidden` ate them, at EVERY width. Fix: `grid-template-columns: minmax(0, 1fr)`. Code
  review concluded the opposite; one real measurement found it.
- **`chrome --dump-dom` never returns on this app.** The open SSE connection means page load never
  completes, and the empty output reads as "the page is broken". Drive CDP and poll for the element
  you expect (`scripts/render-check.mjs`).
- **The New session popup's visibility lives on `#newSessionBackdrop`,** not on the panel. Asserting
  `display` on `#newSessionPopup` passes whether it is open or closed.
- **The 5h/7d windows exist in exactly one local place:** the JSON piped to the `statusLine` command.
  Not in any hook payload, not in transcripts, and there is no `claude usage` subcommand.
- **`statusline-feed.mjs` must not `process.exit(0)` eagerly** the way `send-event.mjs` does (that
  kills the child before it prints) and must NOT have a safety-net timeout (that truncates the
  statusline).
- **The release workflow must never trigger on `release: published` again.** It publishes releases
  itself now, so that trigger makes it build a second time for its own release.
- `desktop/package.json`'s version is intentionally NOT the source of truth; the build stamps it from
  the resolved version, so it lags the newest tag in git.

## Open decisions waiting on Patrick
- Did `fleet-v0.1.6` install cleanly from your installed client (yes/no)? Still unverified since
  0.1.5.
- Should `scripts/render-check.mjs` also run in CI? It currently skips with exit 0 when no browser is
  present, so wiring it up would need a browser step on the runner. Worth it, or keep it local only?
- Anything else to fold into the auto-release skip list beyond `*.md`, `docs/`, `.claude/`,
  `.github/`? For example `scripts/` currently DOES trigger a release.

## Environment state
- Nothing of mine left running. No node process listening on any port, Docker not running, no cron or
  scheduled jobs, keep-awake NOT active, no stray Playwright Chromium.
- The installed Mission Control Center app was running during the session (PID 26892 on port 4317)
  and was deliberately left alone; it has since been closed from outside this session, so port 4317
  is free and `server.lock` is correctly absent. Its own graceful shutdown removed that lock, which
  incidentally confirms the by-hand repair had the right pid, since the cleanup only fires when
  `lock.pid === process.pid`. `log.jsonl` kept growing after the repair, so hooks were reaching the
  server again.
- The statusline wrap is NOT installed: `~/.claude/settings.json` `statusLine` is still your own
  `python statusline-command.py`. It installs on the next `node start.mjs`.
- Shared `gh` active account deliberately left as `przrm` (your work default). It no longer matters
  for git in this repo, which resolves by directory.
- No worktrees beyond the main checkout, no local branches with a gone upstream. Screenshots and test
  artifacts went to the session scratchpad and OS temp only; nothing landed in the repo.
