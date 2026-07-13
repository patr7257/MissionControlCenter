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
        agents.clear(); sessions.clear();
        firstSeenAt = msg.firstSeenAt || null; Store.firstSeenAt = firstSeenAt;
        (msg.agents || []).forEach(upsert);
        (msg.sessions || []).forEach(upsertSession);
        var v = active(); if (v) v.reset(snapshot());
        notifySessionsChanged();
      } else if (msg.type === 'agent') {
        upsert(msg.agent);
        var v2 = active(); if (v2) v2.update(msg.agent);
      } else if (msg.type === 'session') {
        upsertSession(msg.session);
        notifySessionsChanged();
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
    agents: agents, sessions: sessions, firstSeenAt: firstSeenAt,
    get selectedSessionId() { return selectedSessionId; },
    registerView: registerView, setActive: setActive, getActiveId: getActiveId,
    snapshot: snapshot, onTick: onTick, connect: connect,
    visibleAgents: visibleAgents, visibleAgentIds: visibleAgentIds,
    selectSession: selectSession, clearSession: clearSession,
    fmt: { dur: fmtDur, tokens: fmtTokens, esc: esc, shortId: shortId, hash: hashStr }
  };
})();
