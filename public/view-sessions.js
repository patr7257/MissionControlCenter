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

  // ---- Filters (fixed startup defaults, deliberately NOT persisted) ----
  // The board always opens scoped to today's active sessions, which is what the
  // "what is running right now" question needs. Narrowing or widening it during a
  // session works, it just does not carry over to the next app open.
  var filters = { state: 'active', time: 'today', repo: '' };

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
  // preserving the current selection (falling back to All if that repo is gone).
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
    if (filters.repo && names.indexOf(filters.repo) === -1) { filters.repo = ''; }
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
    st.addEventListener('change', function () { filters.state = st.value; syncAll(); });
    tm.addEventListener('change', function () { filters.time = tm.value; syncAll(); });
    rp.addEventListener('change', function () { filters.repo = rp.value; syncAll(); });
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
        '<div class="sc-heading"><span class="sc-name"></span><span class="sc-project"></span><span class="sc-branch"></span></div>' +
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
      name: el.querySelector('.sc-name'),
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
    // A named session (launched from here with a name, see claude --name) leads with
    // that name and demotes the project to the secondary line; unnamed cards look
    // exactly as they always did.
    var name = s.title || '';
    if (c._name !== name) {
      c.name.textContent = name;
      c.name.style.display = name ? '' : 'none';
      c.el.classList.toggle('has-name', !!name);
      c._name = name;
    }
    var project = s.project || '(unknown project)';
    if (c._project !== project) { c.project.textContent = project; c._project = project; }
    var branch = s.branch || '';
    if (c._branch !== branch) { c.branch.textContent = branch; c._branch = branch; }
    var prompt = s.lastPrompt || '';
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

  // Cascading New session picker. /repos returns { root, tree } where tree is a
  // bounded folder tree; each dropdown lists one folder level. Choosing a folder that
  // has subfolders spawns the next dropdown (up to MAX_SELECTORS), each starting on
  // "Not selected" unless DEFAULT_REPO_CHAIN preselects it. New session launches in the
  // deepest folder actually selected, or the repos root if nothing is selected.
  var MAX_SELECTORS = 5;
  // Folder NAMES (not paths) preselected on every app open, since nearly every session
  // starts under this folder. Matched case-insensitively level by level; a rename, a
  // reorganised repos folder, or a different machine simply falls back to "Not selected".
  var DEFAULT_REPO_CHAIN = ['2-ZRM', 'customers'];
  var repoRoot = '';
  var repoTree = [];
  function oneOption(value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; return o; }
  function baseName(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function selectorsEl() { return document.getElementById('newSessionSelectors'); }

  function makeSelect(nodes) {
    var sel = document.createElement('select');
    sel.className = 'ns-select';
    sel.appendChild(oneOption('', 'Not selected'));
    nodes.forEach(function (n) { sel.appendChild(oneOption(n.path, n.name)); });
    sel._nodes = nodes;
    sel.addEventListener('change', function () { onSelectorChange(sel); });
    return sel;
  }
  function onSelectorChange(sel) {
    var host = selectorsEl();
    if (!host) return;
    // Drop every dropdown to the right of the one that changed.
    while (sel.nextSibling) host.removeChild(sel.nextSibling);
    var node = sel.selectedIndex > 0 ? sel._nodes[sel.selectedIndex - 1] : null;
    if (node && node.children && node.children.length && host.children.length < MAX_SELECTORS) {
      host.appendChild(makeSelect(node.children));
    }
  }
  // Walk DEFAULT_REPO_CHAIN, selecting one level per name and letting the normal
  // change handler spawn the next dropdown, so the preselected chain is identical to
  // one the user clicked together by hand. A name that is not on disk stops the walk.
  function applyDefaultChain() {
    var host = selectorsEl();
    if (!host) return;
    for (var i = 0; i < DEFAULT_REPO_CHAIN.length; i++) {
      var sel = host.children[host.children.length - 1];
      if (!sel || !sel._nodes) return;
      var want = String(DEFAULT_REPO_CHAIN[i]).toLowerCase();
      var node = null;
      for (var j = 0; j < sel._nodes.length; j++) {
        if (String(sel._nodes[j].name).toLowerCase() === want) { node = sel._nodes[j]; break; }
      }
      if (!node) return;
      sel.value = node.path;
      onSelectorChange(sel);
    }
  }
  function renderSelectors() {
    var host = selectorsEl();
    if (!host) return;
    host.innerHTML = '';
    if (!repoTree.length) {
      var s = document.createElement('select'); s.className = 'ns-select'; s.disabled = true;
      s.appendChild(oneOption('', 'No repos found'));
      host.appendChild(s);
      return;
    }
    host.appendChild(makeSelect(repoTree));
    applyDefaultChain();
  }
  function loadRepos() {
    var host = selectorsEl();
    if (!host) return;
    // activate() runs on every return to the board (drilling out of a session's
    // Details included). Once the tree is loaded and a real chain is on screen,
    // refetching would only wipe whatever the user just picked.
    if (repoTree.length && host.children.length && !host.children[0].disabled) return;
    fetch('/repos').then(function (res) { return res.json(); }).then(function (data) {
      repoRoot = (data && data.root) || '';
      repoTree = (data && data.tree) || [];
      renderSelectors();
    }).catch(function () {
      var host = selectorsEl();
      if (host) { host.innerHTML = ''; var s = document.createElement('select'); s.className = 'ns-select'; s.disabled = true; s.appendChild(oneOption('', 'Failed to load repos')); host.appendChild(s); }
    });
  }

  // The launch folder is the deepest dropdown with a real selection, or the root.
  function currentLaunchPath() {
    var host = selectorsEl();
    if (!host) return repoRoot;
    var path = repoRoot;
    for (var i = 0; i < host.children.length; i++) { if (host.children[i].value) path = host.children[i].value; }
    return path;
  }

  function launchSession() {
    var btn = document.getElementById('newSessionBtn');
    var feedback = document.getElementById('newSessionFeedback');
    var nameEl = document.getElementById('newSessionName');
    var repoPath = currentLaunchPath();
    if (!repoPath) return;
    var repoName = baseName(repoPath);
    // An entered name becomes the session's display name (claude --name) AND the
    // terminal tab title, so the tab, the Claude prompt box and the card all agree.
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    var label = name || repoName;
    btn.disabled = true;
    if (feedback) feedback.textContent = 'Launching ' + label + '...';
    fetch('/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoPath, title: label, name: name })
    }).then(function (res) { return res.json(); }).then(function (data) {
      var failed = data && data.ok === false;
      if (feedback) feedback.textContent = failed ? 'Launch failed' : 'Launched ' + label;
      if (!failed && nameEl) nameEl.value = '';
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
    var nameEl = document.getElementById('newSessionName');
    if (nameEl) {
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !btn.disabled) launchSession();
      });
    }
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
