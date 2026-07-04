# Design: Office (Sims) view + live view switching for agent-fleet-monitor

Date: 2026-06-30
Status: approved (design), pending spec review
Component: `~/.claude/skills/agent-fleet-monitor` (user-level Claude Code skill)

## Context

The agent-fleet-monitor skill already ships a live localhost dashboard that shows each
running subagent as a professional animated card (Working / Done / Errors lanes). The data
pipeline is solid: a zero-dependency Node `http` server streams hook events over Server-Sent
Events, and the browser keeps an in-memory `agents` Map keyed by `agent_id`, rendered with a
diff-based card renderer.

The user wants a second, playful "full Sims experience" view: an isometric office where each
subagent is an animated little character, and a live in-app toggle to switch between the
professional card view and the office view. This is a front-end feature; the existing data
pipeline is reused unchanged.

Goal: keep the current professional view exactly as is, add the office view, and let the user
flip between them live without losing state.

## Confirmed decisions (from brainstorming)

1. **Metaphor:** isometric office floor. Characters sit at desks; tool-in-use shows above the
   desk; they arrive when spawned and relocate when done.
2. **Motion level:** animated inline-SVG characters. Walk in from a door to an assigned desk,
   sit and play a per-tool activity, show a mood face, celebrate on completion.
3. **On done:** the character celebrates, then walks to a lounge area on the same screen and
   relaxes there. The full roster stays visible (desks = working, lounge = finished).
4. **Toggle:** a header segmented control `Pro | Office`, choice persisted in `localStorage`.
5. **Zero dependency:** CSS + inline SVG/emoji only. No game engine, no npm, fully offline.

## Non-goals (YAGNI)

- No pathfinding or collision. Movement is direct point-to-point CSS transitions.
- No ambient "rich world" props, wandering-to-break-area, footstep trails, or day/night
  (these were the "Rich world" option, explicitly not chosen).
- No new server-side data, metrics, or persistence. The office reads the same fields the
  cards already use.
- No change to hook configuration, install/uninstall, or the SSE protocol.

## Architecture

### Shared store + pluggable views

Today `index.html` mixes data handling and the card renderer in one inline script. As part of
this work, split the front-end into focused files (the file would otherwise roughly double in
size). All files are static and served locally; no bundler.

- `public/store.js` — the single source of truth. Owns the `agents` Map, `firstSeenAt`, the
  EventSource connection and reconnection, the once-per-second timer, and a tiny view registry.
  Exposes: `Store.agents` (Map), `Store.onChange(fn)` and `Store.onAgent(fn)` style callbacks,
  `Store.firstSeenAt`. Emits two signals to the active view: `reset(snapshot)` (full state) and
  `update(agent)` (one agent changed). Knows nothing about how anything is drawn.
- `public/view-cards.js` — the existing diff-based card renderer, moved verbatim, refactored to
  implement the view interface (see below). Behaviour unchanged.
- `public/view-office.js` — the new office renderer, implementing the same interface.
- `public/style.css` — shared styles for header/shell plus both views (card styles moved out of
  `index.html`, office styles added).
- `index.html` — shell only: header (title, connection LED, stats, the `Pro | Office` toggle),
  the two view containers (`#viewCards`, `#viewOffice`), and `<script>`/`<link>` tags loading
  the files above in order: `style.css`, `store.js`, `view-cards.js`, `view-office.js`, then a
  short inline bootstrap.

### View interface

Each view is a plain object the bootstrap registers with the store:

```
view = {
  id: "cards" | "office",
  el: <container element>,
  activate(snapshot),   // becomes visible: do a full reconcile from current state
  deactivate(),         // becomes hidden: stop/wind down any animation loop
  reset(snapshot),      // store replaced all state (fresh SSE snapshot)
  update(agent)         // one agent changed
}
```

The bootstrap keeps `activeView`. The store calls only the active view's `reset`/`update`; the
inactive view receives nothing, so a hidden office does zero work (its rAF loop is stopped in
`deactivate`). Switching: `deactivate()` old, hide its container, show new container,
`activate(snapshot)` new (one-time full reconcile), persist `localStorage.fleetView = id`.

### Server change (small, path-guarded)

`server.mjs` currently serves only `index.html` and returns 404 for anything else. Extend the
`GET` handler to serve any file under `public/` by extension, with a strict guard:

- Resolve the requested path against the absolute `public/` dir; if the resolved path is not
  inside `public/`, return 404 (prevents `..` traversal).
- Content types: `.html` text/html, `.css` text/css, `.js` text/javascript, `.svg`
  image/svg+xml, fallback application/octet-stream. Keep `/` -> `index.html` and the existing
  `/stream`, `/event`, `/favicon.ico` routes as they are.

No other server change. The SSE payloads (`snapshot`, `agent`) are unchanged.

## Office view mechanics

### Layout

- An isometric floor built with a CSS 3D transform on a container (e.g. `transform:
  rotateX(55deg) rotateZ(-45deg)` on the floor plane, with characters counter-rotated upright
  so faces read normally). Floor has a subtle tiled texture and a back wall with a labelled
  door on one edge.
- A **desk grid** fills most of the floor. A fixed pool of desks arranged in rows (start with
  enough for a typical fan-out, e.g. 12). If active agents exceed desks, add rows and let the
  floor scale down to fit the viewport (CSS `transform: scale`), so it never overflows.
- A **lounge** strip (couches/plants-free, just seating) along the front/bottom for finished
  agents.

### Character

- Inline SVG: head, body, two arms, two legs, a simple face. Built once per agent and reused
  (no per-frame DOM rebuild). Appearance is deterministic from `agent_id`: a hash picks a body
  colour and an accent so each agent is distinct and recognizable across the run.
- A floating label above the character: agent type + short id; the current task shown on hover
  (title attr) and as a small caption.
- A speech/activity bubble above the desk shows the current tool icon + name while busy.

### Lifecycle -> animation state machine

Driven entirely by the agent's data fields (`status`, `busy`, `currentTool`, `endedAt`):

| Agent state | Trigger | Character behaviour |
| --- | --- | --- |
| spawning | `SubagentStart`, no desk yet | appear at the door, assigned a free desk, walk to it (CSS left/top transition ~1.2s + leg/bob walk animation) |
| working-busy | `busy === true` | seated; play the activity for `currentTool` (typing/reading/searching), busy mood face, tool bubble visible |
| working-idle | working, `busy === false` | seated; lean-back / look-around idle animation, bubble shows "last: <tool>" faintly |
| done | `status === "done"` (`endedAt` set) | one-shot celebration (jump + "tada"), then walk from desk to a free lounge seat; show done badge + token total; free the desk |

Movement is position-based: set the character's target `left/top`; a CSS transition animates
the slide; a CSS keyframe animates the legs/bob during the `walking` class, removed on arrival
(via `transitionend`). The activity animations are CSS keyframes toggled by class. An optional
single `requestAnimationFrame` loop is used only for lightweight idle variation and is stopped
in `deactivate()`; if not needed, no rAF runs at all.

### Tool -> activity mapping (front-end constant)

`TOOL_ACTIVITY` maps a tool name to `{ icon, anim, label }`, for example:

- `Bash` -> terminal icon, "typing" anim
- `Read` -> book icon, "reading" anim
- `Grep` -> magnifier icon, "searching" anim
- `Edit` / `Write` / `NotebookEdit` -> pencil icon, "writing" anim
- `Glob` -> folder icon, "searching" anim
- `WebFetch` / `WebSearch` -> globe icon, "browsing" anim
- default (any other / MCP tool) -> gear icon, "thinking" anim

Unknown tools fall back to the default so new tools never break the view.

### Desk assignment

The office renderer keeps `deskOf: Map<agent_id, deskIndex>` and a free-desk pool. On first
sight of an agent, pop a free desk; on done (after the walk to lounge), return the desk to the
pool. Lounge seats are assigned the same way from a lounge pool; if the lounge fills, seats
wrap/scale like desks.

## Data flow

```
hook -> send-event.mjs -> server POST /event -> in-memory model -> SSE (snapshot|agent)
   -> store.js (agents Map) -> active view .reset()/.update() -> DOM
```

Both views consume the identical store signals; only their rendering differs. The store's
per-second timer updates live elapsed text in whichever view is active (cards: badges; office:
the seated/elapsed captions).

## Error handling / edge cases

- **Reconnect / fresh snapshot:** store calls active view `reset(snapshot)`; office rebuilds
  desk/lounge assignments from the snapshot deterministically (working -> desks by `startedAt`
  order, done -> lounge) so a refresh restores a coherent scene.
- **More agents than desks:** grid grows by rows and the floor scales to fit; never overflows.
- **Unknown tool:** falls back to the default activity.
- **Missing task text (not yet resolved):** label shows the agent type until the task resolves
  (same fallback the server already does).
- **View while hidden:** inactive view gets no updates and runs no animation loop.
- **localStorage unavailable / first run:** default to the Pro (cards) view.

## File-by-file change summary

- `server.mjs` — extend GET to serve `public/**` with content types and a traversal guard.
- `index.html` — reduce to shell + header toggle + two containers + script/link tags.
- `public/style.css` — new; shared + card styles (moved) + office styles.
- `public/store.js` — new; data, SSE, timer, view registry, toggle persistence helper.
- `public/view-cards.js` — existing renderer moved and wrapped in the view interface.
- `public/view-office.js` — new office renderer (layout, character SVG, state machine, pools).
- `SKILL.md` / `references/` — note the two views and the toggle.

## Verification

1. `node start.mjs`, open the dashboard. Default view is Pro (or last-saved). Toggle shows
   `Pro | Office`.
2. Run `scratchpad/demo-driver.mjs` (6 placeholder agents through full lifecycle):
   - In Office: characters walk in from the door to desks, play per-tool activities with the
     right icons, show mood, celebrate on done, then walk to the lounge and stay.
   - More-agents-than-desks: add agents beyond the desk count; floor scales, no overflow.
3. **Live switch:** flip Pro <-> Office mid-run; both reflect the same agents with no loss; the
   newly shown view reconciles immediately; the hidden view does no work.
4. **Persistence:** choose Office, hard refresh; the page reopens in Office and the scene
   restores coherently from the snapshot.
5. **Regression:** Pro view behaves exactly as before (no shake, in-place updates).
6. Sanity: no em/en dashes, real æ/ø/å where Danish is used, no secrets, single-line
   PowerShell-safe run commands; everything offline (no external requests).

## Open questions

None blocking. Defaults chosen above for desk count (start 12, grow), idle animation richness
(minimal), and lounge sizing (pool + scale).
