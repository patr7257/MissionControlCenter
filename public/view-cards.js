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
    var visible = Store.visibleAgents();
    var visibleIds = Store.visibleAgentIds();
    visible.forEach(function (a) {
      var lane = laneFor(a); counts[lane] += 1; steps += a.steps || 0;
      var c = cards.get(a.id); if (!c) { c = createCard(a); cards.set(a.id, c); }
      applyCard(c, a);
      var laneEl = document.getElementById(LANE_IDS[lane]); if (c.el.parentNode !== laneEl) laneEl.appendChild(c.el);
    });
    cards.forEach(function (c, id) { if (!visibleIds.has(id)) { if (c.el.parentNode) c.el.parentNode.removeChild(c.el); cards.delete(id); } });
    toggleEmpty('working'); toggleEmpty('done'); toggleEmpty('error');
    set('cWorking', counts.working); set('cDone', counts.done); set('cError', counts.error);
    set('sActive', counts.working); set('sDone', counts.done); set('sSteps', steps);
    if (visible.length > 0) set('foot', visible.length + ' agent(s) tracked this run.');
  }
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  function updateOne(a) {
    // simplest correct approach: reconcile all (cheap; card diff is in-place)
    syncAll();
  }

  // Not registered with the Store directly anymore: the combined 'detail' view
  // (see index.html) delegates to ViewCards for the professional lanes and to
  // ViewOffice for the scene, rendering both together in #viewDetail.
  window.ViewCards = {
    id: 'cards',
    el: document.getElementById('viewDetail'),
    activate: function () { syncAll(); },
    deactivate: function () {},
    reset: function () { syncAll(); },
    update: function (a) { updateOne(a); }
  };
})();
