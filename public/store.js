// Shared data store: owns agent state + the SSE connection, and routes
// reset/update signals to whichever view is currently active.
(function () {
  var agents = new Map();
  var sessions = new Map();
  var selectedSessionId = null;
  var firstSeenAt = null;
  var views = new Map();   // id -> view object
  var activeId = null;
  var tickFns = [];        // per-second callbacks (views register their live-timer work)
  var usage = null;        // account-wide 5h/7d quota, or null before we ever hear from it
  var usageFns = [];       // callbacks fired whenever usage changes (top-bar meters)

  function snapshot() {
    return { firstSeenAt: firstSeenAt, agents: Array.from(agents.values()), sessions: Array.from(sessions.values()) };
  }
  function upsert(a) {
    if (!a || !a.id) return;
    agents.set(a.id, a);
    if (!firstSeenAt || a.startedAt < firstSeenAt) firstSeenAt = a.startedAt;
    Store.firstSeenAt = firstSeenAt;
  }
  function upsertSession(s) {
    if (!s || !s.id) return;
    sessions.set(s.id, s);
  }
  function notifySessionsChanged() {
    var sessionsView = views.get('sessions');
    if (sessionsView && typeof sessionsView.sessionsChanged === 'function') sessionsView.sessionsChanged();
  }
  function setUsage(u) {
    usage = u || null;
    for (var i = 0; i < usageFns.length; i++) { try { usageFns[i](usage); } catch (e) {} }
  }
  function onUsage(fn) {
    usageFns.push(fn);
    fn(usage);
  }
  // Shared status predicates. `needsPermission` (the `Notification`/permission
  // prompt hook) is the ONLY status where Claude is genuinely blocked on the
  // user, so it is the sole meaning of "needs input". `awaiting` is set by the
  // `Stop` hook: Claude finished its turn and has nothing left to do, which is
  // informational, not a block. These two definitions are the single shared
  // source of truth (header pills, favicon/title alerting, the board's Active
  // segmented sub-filter, the stat tiles); nothing else may re-derive them.
  function needsInput(s) { return !!s && s.status === 'needs-permission'; }
  function doneAwaiting(s) { return !!s && s.status === 'awaiting'; }

  // ---- Attention: surface sessions genuinely blocked on the user
  // (needs-permission only) even when the window is not focused, via a header
  // pill, the document title, and the favicon. A second, calmer header label
  // separately surfaces "done, awaiting user" (informational, never alerts). ----
  var BASE_TITLE = 'Mission Control Center';
  var FAVICON_OK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='9' fill='%235b9cff'/%3E%3C/svg%3E";
  var FAVICON_ALERT = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='%23ffb43d'/%3E%3Ccircle cx='16' cy='16' r='4.5' fill='%23241a00'/%3E%3C/svg%3E";
  var attnCount = 0;
  function updateAttention() {
    var n = 0, d = 0;
    sessions.forEach(function (s) { if (needsInput(s)) n += 1; if (doneAwaiting(s)) d += 1; });
    attnCount = n;
    var pill = document.getElementById('attention');
    if (pill) {
      pill.style.display = n > 0 ? '' : 'none';
      var c = document.getElementById('attCount'); if (c) c.textContent = n;
    }
    // Informational only: never drives the favicon/title alert below.
    var donePill = document.getElementById('doneAwaiting');
    if (donePill) {
      donePill.style.display = d > 0 ? '' : 'none';
      var dc = document.getElementById('doneCount'); if (dc) dc.textContent = d;
    }
    var fav = document.getElementById('favicon');
    if (fav) fav.setAttribute('href', n > 0 ? FAVICON_ALERT : FAVICON_OK);
    // When the window is focused, keep a stable count in the title; the 1s tick
    // handles the flashing variant while it is hidden.
    if (n === 0) document.title = BASE_TITLE;
    else if (!document.hidden) document.title = '(' + n + ') ' + BASE_TITLE;
  }
  function visibleAgents() {
    if (!selectedSessionId) return Array.from(agents.values());
    var out = [];
    agents.forEach(function (a) { if (a.parentSession === selectedSessionId) out.push(a); });
    return out;
  }
  function visibleAgentIds() {
    var set = new Set();
    visibleAgents().forEach(function (a) { set.add(a.id); });
    return set;
  }
  function selectSession(id) {
    selectedSessionId = id;
    // The combined per-session subagent view (lanes + office) is registered under
    // 'detail'. It is only ever activated here, so it never shows without a
    // selected session.
    var wasActive = (activeId === 'detail');
    setActive('detail');
    if (wasActive) { var v = active(); if (v) v.reset(snapshot()); }
  }
  function clearSession() {
    selectedSessionId = null;
    setActive('sessions');
  }

  // Shared writer for the 4 header stat tiles. Both boards render through this
  // (never write #sActive/#sDone/#sSteps/#sClock or their label spans
  // directly) so there is exactly one owner per DOM node and no view can stomp
  // another's numbers. `list` is [{ n, l }, ...] for the 4 tiles in order; a
  // falsy entry, or an entry missing `n` or `l`, leaves that field untouched
  // (lets a per-second tick refresh just the value while the label stays put).
  // Dirty-checked against the last value written, so calling this every
  // second (or on every agent update) is cheap: unchanged fields never touch
  // the DOM.
  var STAT_IDS = [['sActive', 'sActiveL'], ['sDone', 'sDoneL'], ['sSteps', 'sStepsL'], ['sClock', 'sClockL']];
  var lastStats = [{}, {}, {}, {}];
  function setStats(list) {
    if (!list) return;
    for (var i = 0; i < STAT_IDS.length; i++) {
      var item = list[i];
      if (!item) continue;
      if (item.n !== undefined && lastStats[i].n !== item.n) {
        var en = document.getElementById(STAT_IDS[i][0]);
        if (en) en.textContent = item.n;
        lastStats[i].n = item.n;
      }
      if (item.l !== undefined && lastStats[i].l !== item.l) {
        var el = document.getElementById(STAT_IDS[i][1]);
        if (el) el.textContent = item.l;
        lastStats[i].l = item.l;
      }
    }
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
    // The clock tile is subagent-scoped (elapsed since the run's first agent),
    // so it is only meaningful while the detail view is showing; the sessions
    // board owns that same DOM node for its own "oldest activity" tile (see
    // view-sessions.js), and writing here unconditionally would stomp it every
    // second regardless of which view is on screen.
    if (firstSeenAt && activeId === 'detail') { setStats([null, null, null, { n: fmtDur(Date.now() - firstSeenAt) }]); }
    for (var i = 0; i < tickFns.length; i++) { try { tickFns[i](); } catch (e) {} }
    // Flash the tab title while attention is pending and the window is hidden,
    // so a blocked session is noticeable from another tab or app.
    if (attnCount > 0 && document.hidden) {
      document.title = (document.title.charAt(0) === '(')
        ? ('● ' + attnCount + ' need input')
        : ('(' + attnCount + ') ' + BASE_TITLE);
    }
  }, 1000);

  // Re-settle the title/favicon when the window regains or loses focus.
  document.addEventListener('visibilitychange', updateAttention);

  // Handles one already-parsed message in the exact shape the SSE stream sends:
  // { type:'snapshot', firstSeenAt, agents:[...], sessions:[...] },
  // { type:'agent', agent:{...} }, or { type:'session', session:{...} }.
  // Shared by the live SSE path (connect()) and by Store.ingest (used by the
  // in-browser demo driver), so both go through identical dispatch logic.
  function handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'snapshot') {
      agents.clear(); sessions.clear();
      firstSeenAt = msg.firstSeenAt || null; Store.firstSeenAt = firstSeenAt;
      (msg.agents || []).forEach(upsert);
      (msg.sessions || []).forEach(upsertSession);
      setUsage(msg.usage);
      var v = active(); if (v) v.reset(snapshot());
      notifySessionsChanged();
      updateAttention();
    } else if (msg.type === 'agent') {
      upsert(msg.agent);
      var v2 = active(); if (v2) v2.update(msg.agent);
    } else if (msg.type === 'session') {
      upsertSession(msg.session);
      notifySessionsChanged();
      updateAttention();
    } else if (msg.type === 'usage') {
      setUsage(msg.usage);
    }
  }

  function connect() {
    var conn = document.getElementById('conn');
    var src = new EventSource('/stream');
    src.onopen = function () { conn.classList.add('live'); document.getElementById('connText').textContent = 'live'; };
    src.onerror = function () { conn.classList.remove('live'); document.getElementById('connText').textContent = 'reconnecting'; };
    src.onmessage = function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleMessage(msg);
    };
  }

  // Shared formatting helpers (used by all views).
  function fmtDur(ms) { if (ms == null || ms < 0) ms = 0; var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtTokens(n) { if (n == null) return null; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(n); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function shortId(id) { return id ? String(id).slice(0, 6) : '?'; }
  function hashStr(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

  // Human readable model name, e.g. "claude-opus-5[1m]" -> "Opus 5 (1M)",
  // "claude-haiku-4-5-20251001" -> "Haiku 4.5". Shared by the session card,
  // the breadcrumb and demo.js so there is exactly one prettifier. Accepts
  // either a session-like object ({ modelDisplay, model }) or two positional
  // args (modelDisplay, modelId); prefers the server's modelDisplay when
  // present, otherwise prettifies the raw id. Unknown ids pass through
  // unchanged rather than rendering blank.
  function prettyModelId(raw) {
    if (!raw) return '';
    var id = String(raw);
    var big = /\[1m\]$/i.test(id);
    id = id.replace(/\[1m\]$/i, '');
    var m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
    if (!m) return raw;
    var family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    var version = m[3] ? (m[2] + '.' + m[3]) : m[2];
    var out = family + ' ' + version;
    if (big) out += ' (1M)';
    return out;
  }
  function fmtModel(a, b) {
    if (a && typeof a === 'object') return a.modelDisplay || prettyModelId(a.model) || '';
    return a || prettyModelId(b) || '';
  }

  window.Store = {
    agents: agents, sessions: sessions, firstSeenAt: firstSeenAt,
    get selectedSessionId() { return selectedSessionId; },
    get usage() { return usage; },
    registerView: registerView, setActive: setActive, getActiveId: getActiveId,
    snapshot: snapshot, onTick: onTick, connect: connect, ingest: handleMessage,
    visibleAgents: visibleAgents, visibleAgentIds: visibleAgentIds,
    selectSession: selectSession, clearSession: clearSession,
    onUsage: onUsage, needsInput: needsInput, doneAwaiting: doneAwaiting, setStats: setStats,
    fmt: { dur: fmtDur, tokens: fmtTokens, esc: esc, shortId: shortId, hash: hashStr, model: fmtModel }
  };
})();
