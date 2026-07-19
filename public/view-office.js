// Office (Sims) view: a flat 2.5D office of Humaaans characters, one per agent.
// Characters walk in from the door to a workstation, sit and work (per-tool
// activity), then celebrate and move to the lounge when done. Recolored per agent.
// Cinematic layer (issue #5): ambient office life (breathing idle, day/night wash,
// potted plants, wall clock), per-tool on-monitor desk FX, a head-of-room
// orchestrator with glowing connection threads to active desks, and a one-shot
// confetti burst when the whole session finishes. All motion is CSS-driven and
// gated behind prefers-reduced-motion in style.css.
(function () {
  var F = Store.fmt;
  var COLS = 4, ROWS = 2;                          // workstations, grows by rows
  var ROOM_W = 900, ROOM_H = 640;                  // fixed 2.5D stage size
  var ORIGIN = { x: 118, y: 176 }, GAP = { x: 190, y: 150 };
  var DOOR = { x: 14, y: 150 };
  var DESK_DX = -20, DESK_DY = 80;                 // desk-front offset from character
  var LOUNGE_COLS = 6;
  var LOUNGE_ORIGIN = { x: 44, y: 518 }, LOUNGE_GAP = { x: 140, y: 52 };
  var ORCH = { x: 388, y: 14 };                    // head-of-room orchestrator seat
  var ORCH_ANCHOR = { x: 450, y: 150 };            // thread origin (orchestrator desk)

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

  // Per-tool on-monitor effect category (drives the .deskfront[data-fx] CSS).
  var TOOL_FX = {
    Bash: 'code', Edit: 'code', Write: 'code', NotebookEdit: 'code',
    Grep: 'scan', Glob: 'scan', Read: 'page',
    WebFetch: 'globe', WebSearch: 'globe'
  };
  function fxFor(tool) { return (tool && TOOL_FX[tool]) || 'think'; }

  // Decorative inline-SVG props (behind the characters). Kept small and calm.
  var CROWN_SVG = '<svg viewBox="0 0 40 30"><path d="M4 26 L6 10 L14 18 L20 6 L26 18 L34 10 L36 26 Z" fill="#ffd36b" stroke="#e0a52e" stroke-width="1.6"/><circle cx="20" cy="6" r="2.4" fill="#fff4c2"/></svg>';
  var PLANT_SVG = '<svg viewBox="0 0 54 72"><g class="plant-leaf"><path d="M27 44 C10 40 6 16 22 8 C24 26 30 34 27 44Z" fill="#3ddc84"/><path d="M27 44 C44 40 48 16 32 8 C30 26 24 34 27 44Z" fill="#2fb56a"/><path d="M27 46 C25 30 27 14 27 6" stroke="#2a8f52" stroke-width="2" fill="none"/></g><path d="M16 45 h22 l-3 22 h-16 z" fill="#c8794a"/><rect x="14" y="42" width="26" height="7" rx="2" fill="#e08a56"/></svg>';
  var CLOCK_SVG = '<svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="21" fill="#f4f7fc" stroke="#9aa6c0" stroke-width="3"/><circle cx="23" cy="23" r="2.2" fill="#2b3346"/><line class="clock-hand hh" x1="23" y1="23" x2="23" y2="14" stroke="#2b3346" stroke-width="2.4" stroke-linecap="round"/><line class="clock-hand mh" x1="23" y1="23" x2="23" y2="9" stroke="#5b9cff" stroke-width="2" stroke-linecap="round"/></svg>';

  // Deterministic per-agent appearance.
  var SKIN = ['#f4d1b0', '#e8b894', '#cf9f7a', '#b07d56', '#8c5a3c', '#6f4a32'];
  var HAIR = ['#2c1b18', '#3a2a1a', '#5a3825', '#7a7a7a', '#1f2937', '#a33b2a', '#d6b370', '#e8e8e8'];
  var SHIRT = ['#5b9cff', '#3ddc84', '#ffb43d', '#ff7ad9', '#9b8cff', '#4fd6d2', '#ff8a65', '#c0d152'];
  var PANT = ['#2b3a67', '#3a3f55', '#5a4632', '#34495e', '#6d4c7d', '#2f6f6a'];
  var COAT = ['#5b9cff', '#ff8a65', '#3ddc84', '#9b8cff', '#4fd6d2', '#ffb43d'];
  function look(id) {
    var h = F.hash(id);
    var H = (typeof window.Humaaans !== 'undefined') ? window.Humaaans : null;
    return {
      colors: {
        skin: SKIN[h % SKIN.length], hair: HAIR[(h >> 2) % HAIR.length],
        shirt: SHIRT[(h >> 4) % SHIRT.length], pant: PANT[(h >> 6) % PANT.length],
        coat: COAT[(h >> 8) % COAT.length], shoe: '#3a3a3a', object: '#f4b942'
      },
      sit: H ? H.sitting[h % H.sitting.length] : null,
      stand: H ? H.standing[(h >> 3) % H.standing.length] : null
    };
  }

  function buildSim(a) {
    var root = document.createElement('div'); root.className = 'sim'; root.setAttribute('data-id', a.id);
    var lk = look(a.id);
    var H = window.Humaaans;
    var sit = H ? H.make(lk.sit, lk.colors) : '<svg viewBox="0 0 40 80"><circle cx="20" cy="16" r="12" fill="#b28b67"/><rect x="8" y="30" width="24" height="40" rx="8" fill="#5b9cff"/></svg>';
    var stand = H ? H.make(lk.stand, lk.colors) : sit;
    root.innerHTML = '<div class="bubble" style="display:none"></div><div class="char"></div>' +
      '<div class="label"><span class="nm"></span> <span class="sub2"></span></div>';
    var refs = {
      root: root, bubble: root.querySelector('.bubble'), char: root.querySelector('.char'),
      nm: root.querySelector('.nm'), sub2: root.querySelector('.sub2'),
      sit: sit, stand: stand, _pose: null, _a: a
    };
    refs.nm.textContent = a.type; refs.sub2.textContent = '#' + F.shortId(a.id);
    root.title = a.task || a.type;
    root.addEventListener('transitionend', function (e) {
      if (e.propertyName === 'left' || e.propertyName === 'top') {
        root.classList.remove('walking'); applyPose(refs); updateThreads();
      }
    });
    return refs;
  }

  function setPose(refs, kind) { if (refs._pose === kind) return; refs.char.innerHTML = (kind === 'sit') ? refs.sit : refs.stand; refs._pose = kind; }
  function applyPose(refs) {
    var a = refs._a;
    if (refs.root.classList.contains('walking')) setPose(refs, 'stand');
    else if (a && a.status === 'done') setPose(refs, 'stand');
    else setPose(refs, 'sit');
  }

  var room, scaler, threadsEl, orchEl;
  var sims = new Map();
  var deskOf = new Map();
  var loungeOf = new Map();
  var freeDesks = [], freeLounge = [];
  var loungeRowsAllocated = 2;
  var allDoneFired = false;

  function deskPos(i) { var c = i % COLS, r = Math.floor(i / COLS); return { x: ORIGIN.x + c * GAP.x, y: ORIGIN.y + r * GAP.y }; }
  function loungePos(i) { var c = i % LOUNGE_COLS, r = Math.floor(i / LOUNGE_COLS); return { x: LOUNGE_ORIGIN.x + c * LOUNGE_GAP.x, y: LOUNGE_ORIGIN.y + r * LOUNGE_GAP.y }; }
  function deskEl(i) { return room ? room.querySelector('.deskfront[data-desk="' + i + '"]') : null; }
  function clearDeskFx(i) { var d = deskEl(i); if (d) { d.removeAttribute('data-fx'); d.removeAttribute('data-alert'); } }

  function rescale() {
    var needed = Math.max(ROOM_H, ORIGIN.y + ROWS * GAP.y + 160);
    var scale = Math.min(1, 560 / needed);
    if (scaler) scaler.style.transform = 'scale(' + scale + ')';
  }
  function drawStation(i) {
    if (!room) return;
    var p = deskPos(i);
    var d = document.createElement('div'); d.className = 'deskfront'; d.setAttribute('data-desk', i);
    d.style.left = (p.x + DESK_DX) + 'px'; d.style.top = (p.y + DESK_DY) + 'px';
    d.innerHTML = '<div class="monitor"><span class="scr"></span></div>';
    room.appendChild(d);
  }
  function drawSofa(i) {
    if (!room) return;
    var p = loungePos(i);
    var s = document.createElement('div'); s.className = 'sofa';
    s.style.left = (p.x - 6) + 'px'; s.style.top = (p.y + 78) + 'px';
    room.appendChild(s);
  }
  function drawProp(cls, svg, x, y) {
    var el = document.createElement('div'); el.className = 'prop ' + cls;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.innerHTML = svg;
    room.appendChild(el);
  }
  function drawOrchestrator() {
    // A fixed presence representing the parent session (not an agent object).
    var lk = { skin: '#e8b894', hair: '#3a2a1a', shirt: '#5b9cff', pant: '#2b3a67', coat: '#5b9cff', shoe: '#2a2a2a', object: '#ffd36b' };
    var H = window.Humaaans;
    var svg = H ? H.make(H.standing[0], lk) : '';
    // Head desk (wider than a worker desk).
    var d = document.createElement('div'); d.className = 'deskfront orch-desk';
    d.style.left = (ORCH.x - 22) + 'px'; d.style.top = (ORCH.y + 96) + 'px';
    d.innerHTML = '<div class="monitor"><span class="scr"></span></div>';
    room.appendChild(d);
    orchEl = document.createElement('div'); orchEl.className = 'sim orch';
    orchEl.style.left = ORCH.x + 'px'; orchEl.style.top = ORCH.y + 'px';
    orchEl.innerHTML = '<div class="crown">' + CROWN_SVG + '</div><div class="char">' + svg + '</div>' +
      '<div class="label"><span class="nm">orchestrator</span></div>';
    room.appendChild(orchEl);
  }
  function ensureScene() {
    if (room) return;
    var wrap = document.createElement('div'); wrap.className = 'office-wrap';
    scaler = document.createElement('div'); scaler.className = 'room-scaler';
    room = document.createElement('div'); room.className = 'room';
    room.style.height = ROOM_H + 'px';
    room.innerHTML = '<div class="daynight"></div><div class="window"></div>' +
      '<div class="door" title="entrance"></div><div class="lounge-zone"></div>' +
      '<svg class="threads" viewBox="0 0 ' + ROOM_W + ' ' + ROOM_H + '" preserveAspectRatio="none"></svg>';
    scaler.appendChild(room); wrap.appendChild(scaler);
    ViewOffice.el.innerHTML = ''; ViewOffice.el.appendChild(wrap);
    threadsEl = room.querySelector('.threads');
    // Ambient props behind the characters.
    drawProp('plant', PLANT_SVG, 30, ROOM_H - 96);
    drawProp('plant plant-2', PLANT_SVG, ROOM_W - 84, ROOM_H - 96);
    drawProp('clock', CLOCK_SVG, 200, 38);
    drawOrchestrator();
    resetPools();
    for (var i = 0; i < COLS * ROWS; i++) drawStation(i);
    for (var j = 0; j < LOUNGE_COLS; j++) drawSofa(j);
    rescale();
  }
  function resetPools() {
    freeDesks = []; for (var i = 0; i < COLS * ROWS; i++) freeDesks.push(i);
    freeLounge = []; for (var j = 0; j < LOUNGE_COLS * 2; j++) freeLounge.push(j);
    loungeRowsAllocated = 2;
  }
  function growStationsIfNeeded(idx) {
    while (idx >= COLS * ROWS) {
      ROWS += 1;
      var base = (ROWS - 1) * COLS;
      for (var k = 0; k < COLS; k++) { freeDesks.push(base + k); drawStation(base + k); }
    }
    rescale();
  }
  function growLoungeIfNeeded() {
    if (freeLounge.length) return;
    var base = loungeRowsAllocated * LOUNGE_COLS;
    for (var k = 0; k < LOUNGE_COLS; k++) { freeLounge.push(base + k); drawSofa(base + k); }
    loungeRowsAllocated += 1;
  }

  function place(refs, pos) { refs.root.style.left = pos.x + 'px'; refs.root.style.top = pos.y + 'px'; }
  function placeStatic(refs, pos) {
    refs.root.classList.add('noanim'); place(refs, pos);
    requestAnimationFrame(function () { refs.root.classList.remove('noanim'); });
  }

  // Draw glowing threads from the orchestrator to every actively working desk.
  function updateThreads() {
    if (!threadsEl) return;
    var out = '';
    sims.forEach(function (r, id) {
      var a = r._a;
      if (!a || a.status === 'done' || !a.busy || !a.currentTool) return;
      var di = deskOf.get(id);
      if (di == null) return;
      var p = deskPos(di);
      var x2 = p.x + 56, y2 = p.y + DESK_DY - 4;
      var x1 = ORCH_ANCHOR.x, y1 = ORCH_ANCHOR.y;
      var mx = (x1 + x2) / 2, my = Math.min(y1, y2) - 34;
      out += '<path class="thread" d="M' + x1 + ' ' + y1 + ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + x2 + ' ' + y2 + '"/>';
    });
    threadsEl.innerHTML = out;
  }

  // One-shot confetti when the whole visible session has finished.
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function burstConfetti() {
    if (!room || reducedMotion()) return;
    var layer = document.createElement('div'); layer.className = 'confetti-layer';
    var cols = ['#5b9cff', '#3ddc84', '#ffb43d', '#ff7ad9', '#9b8cff', '#4fd6d2'];
    for (var i = 0; i < 16; i++) {
      var s = document.createElement('i');
      var dx = (Math.random() * 260 - 130).toFixed(0);
      var dy = (ROOM_H * 0.6 + Math.random() * ROOM_H * 0.3).toFixed(0);
      var rot = (Math.random() * 720 - 360).toFixed(0);
      s.style.left = (10 + Math.random() * 80) + '%';
      s.style.background = cols[i % cols.length];
      s.style.setProperty('--dx', dx + 'px');
      s.style.setProperty('--dy', dy + 'px');
      s.style.setProperty('--rot', rot + 'deg');
      s.style.animationDelay = (Math.random() * 0.25).toFixed(2) + 's';
      layer.appendChild(s);
    }
    room.appendChild(layer);
    setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 1900);
  }
  function maybeSessionConfetti() {
    var list = Store.visibleAgents();
    if (!list.length) { allDoneFired = false; return; }
    var allDone = list.every(function (a) { return a.status === 'done'; });
    if (allDone && !allDoneFired) { allDoneFired = true; burstConfetti(); }
    else if (!allDone) { allDoneFired = false; }
  }

  function applyDeskFx(a) {
    var di = deskOf.get(a.id);
    var d = (di == null) ? null : deskEl(di);
    if (!d) return;
    d.removeAttribute('data-fx'); d.removeAttribute('data-alert');
    if (a.status === 'error') { d.setAttribute('data-alert', '1'); return; }
    if (a.busy && a.currentTool) d.setAttribute('data-fx', fxFor(a.currentTool));
  }

  function setState(a, refs) {
    refs._a = a;
    refs.root.classList.remove('busy', 'idle', 'done', 'error');
    refs.root.removeAttribute('data-act');
    var bub = refs.bubble;
    if (a.status === 'done') {
      refs.root.classList.add('done'); bub.style.display = '';
      var tok = F.tokens(a.tokens);
      bub.innerHTML = '<span class="done-badge">&#10003; done' + (tok != null ? (' &#8595; ' + tok) : '') + '</span>';
    } else if (a.status === 'error') {
      refs.root.classList.add('error', 'idle'); bub.style.display = '';
      bub.innerHTML = '<span class="err-badge">&#9888; error</span>';
    } else if (a.busy && a.currentTool) {
      refs.root.classList.add('busy');
      var act = activityFor(a.currentTool);
      refs.root.setAttribute('data-act', act.label);
      bub.style.display = '';
      bub.innerHTML = act.icon + ' <span class="tool">' + F.esc(a.currentTool) + '</span>';
    } else {
      refs.root.classList.add('idle');
      bub.style.display = a.lastTool ? '' : 'none';
      if (a.lastTool) bub.innerHTML = '&#183; ' + F.esc(a.lastTool);
    }
    refs.root.title = a.task || a.type;
    applyPose(refs);
    applyDeskFx(a);
  }

  function upsertSim(a, isStatic) {
    ensureScene();
    var refs = sims.get(a.id);
    var isNew = !refs;
    if (isNew) {
      refs = buildSim(a); sims.set(a.id, refs); room.appendChild(refs.root);
      if (!isStatic) {
        refs.root.classList.add('noanim'); place(refs, DOOR);
        void refs.root.offsetWidth; refs.root.classList.remove('noanim');
      }
    }
    refs._a = a;

    if (a.status !== 'done') {
      var di = deskOf.get(a.id);
      if (di == null) { if (!freeDesks.length) growStationsIfNeeded(COLS * ROWS); di = freeDesks.shift(); deskOf.set(a.id, di); }
      if (isStatic) placeStatic(refs, deskPos(di));
      else { if (isNew) refs.root.classList.add('walking'); place(refs, deskPos(di)); }
    } else {
      if (deskOf.has(a.id)) { var freed = deskOf.get(a.id); clearDeskFx(freed); freeDesks.push(freed); deskOf.delete(a.id); }
      var li = loungeOf.get(a.id);
      var firstDone = (li == null);
      if (li == null) { if (!freeLounge.length) growLoungeIfNeeded(); li = freeLounge.shift(); loungeOf.set(a.id, li); }
      var lpos = loungePos(li);
      if (isStatic) {
        placeStatic(refs, lpos);
      } else if (firstDone) {
        refs.root.classList.add('celebrate'); refs.root.classList.add('walking');
        setTimeout(function () { refs.root.classList.remove('celebrate'); place(refs, lpos); }, 480);
      } else {
        place(refs, lpos);
      }
    }
    setState(a, refs);
    updateThreads();
    maybeSessionConfetti();
  }

  function reconcile(snapshot) {
    ensureScene();
    sims.forEach(function (r) { if (r.root.parentNode) r.root.parentNode.removeChild(r.root); });
    sims.clear(); deskOf.clear(); loungeOf.clear(); resetPools();
    // Clear any lingering desk FX from a prior session's layout.
    var desks = room.querySelectorAll('.deskfront');
    for (var d = 0; d < desks.length; d++) { desks[d].removeAttribute('data-fx'); desks[d].removeAttribute('data-alert'); }
    allDoneFired = false;
    var list = Store.visibleAgents().slice().sort(function (x, y) { return x.startedAt - y.startedAt; });
    list.filter(function (a) { return a.status !== 'done'; }).forEach(function (a) { upsertSim(a, true); });
    list.filter(function (a) { return a.status === 'done'; }).forEach(function (a) { upsertSim(a, true); });
    updateThreads();
    maybeSessionConfetti();
  }

  window.ViewOffice = {
    id: 'office',
    el: document.getElementById('viewOffice'),
    activate: function (snap) { this._active = true; reconcile(snap); },
    deactivate: function () { this._active = false; },
    reset: function (snap) { reconcile(snap); },
    update: function (a) { if (Store.visibleAgentIds().has(a.id)) upsertSim(a, false); }
  };
})();
