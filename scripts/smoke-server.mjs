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
// CMC_DRY_RUN keeps terminal.mjs from spawning real Windows Terminal tabs (and
// from writing state files), so /launch can be asserted on any platform.
const env = {
  ...process.env,
  USERPROFILE: TMP_HOME,
  HOME: TMP_HOME,
  CMC_DRY_RUN: '1',
  CMC_REGISTRY_POLL_MS: String(REGISTRY_POLL_MS),
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

const srv = spawn(process.execPath, [SERVER, '--port', String(PORT)], { env, stdio: 'ignore' });

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

  process.stdout.write(failed ? '\nRESULT: FAIL\n' : '\nRESULT: ALL PASS\n');
  await cleanup(failed ? 1 : 0);
} catch (e) {
  process.stdout.write(`FAIL  unexpected error: ${e && e.message}\n`);
  await cleanup(1);
}
