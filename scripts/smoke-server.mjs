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
const env = { ...process.env, USERPROFILE: TMP_HOME, HOME: TMP_HOME };

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
  check('GET /repos returns an array', Array.isArray(await repos.json()));

  await fetch(`${BASE}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'smoke-1', cwd: 'C:/tmp/smoke' }),
  });
  await sleep(300);
  const snap = await readSnapshot();
  check('snapshot has type snapshot', snap && snap.type === 'snapshot');
  check('ingested session appears in snapshot', snap && snap.sessions.some((s) => s.id === 'smoke-1'));

  process.stdout.write(failed ? '\nRESULT: FAIL\n' : '\nRESULT: ALL PASS\n');
  await cleanup(failed ? 1 : 0);
} catch (e) {
  process.stdout.write(`FAIL  unexpected error: ${e && e.message}\n`);
  await cleanup(1);
}
