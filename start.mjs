// agent-fleet-monitor: start the dashboard
// - ensures the feeder hooks are installed in ~/.claude/settings.json
// - starts the server (only if it is not already running)
// - opens the dashboard in the default browser
// Idempotent: safe to run when already running.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addHooks } from './install-hooks.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const SERVER = path.join(SKILL_DIR, 'server.mjs');

function readPortArg(fallback) {
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not signalable
  }
}

function runningLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock && lock.pid && pidAlive(lock.pid)) return lock;
  } catch {
    // not running
  }
  return null;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // non-fatal: the URL is printed regardless
  }
}

async function waitForLock(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const lock = runningLock();
    if (lock) return lock;
    await new Promise((r) => setTimeout(r, 120));
  }
  return runningLock();
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const added = addHooks();

  let lock = runningLock();
  if (!lock) {
    const port = readPortArg(4317);
    const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    lock = await waitForLock(4000);
  }

  if (!lock) {
    process.stderr.write('Fleet monitor: server did not come up in time. See references/troubleshooting.md\n');
    process.exit(1);
  }

  const url = `http://localhost:${lock.port}`;
  openBrowser(url);
  process.stdout.write(
    `Fleet monitor live at ${url}` +
      (added > 0 ? ` (installed ${added} hook[s])` : ' (hooks already present)') +
      '\n'
  );
}

main();
