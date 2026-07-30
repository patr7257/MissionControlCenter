# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-30
- Branch: `main` (this handover is a docs-only commit straight to `main`)
- PRs this session: #13 (`d8ddb43`), #14 (`56758d2`), #15 (`c8b9d3a`), all squashed and merged,
  all branches deleted. No open PRs.
- CI green on all three.
- **Releases are automatic on merge to `main` and PROVEN in both directions**: code merges published
  `fleet-v0.1.6`, `0.1.7` and `0.1.8` with no manual step, and a docs-only merge correctly reported
  `msi: skipped` without minting a version.
- **Install `fleet-v0.1.8`** (latest):
  `https://github.com/patr7257/MissionControlCenter/releases/tag/fleet-v0.1.8`
  0.1.8 is functionally identical to 0.1.7. It exists because a commit labelled `docs:` also added
  `desktop/build/icon-source.png`, and a PNG is not in the skip list, so the workflow correctly did
  NOT skip. The lesson is about commit hygiene, not the workflow: if a release is unwanted, the
  commit must touch ONLY `*.md`, `docs/`, `.claude/` or `.github/`.

## READ THIS FIRST: the updater fix is not yet proven in the wild
Upgrading an installed 0.1.6 runs the **0.1.6 installer logic**, which is the buggy one, so expect
the "Files in Use" dialog ONE more time on the next upgrade regardless of which version you go to.
The fix only takes effect for upgrades STARTED from a build that contains it (0.1.7 and later). So:
install 0.1.8 now and expect one last prompt, then the following upgrade from 0.1.8 is the genuine
test. If that one is clean and the app comes back with a populated GitHub account dropdown, the fix
is confirmed.

Also: `node stop.mjs` was run at session close, which removed the hook groups. **Relaunch the
installed app once** so it re-registers its hooks, otherwise the board receives no live events.

## TLDR of session outcome
Shipped in `fleet-v0.1.5` (PR #13):
- Session cards rebuilt as variant 05 "Editorial", chosen from five rendered candidates. Actions in
  a real footer row instead of an absolute overlay (the original overlap bug), a context ring, and
  `needs-permission` in coral instead of sharing amber with `working`.
- Context window and 5h/7d quota meters, fed by `statusline-feed.mjs` wrapping the configured
  `statusLine` command. That JSON is the ONLY local source for the rate-limit windows.
- Status freshness: main-session tool activity clears a blocked status immediately, plus a 2500ms
  poll of Claude Code's own `~/.claude/sessions/<pid>.json`.
- Resume on closed cards, ended retention 24h to 7d, the New session popup replacing the permanent
  Repos bar, the need-input pill as a filter, and a per-session GitHub account picker.
- `scripts/render-check.mjs`: real-Chromium CDP verification, zero dependencies.

Shipped in `fleet-v0.1.6` (PR #14):
- Auto-release on merge, ported from `patr7257/todolist`'s `build-installers.yml`.
- Contextual stat tiles (board-level on the board, subagent-level in Details).
- Test servers can no longer hijack `server.lock`.

Shipped in `fleet-v0.1.7` (PR #15):
- **Status semantics corrected.** `awaiting` comes from the `Stop` hook and means Claude FINISHED,
  not that it is blocked. `Store.needsInput` is now only `needs-permission`; new
  `Store.doneAwaiting` is only `awaiting`, labelled `Done - awaiting user`.
- **Segmented Active filter.** `Show` is All / Active / Closed, and a sliding three-way control
  refines Active into All active / Needs input / Done - awaiting user, each with a live count.
- **Two top-bar labels**, each setting the state dropdown AND the segment in one click.
- **Dashboard popup** behind a chart icon, replacing the four always-visible numbers.
- **Updater order fixed** (see the warning above) plus a `No accounts available` fallback instead of
  a blank select.
- **New app icon**: "MCC" only in sizes 48 and up; 16/24/32 keep the clean orbital mark.

Other repos touched:
- `patr7257/PatrickRobelWeb` PR #164 merged: `streaming-hub` got its own icon (display showing play,
  violet) instead of the site PR monogram. Issue #163 closed with the real diagnosis. **`todo` was
  deliberately NOT touched**: its icons were already correct and the phone was showing an
  iOS-cached icon. Its `HANDOVER.md` belongs to a different workstream and was left alone, though
  it is stale (it claims PR #160 is awaiting merge; there are no open PRs there).

New user-level tooling (outside any repo):
- `C:\Users\pr\.claude\skills\app-icons\` designs and generates icons for any project via the
  locally installed Chromium. No ImageMagick, no npm, offline. Covers favicon/PWA/maskable/
  apple-touch/Windows `.ico` plus a 16px contact sheet, and `references/wiring.md` has the
  per-platform snippets.

Not started (carried over):
- patrickrobelweb web embed of the `?demo=1` showcase, public per the earlier decision.
- Humaaans CC-BY credit line + SKILL.md note.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. Relaunch the installed app so hooks re-register, then install `fleet-v0.1.8` (expect one last
   "Files in Use" prompt, see the warning above).
2. Confirm the updater fix on the upgrade AFTER 0.1.8: clean upgrade, no Files-in-Use, and
   a populated GitHub account dropdown afterwards. This is the only unverified part of the pipeline.
3. Watch the new labels with real states: let a session finish (`Done - awaiting user`) and trigger a
   permission prompt (`Needs input`), and confirm the pill counts and segments agree.
4. Add `desktop/assets/statusline-feed.mjs.cmd` (mirroring `send-event.mjs.cmd`) and set
   `CMC_STATUSLINE_COMMAND` in `desktop/main.mjs`. Note the installed app currently wraps the
   statusline with `node "<install dir>\resources\backend\statusline-feed.mjs"`, which works only
   because system Node is present on this machine.
5. Validate focus/reattach by hand: click a card (`wt focus-tab`), Resume a closed card
   (`claude --resume`), and judge whether the `SetForegroundWindow` nudge raises the window or just
   flashes the taskbar icon.
6. Optional: per-app `favicon.ico` for `/todo` and `/streaming-hub` so browser tabs stop showing the
   site favicon. Installed PWA icons are already correct.

## Verbatim resume commands (PowerShell first)
Start the app (installs hooks AND the statusline wrap, serves http://localhost:4317):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node start.mjs
```
Stop it again (removes hooks, RESTORES the original statusLine, frees the port):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node stop.mjs
```
Smoke test (same checks as CI):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs
```
Real-browser render check (skips cleanly if no Chromium):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs
```
Same, plus a screenshot on the Desktop (note the OneDrive path, see gotchas):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\render-check.mjs --shot "$env:USERPROFILE\OneDrive\Desktop\mcc-board.png"
```
Check the lock file agrees with what is listening (the hook-delivery failure mode):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; Get-Content "$env:USERPROFILE\.claude\agent-fleet-monitor\server.lock"; Get-NetTCPConnection -State Listen -LocalPort 4317 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
```
Regenerate the app icon (label only in sizes 48 and up):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node "C:\Users\pr\.claude\skills\app-icons\scripts\make-icons.mjs" --src desktop\build\icon-source.png --out $env:TEMP\mcc-icons --all --label MCC --label-band --bg "#141a26"
```
Force a specific release version instead of the auto patch bump:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; git tag fleet-v0.2.0; git push origin fleet-v0.2.0
```

## Gotchas discovered this session
- **A test server can hijack the machine's hook delivery.** `server.lock` names the one real server.
  `server.mjs` used to write it unconditionally and only cleans up on a GRACEFUL exit, so a killed
  test server left the lock pointing at a dead port and every hook silently no-opped while the app
  looked healthy. Fixed (skipped under `CMC_DRY_RUN`). Symptom: the board stops updating but the UI
  is fine.
- **PowerShell 5.1's `-Encoding utf8` writes a BOM and `JSON.parse` rejects it.** Never repair
  `server.lock` (or any JSON node reads) from PowerShell; use node.
- **An installed app can serve a NEW UI with an OLD backend.** `server.mjs` reads `public/**` from
  disk per request, so a surviving pre-upgrade backend answers API calls with old code. Symptom seen
  for real: a blank GitHub account dropdown because that backend's `GET /repos` had no `accounts`
  field. If a report says "the UI looks new but a feature behaves old", suspect this.
- **iOS never refreshes a home-screen icon after install.** Remove and re-add the app. This masked
  the real streaming-hub bug, where the icon FILE was the wrong artwork.
- **An `.ico` stores a different image per size.** Exploit it: text at 48 and up, clean mark below.
  Three letters at 16px is a smudge that also eats a third of the artwork.
- **There is no ImageMagick on this machine.** `C:\Windows\System32\convert.exe` is the filesystem
  converter. Most icon tutorials and skills online assume ImageMagick and will fail here.
- **The Desktop is OneDrive-redirected.** The visible desktop is
  `C:\Users\pr\OneDrive\Desktop`; the legacy `C:\Users\pr\Desktop` still exists but Explorer does
  NOT show it. Writing a file "to the Desktop" via `$env:USERPROFILE\Desktop` puts it somewhere
  invisible, which happened this session. Always use the OneDrive path when handing Patrick a file.
- **NEVER run `gh auth switch`.** Accounts are pinned by directory (`includeIf` for `2-ZRM`) and per
  session (`GH_CONFIG_DIR`). Switching hijacks other running sessions.
- **`credential.helper` is MULTI-valued and accumulates.** An empty `helper =` line resets the list,
  so the `includeIf` must stay LAST in `~/.gitconfig`.
- **CSS: never leave a card on a bare implicit `auto` grid column.** An `auto` track takes its growth
  limit from max-content and free space only GROWS tracks, so a long name sized the column past the
  card and `overflow:hidden` ate the ring and buttons at every width. Use `minmax(0, 1fr)`.
- **`chrome --dump-dom` never returns on this app** (the open SSE connection means load never
  completes). Drive CDP and poll for the element you expect.
- **The release workflow must never trigger on `release: published` again**; it publishes releases
  itself and would build twice.

## Open decisions waiting on Patrick
- Should `scripts/render-check.mjs` run in CI? It skips with exit 0 without a browser, so wiring it
  up needs a browser step on the runner.
- Anything else to add to the auto-release skip list beyond `*.md`, `docs/`, `.claude/`, `.github/`?
  `scripts/` currently DOES trigger a release.
- Want a fresh `todo` app icon anyway, even though the existing one is fine?
- PatrickRobelWeb's `HANDOVER.md` is stale (claims PR #160 awaits merge, no open PRs). Refresh it in
  its own session?

## Environment state
- Nothing left running. The review server was stopped with `node stop.mjs`, which removed 9 hook
  groups and **restored the original statusLine** to `python "C:\Users\pr\.claude\statusline-command.py"`
  (verified). Port 4317 free, `server.lock` cleared.
- The installed Mission Control Center app was force-closed during the session to free port 4317 for
  the localhost review, and was not restarted. Hooks are currently NOT registered; relaunching the
  app re-adds them.
- Keep-awake NOT active; power defaults restored (lid close = sleep, AC and DC).
- No Docker, no cron or scheduled jobs, no stray Playwright Chromium.
- Both `MissionControlCenter` and `PatrickRobelWeb` are on `main`, clean, single worktree, no
  gone-upstream branches, no open PRs.
- Icon previews left on the REAL Desktop on purpose:
  `C:\Users\pr\OneDrive\Desktop\MCC-icon-preview.png`, `StreamingHub-icon-preview.png`,
  `MCC-icon.ico`. Delete when done with them.
- Test artifacts went to the session scratchpad and OS temp only; nothing landed in either repo.
