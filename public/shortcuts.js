// Keyboard and mouse shortcuts, the app's own back/forward history, and the
// Settings popup that documents them.
//
// ONE registry (BINDINGS below) is the single source of truth: the key handler
// matches against it and the guide in Settings is rendered from it, so a binding
// can never drift from its documentation. Adding a shortcut means adding one
// entry.
//
// Everything here drives the REAL buttons (`statsBtn.click()` and friends) rather
// than re-implementing their open/close and focus behaviour. That keeps one owner
// per popup and means a shortcut cannot get out of step with a click.
//
// Zero dependencies, plain browser JS, same as the rest of public/.
(function () {
  // ---- Settings persistence. Deliberately different from the board's Show
  // filters, which are FIXED at startup on purpose (a stale stored filter used to
  // silently override the default, see CLAUDE.md). A setting the developer
  // explicitly toggled is exactly the thing that SHOULD survive a restart. ----
  var SETTINGS_KEY = 'cmcSettings';
  var defaults = { mouseNav: true };
  var settings = load();

  function load() {
    var out = { mouseNav: defaults.mouseNav };
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.mouseNav === 'boolean') out.mouseNav = parsed.mouseNav;
      }
    } catch (e) {
      // unreadable or disabled storage: defaults are fine
    }
    return out;
  }
  function save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  // ---- App history. Entries are { view: 'sessions' } or { view: 'detail', id }.
  // Store notifies us on every real navigation (see Store.onNav); back/forward
  // replay an entry through the same public API with the notification muted, so
  // the breadcrumb and the views stay in step. ----
  var history = [{ view: 'sessions' }];
  var index = 0;
  var MAX_HISTORY = 100;

  function sameState(a, b) {
    if (!a || !b) return false;
    return a.view === b.view && (a.id || null) === (b.id || null);
  }

  function record(state) {
    if (sameState(history[index], state)) return;
    // A new navigation after going back drops the forward tail, same as a browser.
    history = history.slice(0, index + 1);
    history.push(state);
    if (history.length > MAX_HISTORY) history.shift();
    index = history.length - 1;
  }

  function apply(state) {
    Store.setNavQuiet(true);
    try {
      // A session can end and be pruned while it sits in the history. Falling
      // back to the board beats activating the detail view with nothing in it.
      if (state.view === 'detail' && state.id && Store.sessions.has(state.id)) {
        Store.selectSession(state.id);
      } else {
        Store.clearSession();
      }
    } finally {
      Store.setNavQuiet(false);
    }
  }

  function canBack() { return index > 0; }
  function canForward() { return index < history.length - 1; }
  function back() {
    if (!canBack()) return false;
    index -= 1;
    apply(history[index]);
    return true;
  }
  function forward() {
    if (!canForward()) return false;
    index += 1;
    apply(history[index]);
    return true;
  }

  // ---- Small helpers the bindings act through ----
  function clickById(id) {
    var el = document.getElementById(id);
    if (el) el.click();
    return !!el;
  }
  function anyDialogOpen() {
    var backdrops = document.querySelectorAll('.pop-backdrop');
    for (var i = 0; i < backdrops.length; i++) {
      if (getComputedStyle(backdrops[i]).display !== 'none') return true;
    }
    return false;
  }
  function inDetail() { return Store.getActiveId() === 'detail'; }
  // Jump to the board with one of the three Active segments preselected, exactly
  // as the attention pill and the done-awaiting label do.
  function segment(seg) {
    Store.clearSession();
    if (window.ViewSessions && ViewSessions.setStateFilter) ViewSessions.setStateFilter('active', seg);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- THE REGISTRY. `combos` is display only: a list of ALTERNATIVES, each a
  // list of keys pressed together, so the guide can render "Mouse back or Alt+←"
  // without guessing where a "+" belongs from position. `match` is what actually
  // decides. Order matters only for the guide's reading order. ----
  var BINDINGS = [
    {
      group: 'Navigate',
      combos: [['Mouse back'], ['Alt', '←']],
      label: 'Back: leave a session, or undo a jump',
      match: function (e) { return e.altKey && e.key === 'ArrowLeft'; },
      run: function () { back(); }
    },
    {
      group: 'Navigate',
      combos: [['Mouse forward'], ['Alt', '→']],
      label: 'Forward: redo the jump you came from',
      match: function (e) { return e.altKey && e.key === 'ArrowRight'; },
      run: function () { forward(); }
    },
    {
      group: 'Navigate',
      combos: [['Esc']],
      label: 'Close a dialog, else leave a session',
      // Only the "leave a session" half is ours: each dialog keeps its own Esc
      // handler, and the global handler stands down while one is open.
      match: function (e) { return e.key === 'Escape'; },
      run: function () { if (inDetail()) back(); }
    },
    {
      group: 'Navigate',
      combos: [['Tab'], ['Shift', 'Tab']],
      label: 'Move focus. Enter opens a card\'s terminal',
      match: function () { return false; },
      run: function () {}
    },
    {
      group: 'Board',
      combos: [['N']],
      label: 'New session',
      match: function (e) { return e.key === 'n' || e.key === 'N'; },
      run: function () { clickById('newSessionOpenBtn'); }
    },
    {
      group: 'Board',
      combos: [['S']],
      label: 'Stats dashboard',
      match: function (e) { return e.key === 's' || e.key === 'S'; },
      run: function () { clickById('statsBtn'); }
    },
    {
      group: 'Board',
      combos: [['1']],
      label: 'Show all active sessions',
      match: function (e) { return e.key === '1'; },
      run: function () { segment('all'); }
    },
    {
      group: 'Board',
      combos: [['2']],
      label: 'Show sessions needing input',
      match: function (e) { return e.key === '2'; },
      run: function () { segment('needs-input'); }
    },
    {
      group: 'Board',
      combos: [['3']],
      label: 'Show finished sessions awaiting you',
      match: function (e) { return e.key === '3'; },
      run: function () { segment('done'); }
    },
    {
      group: 'App',
      combos: [[',']],
      label: 'Settings',
      match: function (e) { return e.key === ','; },
      run: function () { clickById('settingsBtn'); }
    },
    {
      group: 'App',
      combos: [['?'], ['F1']],
      label: 'This shortcuts guide',
      match: function (e) { return e.key === '?' || e.key === 'F1'; },
      run: function () { openSettings(); }
    }
  ];

  function onKeydown(e) {
    // Never steal a keystroke from a text field, and never fight the browser's
    // own Ctrl/Cmd shortcuts.
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey) return;
    // While a dialog is open it owns the keyboard: it has its own Esc handler and
    // a bare letter must not open a second popup behind it.
    if (anyDialogOpen()) return;
    for (var i = 0; i < BINDINGS.length; i++) {
      if (BINDINGS[i].match(e)) {
        e.preventDefault();
        BINDINGS[i].run();
        return;
      }
    }
  }

  // ---- Mouse side buttons. Two delivery paths:
  //  - Packaged app: Windows sends WM_APPCOMMAND, Electron raises `app-command`
  //    in the main process, which forwards it over the preload bridge
  //    (window.cmcNav). The renderer never sees a mouse event for these buttons.
  //  - Plain browser at localhost: buttons 3 and 4 arrive as pointer events.
  // Both end up here. `mouseNav` in Settings gates them. ----
  function onAux(e) {
    if (!settings.mouseNav) return;
    if (e.button === 3) { e.preventDefault(); back(); }
    else if (e.button === 4) { e.preventDefault(); forward(); }
  }

  // ---- Settings popup. Same .pop* chrome as New session and the confirm, so
  // visibility lives on the BACKDROP, never the panel. ----
  function renderGuide() {
    var host = document.getElementById('settingsShortcuts');
    if (!host) return;
    host.innerHTML = '';
    var groups = [];
    BINDINGS.forEach(function (b) { if (groups.indexOf(b.group) === -1) groups.push(b.group); });
    groups.forEach(function (group) {
      var h = document.createElement('div');
      h.className = 'sk-group';
      h.textContent = group;
      host.appendChild(h);
      BINDINGS.filter(function (b) { return b.group === group; }).forEach(function (b) {
        var row = document.createElement('div');
        row.className = 'sk-row';
        var keys = document.createElement('span');
        keys.className = 'sk-keys';
        // Keys within one combo join with '+', separate combos with 'or'.
        b.combos.forEach(function (combo, ci) {
          if (ci > 0) {
            var or = document.createElement('i');
            or.textContent = 'or';
            keys.appendChild(or);
          }
          combo.forEach(function (k, ki) {
            if (ki > 0) {
              var plus = document.createElement('i');
              plus.className = 'plus';
              plus.textContent = '+';
              keys.appendChild(plus);
            }
            var kbd = document.createElement('kbd');
            kbd.textContent = k;
            keys.appendChild(kbd);
          });
        });
        var label = document.createElement('span');
        label.className = 'sk-label';
        label.textContent = b.label;
        row.appendChild(keys);
        row.appendChild(label);
        host.appendChild(row);
      });
    });
  }

  function syncSettingsInputs() {
    var mouse = document.getElementById('setMouseNav');
    if (mouse) mouse.checked = !!settings.mouseNav;
  }

  function openSettings() {
    var bd = document.getElementById('settingsBackdrop');
    if (!bd) return;
    renderGuide();
    syncSettingsInputs();
    bd.style.display = 'flex';
    var btn = document.getElementById('settingsBtn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    var close = document.getElementById('settingsCloseBtn');
    if (close) close.focus();
    document.addEventListener('keydown', onSettingsKeydown);
  }
  function closeSettings() {
    var bd = document.getElementById('settingsBackdrop');
    if (bd) bd.style.display = 'none';
    document.removeEventListener('keydown', onSettingsKeydown);
    var btn = document.getElementById('settingsBtn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
  }
  function onSettingsKeydown(e) { if (e.key === 'Escape') { e.preventDefault(); closeSettings(); } }

  function init() {
    Store.onNav(record);
    document.addEventListener('keydown', onKeydown);
    // auxclick is the modern event for the side buttons; mouseup covers browsers
    // that do not raise auxclick for them. Both are idempotent here because each
    // one navigates at most once per press.
    document.addEventListener('auxclick', onAux);
    document.addEventListener('mouseup', onAux);
    if (window.cmcNav && typeof window.cmcNav.onNav === 'function') {
      window.cmcNav.onNav(function (dir) {
        if (!settings.mouseNav) return;
        if (dir === 'back') back();
        else if (dir === 'forward') forward();
      });
    }

    var btn = document.getElementById('settingsBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        var bd = document.getElementById('settingsBackdrop');
        var isOpen = !!bd && bd.style.display !== 'none';
        if (isOpen) closeSettings(); else openSettings();
      });
    }
    var close = document.getElementById('settingsCloseBtn');
    if (close) close.addEventListener('click', closeSettings);
    var bd = document.getElementById('settingsBackdrop');
    if (bd) {
      bd.addEventListener('click', function (e) { if (e.target === bd) closeSettings(); });
    }
    var mouse = document.getElementById('setMouseNav');
    if (mouse) {
      mouse.addEventListener('change', function () {
        settings.mouseNav = !!mouse.checked;
        save();
      });
    }
  }

  window.Shortcuts = {
    init: init,
    back: back,
    forward: forward,
    open: openSettings,
    close: closeSettings,
    bindings: BINDINGS,
    settings: settings,
    // Exposed for the render check: asserting real history behaviour beats
    // asserting that a click happened.
    debug: function () { return { index: index, length: history.length, state: history[index] }; }
  };
})();
