// Real-browser render check for the Sessions board.
//
// Why this exists: `node scripts/smoke-server.mjs` proves the server and the
// wire contract, but it cannot see the UI. A CSS grid blowout once sized a
// card's only column to max-content (a 538px track inside a 432px card), which
// pushed the context ring and the action buttons outside the card where
// overflow:hidden silently ate them, at every window width. Code review had
// concluded the opposite. One real measurement caught it. Geometry bugs need a
// real layout engine.
//
// Zero dependencies, in keeping with the rest of the repo: it drives whatever
// Chromium is already installed on the machine over the Chrome DevTools
// Protocol, using Node's built-in global WebSocket (Node 22+). Nothing is
// downloaded or installed. If no browser is found it SKIPS with exit code 0, so
// it is safe to call from anywhere; it is deliberately NOT part of CI, which
// runs headless Linux without a browser.
//
// Usage:
//   node scripts/render-check.mjs
//   node scripts/render-check.mjs --shot board.png     (also save a screenshot)
//
// Note: `chrome --dump-dom` is useless here. The board holds an open
// Server-Sent Events connection, so page load never completes and --dump-dom
// returns nothing, which reads as a broken page. Always poll for the element
// you expect over CDP instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4399;
const CDP_PORT = 9333;

const shotIndex = process.argv.indexOf('--shot');
const SHOT = shotIndex > -1 ? process.argv[shotIndex + 1] : null;

// Known Chromium-family binaries, in preference order. Playwright's cached
// build first (exact version pinned by whatever is installed), then the two
// browsers that ship on a normal Windows box.
function findBrowser() {
  const candidates = [];
  const pwRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(pwRoot)) {
      if (dir.startsWith('chromium-')) {
        candidates.push(path.join(pwRoot, dir, 'chrome-win64', 'chrome.exe'));
        candidates.push(path.join(pwRoot, dir, 'chrome-win', 'chrome.exe'));
      }
    }
  } catch {
    // no playwright cache, fall through to the installed browsers
  }
  candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  candidates.push('C:/Program Files/Microsoft/Edge/Application/msedge.exe');
  candidates.push('/usr/bin/chromium');
  candidates.push('/usr/bin/google-chrome');
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write((ok ? 'PASS  ' : 'FAIL  ') + name + '\n');
  if (!ok) {
    failures += 1;
    if (detail !== undefined) process.stdout.write('        ' + String(detail).slice(0, 600) + '\n');
  }
}

function post(urlPath, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', () => resolve(0));
    req.write(data);
    req.end();
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

async function waitFor(fn, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timed out waiting for ' + label);
}

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
  });
}

// Minimal CDP client over the built-in WebSocket.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  jsErrors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push(d.text + ' ' + (d.exception ? d.exception.description : ''));
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('console.error: ' + e.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        const t = e.params.entry.text || '';
        if (!/favicon|net::ERR_/i.test(t)) out.push('log: ' + t);
      }
    }
    return out;
  }
}

const BROWSER = findBrowser();
if (!BROWSER) {
  process.stdout.write('SKIP: no Chromium-family browser found, render check not run.\n');
  process.exit(0);
}

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-render-'));
// A fake repos tree so GET /repos returns something the picker can walk, and so
// the GitHub-account rule (anything under 2-ZRM is the work account) is
// exercised against real folder data rather than a stub.
fs.mkdirSync(path.join(TMP_HOME, 'repos', '2-ZRM', 'customers'), { recursive: true });
fs.mkdirSync(path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter'), { recursive: true });

const server = spawn(process.execPath, [path.join(REPO, 'server.mjs'), '--port', String(PORT)], {
  env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, CMC_DRY_RUN: '1', CMC_REGISTRY_POLL_MS: '400' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(TMP_HOME, 'cdp-profile')}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stdout.on('data', () => {});
chrome.stderr.on('data', () => {});

try {
  await waitFor(serverUp, 'server');
  await waitFor(async () => (await getJson(CDP_PORT, '/json/version')).webSocketDebuggerUrl, 'chrome cdp');

  // A long name plus a blocked status is the exact overlap case from the report.
  const SID = 'render-1';
  const CWD = path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter');
  const LONG_NAME = 'A Deliberately Very Long Session Name To Force Ellipsis';
  await post('/event', { hook_event_name: 'SessionStart', session_id: SID, cwd: CWD, model: 'claude-opus-5[1m]', session_title: LONG_NAME });
  await post('/event', { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: CWD, prompt: 'Wire the ZeptoMail HTTPS API into the invite flow and drop nodemailer entirely' });
  await post('/event', { hook_event_name: 'Notification', session_id: SID, cwd: CWD, notification_type: 'permission_prompt', message: 'needs you' });
  const nowSec = Math.floor(Date.now() / 1000);
  await post('/statusline', {
    session_id: SID, cwd: CWD,
    model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5' },
    context_window: { total_input_tokens: 213774, total_output_tokens: 720, context_window_size: 1000000, used_percentage: 78 },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: nowSec + 3600 },
      seven_day: { used_percentage: 68, resets_at: nowSec + 400000 } },
  });

  // A second session driven to 'awaiting' (the Stop hook: turn finished,
  // nothing required) via the exact same hook path a real Claude session
  // uses. Together with SID above (driven to 'needs-permission' via a
  // Notification permission_prompt) this is the minimal pair needed to prove
  // the corrected status semantics: needsInput must count SID only, and
  // doneAwaiting must count SID2 only.
  const SID2 = 'render-2';
  const CWD2 = path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter-awaiting-demo');
  await post('/event', { hook_event_name: 'SessionStart', session_id: SID2, cwd: CWD2, model: 'claude-sonnet-5' });
  await post('/event', { hook_event_name: 'UserPromptSubmit', session_id: SID2, cwd: CWD2, prompt: 'Summarize the CI failures from the last run' });
  await post('/event', { hook_event_name: 'Stop', session_id: SID2, cwd: CWD2 });

  const target = await waitFor(
    async () => (await getJson(CDP_PORT, '/json/list')).find((t) => t.type === 'page' && t.webSocketDebuggerUrl),
    'page target'
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(() => cdp.eval('!!document.querySelector(".session-card")'), 'a session card');

  const facts = await cdp.eval(`(function () {
    var card = document.querySelector('.session-card');
    var q = function (s) { var e = card.querySelector(s); return e ? e.textContent.trim() : null; };
    var body = document.body.innerText;
    return {
      cardClasses: card.className,
      title: q('.sc-title'),
      where: q('.sc-where'),
      ring: card.querySelector('.sc-ring') ? card.querySelector('.sc-ring').textContent.replace(/\\s+/g, ' ').trim() : null,
      actionLabels: Array.prototype.map.call(card.querySelectorAll('button'), function (b) { return b.textContent.trim(); }),
      hasNewSessionBtn: !!document.getElementById('newSessionOpenBtn') || !!document.getElementById('newSessionBtn'),
      hasRepoBar: !!document.querySelector('.new-session-bar'),
      usageText: (document.getElementById('usageMeters') || {}).innerText || '',
      stateOptions: Array.prototype.map.call(document.querySelectorAll('#fltState option'), function (o) { return o.value; }),
      timeOptions: Array.prototype.map.call(document.querySelectorAll('#fltTime option'), function (o) { return o.value; }),
      attentionVisible: (function () { var a = document.getElementById('attention'); return !!a && a.style.display !== 'none'; })(),
      bodyHasRawModel: body.indexOf('claude-opus-5[1m]') !== -1,
      bodyHasPrettyModel: body.indexOf('Opus 5') !== -1
    };
  })()`);

  check('board renders a session card', !!facts.title, JSON.stringify(facts));
  check('long session name is the card title', facts.title === LONG_NAME, facts.title);
  check('needs-permission class applied', /status-needs-permission/.test(facts.cardClasses), facts.cardClasses);
  check('context ring shows its percentage', /78/.test(facts.ring || ''), facts.ring);
  check('model is prettified, raw id absent', facts.bodyHasPrettyModel && !facts.bodyHasRawModel,
    'pretty=' + facts.bodyHasPrettyModel + ' raw=' + facts.bodyHasRawModel);
  check('Details action present', facts.actionLabels.indexOf('Details') !== -1, JSON.stringify(facts.actionLabels));
  check('New session button exists', facts.hasNewSessionBtn);
  check('old always-on repo bar is gone', !facts.hasRepoBar);
  check('quota meters rendered', /5/.test(facts.usageText) && /7/.test(facts.usageText), JSON.stringify(facts.usageText));
  check('Show filter is exactly All/Active/Closed, needs-input pulled out into the segmented control',
    JSON.stringify(facts.stateOptions) === JSON.stringify(['all', 'active', 'closed']), JSON.stringify(facts.stateOptions));
  check('7 day time filter option exists', facts.timeOptions.some(function (v) { return /week|7/.test(v); }), JSON.stringify(facts.timeOptions));
  check('attention pill visible while a session is blocked', facts.attentionVisible);

  // Geometry across realistic desktop widths. This is the check that caught the
  // grid blowout: assert the ring and the buttons stay INSIDE the card, since
  // overflow:hidden hides the failure from the naked eye.
  for (const vw of [1400, 1000, 700, 480, 400]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    const g = await cdp.eval(`(function () {
      var card = document.querySelector('.session-card');
      var cr = card.getBoundingClientRect();
      var pick = function (s) {
        var e = card.querySelector(s); if (!e) return null;
        var r = e.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      };
      return { card: { left: Math.round(cr.left), right: Math.round(cr.right), w: Math.round(cr.width) },
        ring: pick('.sc-ring'), acts: pick('.sc-acts'),
        pageScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    })()`);
    const ok = (!g.ring || g.ring.right <= g.card.right + 1) &&
      (!g.acts || g.acts.right <= g.card.right + 1) &&
      g.pageScrollW <= g.innerW + 1;
    check(`viewport ${vw}px: ring and actions inside the card, no page h-scroll`, ok, JSON.stringify(g));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 250));

  // ---- Status semantics: needs-permission is the only real block on the
  // user; awaiting (Stop hook) is "done", informational. With SID
  // (needs-permission) and SID2 (awaiting) both tracked, the pill must read
  // 1 (not 2, the old bug where needsInput() counted both statuses), the
  // done-awaiting label must read 1, and the awaiting card's own label must
  // read "Done - awaiting user". ----
  const semantics = await cdp.eval(`(function () {
    var awaitingLabel = document.querySelector('.session-card.status-awaiting .sc-st-label');
    return {
      attVisible: (function () { var a = document.getElementById('attention'); return !!a && getComputedStyle(a).display !== 'none'; })(),
      attCount: document.getElementById('attCount') ? document.getElementById('attCount').textContent : null,
      doneVisible: (function () { var d = document.getElementById('doneAwaiting'); return !!d && getComputedStyle(d).display !== 'none'; })(),
      doneCount: document.getElementById('doneCount') ? document.getElementById('doneCount').textContent : null,
      awaitingLabel: awaitingLabel ? awaitingLabel.textContent.trim() : null
    };
  })()`);
  check('needs-input pill counts only needs-permission (reads 1, not 2)', semantics.attVisible && semantics.attCount === '1', JSON.stringify(semantics));
  check('done-awaiting label counts only awaiting (reads 1)', semantics.doneVisible && semantics.doneCount === '1', JSON.stringify(semantics));
  check('awaiting card renders "Done - awaiting user"', semantics.awaitingLabel === 'Done - awaiting user', JSON.stringify(semantics));

  // ---- Segmented "Active" sub-filter: exists with exactly 3 segments,
  // hidden outside Active, and a real thumb that slides. ----
  const segShape = await cdp.eval(`(function () {
    var seg = document.getElementById('segState');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('#segState .seg-tab'));
    return {
      exists: !!seg,
      segmentCount: tabs.length,
      segments: tabs.map(function (t) { return t.getAttribute('data-segment'); }).sort(),
      visibleWhileActive: seg ? getComputedStyle(seg).display !== 'none' : false
    };
  })()`);
  check('segmented control exists with exactly 3 segments', segShape.exists && segShape.segmentCount === 3, JSON.stringify(segShape));
  check('segments are all / needs-input / done',
    JSON.stringify(segShape.segments) === JSON.stringify(['all', 'done', 'needs-input']), JSON.stringify(segShape.segments));
  check('segmented control visible while Show=Active', segShape.visibleWhileActive === true, JSON.stringify(segShape));

  const segHidden = await cdp.eval(`(function () {
    var st = document.getElementById('fltState');
    function setAndRead(v) {
      st.value = v; st.dispatchEvent(new Event('change'));
      return getComputedStyle(document.getElementById('segState')).display;
    }
    return { onAll: setAndRead('all'), onClosed: setAndRead('closed'), onActive: setAndRead('active') };
  })()`);
  check('segmented control hidden when Show=All', segHidden.onAll === 'none', JSON.stringify(segHidden));
  check('segmented control hidden when Show=Closed', segHidden.onClosed === 'none', JSON.stringify(segHidden));
  check('segmented control visible again when Show=Active', segHidden.onActive !== 'none', JSON.stringify(segHidden));

  // needs-input pill: clicking it must land on Active + the Needs input
  // segment, and only the blocked (needs-permission) card should list.
  const attClick = await cdp.eval(`(function () {
    document.getElementById('attention').click();
    var sel = document.querySelector('#segState .seg-tab[aria-selected="true"]');
    return { state: document.getElementById('fltState').value,
      segment: sel ? sel.getAttribute('data-segment') : null,
      cards: document.querySelectorAll('.session-card').length };
  })()`);
  check('needs-input pill click sets state=active and segment=needs-input',
    attClick.state === 'active' && attClick.segment === 'needs-input', JSON.stringify(attClick));
  check('needs-input segment lists only the blocked card', attClick.cards === 1, JSON.stringify(attClick));

  // done-awaiting label: same idea, but the Done segment, and only the
  // awaiting card should list.
  const doneClick = await cdp.eval(`(function () {
    document.getElementById('doneAwaiting').click();
    var sel = document.querySelector('#segState .seg-tab[aria-selected="true"]');
    return { state: document.getElementById('fltState').value,
      segment: sel ? sel.getAttribute('data-segment') : null,
      cards: document.querySelectorAll('.session-card').length };
  })()`);
  check('done-awaiting label click sets state=active and segment=done',
    doneClick.state === 'active' && doneClick.segment === 'done', JSON.stringify(doneClick));
  check('done segment lists only the awaiting card', doneClick.cards === 1, JSON.stringify(doneClick));

  // All active (the default segment) lists both active sessions again.
  const allActive = await cdp.eval(`(function () {
    document.getElementById('segAll').click();
    return { cards: document.querySelectorAll('.session-card').length };
  })()`);
  check('All active segment lists both active cards', allActive.cards === 2, JSON.stringify(allActive));

  // ---- Stats dashboard popup: opens from the icon button, shows the 4
  // labelled tiles (moved off the always-visible header strip), and closes
  // on Esc with focus returned to the button. ----
  const statsOpen = await cdp.eval(`(function () {
    document.getElementById('statsBtn').click();
    var bd = document.getElementById('statsBackdrop');
    var stats = Array.prototype.map.call(document.querySelectorAll('#statsPopup .stat'), function (s) {
      return { n: s.querySelector('.n').textContent, l: s.querySelector('.l').textContent };
    });
    return { open: !!bd && getComputedStyle(bd).display !== 'none',
      expanded: document.getElementById('statsBtn').getAttribute('aria-expanded'), stats: stats };
  })()`);
  check('dashboard popup opens from the icon button', statsOpen.open === true && statsOpen.expanded === 'true', JSON.stringify(statsOpen));
  check('dashboard popup shows four labelled values',
    statsOpen.stats.length === 4 && statsOpen.stats.every(function (s) { return !!s.l; }), JSON.stringify(statsOpen.stats));

  const statsClosed = await cdp.eval(`(function () {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    var bd = document.getElementById('statsBackdrop');
    return { closed: !!bd && getComputedStyle(bd).display === 'none',
      focused: document.activeElement ? document.activeElement.id : null,
      expanded: document.getElementById('statsBtn').getAttribute('aria-expanded') };
  })()`);
  check('Esc closes the dashboard popup, focus returns to the button',
    statsClosed.closed === true && statsClosed.focused === 'statsBtn' && statsClosed.expanded === 'false', JSON.stringify(statsClosed));

  // Popup chrome. Visibility lives on the backdrop, not the panel.
  const popup = await cdp.eval(`(function () {
    var bd = document.getElementById('newSessionBackdrop');
    window.ViewSessions.openNewSession();
    var open = !!bd && getComputedStyle(bd).display !== 'none';
    var focused = document.activeElement ? document.activeElement.id : null;
    return { open: open, focused: focused };
  })()`);
  check('New session popup opens', popup.open === true, JSON.stringify(popup));
  check('focus lands in the popup name field', popup.focused === 'newSessionName', JSON.stringify(popup));

  // The GitHub account picker: the rule is that anything under a 2-ZRM path
  // segment is the work account and everything else is personal. Frontend and
  // backend implement that rule independently, so it is only truly verified by
  // driving the real dropdowns against the real /repos data.
  // Wait for the REAL /repos payload, not the disabled "Loading..." placeholder
  // that ships in the static HTML, and not a half-populated account list.
  await waitFor(() => cdp.eval(`(function () {
    var first = document.querySelector('#newSessionSelectors select');
    var acc = document.getElementById('newSessionAccount');
    return !!first && !first.disabled && first.options.length > 1 && !!acc && acc.options.length >= 2;
  })()`), 'repos and accounts loaded');
  const accountField = await cdp.eval(`(function () {
    var a = document.getElementById('newSessionAccount');
    return { exists: !!a, options: a ? Array.prototype.map.call(a.options, function (o) { return o.value; }) : [] };
  })()`);
  check('GitHub account picker exists with both accounts', accountField.exists && accountField.options.length >= 2,
    JSON.stringify(accountField));

  async function pickTopFolderAndReadAccount(folderName) {
    return cdp.eval(`(function () {
      var host = document.getElementById('newSessionSelectors');
      var sel = host.children[0];
      var want = ${JSON.stringify(folderName)}.toLowerCase();
      var hit = null;
      for (var i = 0; i < sel.options.length; i++) {
        var v = String(sel.options[i].value || '');
        var base = v.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop().toLowerCase();
        if (base === want) { hit = sel.options[i].value; break; }
      }
      if (hit === null) return { picked: null };
      sel.value = hit;
      sel.dispatchEvent(new Event('change'));
      var acc = document.getElementById('newSessionAccount');
      return { picked: hit, account: acc ? acc.value : null };
    })()`);
  }

  const zrmPick = await pickTopFolderAndReadAccount('2-ZRM');
  check('selecting a 2-ZRM folder auto-selects the work account',
    !!zrmPick.picked && zrmPick.account === 'work', JSON.stringify(zrmPick));
  const personalPick = await pickTopFolderAndReadAccount('1-Personal');
  check('selecting a non-2-ZRM folder auto-selects the personal account',
    !!personalPick.picked && personalPick.account === 'personal', JSON.stringify(personalPick));

  const override = await cdp.eval(`(function () {
    var acc = document.getElementById('newSessionAccount');
    acc.value = 'work';
    acc.dispatchEvent(new Event('change'));
    var host = document.getElementById('newSessionSelectors');
    var sel = host.children[0];
    sel.dispatchEvent(new Event('change'));
    return { afterChainChange: acc.value };
  })()`);
  check('a manual account override survives a later folder change',
    override.afterChainChange === 'work', JSON.stringify(override));

  const closed = await cdp.eval(`(function () {
    var bd = document.getElementById('newSessionBackdrop');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return !!bd && getComputedStyle(bd).display === 'none';
  })()`);
  check('Esc closes the popup', closed === true);

  // ---- Empty/missing accounts fallback (2026-07-30: an installed app's
  // updater once left an OLD backend running behind a NEW frontend, so
  // GET /repos came back with no `accounts` field at all and the dropdown
  // rendered completely empty). The dropdown must degrade to a disabled
  // "No accounts available" placeholder, never a blank focused select, and
  // Launch must still work by omitting `account` from the request body so
  // the server's own defaultAccountForPath() decides.
  //
  // Forcing this state cleanly from the harness (a real backend swap) is not
  // practical here, so it is driven in-page: window.fetch is intercepted for
  // just this one call, /repos is answered with accounts: [], the folder
  // host is cleared so loadRepos() re-fetches instead of using its cache,
  // and the popup is reopened. /launch is left to hit the real server
  // (still CMC_DRY_RUN), with its outgoing body captured for inspection. ----
  const emptyAccounts = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var capturedLaunchBody = null;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/repos') !== -1) {
          return Promise.resolve({ json: function () {
            return Promise.resolve({ root: 'C:/fake-empty-accounts', tree: [], accounts: [] });
          } });
        }
        if (u.indexOf('/launch') !== -1 && opts && opts.body) {
          try { capturedLaunchBody = JSON.parse(opts.body); } catch (e) {}
        }
        return originalFetch(url, opts);
      };
      var host = document.getElementById('newSessionSelectors');
      if (host) host.innerHTML = '';
      window.ViewSessions.openNewSession();
      setTimeout(function () {
        var acc = document.getElementById('newSessionAccount');
        var options = acc ? Array.prototype.map.call(acc.options, function (o) {
          return { value: o.value, text: o.textContent, disabled: o.disabled };
        }) : [];
        var btn = document.getElementById('newSessionBtn');
        btn.click();
        setTimeout(function () {
          window.fetch = originalFetch;
          resolve({
            options: options,
            launchBody: capturedLaunchBody,
            popupClosed: getComputedStyle(document.getElementById('newSessionBackdrop')).display === 'none'
          });
        }, 400);
      }, 400);
    });
  })()`);
  check('empty accounts list renders one disabled "No accounts available" option',
    emptyAccounts.options.length === 1 && emptyAccounts.options[0].text === 'No accounts available' && emptyAccounts.options[0].disabled === true,
    JSON.stringify(emptyAccounts.options));
  check('launch with no accounts available omits the account field entirely (never sends account: "")',
    !!emptyAccounts.launchBody && !('account' in emptyAccounts.launchBody), JSON.stringify(emptyAccounts.launchBody));
  check('launch still succeeds with no accounts available (falls back to the server default)',
    emptyAccounts.popupClosed === true, JSON.stringify(emptyAccounts));

  // ---- Take Control (formerly "Reopen"): the in-app confirm that replaced
  // window.confirm(). A native confirm() cannot be styled, blocks the page, and
  // in the Electron shell renders as a bare OS dialog, so the styled dialog has
  // to be verified in a real browser: that it opens, names the session, cancels
  // without POSTing /reopen, and on accept really does call /reopen.
  //
  // The button only appears once a card is `unmanaged`, which is a /focus
  // outcome. /focus is stubbed for exactly that one call (answering what the
  // real server answers for a session with no managed tab) so the state is
  // deterministic no matter what earlier launches in this run left in
  // managedTabs. Everything after that, including /reopen, hits the real server.
  const takeControl = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var reopenCalls = 0;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/focus') !== -1) {
          return Promise.resolve({ json: function () {
            return Promise.resolve({ ok: false, mode: 'unmanaged', error: 'No known terminal tab for this session' });
          } });
        }
        if (u.indexOf('/reopen') !== -1) reopenCalls += 1;
        return originalFetch(url, opts);
      };
      var card = document.querySelector('.session-card');
      card.click();
      setTimeout(function () {
        // Read the class HERE: a successful take-control clears the unmanaged
        // class again (the card is managed once more), so reading it at the end
        // would always come back without it.
        var classesAfterFocus = card.className;
        var btn = card.querySelector('.sc-reopen');
        var btnLabel = btn ? btn.textContent.trim() : null;
        var btnVisible = btn ? getComputedStyle(btn).display !== 'none' : false;
        btn.click();
        var bd = document.getElementById('confirmBackdrop');
        var open = !!bd && getComputedStyle(bd).display !== 'none';
        var titleText = (document.getElementById('confirmTitle') || {}).textContent || '';
        var bodyText = (document.getElementById('confirmText') || {}).innerText || '';
        var okLabel = (document.getElementById('confirmOkBtn') || {}).textContent || '';
        var focused = document.activeElement ? document.activeElement.id : null;
        var styled = !!bd && bd.classList.contains('pop-backdrop') && !!document.querySelector('#confirmPopup.pop');
        // Esc must cancel WITHOUT reopening anything.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        var closedAfterEsc = !!bd && getComputedStyle(bd).display === 'none';
        var reopensAfterCancel = reopenCalls;
        // Second run: confirm for real.
        btn.click();
        document.getElementById('confirmOkBtn').click();
        setTimeout(function () {
          var toast = document.querySelector('.toast');
          window.fetch = originalFetch;
          resolve({
            cardClasses: classesAfterFocus, classesAfterConfirm: card.className,
            btnLabel: btnLabel, btnVisible: btnVisible,
            open: open, styled: styled, titleText: titleText.trim(), bodyText: bodyText,
            okLabel: okLabel.trim(), focused: focused, closedAfterEsc: closedAfterEsc,
            reopensAfterCancel: reopensAfterCancel, reopenCalls: reopenCalls,
            closedAfterConfirm: getComputedStyle(bd).display === 'none',
            toastText: toast ? toast.textContent : null,
            toastShown: !!toast && toast.classList.contains('show')
          });
        }, 500);
      }, 500);
    });
  })()`);
  check('an unmanaged focus attempt marks the card and reveals its action',
    /unmanaged/.test(takeControl.cardClasses) && takeControl.btnVisible === true, JSON.stringify(takeControl.cardClasses));
  check('the action reads "Take Control", not "Reopen"', takeControl.btnLabel === 'Take Control', String(takeControl.btnLabel));
  check('Take Control opens the in-app styled dialog (not window.confirm)',
    takeControl.open === true && takeControl.styled === true, JSON.stringify(takeControl));
  check('the dialog is titled Take Control and its button matches',
    takeControl.titleText === 'Take Control' && takeControl.okLabel === 'Take Control', JSON.stringify(takeControl));
  check('the dialog names the session and explains the duplicate-tab risk',
    takeControl.bodyText.indexOf(LONG_NAME) !== -1 && /two tabs/.test(takeControl.bodyText), JSON.stringify(takeControl.bodyText));
  check('focus lands on the confirm button', takeControl.focused === 'confirmOkBtn', String(takeControl.focused));
  check('Esc cancels the dialog and reopens nothing',
    takeControl.closedAfterEsc === true && takeControl.reopensAfterCancel === 0, JSON.stringify(takeControl));
  check('confirming really calls POST /reopen and closes the dialog',
    takeControl.reopenCalls === 1 && takeControl.closedAfterConfirm === true, JSON.stringify(takeControl));
  check('taking control reports back in a toast',
    takeControl.toastShown === true && /Took control/.test(String(takeControl.toastText)), JSON.stringify(takeControl.toastText));
  check('a successful take-control clears the unmanaged mark from the card',
    !/unmanaged/.test(takeControl.classesAfterConfirm), String(takeControl.classesAfterConfirm));

  const errs = cdp.jsErrors();
  check('no JS or console errors on the board', errs.length === 0, errs.slice(0, 5).join(' | '));

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    process.stdout.write('\nscreenshot: ' + SHOT + '\n');
    // Second shot with the Take Control dialog open: the only way to actually
    // LOOK at a modal that is closed again by the time the board settles.
    await cdp.eval(`(function () {
      var card = document.querySelector('.session-card');
      card.classList.add('unmanaged');
      card.querySelector('.sc-reopen').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const dialogShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const dialogPath = SHOT.replace(/(\.png)?$/i, '') + '-take-control.png';
    fs.writeFileSync(dialogPath, Buffer.from(dialogShot.data, 'base64'));
    process.stdout.write('screenshot: ' + dialogPath + '\n');
  }

  process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILED\n`);
} catch (e) {
  process.stdout.write('HARNESS ERROR: ' + (e && e.message) + '\n');
  failures += 1;
} finally {
  try { chrome.kill(); } catch { /* already gone */ }
  try { server.kill(); } catch { /* already gone */ }
}

process.exit(failures === 0 ? 0 : 1);
