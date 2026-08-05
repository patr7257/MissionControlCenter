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
// Four levels deep on purpose: DEFAULT_REPO_CHAIN preselects 2-ZRM/customers, so
// three selects render on open and one more pick produces a fourth. That is the
// case the popup-width check below measures, and the long folder name is what
// used to force the row wider than the panel.
fs.mkdirSync(path.join(TMP_HOME, 'repos', '2-ZRM', 'customers', 'a-very-long-customer-name', 'their-webshop-frontend'), { recursive: true });
fs.mkdirSync(path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter'), { recursive: true });

// Two sessions flagged for later, written the way the /resume-later skill writes
// them: a plain file in the state dir that the server reads fresh. Seeded BEFORE
// the server boots so the very first /resume-flags call sees them.
fs.mkdirSync(path.join(TMP_HOME, '.claude', 'agent-fleet-monitor'), { recursive: true });
fs.writeFileSync(
  path.join(TMP_HOME, '.claude', 'agent-fleet-monitor', 'resume-flags.json'),
  JSON.stringify([
    {
      sessionId: 'render-1',
      name: 'A Deliberately Very Long Session Name To Force Ellipsis',
      cwd: path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter'),
      project: 'MissionControlCenter',
      note: 'paused to save tokens until 16:00',
      flaggedAt: Date.now() - 12 * 60000,
    },
    {
      sessionId: 'pruned-session-id',
      name: 'Samberg VIBE Extension',
      cwd: path.join(TMP_HOME, 'repos', '2-ZRM', 'customers'),
      project: 'customers',
      note: null,
      flaggedAt: Date.now() - 95 * 60000,
    },
  ])
);

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

  // A third session that has ENDED, which is the pair Close session needs: the
  // button must exist on a running session and not on one there is nothing left to
  // close. Seeded before the page navigates, so its `session-ended` broadcast goes
  // out with nobody listening and cannot pop the panel over the rest of the run.
  const SID3 = 'render-3';
  const CWD3 = path.join(TMP_HOME, 'repos', '1-Personal', 'MissionControlCenter-ended-demo');
  await post('/event', { hook_event_name: 'SessionStart', session_id: SID3, cwd: CWD3, model: 'claude-sonnet-5' });
  await post('/event', { hook_event_name: 'UserPromptSubmit', session_id: SID3, cwd: CWD3, prompt: 'Bump the changelog for the release' });
  await post('/event', { hook_event_name: 'SessionEnd', session_id: SID3, cwd: CWD3 });

  // Record an opened editor for SID's folder (the server runs under CMC_DRY_RUN, so
  // nothing is really spawned). That is what makes `editorOpen` true for SID and
  // false for SID2, which is exactly the pair needed to prove the Close VS Code
  // button only appears for a folder this app opened.
  await post('/open-editor', { sessionId: SID });

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
      // :not(.sc-runring) matters: the runtime ring renders FIRST, so a bare
      // .sc-ring selector now matches that one instead of the context ring.
      ring: card.querySelector('.sc-ring:not(.sc-runring)') ? card.querySelector('.sc-ring:not(.sc-runring)').textContent.replace(/\\s+/g, ' ').trim() : null,
      runRing: card.querySelector('.sc-runring') ? card.querySelector('.sc-runring').textContent.replace(/\\s+/g, ' ').trim() : null,
      actionLabels: Array.prototype.map.call(card.querySelectorAll('button'), function (b) { return b.textContent.trim(); }),
      hasNewSessionBtn: !!document.getElementById('newSessionOpenBtn') || !!document.getElementById('newSessionBtn'),
      hasRepoBar: !!document.querySelector('.new-session-bar'),
      usageText: (document.getElementById('usageMeters') || {}).innerText || '',
      quotaBarText: (document.getElementById('quotaBar') || {}).innerText || '',
      quotaFillWidth: (function () { var f = document.getElementById('quotaFill'); return f ? f.style.width : null; })(),
      quotaBarClass: (document.getElementById('quotaBar') || {}).className || '',
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
  // ONE VS Code button that swaps label with the real editor state, so this card
  // (whose folder was opened during seeding) reads Close VS Code. Matched loosely on
  // purpose: which of the two labels is correct is asserted properly further down.
  check('a VS Code action is present', facts.actionLabels.some((l) => /VS Code$/.test(l)), JSON.stringify(facts.actionLabels));
  check('New session button exists', facts.hasNewSessionBtn);
  check('old always-on repo bar is gone', !facts.hasRepoBar);
  // The 5 hour window is a full-width bar now and only the 7 day ring is left in
  // the header, so the old "5 and 7 both appear up there" check would pass for
  // the wrong reason.
  check('the 7 day window is in the header, the 5 hour one is not',
    /7\s*day/i.test(facts.usageText) && !/5\s*hour/i.test(facts.usageText), JSON.stringify(facts.usageText));
  check('5 hour quota renders as a bar with its percentage and reset time',
    /5 hour limit/i.test(facts.quotaBarText) && /42%/.test(facts.quotaBarText) && /resets/i.test(facts.quotaBarText),
    JSON.stringify(facts.quotaBarText));
  check('the quota bar fill is sized to the reading and takes the shared severity ramp',
    facts.quotaFillWidth === '42%' && /\blo\b/.test(facts.quotaBarClass),
    facts.quotaFillWidth + ' | ' + facts.quotaBarClass);
  check('the card carries a runtime ring labelled MIN', /MIN/.test(String(facts.runRing)), String(facts.runRing));
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

  // ---- Popup width: the cascading folder chain must sit on ONE row. With .chain
  // wrapping and .pop capped at 520px, the 4th select dropped to a new line the
  // moment a third level was picked, so deepening the chain read as the picker
  // breaking. Only real geometry proves it, the same reason the card geometry loop
  // above exists. Walk the chain down to its deepest level first.
  const chainDepth = await cdp.eval(`(function () {
    var host = document.getElementById('newSessionSelectors');
    var first = host.children[0];
    for (var i = 0; i < first.options.length; i++) {
      var v = String(first.options[i].value || '');
      if (/2-zrm$/i.test(v.replace(/[\\\\/]+$/, ''))) { first.value = first.options[i].value; break; }
    }
    first.dispatchEvent(new Event('change'));
    // Keep picking the first real folder in the deepest select until the chain
    // stops growing (a leaf folder spawns no further select).
    for (var guard = 0; guard < 8; guard++) {
      var last = host.children[host.children.length - 1];
      if (!last || last.options.length < 2) break;
      var before = host.children.length;
      last.selectedIndex = 1;
      last.dispatchEvent(new Event('change'));
      if (host.children.length === before) break;
    }
    return host.children.length;
  })()`);
  check('the folder chain cascades four levels deep', chainDepth === 4, String(chainDepth));

  async function chainGeometry() {
    return cdp.eval(`(function () {
      var host = document.getElementById('newSessionSelectors');
      var pr = document.getElementById('newSessionPopup').getBoundingClientRect();
      var sels = Array.prototype.slice.call(host.children).map(function (s) {
        var r = s.getBoundingClientRect();
        return { top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width) };
      });
      var tops = sels.map(function (s) { return s.top; });
      return {
        count: sels.length,
        rows: tops.filter(function (t, i) { return tops.indexOf(t) === i; }).length,
        overflowRight: Math.max.apply(null, [0].concat(sels.map(function (s) { return Math.round(s.right - pr.right); }))),
        narrowest: Math.min.apply(null, [9999].concat(sels.map(function (s) { return s.w; }))),
        panelW: Math.round(pr.width), innerW: window.innerWidth,
        pageScrollW: document.documentElement.scrollWidth
      };
    })()`);
  }

  for (const vw of [1400, 1000, 700, 480, 400]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    const g = await chainGeometry();
    // One row is only required while the panel has room for it: under the 560px
    // media query the chain re-wraps ON PURPOSE, and the assertion there is the
    // weaker but still-true "nothing overflows, no page h-scroll".
    const oneRowRequired = vw >= 700;
    const ok = g.count === 4 && g.overflowRight <= 1 && g.pageScrollW <= g.innerW + 1 &&
      (!oneRowRequired || (g.rows === 1 && g.narrowest >= 60));
    check(`popup ${vw}px: folder chain ${oneRowRequired ? 'on one row, ' : ''}nothing overflowing the panel`, ok, JSON.stringify(g));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 250));

  // Only the New session popup may get the wider cap: the base .pop rule also
  // feeds the confirm and the Settings dialog, so widening it would widen those.
  // max-width resolves even on a panel whose backdrop is display:none.
  const caps = await cdp.eval(`(function () {
    var mw = function (id) { var e = document.getElementById(id); return e ? getComputedStyle(e).maxWidth : null; };
    return { newSession: mw('newSessionPopup'), confirm: mw('confirmPopup'), settings: mw('settingsPopup') };
  })()`);
  check('only the New session popup got the wider cap',
    caps.newSession === '760px' && caps.confirm === '430px' && caps.settings === '560px', JSON.stringify(caps));

  // The footer's .path eats every spare pixel, so a two-word button label broke
  // onto a second line and made that button taller than its neighbours. Compare
  // real heights and tops rather than trusting the CSS text.
  const footBtns = await cdp.eval(`(function () {
    var r = function (id) { var b = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
    return { code: r('newSessionCodeBtn'), cancel: r('newSessionCancelBtn'), launch: r('newSessionBtn') };
  })()`);
  check('the popup footer buttons are one row of equal-height, unwrapped labels',
    Math.abs(footBtns.code.h - footBtns.cancel.h) <= 1 && footBtns.code.top === footBtns.cancel.top &&
      footBtns.cancel.top === footBtns.launch.top, JSON.stringify(footBtns));

  // The popup's own VS Code button opens the DEEPEST selected folder and leaves
  // the popup open (looking at a repo, then launching a session in it, is one
  // flow). It reports into #newSessionFeedback rather than a toast, because
  // .toast is z-index 50 and .pop-backdrop is 100, so a toast raised from inside
  // the modal would render behind it.
  const popupCode = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch, calls = [];
      window.fetch = function (url, opts) {
        if (String(url).indexOf('/open-editor') !== -1) {
          calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, dryRun: true }); } });
        }
        return originalFetch(url, opts);
      };
      // #newSessionPath is written from currentLaunchPath(), so matching it proves
      // the deepest selection was sent and not the repos root.
      var expected = document.getElementById('newSessionPath').textContent;
      document.getElementById('newSessionCodeBtn').click();
      setTimeout(function () {
        window.fetch = originalFetch;
        resolve({
          calls: calls, expected: expected,
          feedback: document.getElementById('newSessionFeedback').textContent,
          stillOpen: getComputedStyle(document.getElementById('newSessionBackdrop')).display !== 'none'
        });
      }, 400);
    });
  })()`);
  check('the popup VS Code button POSTs the currently selected folder',
    popupCode.calls.length === 1 && !!popupCode.calls[0] && popupCode.calls[0].repo === popupCode.expected,
    JSON.stringify(popupCode));
  check('opening VS Code from the popup leaves the popup open', popupCode.stillOpen === true, JSON.stringify(popupCode));
  check('the popup reports in its own feedback line, not a toast behind the modal',
    /VS Code/.test(String(popupCode.feedback)), String(popupCode.feedback));

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

  // ---- Header icon buttons are a PAIR at the right end. `margin-left: auto` on
  // .icon-btn itself worked with one button and broke with two: each button's auto
  // absorbed free space, so the leftover width landed between them as a large gap.
  // Geometry, not classes, is what proves the layout (issue #25).
  const hdr = await cdp.eval(`(function () {
    var stats = document.getElementById('statsBtn').getBoundingClientRect();
    var gear = document.getElementById('settingsBtn').getBoundingClientRect();
    var header = document.querySelector('header').getBoundingClientRect();
    return {
      gap: Math.round(gear.left - stats.right),
      statsBeforeGear: stats.right <= gear.left + 1,
      gearNearRightEdge: Math.round(header.right - gear.right),
      sameRow: Math.abs(stats.top - gear.top) <= 1,
      grouped: !!document.querySelector('.hdr-actions #statsBtn') && !!document.querySelector('.hdr-actions #settingsBtn')
    };
  })()`);
  check('the stats and settings buttons sit next to each other, no free-space gap',
    hdr.gap >= 0 && hdr.gap <= 24, JSON.stringify(hdr));
  check('stats comes first and both are on one row', hdr.statsBeforeGear === true && hdr.sameRow === true, JSON.stringify(hdr));
  check('the pair is parked at the right end of the header', hdr.gearNearRightEdge <= 40, JSON.stringify(hdr));
  check('both header icon buttons live in the .hdr-actions group', hdr.grouped === true, JSON.stringify(hdr));

  // ---- Shortcuts, app history and the Settings popup. The mouse's back/forward
  // buttons and the keyboard bindings all move through ONE history stack, so this
  // asserts the real state transitions (board -> session -> back -> forward), not
  // just that a handler was called. The Electron path (app-command over the
  // preload bridge) cannot exist in plain Chromium, so it is driven here through
  // the same entry point the bridge calls, window.Shortcuts.back/forward. ----
  const settingsUi = await cdp.eval(`(function () {
    document.getElementById('settingsBtn').click();
    var bd = document.getElementById('settingsBackdrop');
    var rows = Array.prototype.map.call(document.querySelectorAll('#settingsShortcuts .sk-row'), function (r) {
      return {
        keys: Array.prototype.map.call(r.querySelectorAll('kbd'), function (k) { return k.textContent; }),
        label: (r.querySelector('.sk-label') || {}).textContent || ''
      };
    });
    var groups = Array.prototype.map.call(document.querySelectorAll('#settingsShortcuts .sk-group'), function (g) { return g.textContent; });
    var panel = document.getElementById('settingsPopup');
    var pr = panel.getBoundingClientRect();
    return {
      open: getComputedStyle(bd).display !== 'none',
      expanded: document.getElementById('settingsBtn').getAttribute('aria-expanded'),
      focused: document.activeElement ? document.activeElement.id : null,
      rowCount: rows.length,
      groups: groups,
      bindingCount: window.Shortcuts.bindings.length,
      hasMouseToggle: !!document.getElementById('setMouseNav'),
      insideViewport: pr.right <= window.innerWidth + 1 && pr.left >= -1,
      sample: rows.slice(0, 3)
    };
  })()`);
  check('gear button opens the Settings popup', settingsUi.open === true && settingsUi.expanded === 'true', JSON.stringify(settingsUi));
  check('the guide lists every registered binding, generated from the registry',
    settingsUi.rowCount === settingsUi.bindingCount && settingsUi.rowCount > 0,
    `rows=${settingsUi.rowCount} bindings=${settingsUi.bindingCount}`);
  check('the guide is grouped and shows real key caps',
    settingsUi.groups.length >= 3 && settingsUi.sample.every((r) => r.keys.length > 0 && r.label.length > 0),
    JSON.stringify(settingsUi.sample));
  check('Settings holds the mouse-navigation setting', settingsUi.hasMouseToggle === true);
  check('the Settings panel stays inside the viewport', settingsUi.insideViewport === true);
  check('focus moves into the Settings dialog', settingsUi.focused === 'settingsCloseBtn', String(settingsUi.focused));

  const settingsClosed = await cdp.eval(`(function () {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    var bd = document.getElementById('settingsBackdrop');
    return { closed: getComputedStyle(bd).display === 'none',
      focused: document.activeElement ? document.activeElement.id : null,
      expanded: document.getElementById('settingsBtn').getAttribute('aria-expanded') };
  })()`);
  check('Esc closes Settings and returns focus to the gear',
    settingsClosed.closed === true && settingsClosed.focused === 'settingsBtn' && settingsClosed.expanded === 'false',
    JSON.stringify(settingsClosed));

  const nav = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var out = {};
      // Drill into a session the way the UI does.
      document.querySelector('.session-card .sc-details').click();
      setTimeout(function () {
        out.afterDrill = { view: Store.getActiveId(), hist: window.Shortcuts.debug() };
        // Mouse back button, via the same entry point the Electron bridge uses.
        window.Shortcuts.back();
        setTimeout(function () {
          out.afterBack = { view: Store.getActiveId(), selected: Store.selectedSessionId, hist: window.Shortcuts.debug() };
          window.Shortcuts.forward();
          setTimeout(function () {
            out.afterForward = { view: Store.getActiveId(), selected: Store.selectedSessionId, hist: window.Shortcuts.debug() };
            // Alt+Left must do the same thing from the keyboard.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
            setTimeout(function () {
              out.afterAltLeft = { view: Store.getActiveId(), hist: window.Shortcuts.debug() };
              // A back with nothing behind it must be a no-op, not an error.
              var extra = window.Shortcuts.back();
              out.backAtStart = { returned: extra, view: Store.getActiveId(), hist: window.Shortcuts.debug() };
              // The crumb must follow history moves, not just clicks.
              out.crumbHidden = getComputedStyle(document.getElementById('crumb')).display === 'none';
              resolve(out);
            }, 120);
          }, 120);
        }, 120);
      }, 200);
    });
  })()`);
  check('drilling into a session records a history entry',
    nav.afterDrill.view === 'detail' && nav.afterDrill.hist.length === 2 && nav.afterDrill.hist.index === 1,
    JSON.stringify(nav.afterDrill));
  check('back returns to the board without dropping the forward entry',
    nav.afterBack.view === 'sessions' && nav.afterBack.selected === null && nav.afterBack.hist.index === 0 && nav.afterBack.hist.length === 2,
    JSON.stringify(nav.afterBack));
  check('forward re-opens the same session',
    nav.afterForward.view === 'detail' && nav.afterForward.hist.index === 1 && nav.afterForward.hist.state.view === 'detail',
    JSON.stringify(nav.afterForward));
  check('Alt+Left navigates back like the mouse button',
    nav.afterAltLeft.view === 'sessions' && nav.afterAltLeft.hist.index === 0, JSON.stringify(nav.afterAltLeft));
  check('back at the start of history is a no-op',
    nav.backAtStart.returned === false && nav.backAtStart.view === 'sessions' && nav.backAtStart.hist.index === 0,
    JSON.stringify(nav.backAtStart));
  check('the breadcrumb follows a history move, not only a click', nav.crumbHidden === true);

  // Bare-letter shortcuts must not fire while typing or behind an open dialog.
  const guards = await cdp.eval(`(function () {
    var openBd = function (id) { return getComputedStyle(document.getElementById(id)).display !== 'none'; };
    // 1) typing in a field
    window.ViewSessions.openNewSession();
    var name = document.getElementById('newSessionName');
    name.focus();
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    var statsAfterTyping = openBd('statsBackdrop');
    // 2) a dialog is open, focus is not in a field
    document.getElementById('newSessionCancelBtn').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    var statsBehindDialog = openBd('statsBackdrop');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // 3) with nothing open, S really does open the stats popup
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    var statsFromShortcut = openBd('statsBackdrop');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { statsAfterTyping: statsAfterTyping, statsBehindDialog: statsBehindDialog, statsFromShortcut: statsFromShortcut };
  })()`);
  check('a bare letter typed in a text field is not a shortcut', guards.statsAfterTyping === false, JSON.stringify(guards));
  check('a bare letter behind an open dialog is not a shortcut', guards.statsBehindDialog === false, JSON.stringify(guards));
  check('S opens the stats dashboard when nothing is open', guards.statsFromShortcut === true, JSON.stringify(guards));

  // Cards must be reachable and activatable from the keyboard at all.
  const cardKeys = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var card = document.querySelector('.session-card');
      var focusCalls = 0;
      var originalFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf('/focus') !== -1) {
          focusCalls += 1;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'focused' }); } });
        }
        return originalFetch(url, opts);
      };
      card.focus();
      var focused = document.activeElement === card;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      setTimeout(function () {
        window.fetch = originalFetch;
        resolve({ tabindex: card.getAttribute('tabindex'), role: card.getAttribute('role'), focused: focused, focusCalls: focusCalls });
      }, 200);
    });
  })()`);
  check('a session card is keyboard focusable', cardKeys.tabindex === '0' && cardKeys.role === 'button' && cardKeys.focused === true,
    JSON.stringify(cardKeys));
  check('Enter on a focused card jumps to its terminal', cardKeys.focusCalls === 1, JSON.stringify(cardKeys));

  // ---- Open in VS Code from a card. A one-click action with NO confirm (unlike
  // Take Control, which risks a duplicate tab): it creates nothing and is undone
  // by closing the window. It must also not double as a card click, i.e. it must
  // not focus the terminal too, which is what ev.stopPropagation() is for. Runs
  // after the takeControl block, so #confirmBackdrop is known to be closed and the
  // no-confirm assertion means something.
  const openEditor = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [], focusCalls = 0;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/open-editor') !== -1) {
          calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, dryRun: true }); } });
        }
        if (u.indexOf('/focus') !== -1) {
          focusCalls += 1;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'focused' }); } });
        }
        return originalFetch(url, opts);
      };
      // Explicitly a card whose folder this app has NOT opened, so the one VS Code
      // button is in its "open" state. Picking the first card would make this test
      // depend on the sort order deciding which state is under it.
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var card = cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf('awaiting-demo') !== -1;
      });
      var btn = card.querySelector('.sc-code');
      btn.click();
      btn.click(); // a second, immediate click must not fire a second request
      setTimeout(function () {
        var toast = document.querySelector('.toast');
        window.fetch = originalFetch;
        resolve({
          calls: calls, focusCalls: focusCalls,
          confirmOpen: getComputedStyle(document.getElementById('confirmBackdrop')).display !== 'none',
          toastText: toast ? toast.textContent : null,
          toastShown: !!toast && toast.classList.contains('show')
        });
      }, 400);
    });
  })()`);
  check('the card VS Code button POSTs /open-editor once, even on a double click', openEditor.calls.length === 1, JSON.stringify(openEditor));
  check('the card sends only a sessionId, never a client-side path',
    !!openEditor.calls[0] && !!openEditor.calls[0].sessionId && !('repo' in openEditor.calls[0]), JSON.stringify(openEditor.calls));
  check('the VS Code button does not also focus the terminal (stopPropagation)', openEditor.focusCalls === 0, JSON.stringify(openEditor));
  check('opening VS Code needs no confirm dialog', openEditor.confirmOpen === false, JSON.stringify(openEditor));
  check('opening VS Code reports back in a toast', openEditor.toastShown === true && /VS Code/.test(String(openEditor.toastText)),
    String(openEditor.toastText));

  // ---- The ONE VS Code button, which swaps between open and close the way the
  // flag button swaps between Resume later and Unflag. There used to be two buttons
  // with the close one revealed by `editorOpen`; now `editorOpen` picks the label.
  // SID's folder was opened during seeding, SID2's was not, which is the pair that
  // proves the two states really come from the server.
  const codeBtns = await cdp.eval(`(function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
    var pick = function (needle) {
      return cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf(needle) !== -1;
      });
    };
    var read = function (card) {
      if (!card) return null;
      var b = card.querySelector('.sc-code');
      if (!b) return null;
      return {
        label: b.textContent.trim(),
        shown: getComputedStyle(b).display !== 'none',
        isOpen: b.classList.contains('is-open')
      };
    };
    return {
      opened: read(pick('A Deliberately')),
      notOpened: read(pick('awaiting-demo')),
      strayCloseButtons: document.querySelectorAll('.sc-code-close').length
    };
  })()`);
  check('a card whose folder this app opened offers Close VS Code',
    codeBtns.opened && codeBtns.opened.label === 'Close VS Code' && codeBtns.opened.shown === true,
    JSON.stringify(codeBtns.opened));
  check('a card whose folder it did not open offers VS Code instead, never a close',
    codeBtns.notOpened && codeBtns.notOpened.label === 'VS Code' && codeBtns.notOpened.shown === true,
    JSON.stringify(codeBtns.notOpened));
  check('the open state is styled, so the two toggles in one row stay tellable apart',
    codeBtns.opened.isOpen === true && codeBtns.notOpened.isOpen === false, JSON.stringify(codeBtns));
  check('there is exactly ONE VS Code button per card (the old second button is gone)',
    codeBtns.strayCloseButtons === 0, String(codeBtns.strayCloseButtons));

  const closeClick = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [], focusCalls = 0;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/close-editor') !== -1) {
          calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, closed: true }); } });
        }
        if (u.indexOf('/focus') !== -1) {
          focusCalls += 1;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'focused' }); } });
        }
        return originalFetch(url, opts);
      };
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var card = cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf('A Deliberately') !== -1;
      });
      var btn = card.querySelector('.sc-code');
      btn.click();
      btn.click();
      setTimeout(function () {
        var toast = document.querySelector('.toast');
        window.fetch = originalFetch;
        resolve({
          calls: calls, focusCalls: focusCalls,
          confirmOpen: getComputedStyle(document.getElementById('confirmBackdrop')).display !== 'none',
          toastText: toast ? toast.textContent : null
        });
      }, 400);
    });
  })()`);
  check('the VS Code button in its close state POSTs /close-editor once, even on a double click',
    closeClick.calls.length === 1, JSON.stringify(closeClick));
  check('closing sends only a sessionId, never a client-side path',
    !!closeClick.calls[0] && !!closeClick.calls[0].sessionId && !('repo' in closeClick.calls[0]), JSON.stringify(closeClick.calls));
  check('the Close VS Code button does not also focus the terminal', closeClick.focusCalls === 0, JSON.stringify(closeClick));
  check('closing needs no confirm dialog of its own', closeClick.confirmOpen === false, JSON.stringify(closeClick));
  check('a successful close reports it in a toast', /Closed the VS Code window/.test(String(closeClick.toastText)), String(closeClick.toastText));

  // ---- Resume later. The card's button IS the state readout, painted from the
  // polled flag list rather than from the session record (the flag file belongs to
  // another process). The seeded flags cover both states in one render: 'render-1'
  // is flagged, 'render-2' is not.
  const flagLabels = await waitFor(async () => {
    const r = await cdp.eval(`(function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var pick = function (needle) {
        return cards.find(function (c) {
          var t = c.querySelector('.sc-title');
          return t && t.textContent.indexOf(needle) !== -1;
        });
      };
      var read = function (card) {
        if (!card) return null;
        var b = card.querySelector('.sc-flag');
        if (!b) return null;
        return { label: b.textContent.trim(), flaggedClass: b.classList.contains('is-flagged'), title: b.title };
      };
      return { flagged: read(pick('A Deliberately')), plain: read(pick('awaiting-demo')) };
    })()`);
    // Poll: the flag list is fetched after first paint, so the labels settle a beat
    // after the cards exist.
    return r && r.flagged && r.flagged.label === 'Unflag' ? r : null;
  }, 'the resume-later labels to settle');
  check('a flagged session\'s card offers Unflag, in the flagged style',
    flagLabels.flagged.label === 'Unflag' && flagLabels.flagged.flaggedClass === true, JSON.stringify(flagLabels));
  check('an unflagged session\'s card offers Resume later, unstyled',
    !!flagLabels.plain && flagLabels.plain.label === 'Resume later' && flagLabels.plain.flaggedClass === false,
    JSON.stringify(flagLabels));

  const flagClick = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [], focusCalls = 0;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/flag-resume') !== -1 || u.indexOf('/unflag-resume') !== -1) {
          calls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, persisted: true }); } });
        }
        if (u.indexOf('/focus') !== -1) {
          focusCalls += 1;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'focused' }); } });
        }
        return originalFetch(url, opts);
      };
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var card = cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf('awaiting-demo') !== -1;
      });
      var btn = card.querySelector('.sc-flag');
      btn.click();
      btn.click(); // a second, immediate click must not fire a second request
      setTimeout(function () {
        var toast = document.querySelector('.toast');
        window.fetch = originalFetch;
        resolve({
          calls: calls, focusCalls: focusCalls,
          confirmOpen: getComputedStyle(document.getElementById('confirmBackdrop')).display !== 'none',
          toastText: toast ? toast.textContent : null,
          toastShown: !!toast && toast.classList.contains('show')
        });
      }, 400);
    });
  })()`);
  check('Resume later POSTs /flag-resume once, even on a double click',
    flagClick.calls.length === 1 && /\/flag-resume/.test(String(flagClick.calls[0] && flagClick.calls[0].url)),
    JSON.stringify(flagClick));
  check('flagging sends only a sessionId, never a client-side path or name',
    !!flagClick.calls[0] && !!flagClick.calls[0].body && !!flagClick.calls[0].body.sessionId &&
      Object.keys(flagClick.calls[0].body).length === 1, JSON.stringify(flagClick.calls));
  check('Resume later does not also focus the terminal (stopPropagation)', flagClick.focusCalls === 0, JSON.stringify(flagClick));
  check('flagging needs no confirm dialog', flagClick.confirmOpen === false, JSON.stringify(flagClick));
  check('flagging reports back in a toast', flagClick.toastShown === true && /resume later/i.test(String(flagClick.toastText)),
    String(flagClick.toastText));

  const unflagClick = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [];
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/flag-resume') !== -1 || u.indexOf('/unflag-resume') !== -1) {
          calls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, persisted: true }); } });
        }
        return originalFetch(url, opts);
      };
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var card = cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf('A Deliberately') !== -1;
      });
      card.querySelector('.sc-flag').click();
      setTimeout(function () {
        var toast = document.querySelector('.toast');
        window.fetch = originalFetch;
        resolve({ calls: calls, toastText: toast ? toast.textContent : null });
      }, 400);
    });
  })()`);
  // The same button in its other state must hit the OTHER endpoint, or an already
  // flagged session would be flagged twice and never cleared from the picker.
  check('the same button unflags an already flagged session via /unflag-resume',
    unflagClick.calls.length === 1 && /\/unflag-resume/.test(String(unflagClick.calls[0] && unflagClick.calls[0].url)),
    JSON.stringify(unflagClick));
  check('unflagging from a card reports back in a toast',
    /no longer flagged/i.test(String(unflagClick.toastText)), String(unflagClick.toastText));

  // ---- The end-of-session panel. Driven through the same entry point the SSE
  // `session-ended` frame uses, so this exercises the real queue and the real panel
  // rather than a copy. Three things it must get right, all of them regressions
  // waiting to happen: only OK dismisses it (the two action buttons act and stay),
  // each action button flips to its opposite so a mistake is undone in place, and
  // two sessions ending together show one panel at a time.
  //
  // The first session is seeded with `editorOpen:false`, which is the case the old
  // dialog got wrong: it offered to close a window that was not there, or (with no
  // record at all) never appeared, so a session with no editor could not be flagged
  // for resume from the moment it actually ended.
  const endPanel = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [];
      // render-1 is flagged in the seeded flag file, render-2 is not: the pair that
      // proves the panel's flag button is a state readout and not a fixed label.
      var flagged = { 'render-1': true };
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/close-editor') !== -1 || u.indexOf('/open-editor') !== -1) {
          calls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, closed: true }); } });
        }
        // The flag stub MIRRORS state rather than answering a constant: the button
        // repaints from a re-read of /resume-flags after every toggle (deliberately,
        // so a failed write shows the truth on disk), so a stub that always answers
        // "nothing is flagged" would make a working toggle look broken.
        if (u.indexOf('/unflag-resume') !== -1) {
          var b1 = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url: u, body: b1 });
          delete flagged[b1.sessionId];
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, persisted: true }); } });
        }
        if (u.indexOf('/flag-resume') !== -1) {
          var b2 = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url: u, body: b2 });
          flagged[b2.sessionId] = true;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, persisted: true }); } });
        }
        if (u.indexOf('/resume-flags') !== -1) {
          return Promise.resolve({ json: function () {
            return Promise.resolve({ flags: Object.keys(flagged).map(function (id) { return { sessionId: id, name: id }; }) });
          } });
        }
        return originalFetch(url, opts);
      };
      window.ViewSessions.sessionEnded({ sessionId: 'render-1', folder: 'C:/fake/one', name: 'First Session', editorOpen: false });
      window.ViewSessions.sessionEnded({ sessionId: 'render-2', folder: 'C:/fake/two', name: 'Second Session', editorOpen: true });
      var read = function () {
        return {
          open: getComputedStyle(document.getElementById('endedBackdrop')).display !== 'none',
          title: document.getElementById('endedTitle').textContent,
          flagLabel: document.getElementById('endedFlagBtn').textContent.trim(),
          codeLabel: document.getElementById('endedCodeBtn').textContent.trim(),
          okLabel: document.getElementById('endedOkBtn').textContent.trim(),
          body: document.getElementById('endedText').textContent,
          path: document.getElementById('endedPath').textContent
        };
      };
      var first = read();
      document.getElementById('endedCodeBtn').click();
      setTimeout(function () {
        // Still open: an action button acts, it does not dismiss.
        var afterCode = read();
        document.getElementById('endedOkBtn').click();
        setTimeout(function () {
          var second = read();
          document.getElementById('endedFlagBtn').click();
          setTimeout(function () {
            var afterFlag = read();
            // Esc is the only other way out, and it must not act on anything.
            var callsBeforeEsc = calls.length;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            setTimeout(function () {
              var third = read();
              window.fetch = originalFetch;
              resolve({
                first: first, afterCode: afterCode, second: second,
                afterFlag: afterFlag, third: third,
                callsBeforeEsc: callsBeforeEsc, calls: calls
              });
            }, 120);
          }, 300);
        }, 120);
      }, 300);
    });
  })()`);
  check('a session ending raises the panel, whatever its editor state',
    endPanel.first.open === true && endPanel.first.title === 'Session ended', JSON.stringify(endPanel.first));
  check('the panel names the session and its folder',
    /First Session/.test(endPanel.first.body) && endPanel.first.path === 'C:/fake/one', JSON.stringify(endPanel.first));
  check('the panel always offers the resume toggle, reading the session\'s real flag state',
    endPanel.first.flagLabel === 'Unflag' && endPanel.second.flagLabel === 'Resume later',
    JSON.stringify({ first: endPanel.first.flagLabel, second: endPanel.second.flagLabel }));
  check('with no VS Code window open the panel offers to OPEN one, never to close nothing (issue #37)',
    endPanel.first.codeLabel === 'Open VS Code', String(endPanel.first.codeLabel));
  check('the button order is Resume later, VS Code, OK, and only OK dismisses',
    endPanel.first.okLabel === 'OK' && endPanel.afterCode.open === true, JSON.stringify(endPanel.afterCode));
  check('the VS Code action really fires and then flips to its opposite',
    endPanel.calls.length >= 1 && /\/open-editor/.test(String(endPanel.calls[0].url)) &&
      endPanel.calls[0].body.sessionId === 'render-1' && endPanel.afterCode.codeLabel === 'Close VS Code',
    JSON.stringify({ calls: endPanel.calls, after: endPanel.afterCode.codeLabel }));
  check('a second session ending queues behind the first instead of being dropped',
    endPanel.second.open === true && /Second Session/.test(endPanel.second.body), JSON.stringify(endPanel.second));
  check('a session whose editor IS open opens on Close VS Code',
    endPanel.second.codeLabel === 'Close VS Code', String(endPanel.second.codeLabel));
  check('Resume later POSTs /flag-resume with only a sessionId and flips to Unflag',
    endPanel.calls.some(function (c) { return /\/flag-resume/.test(c.url) && c.body.sessionId === 'render-2' && !('repo' in c.body); }) &&
      endPanel.afterFlag.flagLabel === 'Unflag' && endPanel.afterFlag.open === true,
    JSON.stringify({ calls: endPanel.calls, after: endPanel.afterFlag }));
  check('Esc dismisses the panel without acting on anything',
    endPanel.third.open === false && endPanel.calls.length === endPanel.callsBeforeEsc,
    JSON.stringify({ open: endPanel.third.open, before: endPanel.callsBeforeEsc, now: endPanel.calls.length }));

  // ---- Close session. The ONE destructive control on a card, so it is the only
  // footer button behind a confirm, and it must only exist while there is something
  // to close. Cancelling has to POST nothing at all: the whole point of the confirm
  // is that a stray click on a five-button row cannot kill a running session.
  const closeSession = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [], focusCalls = 0;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/close-session') !== -1) {
          calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'tab-closed', closed: true }); } });
        }
        if (u.indexOf('/focus') !== -1) {
          focusCalls += 1;
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'focused' }); } });
        }
        return originalFetch(url, opts);
      };
      // The board opens filtered to Active, so the ended session is not rendered at
      // all until the filter is widened. Restored below, since every later check
      // expects the default board.
      var flt = document.getElementById('fltState');
      flt.value = 'all';
      flt.dispatchEvent(new Event('change'));
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var pick = function (needle) {
        return cards.find(function (c) {
          var t = c.querySelector('.sc-title');
          return t && t.textContent.indexOf(needle) !== -1;
        });
      };
      var live = pick('A Deliberately');
      var ended = pick('ended-demo');
      var vis = function (card) {
        if (!card) return null;
        var b = card.querySelector('.sc-close');
        return b ? getComputedStyle(b).display !== 'none' : null;
      };
      var shownOnLive = vis(live);
      var shownOnEnded = vis(ended);
      var btn = live.querySelector('.sc-close');
      btn.click();
      var confirmOpen = getComputedStyle(document.getElementById('confirmBackdrop')).display !== 'none';
      var confirmLabel = document.getElementById('confirmOkBtn').textContent.trim();
      var confirmBody = document.getElementById('confirmText').textContent;
      // Cancel first: it must POST nothing.
      document.getElementById('confirmCancelBtn').click();
      setTimeout(function () {
        var callsAfterCancel = calls.length;
        btn.click();
        document.getElementById('confirmOkBtn').click();
        setTimeout(function () {
          var toast = document.querySelector('.toast');
          window.fetch = originalFetch;
          flt.value = 'active';
          flt.dispatchEvent(new Event('change'));
          resolve({
            shownOnLive: shownOnLive, shownOnEnded: shownOnEnded,
            confirmOpen: confirmOpen, confirmLabel: confirmLabel, confirmBody: confirmBody,
            callsAfterCancel: callsAfterCancel, calls: calls, focusCalls: focusCalls,
            toastText: toast ? toast.textContent : null
          });
        }, 400);
      }, 150);
    });
  })()`);
  check('Close session is offered on a running session', closeSession.shownOnLive === true, JSON.stringify(closeSession));
  check('Close session is NOT offered on a session that already ended (nothing to close)',
    closeSession.shownOnEnded === false, JSON.stringify(closeSession));
  check('Close session raises the in-app confirm, never acting on the first click',
    closeSession.confirmOpen === true && closeSession.confirmLabel === 'Close session', JSON.stringify(closeSession));
  check('the confirm says the session is stopped immediately and other tabs are left alone',
    /lost/i.test(String(closeSession.confirmBody)) && /Other tabs/i.test(String(closeSession.confirmBody)),
    String(closeSession.confirmBody));
  check('cancelling the confirm closes nothing', closeSession.callsAfterCancel === 0, JSON.stringify(closeSession));
  check('confirming POSTs /close-session once, with only a sessionId',
    closeSession.calls.length === 1 && !!closeSession.calls[0].sessionId && !('pid' in closeSession.calls[0]),
    JSON.stringify(closeSession.calls));
  check('Close session does not also focus the terminal (stopPropagation)',
    closeSession.focusCalls === 0, JSON.stringify(closeSession));
  check('closing a session reports the tab really went with it',
    /terminal tab/i.test(String(closeSession.toastText)), String(closeSession.toastText));

  // ---- Runtime ring thresholds. Driven by ageing the session's own startedAt in
  // the store and re-rendering through the REAL sessionsChanged path, so this
  // exercises paintRunRing rather than a copy of its arithmetic. The scale is
  // minutes with a full circle at 180, and the ramp must warn BEFORE 180: amber at
  // 60% (108 min) and red at 85% (153 min).
  const runRing = await cdp.eval(`(function () {
    var out = [];
    var s = Store.sessions.get('render-1');
    [[10,'lo'],[179,'lo'],[180,'mid'],[254,'mid'],[255,'hi'],[299,'hi'],[340,'hi']].forEach(function (pair) {
      s.startedAt = Date.now() - pair[0] * 60000;
      window.ViewSessions.sessionsChanged();
      var cards = Array.prototype.slice.call(document.querySelectorAll('.session-card'));
      var card = cards.find(function (c) {
        var t = c.querySelector('.sc-title');
        return t && t.textContent.indexOf('A Deliberately') !== -1;
      });
      var ring = card.querySelector('.sc-runring');
      out.push({
        min: pair[0], want: pair[1],
        shown: ring.querySelector('b').textContent,
        cls: /\\b(lo|mid|hi)\\b/.exec(ring.className),
        pct: ring.style.getPropertyValue('--pct')
      });
    });
    return out;
  })()`);
  const ramp = runRing.map((r) => `${r.min}min=${r.cls && r.cls[0]}/${r.shown}/${r.pct}`).join(' ');
  check('the runtime ring counts MINUTES, not a percentage',
    runRing.every((r) => r.shown === String(r.min)), ramp);
  check('the runtime ramp warns before 300: amber from 180 min, red from 255 min',
    runRing.every((r) => r.cls && r.cls[0] === r.want), ramp);
  check('the runtime arc fills proportionally and clamps at 300 min',
    runRing.find((r) => r.min === 10).pct === '3' && runRing.find((r) => r.min === 299).pct === '100' &&
      runRing.find((r) => r.min === 340).pct === '100', ramp);
  check('a session past 300 min keeps counting rather than freezing at 300',
    runRing.find((r) => r.min === 340).shown === '340', ramp);

  // ---- Resume picker. The flag file is seeded above, so this exercises the real
  // read path: the amber button counts them, the popup lists them newest-first
  // with a name the developer typed, and a flag whose session has been pruned from
  // the board is still offered (resuming needs only the id).
  const resumePicker = await cdp.eval(`(function () {
    return new Promise(function (resolve) {
      var originalFetch = window.fetch;
      var calls = [];
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf('/resume-flagged') !== -1) {
          calls.push(opts && opts.body ? JSON.parse(opts.body) : null);
          return Promise.resolve({ json: function () { return Promise.resolve({ ok: true, mode: 'reattached', unflagged: true, remaining: 1 }); } });
        }
        return originalFetch(url, opts);
      };
      document.getElementById('resumeOpenBtn').click();
      setTimeout(function () {
        var bd = document.getElementById('resumeBackdrop');
        var rows = Array.prototype.slice.call(document.querySelectorAll('.resume-row'));
        var read = {
          badge: document.getElementById('resumeCount').textContent,
          badgeShown: getComputedStyle(document.getElementById('resumeCount')).display !== 'none',
          open: getComputedStyle(bd).display !== 'none',
          rowCount: rows.length,
          names: rows.map(function (r) { return r.querySelector('.rr-name').textContent; }),
          metas: rows.map(function (r) { return r.querySelector('.rr-meta').textContent; }),
          emptyShown: getComputedStyle(document.getElementById('resumeEmpty')).display !== 'none',
          focused: document.activeElement ? document.activeElement.textContent : null
        };
        rows[0].querySelector('.gobtn').click();
        setTimeout(function () {
          window.fetch = originalFetch;
          read.calls = calls;
          read.closedAfterEsc = (function () {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return getComputedStyle(bd).display === 'none';
          })();
          resolve(read);
        }, 300);
      }, 400);
    });
  })()`);
  check('the amber Resume session button counts the flagged sessions',
    resumePicker.badge === '2' && resumePicker.badgeShown === true, JSON.stringify(resumePicker));
  check('the resume picker opens and lists every flagged session',
    resumePicker.open === true && resumePicker.rowCount === 2 && resumePicker.emptyShown === false,
    JSON.stringify(resumePicker));
  check('a flagged session shows the name the developer gave it',
    resumePicker.names.indexOf('Samberg VIBE Extension') !== -1, JSON.stringify(resumePicker.names));
  check('the picker shows when it was flagged, and the note',
    /flagged 12m ago/.test(resumePicker.metas.join(' ')) && /save tokens/.test(resumePicker.metas.join(' ')),
    JSON.stringify(resumePicker.metas));
  check('a flag whose session left the board is still offered, and says so',
    /not on the board any more/.test(resumePicker.metas.join(' ')), JSON.stringify(resumePicker.metas));
  check('Resume POSTs /resume-flagged for that session id',
    resumePicker.calls.length === 1 && resumePicker.calls[0].sessionId === 'render-1', JSON.stringify(resumePicker.calls));
  check('Esc closes the resume picker', resumePicker.closedAfterEsc === true, JSON.stringify(resumePicker));

  // ---- The 7 day bar claims the header gap between the Resume button and the
  // icon buttons, and must never push those off the row. Geometry, because that is
  // the only thing that proves "fills the space it has left".
  const sevenBar = await cdp.eval(`(function () {
    var r = function (sel) { var e = document.querySelector(sel); if (!e) return null; var b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), top: Math.round(b.top), h: Math.round(b.height) }; };
    return {
      resume: r('#resumeOpenBtn'), bar: r('.m7'), track: r('.m7-track'), actions: r('.hdr-actions'),
      isRing: !!document.querySelector('#usageMeters .ring'),
      val: (document.querySelector('.m7-val') || {}).textContent || '',
      reset: (document.querySelector('.m7-reset') || {}).textContent || '',
      pageScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
    };
  })()`);
  check('the 7 day window is a bar, not a ring any more', sevenBar.isRing === false, JSON.stringify(sevenBar.isRing));
  check('the 7 day bar sits between the Resume button and the icon buttons',
    sevenBar.bar.left >= sevenBar.resume.right && sevenBar.bar.right <= sevenBar.actions.left + 1,
    JSON.stringify(sevenBar));
  check('the 7 day bar actually fills that gap rather than hugging one side',
    sevenBar.track.w > 120 && (sevenBar.actions.left - sevenBar.resume.right) - sevenBar.bar.w < 40,
    JSON.stringify(sevenBar));
  check('adding the 7 day bar causes no page-level horizontal scroll',
    sevenBar.pageScrollW <= sevenBar.innerW + 1, JSON.stringify(sevenBar));
  check('the 7 day bar still reports its percentage', /%$/.test(sevenBar.val.trim()), sevenBar.val);
  // A 7 day reset is days out, so a bare clock time would be ambiguous: the
  // weekday is prefixed unless it lands today.
  check('the 7 day bar says when it resets, with a weekday since it is days out',
    /^resets (\w{3} )?\d\d:\d\d$/.test(sevenBar.reset.trim()), sevenBar.reset);

  // The quota bar's reading age is always visible, not only once stale: a
  // percentage with no age reads as live when the feed may be minutes behind.
  const quotaAge = await cdp.eval(`(function () {
    var stats = Array.prototype.map.call(document.querySelectorAll('#quotaBar .qstat'), function (s) {
      return {
        label: s.querySelector('b').textContent,
        value: s.querySelector('.qval').textContent,
        labelSize: getComputedStyle(s.querySelector('b')).fontSize,
        valueSize: getComputedStyle(s.querySelector('.qval')).fontSize
      };
    });
    return { stats: stats, age: document.getElementById('quotaAge').textContent, note: document.getElementById('quotaNote').textContent };
  })()`);
  check('the quota bar shows the reset time and how old the reading is',
    /^\d\d:\d\d$/.test(quotaAge.note.trim()) && /ago|just now/.test(quotaAge.age), JSON.stringify(quotaAge));
  // Every piece of the row is ONE size, labels and values alike: an oversized
  // value read as a headline with fine print bolted onto it.
  const quotaSizes = quotaAge.stats.flatMap((s) => [s.labelSize, s.valueSize]);
  check('the whole quota stat row is one type size, labels and values alike',
    quotaAge.stats.length === 3 && new Set(quotaSizes).size === 1, JSON.stringify(quotaAge.stats));

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
    // Third shot: Settings with the generated shortcuts guide.
    await cdp.eval(`(function () {
      document.getElementById('confirmCancelBtn').click();
      document.getElementById('settingsBtn').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const setShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const setPath = SHOT.replace(/(\.png)?$/i, '') + '-settings.png';
    fs.writeFileSync(setPath, Buffer.from(setShot.data, 'base64'));
    process.stdout.write('screenshot: ' + setPath + '\n');
    // Fourth shot: the New session popup with the folder chain cascaded as deep as
    // it goes. The one-row-chain fix is asserted by geometry above, but it is also
    // the change a human should actually look at.
    await cdp.eval(`(function () {
      document.getElementById('settingsCloseBtn').click();
      window.ViewSessions.openNewSession();
      var host = document.getElementById('newSessionSelectors');
      for (var guard = 0; guard < 8; guard++) {
        var last = host.children[host.children.length - 1];
        if (!last || last.options.length < 2) break;
        var before = host.children.length;
        last.selectedIndex = 1;
        last.dispatchEvent(new Event('change'));
        if (host.children.length === before) break;
      }
      return host.children.length;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const nsShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const nsPath = SHOT.replace(/(\.png)?$/i, '') + '-new-session.png';
    fs.writeFileSync(nsPath, Buffer.from(nsShot.data, 'base64'));
    process.stdout.write('screenshot: ' + nsPath + '\n');
    // Fifth shot: the end-of-session panel, for the same reason as the Take Control
    // shot: a modal that is closed again by the time the board settles cannot
    // otherwise be looked at. Shot with an editor open, so all three buttons are in
    // the state that has the most to look at.
    await cdp.eval(`(function () {
      document.getElementById('newSessionCancelBtn').click();
      window.ViewSessions.sessionEnded({ sessionId: 'render-1', folder: 'C:/Users/pr/repos/1-Personal/MissionControlCenter', name: 'A Deliberately Very Long Session Name To Force Ellipsis', editorOpen: true });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const endShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const endPath = SHOT.replace(/(\.png)?$/i, '') + '-session-ended.png';
    fs.writeFileSync(endPath, Buffer.from(endShot.data, 'base64'));
    process.stdout.write('screenshot: ' + endPath + '\n');
    // Sixth shot: the resume picker, populated from the seeded flag file.
    await cdp.eval(`(function () {
      document.getElementById('endedOkBtn').click();
      window.ViewSessions.openResume();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const resShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const resPath = SHOT.replace(/(\.png)?$/i, '') + '-resume.png';
    fs.writeFileSync(resPath, Buffer.from(resShot.data, 'base64'));
    process.stdout.write('screenshot: ' + resPath + '\n');
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
