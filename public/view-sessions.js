// Sessions board: machine-wide overview, one card per Claude Code session.
// Top-level view. Clicking a card focuses the terminal window/tab running that
// session (see focusCard below); a small "Details" affordance on the card drills
// into the Pro/Office subagent view for that session instead (see Store.selectSession).
(function () {
  var F = Store.fmt;
  var cards = new Map(); // session id -> refs

  var STATUS_RANK = { 'needs-permission': 0, working: 1, awaiting: 2, recent: 3, ended: 4 };
  var STATUS_LABEL = {
    working: 'Working', awaiting: 'Awaiting input', 'needs-permission': 'Needs permission',
    recent: 'Recent', ended: 'Ended'
  };
  var STATUS_DOT = {
    working: 'var(--working)', awaiting: 'var(--accent)', 'needs-permission': '#ffb43d',
    recent: 'var(--muted)', ended: '#5a6172'
  };

  // ---- Filters (persisted in localStorage; default to showing everything so
  // the board looks unchanged until the user narrows it) ----
  var FILTER_KEYS = { state: 'fleetFltState', time: 'fleetFltTime', repo: 'fleetFltRepo' };
  var filters = { state: 'all', time: 'all', repo: '' };
  function loadFilters() {
    try {
      filters.state = localStorage.getItem(FILTER_KEYS.state) || 'all';
      filters.time = localStorage.getItem(FILTER_KEYS.time) || 'all';
      filters.repo = localStorage.getItem(FILTER_KEYS.repo) || '';
    } catch (e) {}
  }
  function saveFilter(key, val) { try { localStorage.setItem(FILTER_KEYS[key], val); } catch (e) {} }
  loadFilters();

  // Active = connected right now, or in a state that is waiting on the user.
  // Everything else (ended, or an old backfilled "recent" that is not live) is
  // treated as closed/previous.
  function isActiveSession(s) {
    return s.live === true || s.status === 'working' || s.status === 'awaiting' || s.status === 'needs-permission';
  }
  function isToday(ts) {
    if (!ts) return false;
    var d = new Date(ts), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function passesFilters(s) {
    if (filters.state === 'active' && !isActiveSession(s)) return false;
    if (filters.state === 'closed' && isActiveSession(s)) return false;
    if (filters.time === 'today' && !isToday(s.lastActivityAt)) return false;
    if (filters.repo && (s.project || '') !== filters.repo) return false;
    return true;
  }

  // Rebuild the repo dropdown from the distinct projects currently tracked,
  // preserving the selection (falling back to All if that repo is gone).
  function populateRepoFilter() {
    var sel = document.getElementById('fltRepo');
    if (!sel) return;
    var projects = {};
    Store.sessions.forEach(function (s) { if (s.project) projects[s.project] = true; });
    var names = Object.keys(projects).sort(function (a, b) { return a.localeCompare(b); });
    sel.innerHTML = '';
    var all = document.createElement('option'); all.value = ''; all.textContent = 'All repos'; sel.appendChild(all);
    names.forEach(function (n) {
      var o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o);
    });
    if (filters.repo && names.indexOf(filters.repo) === -1) { filters.repo = ''; saveFilter('repo', ''); }
    sel.value = filters.repo;
  }

  function initFilters() {
    var st = document.getElementById('fltState');
    var tm = document.getElementById('fltTime');
    var rp = document.getElementById('fltRepo');
    if (!st || st._wired) return;
    st._wired = true;
    st.value = filters.state;
    tm.value = filters.time;
    st.addEventListener('change', function () { filters.state = st.value; saveFilter('state', st.value); syncAll(); });
    tm.addEventListener('change', function () { filters.time = tm.value; saveFilter('time', tm.value); syncAll(); });
    rp.addEventListener('change', function () { filters.repo = rp.value; saveFilter('repo', rp.value); syncAll(); });
  }

  function fmtRelative(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function sortedSessions() {
    var list = Array.from(Store.sessions.values()).filter(passesFilters);
    list.sort(function (a, b) {
      var ra = STATUS_RANK.hasOwnProperty(a.status) ? STATUS_RANK[a.status] : 5;
      var rb = STATUS_RANK.hasOwnProperty(b.status) ? STATUS_RANK[b.status] : 5;
      if (ra !== rb) return ra - rb;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });
    return list;
  }

  function createCard(s) {
    var el = document.createElement('div');
    el.className = 'session-card';
    el.setAttribute('data-id', s.id);
    el.title = 'Click to bring this session\'s terminal window to the front';
    el.innerHTML =
      '<button type="button" class="sc-details">Details</button>' +
      '<button type="button" class="sc-reopen">Reopen</button>' +
      '<div class="sc-top">' +
        '<span class="sc-dot"></span>' +
        '<div class="sc-heading"><span class="sc-project"></span><span class="sc-branch"></span></div>' +
        '<span class="sc-status"></span>' +
      '</div>' +
      '<div class="sc-prompt"></div>' +
      '<div class="sc-meta">' +
        '<span class="sc-time"></span>' +
        '<span class="sc-model"></span>' +
        '<span class="sc-badge" style="display:none"></span>' +
      '</div>';
    el.classList.add('enter');
    setTimeout(function () { el.classList.remove('enter'); }, 280);
    var c = {
      el: el,
      dot: el.querySelector('.sc-dot'),
      project: el.querySelector('.sc-project'),
      branch: el.querySelector('.sc-branch'),
      status: el.querySelector('.sc-status'),
      prompt: el.querySelector('.sc-prompt'),
      time: el.querySelector('.sc-time'),
      model: el.querySelector('.sc-model'),
      badge: el.querySelector('.sc-badge'),
      details: el.querySelector('.sc-details'),
      reopen: el.querySelector('.sc-reopen'),
      _status: null, _project: null, _branch: null, _prompt: null, _model: null, _badge: null,
      _id: s.id
    };
    el.addEventListener('click', function () { focusCard(c); });
    c.details.addEventListener('click', function (ev) {
      ev.stopPropagation();
      Store.selectSession(c._id);
    });
    c.reopen.addEventListener('click', function (ev) {
      ev.stopPropagation();
      reopenCard(c);
    });
    return c;
  }

  // One click on a card = bring the terminal window running that session to the
  // front. Two outcomes: `mode:'focused'` (a managed tab exists, directly bound
  // or lazily adopted by cwd, and is now on top) or `ok:false, mode:'unmanaged'`
  // (no tab to jump to, never a thrown error). focusSession() never spawns a
  // tab; the only way to open a new one is the explicit, confirm-gated Reopen
  // button (see reopenCard), which appears once a card is marked unmanaged.
  function focusCard(c) {
    c.el.classList.add('focusing');
    fetch('/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: c._id })
    }).then(function (res) { return res.json(); }).then(function (data) {
      c.el.classList.remove('focusing');
      if (data && data.mode === 'unmanaged') {
        c.el.classList.add('unmanaged');
        showToast('Terminal not managed by mission control.');
      } else if (!data || data.ok === false) {
        showToast('Could not focus that terminal.');
      } else {
        c.el.classList.remove('unmanaged');
      }
    }).catch(function () {
      c.el.classList.remove('focusing');
      showToast('Could not reach the server to focus that terminal.');
    });
  }

  // Explicit reattach, gated behind a confirm dialog: opens a brand new
  // terminal tab and resumes into it with `claude --resume`. Only reachable
  // from the Reopen button, which itself only shows up once a focus attempt
  // has come back unmanaged, so this never fires as a side effect of a
  // plain card click.
  function reopenCard(c) {
    if (!window.confirm('Open a new terminal tab for this session? Use this only if the old terminal window is gone.')) return;
    fetch('/reopen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: c._id })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (!data || data.ok === false) {
        showToast('Could not reopen that terminal.');
      } else {
        c.el.classList.remove('unmanaged');
      }
    }).catch(function () {
      showToast('Could not reach the server to reopen that terminal.');
    });
  }

  var toastEl = null;
  var toastTimer = null;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function applyCard(c, s) {
    if (c._status !== s.status) {
      c.el.classList.remove('status-working', 'status-awaiting', 'status-needs-permission', 'status-recent', 'status-ended');
      c.el.classList.add('status-' + s.status);
      c.dot.style.background = STATUS_DOT[s.status] || 'var(--muted)';
      c.status.textContent = STATUS_LABEL[s.status] || s.status;
      c._status = s.status;
    }
    var project = s.project || '(unknown project)';
    if (c._project !== project) { c.project.textContent = project; c._project = project; }
    var branch = s.branch || '';
    if (c._branch !== branch) { c.branch.textContent = branch; c._branch = branch; }
    var prompt = s.lastPrompt || s.title || '';
    if (c._prompt !== prompt) { c.prompt.textContent = prompt; c._prompt = prompt; }
    var model = s.model || '';
    if (c._model !== model) {
      c.model.textContent = model;
      c.model.classList.toggle('sc-model-empty', !model);
      c._model = model;
    }
    var badgeText = (s.subagentCount && s.subagentCount > 0) ? (s.subagentCount + ' subagent' + (s.subagentCount === 1 ? '' : 's')) : '';
    if (c._badge !== badgeText) {
      c.badge.textContent = badgeText;
      c.badge.style.display = badgeText ? '' : 'none';
      c._badge = badgeText;
    }
    c.time.textContent = fmtRelative(s.lastActivityAt);
    c.el.setAttribute('data-last-activity', s.lastActivityAt || '');
  }

  function syncAll() {
    var wrap = document.getElementById('sessionsWrap');
    if (!wrap) return;
    var list = sortedSessions();
    var seen = new Set();
    list.forEach(function (s) {
      seen.add(s.id);
      var c = cards.get(s.id);
      if (!c) { c = createCard(s); cards.set(s.id, c); }
      applyCard(c, s);
    });
    cards.forEach(function (c, id) { if (!seen.has(id)) { if (c.el.parentNode) c.el.parentNode.removeChild(c.el); cards.delete(id); } });
    // Reorder DOM to match sort order (only moves nodes that are out of place).
    var frag = document.createDocumentFragment();
    list.forEach(function (s) { frag.appendChild(cards.get(s.id).el); });
    wrap.appendChild(frag);
    var empty = document.getElementById('sessionsEmpty');
    if (empty) {
      if (list.length) {
        empty.style.display = 'none';
      } else {
        empty.style.display = '';
        empty.textContent = Store.sessions.size
          ? 'No sessions match the current filters.'
          : 'No sessions tracked yet. Start a Claude Code session and it will appear here.';
      }
    }
  }

  function loadRepos() {
    var select = document.getElementById('newSessionRepo');
    if (!select) return;
    fetch('/repos').then(function (res) { return res.json(); }).then(function (repos) {
      select.innerHTML = '';
      if (!repos || !repos.length) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No repos found';
        select.appendChild(opt);
        return;
      }
      repos.forEach(function (r) {
        var opt = document.createElement('option');
        opt.value = r.path;
        opt.textContent = r.name;
        select.appendChild(opt);
      });
    }).catch(function () {
      select.innerHTML = '';
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Failed to load repos';
      select.appendChild(opt);
    });
  }

  function launchSession() {
    var select = document.getElementById('newSessionRepo');
    var btn = document.getElementById('newSessionBtn');
    var feedback = document.getElementById('newSessionFeedback');
    if (!select || !select.value) return;
    var repoPath = select.value;
    var repoName = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : repoPath;
    btn.disabled = true;
    if (feedback) feedback.textContent = 'Launching ' + repoName + '...';
    fetch('/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoPath, title: repoName })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (feedback) feedback.textContent = (data && data.ok === false) ? 'Launch failed' : 'Launched ' + repoName;
      btn.disabled = false;
      setTimeout(function () { if (feedback) feedback.textContent = ''; }, 2500);
    }).catch(function () {
      if (feedback) feedback.textContent = 'Launch failed';
      btn.disabled = false;
      setTimeout(function () { if (feedback) feedback.textContent = ''; }, 2500);
    });
  }

  function initNewSessionBar() {
    var btn = document.getElementById('newSessionBtn');
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', launchSession);
  }

  function tick() {
    cards.forEach(function (c) {
      var raw = c.el.getAttribute('data-last-activity');
      if (!raw) return;
      c.time.textContent = fmtRelative(parseInt(raw, 10));
    });
  }
  Store.onTick(tick);

  window.ViewSessions = {
    id: 'sessions',
    el: document.getElementById('viewSessions'),
    activate: function () {
      initNewSessionBar();
      initFilters();
      loadRepos();
      populateRepoFilter();
      syncAll();
    },
    deactivate: function () {},
    reset: function () { populateRepoFilter(); syncAll(); },
    update: function () {},
    sessionsChanged: function () { if (Store.getActiveId() === 'sessions') { populateRepoFilter(); syncAll(); } }
  };
})();
