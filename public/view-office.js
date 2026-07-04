// Office (Sims) view: a flat 2.5D office of Humaaans characters, one per agent.
// Characters walk in from the door to a workstation, sit and work (per-tool
// activity), then celebrate and move to the lounge when done. Recolored per agent.
(function () {
  var F = Store.fmt;
  var COLS = 4, ROWS = 2;                          // workstations, grows by rows
  var ORIGIN = { x: 70, y: 28 }, GAP = { x: 200, y: 208 };
  var DOOR = { x: 14, y: 150 };
  var DESK_DX = -22, DESK_DY = 104;                // desk-front offset from character
  var LOUNGE_COLS = 6;
  var LOUNGE_ORIGIN = { x: 36, y: 452 }, LOUNGE_GAP = { x: 142, y: 58 };

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
      if (e.propertyName === 'left' || e.propertyName === 'top') { root.classList.remove('walking'); applyPose(refs); }
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

  var room, scaler;
  var sims = new Map();
  var deskOf = new Map();
  var loungeOf = new Map();
  var freeDesks = [], freeLounge = [];
  var loungeRowsAllocated = 2;

  function deskPos(i) { var c = i % COLS, r = Math.floor(i / COLS); return { x: ORIGIN.x + c * GAP.x, y: ORIGIN.y + r * GAP.y }; }
  function loungePos(i) { var c = i % LOUNGE_COLS, r = Math.floor(i / LOUNGE_COLS); return { x: LOUNGE_ORIGIN.x + c * LOUNGE_GAP.x, y: LOUNGE_ORIGIN.y + r * LOUNGE_GAP.y }; }

  function rescale() {
    var needed = ORIGIN.y + ROWS * GAP.y + 180;
    var scale = Math.min(1, 540 / needed);
    if (scaler) scaler.style.transform = 'scale(' + scale + ')';
  }
  function drawStation(i) {
    if (!room) return;
    var p = deskPos(i);
    var d = document.createElement('div'); d.className = 'deskfront'; d.setAttribute('data-desk', i);
    d.style.left = (p.x + DESK_DX) + 'px'; d.style.top = (p.y + DESK_DY) + 'px';
    d.innerHTML = '<div class="monitor"></div>';
    room.appendChild(d);
  }
  function drawSofa(i) {
    if (!room) return;
    var p = loungePos(i);
    var s = document.createElement('div'); s.className = 'sofa';
    s.style.left = (p.x - 6) + 'px'; s.style.top = (p.y + 78) + 'px';
    room.appendChild(s);
  }
  function ensureScene() {
    if (room) return;
    var wrap = document.createElement('div'); wrap.className = 'office-wrap';
    scaler = document.createElement('div'); scaler.className = 'room-scaler';
    room = document.createElement('div'); room.className = 'room';
    room.innerHTML = '<div class="window"></div><div class="door" title="entrance"></div>' +
      '<div class="lounge-zone"></div>';
    scaler.appendChild(room); wrap.appendChild(scaler);
    ViewOffice.el.innerHTML = ''; ViewOffice.el.appendChild(wrap);
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

  function setState(a, refs) {
    refs._a = a;
    refs.root.classList.remove('busy', 'idle', 'done');
    refs.root.removeAttribute('data-act');
    var bub = refs.bubble;
    if (a.status === 'done') {
      refs.root.classList.add('done'); bub.style.display = '';
      var tok = F.tokens(a.tokens);
      bub.innerHTML = '<span class="done-badge">&#10003; done' + (tok != null ? (' &#8595; ' + tok) : '') + '</span>';
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
      if (deskOf.has(a.id)) { freeDesks.push(deskOf.get(a.id)); deskOf.delete(a.id); }
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
  }

  function reconcile(snapshot) {
    ensureScene();
    sims.forEach(function (r) { if (r.root.parentNode) r.root.parentNode.removeChild(r.root); });
    sims.clear(); deskOf.clear(); loungeOf.clear(); resetPools();
    var list = Store.visibleAgents().slice().sort(function (x, y) { return x.startedAt - y.startedAt; });
    list.filter(function (a) { return a.status !== 'done'; }).forEach(function (a) { upsertSim(a, true); });
    list.filter(function (a) { return a.status === 'done'; }).forEach(function (a) { upsertSim(a, true); });
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
