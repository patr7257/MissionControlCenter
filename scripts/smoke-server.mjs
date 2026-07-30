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
// CMC_DRY_RUN keeps terminal.mjs from spawning real Windows Terminal tabs (and
// from writing state files), so /launch can be asserted on any platform.
const env = { ...process.env, USERPROFILE: TMP_HOME, HOME: TMP_HOME, CMC_DRY_RUN: '1' };

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

  // Launch command shape: the tab is hosted by PowerShell (profile loads, tab
  // survives Claude exiting) and an optional session name is passed through as
  // `claude --name '<name>'` with the name also used as the tab title.
  const launchNamed = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'smoke name', name: 'smoke name' }),
  })).json();
  check('POST /launch succeeds', launchNamed && launchNamed.ok === true);
  check(
    'POST /launch hosts the tab in PowerShell and passes the name to claude --name',
    launchNamed &&
      typeof launchNamed.command === 'string' &&
      launchNamed.command.includes('--title "smoke name"') &&
      launchNamed.command.includes('powershell.exe -NoExit -Command "claude --name \'smoke name\'"')
  );
  const launchPlain = await (await fetch(`${BASE}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'C:/tmp/smoke-repo', title: 'smoke-repo' }),
  })).json();
  check(
    'POST /launch without a name runs bare claude under PowerShell',
    launchPlain && launchPlain.command && launchPlain.command.endsWith('powershell.exe -NoExit -Command "claude"')
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

  process.stdout.write(failed ? '\nRESULT: FAIL\n' : '\nRESULT: ALL PASS\n');
  await cleanup(failed ? 1 : 0);
} catch (e) {
  process.stdout.write(`FAIL  unexpected error: ${e && e.message}\n`);
  await cleanup(1);
}
