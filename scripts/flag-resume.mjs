#!/usr/bin/env node
// Flag THIS Claude Code session to be picked up later, so it shows in Mission
// Control's "Resume session" picker. Run from inside the session you want to flag
// (that is the whole point: it reads the session's own identity from its
// environment). Backs the /resume-later skill.
//
// Zero dependencies, Node built-ins only, same as the rest of this repo.
//
//   node scripts/flag-resume.mjs                      flag this session
//   node scripts/flag-resume.mjs paused until 16:00   flag it with a note
//   node scripts/flag-resume.mjs --list               show what is flagged
//   node scripts/flag-resume.mjs --unflag             unflag this session
//   node scripts/flag-resume.mjs --unflag <id>        unflag a specific session
//   node scripts/flag-resume.mjs --id <id> --name X   flag another session by hand
//
// The flag file is the ONE contract with the server: an array of
// { sessionId, name, cwd, project, note, flaggedAt }. server.mjs reads it fresh on
// every request and removes an entry once that session has actually been resumed,
// so nothing here needs to talk to the server, and flagging works whether or not
// Mission Control is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');
const FLAGS_FILE = path.join(DATA_DIR, 'resume-flags.json');
const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');
const MAX_FLAGS = 200;
const MAX_NOTE_LEN = 160;

function readFlags() {
  try {
    const arr = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter((f) => f && typeof f.sessionId === 'string' && f.sessionId);
  } catch {
    return []; // no flags yet, or unreadable: start from empty rather than fail
  }
}

function writeFlags(flags) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Trailing newline and 2-space indent: this file gets read by humans when
  // something looks wrong.
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2) + '\n');
}

// Claude Code publishes a registry entry per live session at
// ~/.claude/sessions/<pid>.json carrying sessionId, cwd and the session's `name`
// (what /rename sets). CLAUDE_PID points straight at ours; the directory scan is
// the fallback for a session whose pid env var is missing.
function readRegistry(sessionId) {
  const direct = process.env.CLAUDE_PID
    ? path.join(REGISTRY_DIR, process.env.CLAUDE_PID + '.json')
    : null;
  const candidates = [];
  if (direct && fs.existsSync(direct)) candidates.push(direct);
  try {
    for (const f of fs.readdirSync(REGISTRY_DIR)) {
      if (f.endsWith('.json')) candidates.push(path.join(REGISTRY_DIR, f));
    }
  } catch {
    // no registry dir: fall through, the env var alone is enough to flag
  }
  for (const file of candidates) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry && entry.sessionId && (!sessionId || entry.sessionId === sessionId)) return entry;
    } catch {
      // half-written this instant, or not ours: keep looking
    }
  }
  return null;
}

// A session's typed name also lands in its transcript as a `customTitle` line, so
// it is recoverable even when the registry file is gone. Reads only the head of
// the file: these transcripts run to megabytes.
function nameFromTranscript(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  // Project folders are the cwd with every non-alphanumeric run turned into '-'.
  const encoded = cwd.replace(/[\\/:]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
  const file = path.join(os.homedir(), '.claude', 'projects', encoded, sessionId + '.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.customTitle === 'string' && obj.customTitle.trim()) return obj.customTitle.trim();
      } catch {
        // a partial last line: ignore
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  return null;
}

function projectFromCwd(cwd) {
  if (!cwd) return null;
  const trimmed = String(cwd).replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop();
  return base || null;
}

function fmtAge(ts) {
  if (!ts) return 'unknown';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ---- argument parsing (deliberately tiny: no flags library, no dependencies) ---
const argv = process.argv.slice(2);
let mode = 'flag';
let explicitId = null;
let explicitName = null;
const noteWords = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--list') mode = 'list';
  else if (a === '--unflag') {
    mode = 'unflag';
    // An id may follow, but "--unflag" alone means "this session".
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { explicitId = argv[i + 1]; i += 1; }
  } else if (a === '--id') { explicitId = argv[i + 1] || null; i += 1; }
  else if (a === '--name') { explicitName = argv[i + 1] || null; i += 1; }
  else if (a === '--help' || a === '-h') mode = 'help';
  else noteWords.push(a);
}

if (mode === 'help') {
  process.stdout.write(
    'Flag this Claude Code session for later resume (Mission Control shows it under "Resume session").\n\n' +
    '  node scripts/flag-resume.mjs [note words...]   flag this session, optional free-text note\n' +
    '  node scripts/flag-resume.mjs --list            list what is flagged\n' +
    '  node scripts/flag-resume.mjs --unflag [id]     unflag this session, or the given one\n' +
    '  node scripts/flag-resume.mjs --id <id> [--name <name>]  flag a session explicitly\n'
  );
  process.exit(0);
}

if (mode === 'list') {
  const flags = readFlags();
  if (!flags.length) {
    process.stdout.write('Nothing is flagged for resume.\n');
    process.exit(0);
  }
  process.stdout.write(flags.length + (flags.length === 1 ? ' session' : ' sessions') + ' flagged for resume:\n');
  for (const f of flags) {
    process.stdout.write(
      '  ' + (f.name || f.project || f.sessionId) +
      '  (' + (f.project || 'unknown project') + ', flagged ' + fmtAge(f.flaggedAt) + ')' +
      (f.note ? '\n      note: ' + f.note : '') + '\n'
    );
  }
  process.stdout.write('\nResume one from the "Resume session" button in Mission Control; that clears its flag.\n');
  process.exit(0);
}

const sessionId = explicitId || process.env.CLAUDE_CODE_SESSION_ID || null;
if (!sessionId) {
  process.stderr.write(
    'Could not tell which session this is: CLAUDE_CODE_SESSION_ID is not set.\n' +
    'Run this from inside the session you want to flag, or pass --id <sessionId>.\n'
  );
  process.exit(1);
}

if (mode === 'unflag') {
  const flags = readFlags();
  const remaining = flags.filter((f) => f.sessionId !== sessionId);
  if (remaining.length === flags.length) {
    process.stdout.write('That session was not flagged, so nothing changed.\n');
    process.exit(0);
  }
  writeFlags(remaining);
  process.stdout.write('Unflagged. ' + remaining.length + ' still flagged for resume.\n');
  process.exit(0);
}

// ---- flag ---------------------------------------------------------------------
const entry = readRegistry(sessionId);
const cwd = (entry && entry.cwd) || process.cwd();
const name = explicitName || (entry && entry.name) || nameFromTranscript(cwd, sessionId) || null;
const note = noteWords.join(' ').trim().slice(0, MAX_NOTE_LEN) || null;

const flags = readFlags();
const existing = flags.find((f) => f.sessionId === sessionId);
const record = {
  sessionId,
  name,
  cwd,
  project: projectFromCwd(cwd),
  note,
  flaggedAt: Date.now(),
};
if (existing) {
  // Re-flagging refreshes the note and the timestamp rather than duplicating.
  Object.assign(existing, record);
} else {
  flags.push(record);
  while (flags.length > MAX_FLAGS) flags.shift();
}
writeFlags(flags);

const label = name || record.project || sessionId;
process.stdout.write(
  'Flagged "' + label + '" for resume' + (note ? ' (' + note + ')' : '') + '.\n' +
  (name
    ? ''
    : 'No session name found, so the picker will show the project instead. Name it with /rename to make it obvious.\n') +
  'Pick it up from the "Resume session" button in Mission Control; resuming clears the flag.\n'
);
