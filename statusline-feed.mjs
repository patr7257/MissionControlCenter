// agent-fleet-monitor statusline wrapper
// Invoked by Claude Code as the statusLine command (installed in place of the
// user's real one; see install-hooks.mjs installStatusline()). The payload
// piped in on stdin is the only local source of the 5h/7d rate-limit windows
// and the true context-window percentage, so this wrapper both feeds that
// data to the dashboard AND still prints the user's original statusline,
// unmodified, so the terminal keeps working exactly as before.
//
// Design goals (in order):
//   1. NEVER break or visibly slow down the user's statusline. Every step
//      below fails open: on any error, the original command's own output
//      (or nothing, if there is no recorded original) is what ends up on
//      stdout, and the exit code always reflects the child, never us.
//   2. Read stdin once, then spawn the ORIGINAL command (a full command
//      string, not an argv array) with that exact same stdin, piping its
//      stdout/stderr straight through and exiting with its code.
//   3. In parallel with that spawn (not before, not after), best-effort
//      fire-and-forget POST the same payload to the monitor server if it is
//      running. This must never delay or affect the child in any way.
// Unlike send-event.mjs, this script must NOT exit(0) eagerly: the whole
// point of it is to run the child and forward its output, so the process
// only exits once that is decided (or once we learn there is nothing to run).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const ORIGINAL_FILE = path.join(DATA_DIR, 'statusline-original.json');

// Reads the exact command string install-hooks.mjs recorded before it
// overwrote settings.statusLine with this wrapper. Three distinct outcomes,
// because two of them look identical from here but mean opposite things:
//   { kind: 'command' } run it and forward its output (the normal case)
//   { kind: 'none' }    the user genuinely had no statusLine, so printing
//                       nothing is the CORRECT result, not a failure
//   { kind: 'missing' } we are installed but the record is gone (data dir
//                       wiped, unreadable, half-written). Printing nothing
//                       here would silently blank a statusline the user does
//                       have, with no clue why, so say so instead.
function readOriginalCommand() {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(ORIGINAL_FILE, 'utf8'));
  } catch {
    return { kind: 'missing' };
  }
  if (record && record.had === false) return { kind: 'none' };
  if (record && record.had && record.statusLine && typeof record.statusLine.command === 'string') {
    return { kind: 'command', command: record.statusLine.command };
  }
  return { kind: 'missing' };
}

// Fire-and-forget POST of the raw statusline payload to the monitor server,
// if (and only if) it is running. Every failure mode here (no lock file, dead
// server, slow server, malformed lock file) is swallowed: this must never
// affect the child process below or its exit code.
function postToServer(rawBody) {
  if (process.env.CMC_DRY_RUN) return;
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!lock || !lock.port) return;
  try {
    const data = Buffer.from(rawBody || '{}', 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path: '/statusline',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 1000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {});
      }
    );
    req.on('error', () => {});
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {
        // best effort only
      }
    });
    req.write(data);
    req.end();
  } catch {
    // best effort only
  }
}

// Read stdin fully (it is the statusLine JSON payload Claude Code piped in),
// then kick off the monitor POST and the original command in parallel.
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', () => {
  // Started first so it runs alongside the spawn below, never gating on it and
  // never delaying it: postToServer only ever fires the request and returns.
  postToServer(body);

  const original = readOriginalCommand();
  if (original.kind === 'none') {
    // The user had no statusLine before we wrapped it, so an empty statusline
    // is the correct, faithful result.
    process.exit(0);
    return;
  }
  if (original.kind === 'missing') {
    // Fail loud but harmless. A blank line here is indistinguishable from a
    // broken terminal, whereas this names the problem and the fix.
    process.stdout.write('mission control: statusline record missing, run node stop.mjs to restore');
    process.exit(0);
    return;
  }
  const originalCommand = original.command;

  try {
    // shell: true so the recorded command STRING parses the way Claude Code
    // itself would run it (a full command line, e.g.
    // python "C:\Users\pr\.claude\statusline-command.py"), including a path
    // with spaces.
    const child = spawn(originalCommand, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => {
      // Could not even spawn the original: fail open, print nothing.
      process.exit(0);
    });
    child.on('exit', (code) => {
      process.exit(typeof code === 'number' ? code : 0);
    });
    child.stdin.on('error', () => {
      // e.g. EPIPE if the child already exited: harmless, the 'exit' handler
      // above still decides our exit code.
    });
    child.stdin.write(body);
    child.stdin.end();
  } catch {
    process.exit(0);
  }
});
process.stdin.on('error', () => {
  process.exit(0);
});
