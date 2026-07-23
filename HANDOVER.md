# HANDOVER

## Date, branch, PR, CI
- Date: 2026-07-19
- Branch: `chore/session-close-repos-picker` (docs + this handover; being PR'd and merged into `main` at session close)
- Open PRs: none (this session's #3, #4, #6, #8 are all merged)
- CI: green on every merged PR; the docs PR runs the same `node --check` + smoke workflow

## TLDR of session outcome
Done (merged to `main`):
- **Demo mode** (#1, PR #3): `public/demo.js` drives the whole UI through a looping fake fleet with no server, via `?demo=1`. `store.js` exposes `Store.ingest`. Real SSE path untouched without the flag.
- **Backlog fixes** (#2, PR #4): `managedTabs` bounded-on-safe-reset cap; subagent-only sessions derive status from live children (`sawTopLevel`); blank model line hidden. Smoke 9/9.
- **Cinematic office** (#5, PR #6): ambient life (breathing, plants, wall clock, day/night wash), per-tool desk FX, orchestrator + glowing threads, session-complete confetti, layout tuning. Vanilla CSS/SVG, reduced-motion gated. Eyeballed by Patrick at `?demo=1`, confirmed good.
- **Deep repos picker** (PR #8): `~/repos` refactored into category folders whose descendants are the real projects; `terminal.listRepos()` now returns `{ root, tree }` (bounded folder tree, noise dirs excluded, capped 5 levels / 4000 nodes), and the New session bar cascades one dropdown per level (each defaults to "Not selected", launches in the deepest folder selected, or the root). Eyeballed, confirmed good.

Not started (from the original plan / asks):
- Dashboard glow-up (glass cards, token sparklines, attention rings, timeline strip).
- Humaaans CC-BY credit line + SKILL.md note.
- **patrickrobelweb web embed** (part of the original "works in the webapp" ask): sync `public/**` into the Next.js site and iframe the `?demo=1` showcase.
- Demo confetti beat (the demo loop ends on an error, so all-done confetti never fires).

## Prioritized next steps
1. PatrickRobelWeb web embed (board #2): new `website/scripts/sync-mission-control.mjs` mirroring `sync-minigames.mjs`, copying `public/**` into `website/public/mission-control-demo/`, then iframe `/mission-control-demo/index.html?demo=1` on the `portfolio/mission-control-center` page. Decide public vs the existing password gate.
2. Dashboard glow-up (pro lanes): glassmorphism/gradient cards, per-agent token sparklines, animated attention rings, a top fleet-activity timeline strip, refined dark mode.
3. Add a demo confetti beat: one agent errors then recovers to `done`, so the all-done confetti fires in the showcase (`public/demo.js`).
4. Add the visible "Characters: Humaaans by Pablo Stanley" CC-BY credit in the office UI; mention demo mode + assets in the skill's SKILL.md.
5. Live terminal validation on the real machine (pre-existing pending: `wt` launch/focus/`--resume` + the `SetForegroundWindow` nudge, only tested in `CMC_DRY_RUN`). The new deep picker also makes launching into a nested project path worth a real-terminal check.

## Verbatim resume commands (PowerShell first)
Run the app / demo (open http://localhost:4317, or http://localhost:4317/?demo=1 for the offline showcase; Ctrl+C to stop):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node server.mjs
```
Run the smoke test:
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node scripts\smoke-server.mjs
```
Inspect the repos folder tree that feeds the New session picker (no server needed):
```
cd "C:\Users\pr\repos\1-Personal\MissionControlCenter"; node --input-type=module -e "import { listRepos } from './terminal.mjs'; console.log(JSON.stringify(listRepos(), null, 2))"
```

## Gotchas discovered this session
- **server.mjs port is 4317**, override only with `--port <n>` (`CMC_PORT` is ignored). A stray `node server.mjs` from a serve-check keeps 4317 held; later curl checks then silently hit that stale process (new one gets EADDRINUSE). Find it: `netstat -ano | grep :4317`, confirm the command line is `node server.mjs`, kill by PID. Never kill the small Claude Code node processes.
- To verify `listRepos()`/the picker, call it directly (see the resume command) instead of starting a server, so you never clash with a running instance or its lock file.
- **Stacked branch on a squash-merge:** rebase only the new commits with `git rebase --onto origin/main <old-base-sha> <branch>`; a plain rebase/merge re-conflicts on the already-squashed changes.
- `/repos` now returns `{ root, tree }` (was a flat array). The smoke assertion was updated to match; any future consumer must read `.tree`.
- `listRepos()` excludes dot-folders and a noise denylist (`node_modules`, `dist`, `.git`, ...) so the cascade stays project-shaped; add to `REPO_TREE_SKIP` in `terminal.mjs` if a noise folder slips through.
- Co-dev gate: first edit in a session needs a `<session_id> use` line appended (never overwrite) to `.claude/.codev-ack` (gitignored, one line per session).

## Open decisions waiting on Patrick
- patrickrobelweb portfolio demo: keep the existing password gating, or make the showcase public?
- Continue with the dashboard glow-up and the web embed in a future session (both unstarted)?

## Environment state
- All dev servers stopped (the 4317 verify server was killed); no listeners on 431x. Docker not running.
- No worktrees (this session's picker work was done on branches in the main checkout). All feature branches merged and deleted local + remote. `main` synced.
- Only `chore/session-close-repos-picker` remains, carrying this handover + the CLAUDE.md update, pending merge.
