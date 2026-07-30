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
  check('Needs input filter option exists', facts.stateOptions.indexOf('needs-input') !== -1, JSON.stringify(facts.stateOptions));
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

  // Needs-input filter, driven the way the attention pill drives it.
  const filterResult = await cdp.eval(`(function () {
    window.ViewSessions.setStateFilter('needs-input');
    return { selValue: document.getElementById('fltState').value,
      cards: document.querySelectorAll('.session-card').length };
  })()`);
  check('pill switches the visible filter to needs-input', filterResult.selValue === 'needs-input', JSON.stringify(filterResult));
  check('blocked session still listed under Needs input', filterResult.cards >= 1, JSON.stringify(filterResult));
  await cdp.eval(`window.ViewSessions.setStateFilter('active')`);

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

  const errs = cdp.jsErrors();
  check('no JS or console errors on the board', errs.length === 0, errs.slice(0, 5).join(' | '));

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    process.stdout.write('\nscreenshot: ' + SHOT + '\n');
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
