// Sessions board: machine-wide overview, one card per Claude Code session.
// Top-level view. Clicking a card focuses the terminal window/tab running that
// session (see focusCard below); a small "Details" affordance on the card drills
// into the Pro/Office subagent view for that session instead (see Store.selectSession).
(function () {
  var F = Store.fmt;
  var cards = new Map(); // session id -> refs

  var STATUS_RANK = { 'needs-permission': 0, working: 1, awaiting: 2, recent: 3, ended: 4 };
  // "awaiting" (the Stop hook: Claude finished its turn, nothing required)
  // reads as "Done - awaiting user", never "Awaiting input" - it is not
  // asking for anything. Only needs-permission is a real block on the user.
  var STATUS_LABEL = {
    working: 'Working', awaiting: 'Done - awaiting user', 'needs-permission': 'Needs permission',
    recent: 'Recent', ended: 'Ended'
  };

  // ---- Filters (fixed startup defaults, deliberately NOT persisted) ----
  // The board always opens scoped to today's active sessions, which is what the
  // "what is running right now" question needs. Narrowing or widening it during a
  // session works, it just does not carry over to the next app open.
  // `segment` refines the Active state only: 'all' (every active session),
  // 'needs-input' (blocked on the user, needs-permission) or 'done' (finished,
  // awaiting the user, informational). Meaningless for All/Closed.
  var filters = { state: 'active', time: 'today', repo: '', segment: 'all' };

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
  function isWithinDays(ts, days) {
    if (!ts) return false;
    return (Date.now() - ts) <= days * 24 * 60 * 60 * 1000;
  }
  // Shared by passesFilters and the segmented control's live counts, so a
  // segment's count always matches what selecting it would actually show.
  function matchesTimeRepo(s) {
    if (filters.time === 'today' && !isToday(s.lastActivityAt)) return false;
    if (filters.time === 'week' && !isWithinDays(s.lastActivityAt, 7)) return false;
    if (filters.repo && (s.project || '') !== filters.repo) return false;
    return true;
  }
  function passesFilters(s) {
    if (filters.state === 'active') {
      if (!isActiveSession(s)) return false;
      if (filters.segment === 'needs-input' && !Store.needsInput(s)) return false;
      if (filters.segment === 'done' && !Store.doneAwaiting(s)) return false;
    } else if (filters.state === 'closed') {
      if (isActiveSession(s)) return false;
    }
    return matchesTimeRepo(s);
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
    initSegmentedControl();
  }

  // Switch the Show filter (used by the attention pill and the done-awaiting
  // label: each jumps straight to Active plus a specific segment) and keep
  // the visible <select> in sync, not just the internal filters object. A
  // segment argument is optional so plain state switches (none currently, but
  // kept general) do not have to touch the segment choice.
  function setStateFilter(value, segment) {
    filters.state = value;
    var st = document.getElementById('fltState');
    if (st) st.value = value;
    if (segment) filters.segment = segment;
    syncAll();
  }

  // ---- Segmented "Active" sub-filter: All active / Needs input / Done -
  // awaiting user. A real slider (a thumb measured and positioned in JS,
  // since the three segments have very different natural widths) rather than
  // three buttons that merely recolour. Roving tabindex + arrow-key movement
  // (role="tablist"/"tab", aria-selected) for keyboard access. ----
  var SEGMENTS = ['all', 'needs-input', 'done'];
  function segEls() {
    var wrap = document.getElementById('segState');
    if (!wrap) return null;
    return {
      wrap: wrap,
      thumb: wrap.querySelector('.seg-thumb'),
      tabs: Array.prototype.slice.call(wrap.querySelectorAll('.seg-tab'))
    };
  }
  function setSegment(seg) {
    if (SEGMENTS.indexOf(seg) === -1) seg = 'all';
    filters.segment = seg;
    syncAll();
  }
  function positionSegThumb(e) {
    if (!e || !e.thumb) return;
    var active = e.tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0];
    if (!active) return;
    e.thumb.style.width = active.offsetWidth + 'px';
    e.thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
  function setSegCount(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(n)) el.textContent = n;
    el.classList.toggle('zero', n === 0);
  }
  // Counts reflect what selecting that segment would actually list: every
  // active session matching the current time/repo filters, partitioned by
  // needsInput/doneAwaiting. Kept in sync with passesFilters via
  // matchesTimeRepo so a segment's number never lies about its own list.
  function updateSegmentCounts() {
    var total = 0, needs = 0, done = 0;
    Store.sessions.forEach(function (s) {
      if (!isActiveSession(s) || !matchesTimeRepo(s)) return;
      total += 1;
      if (Store.needsInput(s)) needs += 1;
      if (Store.doneAwaiting(s)) done += 1;
    });
    setSegCount('segAllCount', total);
    setSegCount('segNeedsCount', needs);
    setSegCount('segDoneCount', done);
  }
  // Refreshes counts, visibility (shown only while Show=Active) and the
  // selected/thumb state together, since the thumb's position depends on the
  // just-updated count text changing each tab's rendered width.
  function refreshSegmentedControl() {
    var e = segEls();
    if (!e) return;
    updateSegmentCounts();
    var show = filters.state === 'active';
    e.wrap.style.display = show ? '' : 'none';
    e.tabs.forEach(function (tab) {
      var isSel = tab.getAttribute('data-segment') === filters.segment;
      tab.setAttribute('aria-selected', isSel ? 'true' : 'false');
      tab.tabIndex = isSel ? 0 : -1;
    });
    if (show) positionSegThumb(e);
  }
  function initSegmentedControl() {
    var e = segEls();
    if (!e || e.wrap._wired) return;
    e.wrap._wired = true;
    e.tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () { setSegment(tab.getAttribute('data-segment')); tab.focus(); });
      tab.addEventListener('keydown', function (ev) {
        var target = null;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') target = (idx + 1) % e.tabs.length;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') target = (idx - 1 + e.tabs.length) % e.tabs.length;
        else if (ev.key === 'Home') target = 0;
        else if (ev.key === 'End') target = e.tabs.length - 1;
        else return;
        ev.preventDefault();
        var next = e.tabs[target];
        setSegment(next.getAttribute('data-segment'));
        next.focus();
      });
    });
    window.addEventListener('resize', function () { if (filters.state === 'active') positionSegThumb(segEls()); });
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

  // Header stat tiles (board's slice): unlike the filtered board list, these
  // count every tracked session so the tiles answer "what's going on machine
  // wide", not "what's on screen right now". "needs input" reuses the exact
  // same predicate as the attention pill and the Needs input filter so all
  // three never drift apart. "oldest activity" is how long ago the LEAST
  // recently active tracked session was last active; a dash when there are no
  // sessions (or none with a timestamp) rather than a misleading '0:00'.
  function oldestActivityTs() {
    var oldest = null;
    Store.sessions.forEach(function (s) {
      if (s.lastActivityAt && (oldest === null || s.lastActivityAt < oldest)) oldest = s.lastActivityAt;
    });
    return oldest;
  }
  function updateStatTiles() {
    var total = Store.sessions.size;
    var needsInputN = 0, workingN = 0;
    Store.sessions.forEach(function (s) {
      if (Store.needsInput(s)) needsInputN += 1;
      if (s.status === 'working') workingN += 1;
    });
    var oldest = oldestActivityTs();
    Store.setStats([
      { n: total, l: 'sessions' },
      { n: needsInputN, l: 'needs input' },
      { n: workingN, l: 'working' },
      { n: oldest == null ? '-' : fmtRelative(oldest), l: 'oldest activity' }
    ]);
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

  // ---- Card (variant 05 "Editorial": status line, 18px title, mono
  // project/branch line, a context ring at the right of the header, the
  // prompt as a pull quote, and a footer row with mono meta on the left and
  // action buttons on the right. Nothing is absolutely positioned; nothing
  // overlaps.) ----
  function createCard(s) {
    var el = document.createElement('div');
    el.className = 'session-card';
    el.setAttribute('data-id', s.id);
    el.title = 'Click to bring this session\'s terminal window to the front';
    el.innerHTML =
      '<div class="sc-head">' +
        '<div class="sc-h">' +
          '<div class="sc-st"><span class="sc-pip"></span><span class="sc-st-label"></span></div>' +
          '<div class="sc-title"></div>' +
          '<div class="sc-where"></div>' +
        '</div>' +
        '<div class="sc-ring" style="display:none"><div><b></b><span>CTX</span></div></div>' +
      '</div>' +
      '<div class="sc-prompt"></div>' +
      '<div class="sc-foot">' +
        '<span class="sc-meta">' +
          '<b class="sc-model"></b><span class="sc-time"></span><b class="sc-badge" style="display:none"></b>' +
        '</span>' +
        '<span class="sc-acts">' +
          '<button type="button" class="sc-details">Details</button>' +
          '<button type="button" class="sc-resume prim" style="display:none">Resume</button>' +
          '<button type="button" class="sc-reopen">Reopen</button>' +
        '</span>' +
      '</div>';
    el.classList.add('enter');
    setTimeout(function () { el.classList.remove('enter'); }, 280);
    var c = {
      el: el,
      stLabel: el.querySelector('.sc-st-label'),
      title: el.querySelector('.sc-title'),
      where: el.querySelector('.sc-where'),
      ring: el.querySelector('.sc-ring'),
      ringPct: el.querySelector('.sc-ring b'),
      prompt: el.querySelector('.sc-prompt'),
      time: el.querySelector('.sc-time'),
      model: el.querySelector('.sc-model'),
      badge: el.querySelector('.sc-badge'),
      details: el.querySelector('.sc-details'),
      resume: el.querySelector('.sc-resume'),
      reopen: el.querySelector('.sc-reopen'),
      _status: null, _isActive: null, _title: null, _where: null, _prompt: null,
      _model: null, _badge: null, _ctxPct: undefined, _ctxSev: null, _closed: null,
      _id: s.id
    };
    el.addEventListener('click', function () { focusCard(c); });
    c.details.addEventListener('click', function (ev) {
      ev.stopPropagation();
      Store.selectSession(c._id);
    });
    c.resume.addEventListener('click', function (ev) {
      ev.stopPropagation();
      resumeCard(c);
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

  // Shared reattach call: opens a brand new terminal tab and resumes into it
  // with `claude --resume`. Reopen gates this behind a confirm dialog (it is
  // only reachable once an active session's focus attempt has come back
  // unmanaged); Resume does not (resuming a CLOSED session is the intended
  // action, there is no duplicate-tab risk since nothing else could be open).
  function doReopen(c) {
    return fetch('/reopen', {
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
  function reopenCard(c) {
    if (!window.confirm('Open a new terminal tab for this session? Use this only if the old terminal window is gone.')) return;
    doReopen(c);
  }
  function resumeCard(c) { doReopen(c); }

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
      c.stLabel.textContent = STATUS_LABEL[s.status] || s.status;
      c._status = s.status;
    }
    var isActive = isActiveSession(s);
    if (c._isActive !== isActive) {
      c.el.classList.toggle('is-active', isActive);
      c._isActive = isActive;
    }
    // Heading: the session's name if it has one (claude --name, or picked up
    // from the session registry), else the project.
    var named = !!s.title;
    var title = s.title || s.project || '(unknown project)';
    if (c._title !== title) { c.title.textContent = title; c._title = title; }
    // The line underneath never repeats the heading: an unnamed card is
    // already titled with its project, so it shows the branch alone. Only a
    // named card needs the project spelled out again.
    var project = s.project || '(unknown project)';
    var where;
    if (named) {
      where = s.branch ? (project + ' / ' + s.branch) : project;
    } else {
      where = s.branch || '';
    }
    if (c._where !== where) { c.where.textContent = where; c._where = where; }
    var prompt = s.lastPrompt || '';
    if (c._prompt !== prompt) { c.prompt.textContent = prompt; c._prompt = prompt; }
    var model = F.model(s);
    if (c._model !== model) {
      c.model.textContent = model;
      c.model.style.display = model ? '' : 'none';
      c._model = model;
    }
    var badgeText = (s.subagentCount && s.subagentCount > 0) ? (s.subagentCount + ' subagent' + (s.subagentCount === 1 ? '' : 's')) : '';
    if (c._badge !== badgeText) {
      c.badge.textContent = badgeText;
      c.badge.style.display = badgeText ? '' : 'none';
      c._badge = badgeText;
    }
    // Context ring: hidden entirely when null. Severity ramp (under 60 accent,
    // 60-85 amber, 85+ red) is a class on the CARD itself (.lo/.mid/.hi), so
    // the ring's conic-gradient can read --sev by inheritance.
    var ctxPct = (s.ctxPct == null) ? null : Math.max(0, Math.min(100, Math.round(s.ctxPct)));
    if (c._ctxPct !== ctxPct) {
      if (ctxPct == null) {
        c.ring.style.display = 'none';
        if (c._ctxSev) { c.el.classList.remove(c._ctxSev); c._ctxSev = null; }
      } else {
        c.ring.style.display = '';
        c.ring.style.setProperty('--pct', ctxPct);
        c.ringPct.textContent = ctxPct;
        var sev = ctxPct >= 85 ? 'hi' : ctxPct >= 60 ? 'mid' : 'lo';
        if (c._ctxSev !== sev) {
          if (c._ctxSev) c.el.classList.remove(c._ctxSev);
          c.el.classList.add(sev);
          c._ctxSev = sev;
        }
      }
      c._ctxPct = ctxPct;
    }
    // Actions: Details always, Resume when closed, Reopen (CSS-driven via
    // .unmanaged.is-active) only while active and unmanaged.
    var closed = !isActive;
    if (c._closed !== closed) {
      c.resume.style.display = closed ? '' : 'none';
      c._closed = closed;
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
    updateStatTiles();
    refreshSegmentedControl();
  }

  // Cascading New session picker, now hosted inside a popup dialog instead of
  // a top-of-board bar. /repos returns { root, tree } where tree is a bounded
  // folder tree; each dropdown lists one folder level. Choosing a folder that
  // has subfolders spawns the next dropdown (up to MAX_SELECTORS), each starting
  // on "Not selected" unless DEFAULT_REPO_CHAIN preselects it. New session
  // launches in the deepest folder actually selected, or the repos root if
  // nothing is selected.
  var MAX_SELECTORS = 5;
  // Folder NAMES (not paths) preselected on every app open, since nearly every session
  // starts under this folder. Matched case-insensitively level by level; a rename, a
  // reorganised repos folder, or a different machine simply falls back to "Not selected".
  var DEFAULT_REPO_CHAIN = ['2-ZRM', 'customers'];
  var repoRoot = '';
  var repoTree = [];
  // GitHub account picker (see GH_ACCOUNTS in terminal.mjs). Populated from
  // /repos's `accounts` field: [{ key, label, login, matchPath, isDefault }],
  // never the config dir. `accountManualOverride` is set the moment the user
  // touches the dropdown themselves, so a later folder-chain change never
  // stomps a deliberate choice; it resets to auto-follow every time the popup
  // is reopened.
  var accounts = [];
  var accountManualOverride = false;
  function oneOption(value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; return o; }
  function baseName(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function selectorsEl() { return document.getElementById('newSessionSelectors'); }

  // Mirrors terminal.mjs's defaultAccountForPath: a path SEGMENT match
  // (bounded by / or \, case-insensitive), never a bare substring, so a repo
  // literally named 'my-2-ZRMish' does not match a '2-ZRM' rule. The rule
  // itself is read from the `accounts` data (matchPath), never hardcoded here.
  function pathHasSegment(p, segment) {
    if (!p || !segment) return false;
    var parts = String(p).replace(/\\/g, '/').split('/').filter(function (x) { return x; });
    var want = String(segment).toLowerCase();
    for (var i = 0; i < parts.length; i++) { if (parts[i].toLowerCase() === want) return true; }
    return false;
  }
  function pickAutoAccount(p) {
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].matchPath && pathHasSegment(p, accounts[i].matchPath)) return accounts[i];
    }
    for (var j = 0; j < accounts.length; j++) { if (accounts[j].isDefault) return accounts[j]; }
    return accounts[0] || null;
  }
  // Renders the account <select> from `accounts`, preserving the current
  // selection when it is still a valid key (so a later refresh does not
  // silently reset a choice already made).
  function populateAccountSelect() {
    var sel = document.getElementById('newSessionAccount');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    if (!accounts.length) {
      // No account list from the server: an old backend answering behind a
      // newer frontend (the exact bug hit on 2026-07-30 - an installed app's
      // updater left the old backend running while the new UI shipped, so
      // GET /repos came back with no accounts field at all), or genuinely no
      // accounts configured. A blank, focused select with zero options gives
      // the user nothing to act on and looks broken; a disabled placeholder
      // at least says what happened, matching the folder picker's own
      // "No repos found" / "Failed to load repos" pattern so the two read as
      // one system.
      var none = oneOption('', 'No accounts available');
      none.disabled = true;
      sel.appendChild(none);
      return;
    }
    accounts.forEach(function (a) {
      var o = document.createElement('option'); o.value = a.key; o.textContent = a.label; sel.appendChild(o);
    });
    if (prev && accounts.some(function (a) { return a.key === prev; })) sel.value = prev;
  }
  // Auto-select follows the folder chain unless the user has manually
  // overridden the dropdown this popup session.
  function autoSelectAccountForPath(p) {
    if (accountManualOverride) return;
    var sel = document.getElementById('newSessionAccount');
    if (!sel || !accounts.length) return;
    var acc = pickAutoAccount(p);
    if (acc) sel.value = acc.key;
  }

  // Keeps the popup footer's path readout in sync with whatever the chain
  // currently resolves to (mirrors the design specimen's .pop-foot .path).
  function updateLaunchPath() {
    var el = document.getElementById('newSessionPath');
    if (!el) return;
    el.textContent = currentLaunchPath() || repoRoot || '';
  }

  function makeSelect(nodes) {
    var sel = document.createElement('select');
    sel.className = 'sel';
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
    updateLaunchPath();
    autoSelectAccountForPath(currentLaunchPath());
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
      var s = document.createElement('select'); s.className = 'sel'; s.disabled = true;
      s.appendChild(oneOption('', 'No repos found'));
      host.appendChild(s);
      updateLaunchPath();
      autoSelectAccountForPath(currentLaunchPath());
      return;
    }
    host.appendChild(makeSelect(repoTree));
    applyDefaultChain();
    updateLaunchPath();
    autoSelectAccountForPath(currentLaunchPath());
  }
  function loadRepos() {
    var host = selectorsEl();
    if (!host) return;
    // Fetched lazily on first popup open (see openNewSessionPopup), not from
    // activate(): once the tree is loaded and a real chain is on screen,
    // refetching would only wipe whatever the user just picked.
    if (repoTree.length && host.children.length && !host.children[0].disabled) {
      populateAccountSelect();
      autoSelectAccountForPath(currentLaunchPath());
      return;
    }
    fetch('/repos').then(function (res) { return res.json(); }).then(function (data) {
      repoRoot = (data && data.root) || '';
      repoTree = (data && data.tree) || [];
      accounts = (data && data.accounts) || [];
      populateAccountSelect();
      renderSelectors();
    }).catch(function () {
      var host = selectorsEl();
      if (host) { host.innerHTML = ''; var s = document.createElement('select'); s.className = 'sel'; s.disabled = true; s.appendChild(oneOption('', 'Failed to load repos')); host.appendChild(s); }
      updateLaunchPath();
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
    var accSel = document.getElementById('newSessionAccount');
    var repoPath = currentLaunchPath();
    if (!repoPath) return;
    var repoName = baseName(repoPath);
    // An entered name becomes the session's display name (claude --name) AND the
    // terminal tab title, so the tab, the Claude prompt box and the card all agree.
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    var label = name || repoName;
    var accountKey = accSel ? accSel.value : '';
    // When there is no real account selected (the "No accounts available"
    // placeholder, or no picker at all), omit the `account` key entirely
    // rather than sending an empty string, so the server's own default
    // resolution (terminal.mjs defaultAccountForPath) decides. A missing
    // account list must never block launching.
    var body = { repo: repoPath, title: label, name: name };
    if (accountKey) body.account = accountKey;
    btn.disabled = true;
    if (feedback) feedback.textContent = 'Launching ' + label + '...';
    fetch('/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) { return res.json(); }).then(function (data) {
      var failed = data && data.ok === false;
      if (feedback) {
        feedback.textContent = failed
          ? 'Launch failed'
          : 'Launched ' + label + (data && data.account ? (' as ' + data.account) : '');
      }
      if (!failed) {
        if (nameEl) nameEl.value = '';
        // A successful launch closes the popup; a failed one leaves it open
        // (with the repo/name still filled in) so the developer can retry.
        closeNewSessionPopup();
      }
      btn.disabled = false;
      setTimeout(function () { if (feedback) feedback.textContent = ''; }, 2500);
    }).catch(function () {
      if (feedback) feedback.textContent = 'Launch failed';
      btn.disabled = false;
      setTimeout(function () { if (feedback) feedback.textContent = ''; }, 2500);
    });
  }

  // ---- New session popup chrome (Esc closes, backdrop click closes, focus
  // moves to Name on open and back to the opener button on close). The popup
  // markup lives outside #viewSessions in index.html (a fixed backdrop), so
  // this wiring runs once at load, independent of the sessions view's own
  // activate/deactivate lifecycle. ----
  function openNewSessionPopup() {
    var backdrop = document.getElementById('newSessionBackdrop');
    if (!backdrop) return;
    backdrop.style.display = 'flex';
    // Reopening the popup always resets to auto-follow: a manual override
    // only lasts for the popup session it was made in.
    accountManualOverride = false;
    loadRepos();
    updateLaunchPath();
    autoSelectAccountForPath(currentLaunchPath());
    var nameEl = document.getElementById('newSessionName');
    if (nameEl) nameEl.focus();
    document.addEventListener('keydown', onPopupKeydown);
  }
  function closeNewSessionPopup() {
    var backdrop = document.getElementById('newSessionBackdrop');
    if (backdrop) backdrop.style.display = 'none';
    document.removeEventListener('keydown', onPopupKeydown);
    var openBtn = document.getElementById('newSessionOpenBtn');
    if (openBtn) openBtn.focus();
  }
  function onPopupKeydown(e) { if (e.key === 'Escape') closeNewSessionPopup(); }

  function initNewSessionPopup() {
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
    var accSel = document.getElementById('newSessionAccount');
    if (accSel) accSel.addEventListener('change', function () { accountManualOverride = true; });
    var cancelBtn = document.getElementById('newSessionCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeNewSessionPopup);
    var backdrop = document.getElementById('newSessionBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeNewSessionPopup(); });
    }
  }

  // ---- Top-bar usage meters (5h / 7d quota). Lives in the header, so it is
  // rendered independent of which view is active; wired once at load. ----
  var usageRefs = null;
  var STALE_MS = 5 * 60 * 1000;
  function sevClass(pct) { return pct >= 85 ? 'hi' : pct >= 60 ? 'mid' : 'lo'; }
  function fmtClock(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var hh = d.getHours(), mm = d.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function ensureUsageDom() {
    if (usageRefs) return usageRefs;
    var host = document.getElementById('usageMeters');
    if (!host) return null;
    host.innerHTML =
      '<div class="g" id="meterFive" style="display:none"><span class="ring"><i></i></span><span class="lb">5 hour<em></em></span></div>' +
      '<div class="g" id="meterSeven" style="display:none"><span class="ring"><i></i></span><span class="lb">7 day<em></em></span></div>';
    usageRefs = {
      host: host,
      five: { wrap: document.getElementById('meterFive'), ring: host.querySelector('#meterFive .ring'), val: host.querySelector('#meterFive i'), note: host.querySelector('#meterFive em'), _sev: null, _pct: undefined, _note: null },
      seven: { wrap: document.getElementById('meterSeven'), ring: host.querySelector('#meterSeven .ring'), val: host.querySelector('#meterSeven i'), note: host.querySelector('#meterSeven em'), _sev: null, _pct: undefined, _note: null }
    };
    return usageRefs;
  }
  function renderUsageWindow(ref, data, stale, freshNote, ageText) {
    if (!data || data.pct == null) {
      if (ref.wrap.style.display !== 'none') ref.wrap.style.display = 'none';
      ref._sev = null; ref._pct = undefined; ref._note = null;
      return;
    }
    if (ref.wrap.style.display === 'none') ref.wrap.style.display = '';
    var pct = Math.max(0, Math.min(100, Math.round(data.pct)));
    var sev = sevClass(pct);
    if (ref._sev !== sev) {
      if (ref._sev) ref.wrap.classList.remove(ref._sev);
      ref.wrap.classList.add(sev);
      ref._sev = sev;
    }
    if (ref._pct !== pct) {
      ref.ring.style.setProperty('--pct', pct);
      ref.val.textContent = pct;
      ref._pct = pct;
    }
    var note = stale ? (ageText || 'stale') : (freshNote || '');
    if (ref._note !== note) { ref.note.textContent = note; ref._note = note; }
  }
  function updateUsageMeters() {
    var refs = ensureUsageDom();
    if (!refs) return;
    var usage = Store.usage;
    if (!usage) {
      refs.five.wrap.style.display = 'none';
      refs.seven.wrap.style.display = 'none';
      refs.host.classList.remove('stale');
      return;
    }
    // The feed only updates while some session renders its statusline, so a
    // reading older than 5 minutes is dimmed and shown as an age rather than
    // implied to be current.
    var stale = !!(usage.at && (Date.now() - usage.at) > STALE_MS);
    refs.host.classList.toggle('stale', stale);
    var ageText = usage.at ? fmtRelative(usage.at) : '';
    var fiveNote = (usage.fiveHour && usage.fiveHour.resetsAt) ? ('resets ' + fmtClock(usage.fiveHour.resetsAt)) : '';
    renderUsageWindow(refs.five, usage.fiveHour, stale, fiveNote, ageText);
    renderUsageWindow(refs.seven, usage.sevenDay, stale, 'rolling', ageText);
  }

  function tick() {
    cards.forEach(function (c) {
      var raw = c.el.getAttribute('data-last-activity');
      if (!raw) return;
      c.time.textContent = fmtRelative(parseInt(raw, 10));
    });
    // The "oldest activity" tile ages every second same as the card timestamps
    // above; only worth recomputing while the board is actually on screen.
    if (Store.getActiveId() === 'sessions') updateStatTiles();
  }
  Store.onTick(tick);
  Store.onTick(updateUsageMeters);
  Store.onUsage(updateUsageMeters);
  initNewSessionPopup();

  window.ViewSessions = {
    id: 'sessions',
    el: document.getElementById('viewSessions'),
    activate: function () {
      initFilters();
      populateRepoFilter();
      syncAll();
    },
    deactivate: function () {},
    reset: function () { populateRepoFilter(); syncAll(); },
    update: function () {},
    sessionsChanged: function () { if (Store.getActiveId() === 'sessions') { populateRepoFilter(); syncAll(); } },
    setStateFilter: setStateFilter,
    openNewSession: openNewSessionPopup
  };
})();
