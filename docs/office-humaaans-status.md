# Office (Humaaans) view: status and next steps

Updated: 2026-07-19 (cinematic pass shipped, PR #6).

## State
The dashboard shows a Sessions board; drilling into a session opens a combined per-session
detail view that renders the professional lanes AND the Humaaans "Office" scene together
(there is no top-level Pro/Office toggle any more, that was removed). The office uses CC0-derived
Humaaans characters in a flat 2.5D room.

- Characters: `public/humaaans.js` holds 12 recolorable inline-SVG poses (6 sitting, 6 standing).
  Per agent, colors + pose are picked deterministically from the agent id in `public/view-office.js`.
- Renderer: `public/view-office.js` places one character per agent at a workstation desk, walks
  them in from the door, shows per-tool activity, and moves them to the lounge when done.
- Styling: the office block in `public/style.css`, plus the cinematic block appended after it.
- All offline / zero-dependency.

## Cinematic pass (shipped 2026-07-19, issue #5 / PR #6)
The office was taken from a first visual pass to a cinematic showcase bar. All vanilla CSS/SVG,
zero-dep, and fully gated behind `prefers-reduced-motion` (which stills the whole scene):

- Ambient life: breathing + gentle idle sway, potted plants, a wall clock with sweeping hands,
  and a slow (64s) day/night light wash on the room.
- Per-tool on-monitor desk FX: code-rain (Bash/Edit/Write), magnifier sweep (Grep/Glob),
  page-flip (Read), network pulse (WebFetch/WebSearch), and a red desk-lamp flash on agent error.
- Orchestrator: a head-of-room figure (with a small crown) representing the selected session,
  and glowing SVG threads from it to each active subagent desk, recomputed on placement/walk-in.
- Confetti: a one-shot burst when every visible agent in the session is done.
- Layout tuning: taller room (`ROOM_H` 640), desks no longer clip legs (`DESK_DY` 104 to 80),
  the orchestrator seat reserved at the head of the room.

Verify visually via demo mode: `node server.mjs`, then open `http://localhost:4317/?demo=1`.

## Remaining / next steps
1. **Humaaans CC-BY credit line.** Add a visible "Characters: Humaaans by Pablo Stanley" credit
   somewhere in the office UI (the library is CC-BY). Not yet done.
2. **Demo confetti beat.** The bundled demo loop ends with one agent in `error`, so it never hits
   the all-done confetti path. Add an error-then-recover-to-done beat in `public/demo.js` so the
   showcase actually demonstrates the confetti.
3. **Dashboard glow-up (pro lanes).** Not started: glassmorphism/gradient cards, per-agent token
   sparklines, animated attention rings, a top fleet-activity timeline strip, refined dark mode.
4. **patrickrobelweb web embed.** Not started: sync `public/**` into the Next.js site and iframe
   the `?demo=1` showcase on the portfolio page (mirror the arcade `sync-minigames.mjs` pattern).
5. **Human eyeball of the cinematic office.** Merged CI-green but not yet visually confirmed;
   check composition at 1 / 5 / many agents, whether the small monitor FX read at scale, and the
   worker name labels (currently occluded behind the desk fronts).

## How to relaunch
`node "C:/Users/pr/.claude/skills/agent-fleet-monitor/start.mjs"` then open http://localhost:4317.
For the offline showcase, use `?demo=1`. Stop with `stop.mjs`.
Prior design + plan: `docs/specs/2026-06-30-office-sims-view-design.md`,
`docs/plans/2026-06-30-office-sims-view.md`.
