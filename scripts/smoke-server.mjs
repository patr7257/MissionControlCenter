// Smoke test for the mission control server. Boots server.mjs in a hermetic
// temp HOME (so the real ~/.claude is untouched), checks the core endpoints,
// exercises one hook event, and exits non-zero on any failure. Zero deps: only
// Node built-ins plus the global fetch. Used by CI and runnable locally:
//   node scripts/smoke-server.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-smoke-'));
const PORT = 4318;
const BASE = `http://127.0.0.1:${PORT}`;
// The registry reconcile poll defaults to 2500ms in production; sped up here
// so the registry test cases below do not have to sleep that long.
const REGISTRY_POLL_MS = 250;
const REGISTRY_DIR = path.join(TMP_HOME, '.claude', 'sessions');
fs.mkdirSync(REGISTRY_DIR, { recursive: true });
// openInVsCode() requires the folder to really exist, so the /open-editor cases
// get real directories inside the temp HOME's repos root (the containment check
// for a client-supplied path resolves against <HOME>/repos).
const OPEN_DIR = path.join(TMP_HOME, 'repos', '1-Personal', 'opener-demo');
const OPEN_SEMI_DIR = path.join(TMP_HOME, 'repos', '1-Personal', 'semi;colon');
const OPEN_GONE_DIR = path.join(TMP_HOME, 'repos', '1-Personal', 'deleted-repo');
const OPEN_OUTSIDE_DIR = path.join(TMP_HOME, 'not-repos');
// Exists, is inside the repos root, and is deliberately never opened: the fixture
// for "close refuses a folder this app did not open".
const OPEN_GONE_NEVER_OPENED = path.join(TMP_HOME, 'repos', '1-Personal', 'never-opened');
fs.mkdirSync(OPEN_GONE_NEVER_OPENED, { recursive: true });
fs.mkdirSync(OPEN_DIR, { recursive: true });
fs.mkdirSync(OPEN_SEMI_DIR, { recursive: true });
fs.mkdirSync(OPEN_OUTSIDE_DIR, { recursive: true });
// CMC_DRY_RUN keeps terminal.mjs from spawning real Windows Terminal tabs (and
// from writing state files), so /launch can be asserted on any platform.
const env = {
  ...process.env,
  USERPROFILE: TMP_HOME,
  HOME: TMP_HOME,
  CMC_DRY_RUN: '1',
  CMC_REGISTRY_POLL_MS: String(REGISTRY_POLL_MS),
  // VS Code is NOT installed on the CI runner, and this script must assert the
  // command shape rather than discovery. process.execPath is a real existing
  // executable everywhere, and nothing is ever spawned under CMC_DRY_RUN, so the
  // reported command stays deterministic and platform neutral.
  CMC_VSCODE_EXE: process.execPath,
};

// Registry files are keyed by pid; registryPidAlive() in server.mjs does a
// real process.kill(pid, 0) existence probe, so tests use this script's own
// pid (alive for the whole run) to simulate a live session, and a pid that
// was never issued to simulate a crashed/stale one.
const FAKE_DEAD_PID = 999999;
function writeRegistryFile(id, obj) {
  fs.writeFileSync(path.join(REGISTRY_DIR, `${id}.json`), JSON.stringify(obj));
}
function removeRegistryFile(id) {
  fs.rmSync(path.join(REGISTRY_DIR, `${id}.json`), { force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, cond) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!cond) failed = true;
}

async function readSnapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue; // skip the leading "retry:" frame
      reader.cancel();
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

// stderr is INHERITED, not ignored: a server that throws used to fail this suite
// with a wall of unexplained FAILs and no stack trace anywhere, in CI included.
// stdout stays ignored (the server is chatty about backfill on boot).
const srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], { env, stdio: ['ignore', 'ignore', 'inherit'] });

async function cleanup(code) {
  try {
    srv.kill();
  } catch {}
  await sleep(200);
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(150);
  }
  check('server responds on GET /', up);
  if (!up) await cleanup(1);

  const root = await fetch(`${BASE}/`);
  check('GET / returns 200', root.status === 200);

  const repos = await fetch(`${BASE}/repos`);
  check('GET /repos returns 200', repos.status === 200);
  const reposBody = await repos.json();
  check('GET /repos returns a { root, tree } folder tree', reposBody && typeof reposBody.root === 'string' && Array.isArray(reposBody.tree));
  check(
    'GET /repos exposes an accounts array with both registry keys and no configDir',
    Array.isArray(reposBody.accounts) &&
      reposBody.accounts.some((a) => a.key === 'personal') &&
      reposBody.accounts.some((a) => a.key === 'work') &&
      reposBody.accounts.every((a) => !('configDir' in a))
  );

  // The PowerShell script the tab runs never appears literally on the wt
  // command line any more: it travels as a base64 -EncodedCommand payload,
  // because wt treats `;` as its own command separator even inside a quoted
  // argument and used to turn each `$env:X='y'; ` statement into a junk tab.
  // So decode what really runs, rather than asserting on a readable copy.
  function decodedScript(result) {
    if (!result || typeof result.command !== 'string') return '';
    const match = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(result.command);
    if (!match) return '';
    return Buffer.from(match[1], 'base64').toString('utf16le');
  }

  // The regression assertion for this whole mechanism: not one generated wt
  // argument may carry a raw semicolon.
  function hasNoSemicolon(result) {
    return Boolean(result) && typeof result.command === 'string' && !result.command.includes(';');
  }

  // GH_CONFIG_DIR plus the four git identity vars must precede `claude` in the
  // decoded script, whichever account it resolved to, one statement per line.
  function hasGhEnvPrefix(script) {
    return (
      typeof script === 'string' &&
      /^\$env:GH_CONFIG_DIR='[^']*'\n\$env:GIT_AUTHOR_NAME='[^']*'\n\$env:GIT_AUTHOR_EMAIL='[^']*'\n\$env:GIT_COMMITTER_NAME='[^']*'\n\$env:GIT_COMMITTER_EMAIL='[^']*'\nclaude/.test(
        script
      )
    );
  }

  // Launch command shape: the tab is hosted by PowerShell (profile loads, tab
  // survives Claude exiting) and an optional session name is passed through as
  // `claude --name '<name>'` with the name also used as the tab title.
  const launchNamed = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'smoke name', name: 'smoke name' }),
  })).json();
  check('POST /launch succeeds', launchNamed && launchNamed.ok === true);
  const namedScript = decodedScript(launchNamed);
  check(
    'POST /launch hosts the tab in PowerShell via a base64 -EncodedCommand payload',
    launchNamed &&
      typeof launchNamed.command === 'string' &&
      launchNamed.command.includes('--title "smoke name"') &&
      launchNamed.command.includes('powershell.exe -NoExit -EncodedCommand ') &&
      namedScript.length > 0
  );
  check(
    'POST /launch passes the name to claude --name inside the encoded payload',
    namedScript.endsWith("claude --name 'smoke name'")
  );
  check(
    'POST /launch returns the decoded payload as `script` so it matches what runs',
    launchNamed && launchNamed.script === namedScript
  );
  check('POST /launch generates no wt argument containing a semicolon', hasNoSemicolon(launchNamed));
  check('POST /launch under a non-2-ZRM path resolves to the personal account', launchNamed && launchNamed.account === 'patr7257');
  check('POST /launch sets GH_CONFIG_DIR and the four git identity vars before claude', hasGhEnvPrefix(namedScript));

  const launchPlain = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'smoke-repo' }),
  })).json();
  const plainScript = decodedScript(launchPlain);
  check(
    'POST /launch without a name runs bare claude under PowerShell, prefixed with the account env vars',
    plainScript.endsWith('\nclaude') && hasGhEnvPrefix(plainScript) && hasNoSemicolon(launchPlain)
  );

  // A semicolon in a value we cannot sanitize away (the repo path must stay a
  // usable directory) is refused outright rather than splitting the wt command
  // line into junk tabs. A semicolon in the TITLE is sanitized instead, so it
  // launches normally.
  const launchSemicolonPath = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke;repo', title: 'semicolon path' }),
  })).json();
  check(
    'POST /launch refuses a repo path containing a semicolon instead of spawning junk tabs',
    launchSemicolonPath && launchSemicolonPath.ok === false && /semicolon/i.test(String(launchSemicolonPath.error))
  );
  const launchSemicolonTitle = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'bad;title' }),
  })).json();
  check(
    'POST /launch sanitizes a semicolon out of the tab title and still launches',
    launchSemicolonTitle && launchSemicolonTitle.ok === true && hasNoSemicolon(launchSemicolonTitle)
  );

  // Path-based account resolution: a repo under a 2-ZRM segment resolves to
  // przrm, anything else resolves to patr7257, when no account is given.
  const launchZrmPath = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/repos/2-ZRM/customers/some-app', title: 'zrm-app' }),
  })).json();
  check('POST /launch under a 2-ZRM path resolves to the work account (przrm)', launchZrmPath && launchZrmPath.account === 'przrm');

  // Explicit account override wins in both directions.
  const launchOverrideToWork = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'override-work', account: 'work' }),
  })).json();
  check('POST /launch with an explicit work override wins over a non-2-ZRM path', launchOverrideToWork && launchOverrideToWork.account === 'przrm');
  const launchOverrideToPersonal = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/repos/2-ZRM/customers/some-app', title: 'override-personal', account: 'personal' }),
  })).json();
  check(
    'POST /launch with an explicit personal override wins over a 2-ZRM path',
    launchOverrideToPersonal && launchOverrideToPersonal.account === 'patr7257'
  );

  // An invalid/garbage account value must fall back to the path default and
  // must never reach the generated command string as-is (it is not one of
  // the fixed registry keys, so it can never be interpolated into the shell).
  const launchGarbageAccount = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'garbage-account', account: "x'; rm -rf /" }),
  })).json();
  check(
    'POST /launch with a garbage account value falls back to the path default (personal)',
    launchGarbageAccount && launchGarbageAccount.account === 'patr7257'
  );
  check(
    'POST /launch with a garbage account value never lets it reach the command string',
    launchGarbageAccount &&
      typeof launchGarbageAccount.command === 'string' &&
      !launchGarbageAccount.command.includes('rm -rf') &&
      !decodedScript(launchGarbageAccount).includes('rm -rf')
  );

  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-1', cwd: 'C:/tmp/smoke' }),
  });
  await sleep(300);
  const snap = await readSnapshot();
  check('snapshot has type snapshot', snap && snap.type === 'snapshot');
  check('ingested session appears in snapshot', snap && snap.sessions.some((s) => s.id === 'smoke-1'));
  const smoke1 = snap && snap.sessions.find((s) => s.id === 'smoke-1');
  check('no-model SessionStart serializes model as null', smoke1 && smoke1.model === null);

  // Reopen/resume builds its command the same way as a launch, so it carries the
  // same semicolon hazard and must pass the same assertions. Needs a known
  // session (its cwd comes from the server's own record), hence running here
  // rather than next to the /launch checks.
  const reopened = await (await fetch(`${BASE}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-1' }),
  })).json();
  const reopenScript = decodedScript(reopened);
  check('POST /reopen reattaches with claude --resume in an encoded payload', reopened && reopened.ok === true && reopened.mode === 'reattached' && reopenScript.endsWith('claude --resume smoke-1'));
  check('POST /reopen sets the account env vars before claude --resume', hasGhEnvPrefix(reopenScript));
  check('POST /reopen generates no wt argument containing a semicolon', hasNoSemicolon(reopened));

  // ---- Open in VS Code (POST /open-editor). Deliberately NOT routed through wt:
  // a tab that ran `code .` and closed itself would shift every later tab down by
  // one while managedTabs kept its old positional tabIndex, so every subsequent
  // focus click would jump to the wrong tab. Hence a direct GUI-exe spawn, which
  // is also why no console window can flash.
  const openByPath = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_DIR }),
  })).json();
  check('POST /open-editor with a client path succeeds', openByPath && openByPath.ok === true && openByPath.dryRun === true);
  check(
    'POST /open-editor reports the REAL command: the resolved exe plus the folder',
    openByPath && typeof openByPath.command === 'string' &&
      openByPath.command.includes(process.execPath) && openByPath.command.includes(OPEN_DIR)
  );
  check(
    'POST /open-editor never routes through Windows Terminal or a shell (the tabIndex invariant)',
    openByPath && !/(^|["\s])wt(\.exe)?["\s]/i.test(openByPath.command) &&
      !/cmd(\.exe)?["\s]+\/c|powershell/i.test(openByPath.command) &&
      !('tabIndex' in openByPath)
  );

  // A folder NAME containing a semicolon is fine here and refused by /launch: the
  // semicolon rule is a wt command-line invariant and this path builds none.
  const openSemi = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_SEMI_DIR }),
  })).json();
  check('POST /open-editor accepts a folder name with a semicolon (unlike /launch, which must refuse it)', openSemi && openSemi.ok === true);

  // The card path sends only a sessionId; the server resolves the cwd itself,
  // exactly as /focus and /reopen do.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-open', cwd: OPEN_DIR }),
  });
  await sleep(200);
  const openBySession = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-open' }),
  })).json();
  check(
    'POST /open-editor resolves the folder server side from a sessionId alone',
    openBySession && openBySession.ok === true && String(openBySession.command).includes(OPEN_DIR)
  );
  const openBoth = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-open', repo: OPEN_SEMI_DIR }),
  })).json();
  check(
    'POST /open-editor prefers the server-resolved session cwd over a client path',
    openBoth && openBoth.ok === true && String(openBoth.command).includes(OPEN_DIR) &&
      !String(openBoth.command).includes(OPEN_SEMI_DIR)
  );

  const openUnknownRes = await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'no-such-session' }),
  });
  const openUnknown = await openUnknownRes.json();
  check(
    'POST /open-editor for an unknown session answers 200 with an explanatory failure',
    openUnknownRes.status === 200 && openUnknown && openUnknown.ok === false &&
      /working directory/i.test(String(openUnknown.error))
  );
  const openGone = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_GONE_DIR }),
  })).json();
  check('POST /open-editor refuses a folder that is gone', openGone && openGone.ok === false && /exist/i.test(String(openGone.error)));
  const openOutside = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_OUTSIDE_DIR }),
  })).json();
  check(
    'POST /open-editor refuses a client path outside the repos root',
    openOutside && openOutside.ok === false && openOutside.reason === 'outside-root'
  );
  const openTraversal = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: path.join(TMP_HOME, 'repos', '..', 'not-repos') }),
  })).json();
  check(
    'POST /open-editor refuses a .. traversal out of the repos root',
    openTraversal && openTraversal.ok === false && openTraversal.reason === 'outside-root'
  );
  const openEmpty = await (await fetch(`${BASE}/open-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  check('POST /open-editor with neither a session nor a folder fails cleanly', openEmpty && openEmpty.ok === false);

  // ---- Closing a VS Code window (POST /close-editor). Scoped to windows THIS app
  // opened, which is the whole safety story: there is no way to identify a window
  // except by title, so refusing anything we have no record of is what stops it
  // closing an editor the developer opened by hand.
  const snapAfterOpen = await readSnapshot();
  const openedSession = snapAfterOpen && snapAfterOpen.sessions.find((s) => s.id === 'smoke-open');
  check('a session whose folder we opened reports editorOpen, so the card shows Close VS Code',
    !!openedSession && openedSession.editorOpen === true);
  const otherSession = snapAfterOpen && snapAfterOpen.sessions.find((s) => s.id === 'smoke-1');
  check('a session whose folder we never opened reports editorOpen false',
    !!otherSession && otherSession.editorOpen === false);

  const closeNotOurs = await (await fetch(`${BASE}/close-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_GONE_NEVER_OPENED }),
  })).json();
  check('POST /close-editor refuses a folder this app never opened',
    closeNotOurs && closeNotOurs.ok === false && closeNotOurs.reason === 'not-ours');

  const closeBySession = await (await fetch(`${BASE}/close-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-open' }),
  })).json();
  check('POST /close-editor closes the window for a folder we opened',
    closeBySession && closeBySession.ok === true && closeBySession.dryRun === true);
  check('POST /close-editor matches the window by folder BASENAME, never a full path',
    closeBySession && closeBySession.baseName === path.basename(OPEN_DIR) &&
      typeof closeBySession.script === 'string' && closeBySession.script.includes(path.basename(OPEN_DIR)) &&
      !closeBySession.script.includes(OPEN_DIR));
  check('the close script posts WM_CLOSE (0x0010) and never sends a keystroke or steals focus',
    closeBySession && /PostMessage\(h, 0x0010/.test(closeBySession.script) &&
      !/SendKeys|AppActivate|SetForegroundWindow|mouse_event|SendInput/i.test(closeBySession.script));
  check('the close script only ever targets a VS Code process',
    closeBySession && /ProcessName/.test(closeBySession.script) && closeBySession.script.includes("'code'"));
  check('the close script refuses rather than guessing when two windows match',
    closeBySession && /\$hits\.Count -gt 1/.test(closeBySession.script));

  const closeTwice = await (await fetch(`${BASE}/close-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-open' }),
  })).json();
  check('closing forgets the record, so a second close is refused as not ours',
    closeTwice && closeTwice.ok === false && closeTwice.reason === 'not-ours');
  const snapAfterClose = await readSnapshot();
  const closedSession = snapAfterClose && snapAfterClose.sessions.find((s) => s.id === 'smoke-open');
  check('editorOpen goes back to false after a close, so the button disappears',
    !!closedSession && closedSession.editorOpen === false);

  const closeEmpty = await (await fetch(`${BASE}/close-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  check('POST /close-editor with neither a session nor a folder fails cleanly', closeEmpty && closeEmpty.ok === false);
  const closeOutside = await (await fetch(`${BASE}/close-editor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: OPEN_OUTSIDE_DIR }),
  })).json();
  check('POST /close-editor refuses a client path outside the repos root',
    closeOutside && closeOutside.ok === false && closeOutside.reason === 'outside-root');

  // Subagent-only session: a session that never gets a top-level hook (no
  // SessionStart/UserPromptSubmit of its own) must not sit on the 'working'
  // default forever. SubagentStart is the event server.mjs listens for
  // (handleEvent's second switch, ~line 495); it carries the subagent's own
  // agent_id plus the parent session_id, no cwd or model.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'SubagentStart',
      session_id: 'smoke-2-parent',
      agent_id: 'smoke-2-agent',
      agent_type: 'general-purpose',
    }),
  });
  await sleep(300);
  const snap2 = await readSnapshot();
  const subagentOnly = snap2 && snap2.sessions.find((s) => s.id === 'smoke-2-parent');
  check('subagent-only session appears in snapshot', !!subagentOnly);
  check(
    'subagent-only session status is derived (working) from its active child, not left on a stale default',
    subagentOnly && subagentOnly.status === 'working'
  );

  // Statusline ingestion (POST /statusline): the payload shape Claude Code
  // pipes on stdin to the statusLine command, forwarded here by
  // statusline-feed.mjs. session_id matches the 'smoke-1' session created
  // above via SessionStart.
  const statuslinePayload = {
    session_id: 'smoke-1',
    transcript_path: 'C:/tmp/smoke/transcript.jsonl',
    cwd: 'C:/tmp/smoke',
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: {
      total_input_tokens: 12345,
      total_output_tokens: 678,
      context_window_size: 200000,
      current_usage: 12345,
      used_percentage: 42.5,
      remaining_percentage: 57.5,
    },
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
    workspace: { current_dir: 'C:/tmp/smoke' },
    version: '2.1.220',
  };
  await fetch(`${BASE}/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(statuslinePayload),
  });
  await sleep(300);
  const snap3 = await readSnapshot();
  const s1 = snap3 && snap3.sessions.find((s) => s.id === 'smoke-1');
  check(
    'statusline payload populates modelDisplay/ctx fields on the session_id-matched session',
    !!s1 &&
      s1.modelDisplay === 'Opus 5' &&
      s1.ctxPct === 42.5 &&
      s1.ctxTokens === 12345 &&
      s1.ctxSize === 200000 &&
      typeof s1.usageAt === 'number'
  );
  check(
    'statusline payload backfills a null model from model.id',
    s1 && s1.model === 'claude-opus-5'
  );
  check(
    'snapshot carries a usage object with both windows in ms-epoch resetsAt',
    !!(
      snap3 &&
      snap3.usage &&
      snap3.usage.fiveHour &&
      snap3.usage.fiveHour.pct === 10 &&
      snap3.usage.fiveHour.resetsAt > 1e12 &&
      snap3.usage.sevenDay &&
      snap3.usage.sevenDay.pct === 20 &&
      snap3.usage.sevenDay.resetsAt > 1e12
    )
  );

  // cwd-fallback: a statusline payload with no session_id at all must still
  // resolve to the right session by matching a tracked session's cwd.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-3', cwd: 'C:/tmp/smoke-3' }),
  });
  await sleep(200);
  const cwdFallbackPayload = { ...statuslinePayload, cwd: 'C:/tmp/smoke-3', model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' } };
  delete cwdFallbackPayload.session_id;
  await fetch(`${BASE}/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cwdFallbackPayload),
  });
  await sleep(300);
  const snap4 = await readSnapshot();
  const s3 = snap4 && snap4.sessions.find((s) => s.id === 'smoke-3');
  check(
    'statusline payload with no session_id resolves via cwd fallback',
    !!s3 && s3.modelDisplay === 'Sonnet 5'
  );

  // A payload with no rate_limits key at all (neither window active yet) must
  // not throw, and must not clobber the previously recorded usage.
  const noRateLimitsPayload = { ...statuslinePayload, model: { id: 'claude-opus-5', display_name: 'Opus 5 (later)' } };
  delete noRateLimitsPayload.rate_limits;
  await fetch(`${BASE}/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(noRateLimitsPayload),
  });
  await sleep(300);
  const snap5 = await readSnapshot();
  check('statusline payload with no rate_limits key does not blow up', !!snap5);
  check(
    'statusline payload with no rate_limits key does not clobber previously recorded usage',
    !!(
      snap5 &&
      snap5.usage &&
      snap5.usage.fiveHour &&
      snap5.usage.fiveHour.pct === 10 &&
      snap5.usage.sevenDay &&
      snap5.usage.sevenDay.pct === 20
    )
  );

  // Fix (e): a main-session tool call (no agent_id) must unblock a stuck
  // 'needs-permission' status immediately, and must never create a phantom
  // agent/card in the subagent lanes.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-7', cwd: 'C:/tmp/smoke-7' }),
  });
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'Notification',
      session_id: 'smoke-7',
      notification_type: 'permission_prompt',
    }),
  });
  await sleep(200);
  const beforeUnblock = await readSnapshot();
  const s7Before = beforeUnblock && beforeUnblock.sessions.find((s) => s.id === 'smoke-7');
  check('smoke-7 is needs-permission before the main-session tool call', s7Before && s7Before.status === 'needs-permission');
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'smoke-7', tool_name: 'Bash' }),
  });
  await sleep(300);
  const afterUnblock = await readSnapshot();
  const s7After = afterUnblock && afterUnblock.sessions.find((s) => s.id === 'smoke-7');
  check(
    'a main-session PreToolUse (no agent_id) clears needs-permission to working',
    s7After && s7After.status === 'working'
  );
  check(
    'a main-session PreToolUse (no agent_id) creates no phantom agent card',
    !!afterUnblock && !afterUnblock.agents.some((a) => a.parentSession === 'smoke-7')
  );

  // Registry reconciliation (~/.claude/sessions/*.json, polled every
  // REGISTRY_POLL_MS). Each case below sets up a session at a known status,
  // drops a registry file, waits a couple of poll ticks, then reads the
  // snapshot back.
  const registrySettle = () => sleep(REGISTRY_POLL_MS * 3);

  // (a) a 'busy' registry file clears a session we had marked needs-permission.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-r1', cwd: 'C:/tmp/smoke-r1' }),
  });
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Notification', session_id: 'smoke-r1', notification_type: 'permission_prompt' }),
  });
  await sleep(150);
  writeRegistryFile('smoke-r1', {
    pid: process.pid,
    sessionId: 'smoke-r1',
    cwd: 'C:/tmp/smoke-r1',
    status: 'busy',
    statusUpdatedAt: Date.now(),
    name: 'registry busy test',
  });
  await registrySettle();
  const snapR1 = await readSnapshot();
  const r1 = snapR1 && snapR1.sessions.find((s) => s.id === 'smoke-r1');
  check('registry status busy clears a needs-permission session to working', r1 && r1.status === 'working');
  check('registry name is applied to a session with no title yet', r1 && r1.title === 'registry busy test');
  check('registry file presence marks the session live', r1 && r1.live === true);

  // A LATER name change must be adopted: `/rename` inside a session updates the
  // registry's `name`, and the board used to ignore it forever because every
  // writer was guarded on the title being empty (issue #23).
  writeRegistryFile('smoke-r1', {
    pid: process.pid,
    sessionId: 'smoke-r1',
    cwd: 'C:/tmp/smoke-r1',
    status: 'busy',
    statusUpdatedAt: Date.now(),
    name: 'renamed by hand',
  });
  await registrySettle();
  const snapR1b = await readSnapshot();
  const r1b = snapR1b && snapR1b.sessions.find((s) => s.id === 'smoke-r1');
  check('a registry name change is adopted, so /rename reaches the board', r1b && r1b.title === 'renamed by hand');

  // ...but a registry file with no name at all must not blank the title.
  writeRegistryFile('smoke-r1', {
    pid: process.pid,
    sessionId: 'smoke-r1',
    cwd: 'C:/tmp/smoke-r1',
    status: 'busy',
    statusUpdatedAt: Date.now(),
  });
  await registrySettle();
  const snapR1c = await readSnapshot();
  const r1c = snapR1c && snapR1c.sessions.find((s) => s.id === 'smoke-r1');
  check('a registry file with no name does not clear the existing title', r1c && r1c.title === 'renamed by hand');

  // The statusline payload carries session_name and also tracks /rename.
  await fetch(`${BASE}/statusline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'smoke-r1', cwd: 'C:/tmp/smoke-r1', session_name: 'renamed via statusline' }),
  });
  await sleep(200);
  const snapR1d = await readSnapshot();
  const r1d = snapR1d && snapR1d.sessions.find((s) => s.id === 'smoke-r1');
  check('a statusline session_name change is adopted too', r1d && r1d.title === 'renamed via statusline');

  // (b) a 'waiting' registry file must NOT clobber needs-permission.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-r2', cwd: 'C:/tmp/smoke-r2' }),
  });
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Notification', session_id: 'smoke-r2', notification_type: 'permission_prompt' }),
  });
  await sleep(150);
  writeRegistryFile('smoke-r2', {
    pid: process.pid,
    sessionId: 'smoke-r2',
    cwd: 'C:/tmp/smoke-r2',
    status: 'waiting',
    statusUpdatedAt: Date.now(),
  });
  await registrySettle();
  const snapR2 = await readSnapshot();
  const r2 = snapR2 && snapR2.sessions.find((s) => s.id === 'smoke-r2');
  check('registry status waiting does not clobber needs-permission', r2 && r2.status === 'needs-permission');

  // (c) a 'waiting' registry file moves a plain 'working' session to 'awaiting'.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-r3', cwd: 'C:/tmp/smoke-r3' }),
  });
  await sleep(150);
  writeRegistryFile('smoke-r3', {
    pid: process.pid,
    sessionId: 'smoke-r3',
    cwd: 'C:/tmp/smoke-r3',
    status: 'waiting',
    statusUpdatedAt: Date.now(),
  });
  await registrySettle();
  const snapR3 = await readSnapshot();
  const r3 = snapR3 && snapR3.sessions.find((s) => s.id === 'smoke-r3');
  check('registry status waiting moves a working session to awaiting', r3 && r3.status === 'awaiting');

  // (d) removing the registry file clears live and degrades the in-flight
  // 'awaiting' status to 'recent' (smoke-r3 from case (c) above).
  removeRegistryFile('smoke-r3');
  await registrySettle();
  const snapR3b = await readSnapshot();
  const r3b = snapR3b && snapR3b.sessions.find((s) => s.id === 'smoke-r3');
  check('removing the registry file clears live', r3b && r3b.live === false);
  check('removing the registry file degrades an in-flight status to recent', r3b && r3b.status === 'recent');

  // (f) an unknown status value leaves our status untouched.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-r4', cwd: 'C:/tmp/smoke-r4' }),
  });
  await sleep(150);
  writeRegistryFile('smoke-r4', {
    pid: process.pid,
    sessionId: 'smoke-r4',
    cwd: 'C:/tmp/smoke-r4',
    status: 'some-unrecognised-future-status',
    statusUpdatedAt: Date.now(),
  });
  await registrySettle();
  const snapR4 = await readSnapshot();
  const r4 = snapR4 && snapR4.sessions.find((s) => s.id === 'smoke-r4');
  check('an unrecognised registry status leaves session status untouched (still working)', r4 && r4.status === 'working');
  check('an unrecognised registry status still marks the session live', r4 && r4.live === true);

  // A stale file for a dead pid must be ignored outright: no live flip, no
  // status change, and the server must not throw. SessionStart always sets
  // live:true on its own (that is the hook's job, unrelated to the
  // registry), so this session is first ended via SessionEnd to get a known
  // live:false/status:'ended' baseline that only the registry could disturb;
  // if the dead-pid file were mistakenly treated as alive, it would flip
  // live back to true and/or move status to 'awaiting'.
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-r5', cwd: 'C:/tmp/smoke-r5' }),
  });
  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'smoke-r5', cwd: 'C:/tmp/smoke-r5' }),
  });
  await sleep(150);
  writeRegistryFile('smoke-r5', {
    pid: FAKE_DEAD_PID,
    sessionId: 'smoke-r5',
    cwd: 'C:/tmp/smoke-r5',
    status: 'waiting',
    statusUpdatedAt: Date.now(),
  });
  await registrySettle();
  const snapR5 = await readSnapshot();
  check('a registry file for a dead pid does not crash the server', !!snapR5);
  const r5 = snapR5 && snapR5.sessions.find((s) => s.id === 'smoke-r5');
  check('a registry file for a dead pid is ignored: status stays ended, not resurrected to awaiting', r5 && r5.status === 'ended');
  check('a registry file for a dead pid is ignored: live stays false, not flipped to true', r5 && r5.live === false);
  removeRegistryFile('smoke-r5');

  // ---- Updater install command (desktop/installer-cmd.mjs). Platform neutral,
  // so it runs in CI on Linux: it asserts the SHAPE handed to child_process.
  // windowsVerbatimArguments is the load-bearing part. Without it Node quotes the
  // whole `cmd /c ...` argument and escapes the embedded quotes as \", cmd passes
  // \"C:\...\x.msi\" to msiexec, and the installer fails with "This installation
  // package could not be opened" while the MSI sits fine in %TEMP% (issue #18).
  // scripts/check-installer-launch.mjs proves the same thing by really spawning
  // it, on Windows only. ----
  const { installerSpawnArgs } = await import('../desktop/installer-cmd.mjs');
  const MSI = 'C:\\Users\\pr\\AppData\\Local\\Temp\\cmc-update-x1\\Mission.Control.Center.9.9.9.msi';
  const shape = installerSpawnArgs(MSI);
  check('installer command runs through cmd /c', shape.file === 'cmd' && shape.args[0] === '/c');
  check('installer command delays with ping before msiexec, in one cmd line',
    typeof shape.args[1] === 'string' &&
      /^ping -n \d+ 127\.0\.0\.1 & msiexec \/i "/.test(shape.args[1]) &&
      shape.args[1].includes(MSI) &&
      shape.args.length === 2);
  check('installer command sets windowsVerbatimArguments so cmd gets the quotes unescaped',
    shape.options && shape.options.windowsVerbatimArguments === true);
  check('installer command stays detached with ignored stdio so it outlives the app',
    shape.options && shape.options.detached === true && shape.options.stdio === 'ignore');
  check('installer command adds no redirect (stdio is already ignored)', !shape.args[1].includes('>'));
  // cmd /c strips the outer quote pair when the command line starts with a quote,
  // which breaks a quoted program path containing spaces. The unquoted leading
  // ping is what prevents that.
  check('installer command line does not start with a quote', !shape.args[1].startsWith('"'));
  check('installer command does not wrap msiexec in start', !/\bstart\b/.test(shape.args[1]));

  // The temp-dir sweep must never delete the dir it was told to keep, and must
  // never touch unrelated dirs. Run inside a SANDBOX, never the machine's real
  // temp: the first version of this test called the sweep with its real default
  // root and deleted the developer's genuinely downloaded MSIs mid-session.
  const { cleanupOldUpdateDirs, UPDATE_DIR_PREFIX } = await import('../desktop/update-check.mjs');
  const sweepRoot = fs.mkdtempSync(path.join(TMP_HOME, 'sweep-'));
  const keep = fs.mkdtempSync(path.join(sweepRoot, UPDATE_DIR_PREFIX));
  const stale = fs.mkdtempSync(path.join(sweepRoot, UPDATE_DIR_PREFIX));
  const unrelated = fs.mkdtempSync(path.join(sweepRoot, 'cmc-not-an-update-'));
  fs.writeFileSync(path.join(stale, 'old.msi'), 'x');
  const removedCount = cleanupOldUpdateDirs(keep, sweepRoot);
  check('update dir sweep removes a previous download dir', !fs.existsSync(stale) && removedCount === 1);
  check('update dir sweep keeps the current download dir', fs.existsSync(keep));
  check('update dir sweep leaves unrelated temp dirs alone', fs.existsSync(unrelated));
  check('update dir sweep is scoped to the root it was given, not the real temp dir',
    fs.existsSync(sweepRoot) && fs.readdirSync(sweepRoot).length === 2);

  // ---- Resume flags. The flag file is written by the /resume-later skill from
  // inside another process, so the server must read it FRESH rather than cache it:
  // written here AFTER the server booted, and expected to show up immediately.
  const FLAGS_FILE = path.join(TMP_HOME, '.claude', 'agent-fleet-monitor', 'resume-flags.json');
  fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true });
  fs.writeFileSync(FLAGS_FILE, JSON.stringify([
    { sessionId: 'smoke-open', name: 'Flagged And Known', cwd: OPEN_DIR, project: 'opener-demo', note: 'back at 16:00', flaggedAt: Date.now() - 60000 },
    { sessionId: 'never-seen-session', name: 'Flagged But Pruned', cwd: OPEN_DIR, project: 'opener-demo', note: null, flaggedAt: Date.now() - 3600000 },
  ]));
  const flagList = await (await fetch(`${BASE}/resume-flags`)).json();
  check('GET /resume-flags reads a file written after the server started (no caching)',
    flagList && Array.isArray(flagList.flags) && flagList.flags.length === 2);
  const knownFlag = flagList.flags.find((f) => f.sessionId === 'smoke-open');
  const prunedFlag = flagList.flags.find((f) => f.sessionId === 'never-seen-session');
  check('a flag for a live session is enriched with what the board knows',
    !!knownFlag && knownFlag.known === true && knownFlag.status !== null && knownFlag.note === 'back at 16:00');
  check('a flag whose session is not on the board is still listed, marked unknown',
    !!prunedFlag && prunedFlag.known === false && prunedFlag.name === 'Flagged But Pruned');

  const resumed = await (await fetch(`${BASE}/resume-flagged`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-open' }),
  })).json();
  check('POST /resume-flagged reattaches the session',
    resumed && resumed.ok === true && resumed.mode === 'reattached');
  check('resuming a flagged session drops exactly that flag, leaving the other one',
    resumed && resumed.unflagged === true && resumed.remaining === 1);
  // ok and persisted differ under CMC_DRY_RUN on purpose: the removal is computed
  // but the file is not touched, so a scratch server cannot delete real reminders.
  check('a dry-run resume reports that the flag file was NOT actually rewritten',
    resumed && resumed.persisted === false);
  check('resuming a flagged session generates no wt argument containing a semicolon', hasNoSemicolon(resumed));

  const notFlagged = await (await fetch(`${BASE}/resume-flagged`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'smoke-1' }),
  })).json();
  check('POST /resume-flagged refuses a session that is not flagged',
    notFlagged && notFlagged.ok === false && /not flagged/i.test(String(notFlagged.error)));

  const unflagged = await (await fetch(`${BASE}/unflag-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'never-seen-session' }),
  })).json();
  // Both flags are still on disk here: the resume above computed its removal but
  // did not write it (dry run), so unflagging the OTHER one leaves exactly one.
  check('POST /unflag-resume drops a flag without resuming anything',
    unflagged && unflagged.ok === true && unflagged.remaining === 1);
  const unflagUnknown = await (await fetch(`${BASE}/unflag-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'was-never-flagged' }),
  })).json();
  check('unflagging something that was never flagged reports it rather than pretending it worked',
    unflagUnknown && unflagUnknown.ok === false && /not flagged/i.test(String(unflagUnknown.error)));

  // ---- startedAt is a RUN start, not "when the server first noticed". The
  // registry is authoritative and wins over whatever created the session, which is
  // what makes the card's runtime ring meaningful (mtime made a five-hour session
  // look seconds old, and NTFS tunneling makes birthtime jump around).
  const REG_START = Date.now() - 137 * 60000;
  writeRegistryFile(String(process.pid), {
    pid: process.pid,
    sessionId: 'smoke-started',
    cwd: OPEN_DIR,
    name: 'Started Long Ago',
    status: 'busy',
    startedAt: REG_START,
    statusUpdatedAt: Date.now(),
  });
  await sleep(REGISTRY_POLL_MS * 3);
  const startSnap = await readSnapshot();
  const startedSession = startSnap && startSnap.sessions.find((s) => s.id === 'smoke-started');
  check('a session adopts the registry startedAt, so its runtime is the real run length',
    !!startedSession && Math.abs(startedSession.startedAt - REG_START) < 1000,
    startedSession ? String(startedSession.startedAt) + ' vs ' + String(REG_START) : 'no session');
  removeRegistryFile(String(process.pid));

  // ---- openInVsCode branches the running server cannot reach (its
  // CMC_VSCODE_EXE is fixed at spawn time), asserted by importing terminal.mjs
  // here the same way the desktop modules above are. CMC_DRY_RUN keeps this
  // process from spawning anything; the child server has its own explicit env, so
  // mutating ours cannot disturb it.
  process.env.CMC_DRY_RUN = '1';
  const terminal = await import('../terminal.mjs');
  check('terminal.mjs exports openInVsCode', typeof terminal.openInVsCode === 'function');
  const prevExe = process.env.CMC_VSCODE_EXE;
  process.env.CMC_VSCODE_EXE = path.join(TMP_HOME, 'no-such-code.exe');
  const badOverride = terminal.openInVsCode(OPEN_DIR);
  process.env.CMC_VSCODE_EXE = prevExe === undefined ? process.execPath : prevExe;
  check('a CMC_VSCODE_EXE override that does not exist is reported, not silently ignored',
    badOverride && badOverride.ok === false && badOverride.reason === 'no-editor' &&
      /CMC_VSCODE_EXE/.test(String(badOverride.error)));
  const emptyFolder = terminal.openInVsCode('');
  check('openInVsCode refuses an empty folder', emptyFolder && emptyFolder.ok === false && emptyFolder.reason === 'bad-folder');
  const notADir = terminal.openInVsCode(SERVER);
  check('openInVsCode refuses a path that is a file, not a folder',
    notADir && notADir.ok === false && /not a folder/i.test(String(notADir.error)));
  // The cheapest possible guard against a future refactor routing this through wt:
  // an entry here would desync every later tabIndex from the real tab positions.
  const tabsBefore = terminal.managedTabs.length;
  terminal.openInVsCode(OPEN_DIR);
  check('openInVsCode adds no managedTabs entry (the positional tabIndex invariant)',
    terminal.managedTabs.length === tabsBefore);
  // ELECTRON_RUN_AS_NODE must never reach Code.exe: VS Code is an Electron app, so
  // it would run as a bare Node interpreter, try to require the folder path and
  // exit 1 with nothing visible (stdio is ignored), i.e. the button silently does
  // nothing. desktop/main.mjs spawns server.mjs with exactly that variable set, so
  // every packaged install would have hit it. Caught by really spawning it.
  const spawnEnv = terminal.editorSpawnEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'keep-me', CMC_X: 'y' });
  check('editorSpawnEnv strips ELECTRON_RUN_AS_NODE so Code.exe does not run as Node',
    !('ELECTRON_RUN_AS_NODE' in spawnEnv));
  check('editorSpawnEnv keeps the rest of the environment', spawnEnv.PATH === 'keep-me' && spawnEnv.CMC_X === 'y');
  check('editorSpawnEnv never mutates the env it was given', (() => {
    const base = { ELECTRON_RUN_AS_NODE: '1' };
    terminal.editorSpawnEnv(base);
    return base.ELECTRON_RUN_AS_NODE === '1';
  })());
  // THE bug behind issue #33, and the reason this assertion exists at all:
  // `windowsHide: true` is not just "no console window". Node maps it to libuv's
  // UV_PROCESS_WINDOWS_HIDE, which sets STARTUPINFO.wShowWindow = SW_HIDE with
  // STARTF_USESHOWWINDOW, and a GUI app honours that for its FIRST window. So a
  // COLD VS Code start opened its window invisibly: the process ran, the folder
  // loaded, and the button looked dead. Only the cold start was affected, because
  // a warm instance creates the window itself, which is what made it read as
  // intermittent. Measured by cold-starting Code.exe into a throwaway
  // --user-data-dir and enumerating window handles: windowsHide true gave a
  // hidden window, false a visible one, same folder.
  const editorOpts = terminal.editorSpawnOptions({ ELECTRON_RUN_AS_NODE: '1', PATH: 'keep-me' });
  check('terminal.mjs exports editorSpawnOptions', typeof terminal.editorSpawnOptions === 'function');
  check('editorSpawnOptions never hides the window it is about to open (issue #33)',
    editorOpts && editorOpts.windowsHide !== true, JSON.stringify(editorOpts && editorOpts.windowsHide));
  check('editorSpawnOptions keeps detached, so the warm named-pipe handoff survives',
    editorOpts && editorOpts.detached === true);
  check('editorSpawnOptions never asks for a shell (a console flash and a quoting hazard)',
    editorOpts && editorOpts.shell === false);
  check('editorSpawnOptions carries the stripped env, so Code.exe cannot run as Node',
    editorOpts && editorOpts.env && !('ELECTRON_RUN_AS_NODE' in editorOpts.env) && editorOpts.env.PATH === 'keep-me');
  check('isInsideReposRoot accepts a folder in the repos root and rejects a sibling',
    terminal.isInsideReposRoot(path.join(os.homedir(), 'repos', 'anything')) === true &&
      terminal.isInsideReposRoot(path.join(os.homedir(), 'repos-secret')) === false);

  process.stdout.write(failed ? '\nRESULT: FAIL\n' : '\nRESULT: ALL PASS\n');
  await cleanup(failed ? 1 : 0);
} catch (e) {
  process.stdout.write(`FAIL  unexpected error: ${e && e.message}\n`);
  await cleanup(1);
}
