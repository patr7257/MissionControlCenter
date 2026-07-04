// agent-fleet-monitor hook shim
// Invoked by every feeder hook with the hook payload on stdin.
// Design goals (in order):
//   1. NEVER break or slow down a Claude Code session.
//   2. If the monitor is not running (no lock file), do nothing, instantly.
//   3. Otherwise POST the payload to the local server, best effort.
// This script always exits 0, no matter what happens.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const LOCK_FILE = path.join(os.homedir(), '.claude', 'agent-fleet-monitor', 'server.lock');

function done() {
  // Always succeed so the session is never affected.
  process.exit(0);
}

// Fast no-op when the dashboard is not running.
let lock;
try {
  lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
} catch {
  done();
}
if (!lock || !lock.port) done();

// Read the hook payload from stdin, then forward it.
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  body += c;
});
process.stdin.on('end', () => {
  try {
    const data = Buffer.from(body || '{}', 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path: '/event',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 1500,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', done);
      }
    );
    req.on('error', done);
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      done();
    });
    req.write(data);
    req.end();
  } catch {
    done();
  }
});
process.stdin.on('error', done);

// Hard safety net: never hang the session.
setTimeout(done, 2500);
