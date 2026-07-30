# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-30
- Branch: `main` (a docs-only follow-up commit lands straight on `main`; the feature work went through a PR)
- PR: #13 merged (squash, `d8ddb43`), branch `feat/board-visuals-usage-resume` deleted. No open PRs.
- CI: green on #13. "Fleet desktop MSI" build for `fleet-v0.1.5` also green.
- Release: `fleet-v0.1.5` published with `Mission.Control.Center.0.1.5.msi` attached (116 MB).

## TLDR of session outcome
Done (merged in #13, shipped in `fleet-v0.1.5`):
- **Session cards rebuilt as variant 05 "Editorial"**, chosen from five rendered candidates. One
  concern per line: mono status line with a glowing pip, 18px title, a `project / branch` line that
  never repeats the heading, the prompt as a clamped pull quote, and a hairline footer with the
  actions in a real row. The old absolutely-positioned `.sc-details` / `.sc-reopen` overlay (the
  original overlap bug) is gone. `needs-permission` is coral `--perm` instead of sharing amber with
  `working`.
- **Context window + 5h/7d quota, from the only local source that has them.** New
  `statusline-feed.mjs` wraps the configured `statusLine` command: it forwards the original's stdout
  and exit code untouched and fire-and-forget POSTs the payload to a new `POST /statusline`.
  `install-hooks.mjs` records the real `statusLine` verbatim to
  `~/.claude/agent-fleet-monitor/statusline-original.json` and `uninstall-hooks.mjs` restores it.
  Same feed supplies the readable model name (`Opus 5 (1M)`).
- **Status stops lying about needing input.** Main-session tool events (no `agent_id`) used to be
  dropped, and Claude Code never notifies when you ANSWER a permission prompt. Now tool activity
  clears a blocked status immediately, plus `reconcileSessionRegistry()` polls
  `~/.claude/sessions/<pid>.json` (Claude Code's own registry) every 2500ms as authoritative truth.
- **Resume closed sessions**, no confirm, and ended-session retention raised 24h -> 7d.
- **New session popup** replaces the permanent `Repos:` bar; green button next to Sessions.
- **The "N need input" pill is a real filter** that self-heals back to Active.
- **Per-session GitHub account.** `GH_ACCOUNTS` in `terminal.mjs` + a picker in the popup that
  follows the selected folder and can be overridden; the launch exports `GH_CONFIG_DIR` and the four
  git identity vars into that tab only.
- **`scripts/render-check.mjs`**: real-Chromium CDP verification, zero dependencies.

Machine config applied outside the repo (not version controlled):
- Two gh config dirs, each independently logged in: `~/.config/gh-personal` (`patr7257`),
  `~/.config/gh-work` (`przrm`).
- `~/.gitconfig` credential helper pinned to personal, with `includeIf gitdir/i:.../repos/2-ZRM/` ->
  `~/.gitconfig-zrm` pinning work. Global `user.email` now `patr7257@gmail.com`; 2-ZRM keeps
  `pr@zrm.dk`. Backup: `~/.gitconfig.pre-multiaccount.bak`.
- `.claude/settings.local.json` gained `env.GH_CONFIG_DIR` so bare `gh` commands in THIS repo resolve
  to `patr7257`.

Not started (carried over):
- patrickrobelweb web embed of the `?demo=1` showcase.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).
- The four header stat tiles are still subagent-scoped and read 0 on the board.

## Prioritized next steps
1. Install `fleet-v0.1.5` from a REAL client (Fleet menu > Download & install, or the MSI link) and
   confirm the in-app update path works. Only the release asset was verified this session.
2. Run `node start.mjs` once so the statusline wrap installs, then confirm the top-bar 5h/7d rings and
   the per-card context rings populate, and that your terminal statusline still renders identically.
3. Verify the reported bug is actually gone end to end: trigger a permission prompt, approve it, and
   watch the card leave `NEEDS PERMISSION` within about a second instead of at end of turn.
4. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`, so packaged MSI installs also feed the quota
   meters. Until then they stay blank in an installed app.
5. Validate the focus/reattach half of the terminal integration by hand: click a card
   (`wt focus-tab`), use Resume on a closed card (`claude --resume`), and judge whether the
   `SetForegroundWindow` nudge raises the window or just flashes the taskbar icon.
6. Decide whether to automate releases (a `workflow_dispatch` job that bumps, tags and publishes in
   one click). Today a release is a manual `gh release create`; merging to `main` only runs CI.
7. patrickrobelweb web embed, then the remaining carried-over polish items.

## Verbatim resume commands (PowerShell first)
Start the app (installs hooks AND the statusline wrap, starts the server, opens http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES your original statusLine, frees port 4317):
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
Same, but also save a screenshot of the board to your desktop:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\Desktop\mcc-board.png"
```
Confirm which GitHub account a directory resolves to (run it from inside any repo):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git config --get user.email; git config --get-all credential.https://github.com.helper | Select-Object -Last 1
```
Print the exact `wt` command a launch would run, without opening a tab:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; $env:CMC_DRY_RUN='1'; node --input-type=module -e "import { launchSession } from './terminal.mjs'; console.log(launchSession('C:/Users/pr/repos/2-ZRM/customers','customers','demo name').command)"; Remove-Item Env:CMC_DRY_RUN
```

## Gotchas discovered this session
- **NEVER run `gh auth switch` on this machine.** It writes the active account to ONE machine-wide
  file, and with several sessions open across both accounts it hijacks the others; a push authenticated
  as the wrong account mid-session because of exactly this. Accounts are pinned by directory and by
  session now. If a bare `gh` command reports the wrong account, prefix it
  (`GH_CONFIG_DIR='C:/Users/pr/.config/gh-personal' gh ...`) instead of switching.
- **`credential.helper` is MULTI-valued and accumulates.** An empty `helper =` line is what resets the
  inherited list. The `includeIf` for 2-ZRM must therefore stay LAST in `~/.gitconfig`, or the personal
  helper answers first and the override silently never applies.
- **CSS: never leave a card on a bare implicit `auto` grid column.** An `auto` track takes its growth
  limit from max-content and free-space distribution only ever GROWS tracks, so a long session name
  sized the card's column to 538px inside a 432px card, pushing the context ring and the buttons
  outside where `overflow:hidden` silently ate them, at EVERY window width. `min-width:0` and
  `text-overflow:ellipsis` only work once the track is clamped: `grid-template-columns: minmax(0, 1fr)`.
  Code review confidently concluded the opposite; one real measurement found it.
- **`chrome --dump-dom` never returns on this app.** The board holds an open SSE connection so page
  load never completes, and the empty output reads as "the page is broken". Drive CDP and poll for the
  element you expect (`scripts/render-check.mjs` does this).
- **The New session popup's visibility lives on `#newSessionBackdrop`, not on the panel.** Asserting
  `display` on `#newSessionPopup` passes whether it is open or closed.
- **The 5h/7d windows exist in exactly one local place:** the JSON piped to the `statusLine` command.
  Not in any hook payload, not in transcripts, and there is no `claude usage` subcommand. Do not go
  looking again.
- **`statusline-feed.mjs` must not `process.exit(0)` eagerly** the way `send-event.mjs` does (that
  would kill the child before it prints) and must NOT have a safety-net timeout (that would truncate
  the statusline).
- **Merging to `main` does not release anything.** `fleet-desktop-msi.yml` triggers on a PUBLISHED
  release, not on a tag push, and the workflow derives the MSI version from the tag via
  `npm version`, so `desktop/package.json` intentionally lags the newest tag.
- `desktop/update-check.mjs` said the repo was private; it is PUBLIC as of today. The gh listing works
  under either account, so the account split does not break update checks.

## Open decisions waiting on Patrick
- Did `fleet-v0.1.5` install cleanly from your installed client (yes/no)?
- Automate releases behind a one-click `workflow_dispatch`, or keep publishing them by hand?
- Should the four header stat tiles become board-level (sessions / blocked / working) instead of
  subagent-scoped, since they read 0 on the board today?
- `3-Studie/todolist-system-studie` is a DTU GitLab group project that now authors as
  `patr7257@gmail.com` under the new global default. Add a local `user.email` override there, or leave it?
- patrickrobelweb portfolio demo: keep the password gate, or make the showcase public?

## Environment state
- Nothing left running. No node process listening on any port (all test servers exited), Docker not
  running, no cron or scheduled jobs, keep-awake NOT active.
- No worktrees beyond the main checkout. No local branches with a gone upstream. `main` synced with
  origin; #13's branch deleted local and remote.
- The statusline wrap is NOT currently installed: `stop.mjs` was never run against a live install this
  session, and `start.mjs` was never run. Your `~/.claude/settings.json` `statusLine` is still your own
  `python statusline-command.py`. It installs on the next `node start.mjs`.
- Shared `gh` active account was deliberately left as `przrm` (your work default). It no longer matters
  for git operations in this repo, which resolve by directory.
- Render/screenshot artifacts were written to the session scratchpad and OS temp only; nothing landed
  in the repo.
