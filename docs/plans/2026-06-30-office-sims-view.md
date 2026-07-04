# Office (Sims) View + Live View Switching - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isometric "office" (Sims-style) view to the agent-fleet-monitor dashboard, with a live in-app `Pro | Office` toggle, without changing the existing data pipeline.

**Architecture:** Refactor the front-end into a shared data store plus two pluggable view renderers (cards = existing, office = new). The store owns the `agents` Map and the SSE connection and pushes `reset`/`update` signals only to the active view. The server gains one small, path-guarded change to serve static files from `public/`.

**Tech Stack:** Node.js built-in `http` (server, zero npm deps), vanilla browser JS, CSS (incl. 3D transforms + keyframes), inline SVG. No bundler, no framework, fully offline.

## Global Constraints

- Zero runtime dependencies. Node built-ins only on the server; no npm packages, no CDN, no external network calls anywhere (fully offline). Verbatim from spec.
- Skill directory is NOT a git repo and the current shell cwd is an unrelated client repo. Do NOT run `git commit` and do NOT commit anything into the cwd repo. Each task ends at a verified browser/curl checkpoint instead.
- No em dashes or en dashes anywhere (code, comments, UI copy, docs). Use commas, colons, parentheses, or a single hyphen. (User global rule.)
- Any Danish text uses real letters æ/ø/å, never ae/oe/aa. (User global rule.) Note: this UI is in English, so this mainly guards stray copy.
- Run commands must be single-line and PowerShell-safe (the user pastes into Windows PowerShell). Provide a `.ps1`/`.mjs` file plus one line to run it when more than one line is needed. (User global rule.)
- Base skill dir (referred to below as `<SKILL>`): `C:/Users/pr/.claude/skills/agent-fleet-monitor`.
- Scratchpad (for the demo driver): `C:/Users/pr/AppData/Local/Temp/claude/C--Users-pr-repos-korselsplaner-sundvikar/436e3874-2895-49cd-a730-9964003ed3af/scratchpad`.
- Agent data fields available from the store (do not invent others): `id, type, task, status ("working"|"done"), busy (bool), currentTool, lastTool, steps, tokens, startedAt, endedAt`.

---

## File Structure (locked before tasks)

- `server.mjs` (modify) - extend the GET handler to serve any file under `public/` with correct content type and a path-traversal guard. Existing `/`, `/stream`, `/event`, `/favicon.ico` routes unchanged.
- `public/index.html` (modify) - reduce to a shell: header (title, connection LED, stats, the `Pro | Office` toggle) + two view containers (`#viewCards`, `#viewOffice`) + `<link>`/`<script>` tags + a short inline bootstrap. No inline view logic.
- `public/style.css` (create) - shared shell styles + the card styles (moved out of index.html) + office styles.
- `public/store.js` (create) - the data layer: `agents` Map, `firstSeenAt`, EventSource + reconnect, the 1s timer, a view registry, and the toggle/persistence helper. Exposes a global `Store`.
- `public/view-cards.js` (create) - the existing diff-based card renderer, moved verbatim and wrapped in the view interface. Exposes a global `ViewCards`.
- `public/view-office.js` (create) - the new office renderer. Exposes a global `ViewOffice`.
- `SKILL.md` / `references/troubleshooting.md` (modify) - document the two views and the toggle.

**View interface (every view object implements this; defined here, used by all tasks):**

```js
// view = {
//   id: "cards" | "office",
//   el: HTMLElement,            // the view's container
//   activate(snapshot),         // shown: full reconcile from current state; start any loop
//   deactivate(),               // hidden: stop any animation loop, keep DOM
//   reset(snapshot),            // store replaced all state (fresh SSE snapshot)
//   update(agent)               // one agent changed
// }
// snapshot = { firstSeenAt:number|null, agents: Agent[] }
```

**Store global API (defined in Task 2, used by Tasks 2-4):**

```js
// window.Store = {
//   agents,                 // Map<id, Agent>
//   firstSeenAt,            // number | null
//   registerView(view),     // add a view to the registry
//   setActive(id),          // switch active view, persist to localStorage, returns the view
//   getActiveId(),          // current active view id
//   snapshot()              // { firstSeenAt, agents:[...] }  (array copy)
// }
```

---

## Task 1: Server serves static files from `public/`

**Files:**
- Modify: `<SKILL>/server.mjs` (the `http.createServer` request handler)

**Interfaces:**
- Consumes: nothing new.
- Produces: GET for any existing file under `public/` returns 200 with the right `Content-Type`; paths escaping `public/` return 404. `/`, `/stream`, `/event`, `/favicon.ico` behave as before.

- [ ] **Step 1: Add a content-type map and a static handler near the top of the request handler**

In `server.mjs`, just after `const PUBLIC_DIR = path.join(SKILL_DIR, 'public');` already exists. Add this helper above `const server = http.createServer(...)`:

```js
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Serve a file from PUBLIC_DIR if (and only if) the resolved path stays inside it.
function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  serveFile(res, resolved, type); // serveFile already exists in server.mjs
}
```

- [ ] **Step 2: Route non-special GETs through the static handler**

In the request handler, keep the existing `/`, `/favicon.ico`, `/stream`, and POST `/event` branches. Replace the final fallback (`res.writeHead(404...); res.end('not found')`) at the very bottom with:

```js
  if (req.method === 'GET') {
    serveStatic(res, url);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
```

(The `/` branch still maps to `index.html` as today, so the diff is only the new GET fallback.)

- [ ] **Step 3: Create a probe asset and verify serving + guard**

Create `<SKILL>/public/_probe.txt` containing the single line `probe-ok`. Restart the server, then run this one-liner (PowerShell-safe, single line):

```
node -e "const h=require('http');function g(p){return new Promise(r=>{let b='';h.get({host:'127.0.0.1',port:4317,path:p},x=>{x.on('data',c=>b+=c);x.on('end',()=>r(x.statusCode+' '+(x.headers['content-type']||'')+' '+JSON.stringify(b.slice(0,16))))})})}(async()=>{console.log('probe:',await g('/_probe.txt'));console.log('traversal:',await g('/..%2f..%2fsettings.json'));console.log('root:',await g('/'))})()"
```

Expected: `probe:` shows `200 text/plain... "probe-ok"`; `traversal:` shows `404 ...`; `root:` shows `200 text/html...`.

- [ ] **Step 4: Remove the probe asset**

Delete `<SKILL>/public/_probe.txt`. Checkpoint: server change complete and guarded.

---

## Task 2: Front-end refactor to store + pluggable views + toggle (Pro unchanged, Office placeholder)

**Files:**
- Create: `<SKILL>/public/style.css`
- Create: `<SKILL>/public/store.js`
- Create: `<SKILL>/public/view-cards.js`
- Modify: `<SKILL>/public/index.html` (reduce to shell)

**Interfaces:**
- Consumes: the view interface and `Store` API defined in the File Structure section.
- Produces: `window.Store` (full API above), `window.ViewCards` (a view object with `id:"cards"`), and a working `Pro | Office` toggle. Office is an empty placeholder container in this task.

- [ ] **Step 1: Move all CSS into `public/style.css`**

Cut the entire contents of the `<style>...</style>` block currently in `index.html` into a new file `public/style.css` (CSS only, no `<style>` tags). Add these shell additions at the end of the file:

```css
/* View switching */
.view { display: none; }
.view.active { display: block; }
.toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; margin-left: 4px; }
.toggle button {
  background: transparent; color: var(--muted); border: 0; padding: 6px 12px;
  font: inherit; font-size: 12px; cursor: pointer; letter-spacing: 0.4px;
}
.toggle button.on { background: var(--accent); color: #07101f; font-weight: 650; }
```

- [ ] **Step 2: Create `public/store.js`**

This is the existing data logic (agents Map, EventSource, 1s timer) plus the view registry. Write the file exactly:

```js
// Shared data store: owns agent state + the SSE connection, and routes
// reset/update signals to whichever view is currently active.
(function () {
  var agents = new Map();
  var firstSeenAt = null;
  var views = new Map();   // id -> view object
  var activeId = null;
  var tickFns = [];        // per-second callbacks (views register their live-timer work)

  function snapshot() {
    return { firstSeenAt: firstSeenAt, agents: Array.from(agents.values()) };
  }
  function upsert(a) {
    if (!a || !a.id) return;
    agents.set(a.id, a);
    if (!firstSeenAt || a.startedAt < firstSeenAt) firstSeenAt = a.startedAt;
    Store.firstSeenAt = firstSeenAt;
  }

  function registerView(view) { views.set(view.id, view); }
  function getActiveId() { return activeId; }
  function setActive(id) {
    if (!views.has(id) || id === activeId) return views.get(id);
    var prev = activeId ? views.get(activeId) : null;
    if (prev) { prev.deactivate(); prev.el.classList.remove('active'); }
    activeId = id;
    var next = views.get(id);
    next.el.classList.add('active');
    next.activate(snapshot());
    try { localStorage.setItem('fleetView', id); } catch (e) {}
    return next;
  }
  function active() { return activeId ? views.get(activeId) : null; }
  function onTick(fn) { tickFns.push(fn); }

  // Per-second live timers (elapsed text, overall clock). Text-only, no reflow.
  setInterval(function () {
    document.querySelectorAll('.badge[data-elapsed]').forEach(function (el) {
      var raw = el.getAttribute('data-elapsed'); if (!raw) return;
      var p = raw.split(','); var start = parseInt(p[0], 10);
      var end = p[1] ? parseInt(p[1], 10) : Date.now();
      el.textContent = fmtDur(end - start);
    });
    if (firstSeenAt) { var c = document.getElementById('sClock'); if (c) c.textContent = fmtDur(Date.now() - firstSeenAt); }
    for (var i = 0; i < tickFns.length; i++) { try { tickFns[i](); } catch (e) {} }
  }, 1000);

  function connect() {
    var conn = document.getElementById('conn');
    var src = new EventSource('/stream');
    src.onopen = function () { conn.classList.add('live'); document.getElementById('connText').textContent = 'live'; };
    src.onerror = function () { conn.classList.remove('live'); document.getElementById('connText').textContent = 'reconnecting'; };
    src.onmessage = function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'snapshot') {
        agents.clear(); firstSeenAt = msg.firstSeenAt || null; Store.firstSeenAt = firstSeenAt;
        (msg.agents || []).forEach(upsert);
        var v = active(); if (v) v.reset(snapshot());
      } else if (msg.type === 'agent') {
        upsert(msg.agent);
        var v2 = active(); if (v2) v2.update(msg.agent);
      }
    };
  }

  // Shared formatting helpers (used by all views).
  function fmtDur(ms) { if (ms == null || ms < 0) ms = 0; var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtTokens(n) { if (n == null) return null; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function shortId(id) { return id ? String(id).slice(0, 6) : '?'; }
  function hashStr(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

  window.Store = {
    agents: agents, firstSeenAt: firstSeenAt,
    registerView: registerView, setActive: setActive, getActiveId: getActiveId,
    snapshot: snapshot, onTick: onTick, connect: connect,
    fmt: { dur: fmtDur, tokens: fmtTokens, esc: esc, shortId: shortId, hash: hashStr }
  };
})();
```

- [ ] **Step 3: Create `public/view-cards.js` (existing renderer wrapped as a view)**

Move the current card rendering into this file, using `Store.fmt.*` for helpers and exposing a view object. The card-building/diff logic is the code already in `index.html` (createCard/applyCard/toolHtml/toggleEmpty/sync), now reading from a passed-in agents map. Write the file:

```js
// Professional card view: Working / Done / Errors lanes with in-place diff updates.
(function () {
  var F = Store.fmt;
  var LANE_IDS = { working: 'laneWorking', done: 'laneDone', error: 'laneError' };
  var EMPTY_MSG = { working: 'No active agents', done: 'Nothing finished yet', error: 'No errors' };
  var ICONS = { Explore: '🔍', Plan: '📐', general: '🤖', 'general-purpose': '🤖', claude: '✨', 'code-reviewer': '🔎', 'code-review': '🔎', reviewer: '🔎', fork: '🍴', test: '🧪', research: '📚', 'claude-code-guide': '🧭' };
  var cards = new Map();

  function iconFor(type) { if (!type) return '🤖'; if (ICONS[type]) return ICONS[type]; var k = Object.keys(ICONS).find(function (x) { return type.toLowerCase().indexOf(x.toLowerCase()) !== -1; }); return k ? ICONS[k] : '🤖'; }
  function laneFor(a) { if (a.status === 'error') return 'error'; if (a.status === 'done') return 'done'; return 'working'; }
  function toolHtml(a) {
    if (a.status === 'done') return '<span class="tool">&#10003; finished</span>';
    if (a.busy && a.currentTool) return '&#9656; now: <span class="tool live">' + F.esc(a.currentTool) + '</span><span class="blink">_</span>';
    if (a.lastTool) return '&#183; last: <span class="tool">' + F.esc(a.lastTool) + '</span>';
    return '&#183; spawning';
  }
  function createCard(a) {
    var el = document.createElement('div'); el.className = 'card'; el.setAttribute('data-id', a.id);
    el.innerHTML = '<div class="top"><div class="avatar"></div><div><div class="name"></div><div class="sub"></div></div></div><div class="task"></div><div class="row"><span class="toolline"></span><span class="spacer"></span><span class="badge elapsed" data-elapsed=""></span><span class="badge metric"></span></div>';
    var c = { el: el, avatar: el.querySelector('.avatar'), name: el.querySelector('.name'), sub: el.querySelector('.sub'), task: el.querySelector('.task'), toolline: el.querySelector('.toolline'), elapsed: el.querySelector('.elapsed'), metric: el.querySelector('.metric'), _task: null, _tool: null, _metric: null, _status: null };
    c.avatar.textContent = iconFor(a.type); c.name.textContent = a.type; c.sub.textContent = '#' + F.shortId(a.id);
    el.classList.add('enter'); setTimeout(function () { el.classList.remove('enter'); }, 320);
    return c;
  }
  function applyCard(c, a) {
    if (c._task !== a.task) { c.task.textContent = a.task; c._task = a.task; }
    var th = toolHtml(a); if (c._tool !== th) { c.toolline.innerHTML = th; c._tool = th; }
    c.el.classList.toggle('busy', !!a.busy && a.status !== 'done');
    if (c._status !== a.status) { c.el.classList.remove('status-working', 'status-done', 'status-error'); c.el.classList.add('status-' + a.status); c._status = a.status; }
    c.elapsed.setAttribute('data-elapsed', a.startedAt + (a.endedAt ? (',' + a.endedAt) : ''));
    c.elapsed.textContent = F.dur((a.endedAt || Date.now()) - a.startedAt);
    var tokens = F.tokens(a.tokens); var metric = tokens != null ? ('&#8595; ' + tokens) : (a.steps + ' steps');
    if (c._metric !== metric) { c.metric.innerHTML = metric; c._metric = metric; }
  }
  function toggleEmpty(k) {
    var el = document.getElementById(LANE_IDS[k]); var hasCard = el.querySelector('.card'); var emptyEl = el.querySelector('.empty');
    if (!hasCard) { if (!emptyEl) { emptyEl = document.createElement('div'); emptyEl.className = 'empty'; el.appendChild(emptyEl); } emptyEl.textContent = EMPTY_MSG[k]; }
    else if (emptyEl) { emptyEl.parentNode.removeChild(emptyEl); }
  }
  function syncAll() {
    var counts = { working: 0, done: 0, error: 0 }, steps = 0;
    Store.agents.forEach(function (a) {
      var lane = laneFor(a); counts[lane] += 1; steps += a.steps || 0;
      var c = cards.get(a.id); if (!c) { c = createCard(a); cards.set(a.id, c); }
      applyCard(c, a);
      var laneEl = document.getElementById(LANE_IDS[lane]); if (c.el.parentNode !== laneEl) laneEl.appendChild(c.el);
    });
    cards.forEach(function (c, id) { if (!Store.agents.has(id)) { if (c.el.parentNode) c.el.parentNode.removeChild(c.el); cards.delete(id); } });
    toggleEmpty('working'); toggleEmpty('done'); toggleEmpty('error');
    set('cWorking', counts.working); set('cDone', counts.done); set('cError', counts.error);
    set('sActive', counts.working); set('sDone', counts.done); set('sSteps', steps);
    if (Store.agents.size > 0) set('foot', Store.agents.size + ' agent(s) tracked this run.');
  }
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  function updateOne(a) {
    // simplest correct approach: reconcile all (cheap; card diff is in-place)
    syncAll();
  }

  window.ViewCards = {
    id: 'cards',
    el: document.getElementById('viewCards'),
    activate: function () { syncAll(); },
    deactivate: function () {},
    reset: function () { syncAll(); },
    update: function (a) { updateOne(a); }
  };
})();
```

- [ ] **Step 4: Rewrite `public/index.html` as a shell**

Replace the whole file with this (header markup is unchanged from today; the lanes move under `#viewCards`; an empty `#viewOffice` is added; scripts load store + views + bootstrap):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Fleet Monitor</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header>
    <h1><span class="dot">&#9679;</span> Agent Fleet Monitor</h1>
    <div class="conn" id="conn"><span class="led"></span><span id="connText">connecting</span></div>
    <div class="toggle" id="toggle">
      <button data-view="cards" class="on">Pro</button>
      <button data-view="office">Office</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="n" id="sActive">0</div><div class="l">working</div></div>
      <div class="stat"><div class="n" id="sDone">0</div><div class="l">done</div></div>
      <div class="stat"><div class="n" id="sSteps">0</div><div class="l">steps</div></div>
      <div class="stat"><div class="n" id="sClock">0:00</div><div class="l">elapsed</div></div>
    </div>
  </header>

  <div id="viewCards" class="view active">
    <main>
      <section class="lane working"><div class="lane-head"><span class="pip">&#9679;</span> Working <span class="count" id="cWorking">0</span></div><div class="lane-body" id="laneWorking"><div class="empty">No active agents</div></div></section>
      <section class="lane done"><div class="lane-head"><span class="pip">&#9679;</span> Done <span class="count" id="cDone">0</span></div><div class="lane-body" id="laneDone"><div class="empty">Nothing finished yet</div></div></section>
      <section class="lane error"><div class="lane-head"><span class="pip">&#9679;</span> Errors <span class="count" id="cError">0</span></div><div class="lane-body" id="laneError"><div class="empty">No errors</div></div></section>
    </main>
    <footer id="foot">Waiting for agents. Dispatch parallel subagents and they will appear here.</footer>
  </div>

  <div id="viewOffice" class="view"></div>

  <script src="/store.js"></script>
  <script src="/view-cards.js"></script>
  <script src="/view-office.js"></script>
  <script>
    (function () {
      Store.registerView(ViewCards);
      Store.registerView(ViewOffice);
      var saved = null; try { saved = localStorage.getItem('fleetView'); } catch (e) {}
      var start = (saved === 'office') ? 'office' : 'cards';
      document.querySelectorAll('#toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-view');
          Store.setActive(id);
          document.querySelectorAll('#toggle button').forEach(function (x) { x.classList.toggle('on', x === b); });
        });
        b.classList.toggle('on', b.getAttribute('data-view') === start);
      });
      Store.setActive(start);
      Store.connect();
    })();
  </script>
</body>
</html>
```

- [ ] **Step 5: Create a minimal `public/view-office.js` placeholder**

So the bootstrap can register it. Full implementation lands in Tasks 3-4.

```js
// Office (Sims) view - placeholder until Task 3. Implements the view interface.
(function () {
  var el = document.getElementById('viewOffice');
  el.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center">Office view coming up...</div>';
  window.ViewOffice = {
    id: 'office', el: el,
    activate: function () {}, deactivate: function () {},
    reset: function () {}, update: function () {}
  };
})();
```

- [ ] **Step 6: Verify Pro view unchanged + toggle works + persistence**

Ensure the server is running (`node "<SKILL>/start.mjs"`). Run the demo driver (single line):

```
node "C:/Users/pr/AppData/Local/Temp/claude/C--Users-pr-repos-korselsplaner-sundvikar/436e3874-2895-49cd-a730-9964003ed3af/scratchpad/demo-driver.mjs"
```

In the browser at `http://localhost:4317`:
- Pro view shows the same lanes/cards as before (in-place updates, no shake).
- Clicking `Office` shows the placeholder; clicking `Pro` returns. The active button is highlighted.
- Choose `Office`, hard refresh (Ctrl+Shift+R): page reopens on Office. Choose `Pro`, refresh: reopens on Pro.

Also confirm assets serve (single line):

```
node -e "const h=require('http');function g(p){return new Promise(r=>{let b='';h.get({host:'127.0.0.1',port:4317,path:p},x=>{x.on('data',c=>b+=c);x.on('end',()=>r(x.statusCode))})})}(async()=>{for(const p of ['/style.css','/store.js','/view-cards.js','/view-office.js']) console.log(p, await g(p))})()"
```

Expected: each prints `200`. Checkpoint: modular front-end, Pro intact, toggle + persistence working.

---

## Task 3: Office view - static isometric scene + data-driven characters (no walking yet)

**Files:**
- Modify: `<SKILL>/public/view-office.js` (replace placeholder)
- Modify: `<SKILL>/public/style.css` (append office styles)

**Interfaces:**
- Consumes: `Store.agents`, `Store.snapshot()`, `Store.fmt.*`, `Store.onTick`, the view interface.
- Produces: `window.ViewOffice` with a working `reset`/`update` that places one character per agent at a desk (working) or lounge (done), shows the tool bubble + mood, updates token/elapsed captions. Characters appear in place (teleport); walking animation is Task 4.

- [ ] **Step 1: Append office CSS to `public/style.css`**

```css
/* ---- Office view ---- */
#viewOffice.active { display: block; }
.office-wrap { padding: 18px 22px 40px; }
.floor-scaler { transform-origin: top center; transition: transform 0.3s ease; }
.floor {
  position: relative; margin: 60px auto 0; width: 760px; height: 460px;
  background:
    linear-gradient(transparent 0 0),
    repeating-linear-gradient(0deg, #1a2233 0 39px, #18202f 39px 40px),
    repeating-linear-gradient(90deg, #1a2233 0 39px, #18202f 39px 40px);
  background-color: #18202f; border: 1px solid var(--line); border-radius: 6px;
  transform: rotateX(55deg) rotateZ(-45deg); transform-style: preserve-3d;
  box-shadow: 0 40px 80px rgba(0,0,0,0.5);
}
.door { position: absolute; left: -2px; top: 40px; width: 14px; height: 70px; background: var(--accent); border-radius: 2px; box-shadow: 0 0 12px var(--accent); }
.spot { position: absolute; width: 64px; height: 64px; }            /* desk or lounge slot */
.desk { position: absolute; left: 8px; top: 30px; width: 48px; height: 26px; background: #2a3650; border: 1px solid #3a4straight; border-radius: 3px; }
.lounge-zone { position: absolute; left: 0; bottom: -2px; width: 100%; height: 96px; border-top: 1px dashed var(--line); }
.lounge-label, .desks-label { position: absolute; color: var(--muted); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }

/* Character: counter-rotated so it stands upright above the tilted floor. */
.sim { position: absolute; width: 64px; height: 64px; transition: left 1.2s ease, top 1.2s ease; }
.sim .billboard { position: absolute; left: 0; bottom: 8px; width: 64px; transform: rotateZ(45deg) rotateX(-55deg); transform-origin: center bottom; }
.sim svg { display: block; margin: 0 auto; overflow: visible; }
.sim .label { text-align: center; font-size: 10px; color: var(--text); white-space: nowrap; margin-top: 2px; }
.sim .label .sub2 { color: var(--muted); }
.bubble {
  position: absolute; left: 50%; transform: translateX(-50%) translateY(-100%);
  top: -2px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 2px 7px; font-size: 10px; color: var(--text); white-space: nowrap;
}
.bubble .tool { color: var(--working); font-weight: 650; }
.sim.busy .body { animation: simwork 0.7s ease-in-out infinite; }
.sim.idle .body { animation: simidle 3s ease-in-out infinite; }
.sim.done .body { animation: none; }
@keyframes simwork { 0%,100%{ transform: translateY(0);} 50%{ transform: translateY(-2px);} }
@keyframes simidle { 0%,100%{ transform: rotate(0);} 50%{ transform: rotate(-3deg);} }
.sim.celebrate { animation: simjump 0.5s ease; }
@keyframes simjump { 0%,100%{ transform: translateY(0);} 30%{ transform: translateY(-14px);} 60%{ transform: translateY(-4px);} }
.done-badge { color: var(--done); font-size: 10px; }
```

Note: replace the obviously broken `#3a4straight` token above with `#3a4a66` when implementing (kept here so you notice and set a real hex).

- [ ] **Step 2: Replace `public/view-office.js` with the scene + character renderer**

```js
// Office (Sims) view: isometric floor with one SVG character per agent.
(function () {
  var F = Store.fmt;
  var DESK_COLS = 4, DESK_ROWS = 3;           // 12 desks to start
  var DESK_ORIGIN = { x: 70, y: 50 }, DESK_GAP = { x: 165, y: 120 };
  var LOUNGE_COLS = 6;
  var LOUNGE_ORIGIN = { x: 60, y: 380 }, LOUNGE_GAP = { x: 115, y: 44 };

  var TOOL_ACTIVITY = {
    Bash: { icon: '⌨️', label: 'typing' },
    Read: { icon: '📖', label: 'reading' },
    Grep: { icon: '🔍', label: 'searching' },
    Glob: { icon: '📁', label: 'searching' },
    Edit: { icon: '✏️', label: 'writing' },
    Write: { icon: '✏️', label: 'writing' },
    NotebookEdit: { icon: '✏️', label: 'writing' },
    WebFetch: { icon: '🌐', label: 'browsing' },
    WebSearch: { icon: '🌐', label: 'browsing' },
    _default: { icon: '⚙️', label: 'thinking' }
  };
  function activityFor(tool) { return (tool && TOOL_ACTIVITY[tool]) || TOOL_ACTIVITY._default; }

  var PALETTE = ['#5b9cff', '#3ddc84', '#ffb43d', '#ff7ad9', '#9b8cff', '#4fd6d2', '#ff8a65', '#c0d152'];
  function look(id) { var h = F.hash(id); return { body: PALETTE[h % PALETTE.length], hat: PALETTE[(h >> 3) % PALETTE.length] }; }

  // Build the character SVG once. Returns {root, body, bubble, label, badge}.
  function buildSim(a) {
    var root = document.createElement('div'); root.className = 'sim'; root.setAttribute('data-id', a.id);
    var col = look(a.id);
    root.innerHTML =
      '<div class="bubble" style="display:none"></div>' +
      '<div class="billboard">' +
        '<svg width="40" height="48" viewBox="0 0 40 48">' +
          '<g class="body">' +
            '<ellipse cx="20" cy="46" rx="11" ry="3" fill="rgba(0,0,0,0.35)"></ellipse>' +
            '<rect x="13" y="20" width="14" height="18" rx="6" fill="' + col.body + '"></rect>' +
            '<rect x="15" y="36" width="4" height="9" rx="2" fill="#2a3650"></rect>' +
            '<rect x="21" y="36" width="4" height="9" rx="2" fill="#2a3650"></rect>' +
            '<circle cx="20" cy="13" r="8" fill="#f1c79b"></circle>' +
            '<path d="M12 11 a8 8 0 0 1 16 0 z" fill="' + col.hat + '"></path>' +
            '<circle class="eye" cx="17" cy="13" r="1.3" fill="#222"></circle>' +
            '<circle class="eye" cx="23" cy="13" r="1.3" fill="#222"></circle>' +
          '</g>' +
        '</svg>' +
        '<div class="label"><span class="nm"></span><br><span class="sub2"></span></div>' +
      '</div>';
    var refs = { root: root, body: root.querySelector('.body'), bubble: root.querySelector('.bubble'), nm: root.querySelector('.nm'), sub2: root.querySelector('.sub2') };
    refs.nm.textContent = a.type; refs.sub2.textContent = '#' + F.shortId(a.id);
    root.title = a.task || a.type;
    return refs;
  }

  var floor, scaler;
  var sims = new Map();        // id -> refs
  var deskOf = new Map();      // id -> deskIndex
  var loungeOf = new Map();    // id -> loungeIndex
  var freeDesks = [], freeLounge = [];

  function deskPos(i) { var c = i % DESK_COLS, r = Math.floor(i / DESK_COLS); return { x: DESK_ORIGIN.x + c * DESK_GAP.x, y: DESK_ORIGIN.y + r * DESK_GAP.y }; }
  function loungePos(i) { var c = i % LOUNGE_COLS, r = Math.floor(i / LOUNGE_COLS); return { x: LOUNGE_ORIGIN.x + c * LOUNGE_GAP.x, y: LOUNGE_ORIGIN.y + r * LOUNGE_GAP.y }; }

  function ensureScene() {
    if (floor) return;
    var wrap = document.createElement('div'); wrap.className = 'office-wrap';
    scaler = document.createElement('div'); scaler.className = 'floor-scaler';
    floor = document.createElement('div'); floor.className = 'floor';
    floor.innerHTML = '<div class="door" title="entrance"></div><div class="lounge-zone"></div>';
    scaler.appendChild(floor); wrap.appendChild(scaler);
    ViewOffice.el.innerHTML = ''; ViewOffice.el.appendChild(wrap);
    resetPools();
  }
  function resetPools() {
    freeDesks = []; for (var i = 0; i < DESK_COLS * DESK_ROWS; i++) freeDesks.push(i);
    freeLounge = []; for (var j = 0; j < LOUNGE_COLS * 2; j++) freeLounge.push(j);
  }
  function growDesksIfNeeded(idx) {
    // Auto-grow: if we ran out, add a row and scale the floor to keep it on screen.
    while (idx >= DESK_COLS * DESK_ROWS) { DESK_ROWS += 1; freeDesks.push((DESK_ROWS - 1) * DESK_COLS + 0, (DESK_ROWS - 1) * DESK_COLS + 1, (DESK_ROWS - 1) * DESK_COLS + 2, (DESK_ROWS - 1) * DESK_COLS + 3); }
    var needed = DESK_ORIGIN.y + DESK_ROWS * DESK_GAP.y + 140;
    var scale = Math.min(1, 600 / needed);
    if (scaler) scaler.style.transform = 'scale(' + scale + ')';
  }

  function place(refs, pos) { refs.root.style.left = pos.x + 'px'; refs.root.style.top = pos.y + 'px'; }

  function setState(a, refs) {
    refs.root.classList.remove('busy', 'idle', 'done');
    var bub = refs.bubble;
    if (a.status === 'done') {
      refs.root.classList.add('done');
      bub.style.display = '';
      var tok = F.tokens(a.tokens);
      bub.innerHTML = '<span class="done-badge">&#10003; done' + (tok != null ? (' &#8595; ' + tok) : '') + '</span>';
    } else if (a.busy && a.currentTool) {
      refs.root.classList.add('busy');
      var act = activityFor(a.currentTool);
      bub.style.display = '';
      bub.innerHTML = act.icon + ' <span class="tool">' + F.esc(a.currentTool) + '</span>';
    } else {
      refs.root.classList.add('idle');
      bub.style.display = a.lastTool ? '' : 'none';
      if (a.lastTool) bub.innerHTML = '&#183; ' + F.esc(a.lastTool);
    }
    refs.root.title = a.task || a.type;
  }

  function upsertSim(a) {
    ensureScene();
    var refs = sims.get(a.id);
    if (!refs) { refs = buildSim(a); sims.set(a.id, refs); floor.appendChild(refs.root); }

    if (a.status !== 'done') {
      var di = deskOf.get(a.id);
      if (di == null) { di = freeDesks.length ? freeDesks.shift() : (DESK_COLS * DESK_ROWS); growDesksIfNeeded(di); deskOf.set(a.id, di); }
      place(refs, deskPos(di));
    } else {
      // moved to lounge: free its desk, take a lounge seat
      if (deskOf.has(a.id)) { freeDesks.push(deskOf.get(a.id)); deskOf.delete(a.id); }
      var li = loungeOf.get(a.id);
      if (li == null) { li = freeLounge.length ? freeLounge.shift() : 0; loungeOf.set(a.id, li); }
      place(refs, loungePos(li));
    }
    setState(a, refs);
  }

  function reconcile(snapshot) {
    ensureScene();
    // Rebuild assignments deterministically: working by startedAt, then done.
    sims.forEach(function (r) { if (r.root.parentNode) r.root.parentNode.removeChild(r.root); });
    sims.clear(); deskOf.clear(); loungeOf.clear(); resetPools();
    var list = (snapshot.agents || []).slice().sort(function (x, y) { return x.startedAt - y.startedAt; });
    list.filter(function (a) { return a.status !== 'done'; }).forEach(upsertSim);
    list.filter(function (a) { return a.status === 'done'; }).forEach(upsertSim);
  }

  window.ViewOffice = {
    id: 'office',
    el: document.getElementById('viewOffice'),
    activate: function (snap) { reconcile(snap); },
    deactivate: function () {},
    reset: function (snap) { reconcile(snap); },
    update: function (a) { upsertSim(a); }
  };
})();
```

- [ ] **Step 3: Verify the office reflects live data**

Server running; run the demo driver (single line, as in Task 2 Step 6). Switch to `Office`.

Expected:
- A tilted floor with a glowing door; characters appear at desks, each a distinct color.
- Busy characters show a tool bubble with the right icon (e.g. Read shows a book, Bash a keyboard) and bob; idle ones show a faint "last:" bubble and sway.
- When the demo's agents finish, their characters jump to the lounge strip and show a green "done + tokens" bubble; their desks free up.
- Labels show agent type + short id; hovering shows the task.

- [ ] **Step 4: Verify reconcile on refresh + view switching**

- Switch to Office, hard refresh: scene rebuilds with working agents at desks and finished ones in the lounge (no duplicates, no overlap).
- Toggle Pro <-> Office repeatedly during the run: both stay consistent with the same agents. Checkpoint: office is correct and data-driven (movement is instant for now).

---

## Task 4: Office animation polish (walk in, walk to lounge, per-tool activity, celebrate, idle)

**Files:**
- Modify: `<SKILL>/public/view-office.js`
- Modify: `<SKILL>/public/style.css` (per-tool activity tweaks + walk cycle)

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: characters that walk from the door to their desk on first appearance, celebrate then walk to the lounge on done, with per-tool activity animations and an idle loop that pauses cleanly when the view is hidden.

- [ ] **Step 1: Spawn at the door, then walk to the desk**

In `upsertSim`, when a sim is first created (the `if (!refs)` branch), place it at the door before assigning the desk, so the CSS `left/top` transition animates the walk:

```js
    if (!refs) {
      refs = buildSim(a); sims.set(a.id, refs); floor.appendChild(refs.root);
      place(refs, { x: 4, y: 60 });        // door position
      // force layout so the next position change animates
      void refs.root.offsetWidth;
      refs.root.classList.add('walking');
    }
```

Add a `transitionend` handler in `buildSim` (on `.sim`) that removes `walking`:

```js
    root.addEventListener('transitionend', function (e) { if (e.propertyName === 'left' || e.propertyName === 'top') root.classList.remove('walking'); });
```

Add to CSS:

```css
.sim.walking .body { animation: simwalk 0.35s steps(2) infinite; }
@keyframes simwalk { 0%{ transform: translateY(0);} 50%{ transform: translateY(-3px) rotate(2deg);} 100%{ transform: translateY(0);} }
```

- [ ] **Step 2: Celebrate then walk to lounge on done**

Change the done branch in `upsertSim` so the character jumps in place first, then transitions to the lounge seat:

```js
    } else {
      if (deskOf.has(a.id)) { freeDesks.push(deskOf.get(a.id)); deskOf.delete(a.id); }
      var li = loungeOf.get(a.id);
      if (li == null) {
        li = freeLounge.length ? freeLounge.shift() : 0; loungeOf.set(a.id, li);
        refs.root.classList.add('celebrate');
        refs.root.classList.add('walking');
        setTimeout(function () { refs.root.classList.remove('celebrate'); place(refs, loungePos(li)); }, 480);
      } else {
        place(refs, loungePos(li));
      }
    }
```

(The reconcile path on refresh must NOT animate: in `reconcile`, after building, set positions without the walking class. Guard by only adding `walking` in the live `update` path, which is already the case because `reconcile` calls `upsertSim` but the sims are freshly created at the door, then jump. To avoid a refresh-walk storm, in `reconcile` add `refs.root.classList.add('noanim')` during placement and remove on next frame.)

Add CSS:

```css
.sim.noanim { transition: none; }
```

And in `reconcile`, wrap placement:

```js
    function placeStatic(refs, pos) { refs.root.classList.add('noanim'); place(refs, pos); requestAnimationFrame(function () { refs.root.classList.remove('noanim'); }); }
```

Use `placeStatic` for the initial reconcile placements (replace the `upsertSim` calls in `reconcile` with a dedicated static placement loop that creates sims, assigns desk/lounge by status, calls `placeStatic`, and `setState`).

- [ ] **Step 3: Per-tool activity classes**

Give the body an activity class so different tools read differently. In `setState`, when busy:

```js
      refs.root.setAttribute('data-act', act.label);
```

Add CSS (subtle variants):

```css
.sim[data-act="reading"].busy .body { animation: simread 1.6s ease-in-out infinite; }
.sim[data-act="typing"].busy .body { animation: simwork 0.45s ease-in-out infinite; }
.sim[data-act="searching"].busy .body { animation: simidle 1.2s ease-in-out infinite; }
@keyframes simread { 0%,100%{ transform: rotate(-2deg);} 50%{ transform: rotate(2deg);} }
```

- [ ] **Step 4: Idle loop that pauses when hidden**

The CSS animations already pause when `#viewOffice` is `display:none` (browsers pause animations on hidden elements), so no JS rAF is required. Confirm `deactivate()` need do nothing for animation, but set a flag so any future loop is guarded:

```js
    activate: function (snap) { this._active = true; reconcile(snap); },
    deactivate: function () { this._active = false; },
```

- [ ] **Step 5: Full verification**

Server running; run the demo driver. In Office view, confirm the full sequence:
- Characters **walk in from the door** to their desks (smooth slide + leg bob), not teleport.
- Busy characters animate per tool (reading vs typing vs searching look different); the tool bubble matches `currentTool`.
- On finish: a small jump, then a **walk to the lounge**; desk frees and can be reused by a later agent.
- Idle agents sway. Switching to Pro and back does not restart walks for already-seated agents (refresh-path uses `placeStatic`).
- More than 12 concurrent agents: floor scales down to fit, no overflow (temporarily lower the demo desk count or add agents to test; or set `DESK_ROWS`/cols small and confirm scaling).
- Switch to Pro: no animation cost in Office (it is `display:none`).

Checkpoint: full Sims experience complete.

---

## Task 5: Docs

**Files:**
- Modify: `<SKILL>/SKILL.md`
- Modify: `<SKILL>/references/troubleshooting.md`

- [ ] **Step 1: Note the two views in SKILL.md**

Under "Notes", add a line:

```
- The dashboard has two live views, switchable in the header: "Pro" (professional cards) and
  "Office" (an isometric Sims-style office where each subagent is an animated character). The
  choice is remembered per browser. Both render from the same live data.
```

- [ ] **Step 2: Add an Office troubleshooting note**

In `references/troubleshooting.md`, add:

```
## Office view shows nothing or looks flat

- The Office view needs the static assets to load. Confirm `/style.css`, `/store.js`,
  `/view-cards.js`, `/view-office.js` all return 200 (the server serves everything under
  public/). Hard refresh (Ctrl+Shift+R) to bypass cache after an update.
- Characters only appear for subagent activity (events with an agent_id), same as the cards.
- If the floor overflows with many agents, that is expected to scale down; resize the window
  or reduce concurrent agents.
```

- [ ] **Step 3: Verify docs**

Read both files back; confirm the additions are present and contain no em/en dashes. Checkpoint: feature documented.

---

## Self-Review

**Spec coverage:**
- View-switch architecture (shared store, active-only updates, persistence) -> Task 2. Covered.
- Server serves `public/**` with guard -> Task 1. Covered.
- Isometric floor, desks, door, lounge -> Task 3 (scene) + Task 4 (polish). Covered.
- Inline-SVG deterministic characters -> Task 3 Step 2 (`buildSim`, `look`). Covered.
- Lifecycle state machine (spawn/walk, busy, idle, done->lounge) -> Task 3 (states) + Task 4 (walking/celebrate). Covered.
- Tool -> activity mapping -> Task 3 (`TOOL_ACTIVITY`) + Task 4 (activity classes). Covered.
- Desk/lounge pools + grow/scale -> Task 3 (`freeDesks`, `growDesksIfNeeded`). Covered.
- Reconcile on reconnect/refresh -> Task 3 `reconcile` + Task 4 `placeStatic`. Covered.
- File split (style.css, store.js, view-cards.js, view-office.js, shell index.html) -> Task 2. Covered.
- Edge cases (more agents than desks, unknown tool, missing task, hidden view, no localStorage) -> Tasks 2-4. Covered.
- Docs -> Task 5. Covered.

**Placeholder scan:** One intentional broken token `#3a4straight` is flagged in-line with an instruction to replace it with `#3a4a66`; not a silent placeholder. No TBD/TODO/"handle edge cases" left.

**Type consistency:** `Store.fmt.{dur,tokens,esc,shortId,hash}` defined in Task 2 and used consistently in Tasks 3-4. View interface (`activate/deactivate/reset/update`, `id`, `el`) consistent across `ViewCards` and `ViewOffice`. `upsertSim`, `reconcile`, `placeStatic`, `deskOf/loungeOf/freeDesks/freeLounge`, `deskPos/loungePos` names consistent within Task 3-4.

**Scope:** Single feature, one plan. No decomposition needed.
