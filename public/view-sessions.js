// Sessions board: machine-wide overview, one card per Claude Code session.
// Top-level view. Clicking a card drills into the Pro/Office detail filtered
// to that session (see Store.selectSession).
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
    var list = Array.from(Store.sessions.values());
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
    el.innerHTML =
      '<button type="button" class="sc-open">Open</button>' +
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
    el.addEventListener('click', function () { Store.selectSession(s.id); });
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
      open: el.querySelector('.sc-open'),
      _status: null, _project: null, _branch: null, _prompt: null, _model: null, _badge: null,
      _id: s.id
    };
    c.open.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openSession(c);
    });
    return c;
  }

  function openSession(c) {
    var open = c.open;
    var prevText = open.textContent;
    open.disabled = true;
    open.textContent = '...';
    fetch('/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: c._id })
    }).then(function (res) { return res.json(); }).then(function (data) {
      open.textContent = data && data.mode ? data.mode : 'failed';
      setTimeout(function () { open.disabled = false; open.textContent = prevText; }, 1400);
    }).catch(function () {
      open.textContent = 'failed';
      setTimeout(function () { open.disabled = false; open.textContent = prevText; }, 1400);
    });
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
    if (c._model !== model) { c.model.textContent = model; c._model = model; }
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
    if (empty) empty.style.display = list.length ? 'none' : '';
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
      loadRepos();
      syncAll();
    },
    deactivate: function () {},
    reset: function () { syncAll(); },
    update: function () {},
    sessionsChanged: function () { if (Store.getActiveId() === 'sessions') syncAll(); }
  };
})();
