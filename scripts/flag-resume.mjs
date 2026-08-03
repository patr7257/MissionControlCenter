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
//   node scripts/flag-resume.mjs --find "MCC vscode open button"   flag an EARLIER session
//   node scripts/flag-resume.mjs --id <id> --name X --cwd <path>   flag one explicitly
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

// Resolve a session NAME to its id and cwd. This exists because Claude Code prints
// `claude --resume "<name>"` when a session ends, so a name is what Patrick has in
// hand afterwards, for a session that is already gone. Guessing the cwd is not an
// option: it becomes the resumed tab's working directory.
//
// The board's own persisted model is the best source (it stores title + id + cwd for
// every session it has seen), with a transcript scan as the fallback for one it has
// pruned. Returns { sessionId, name, cwd } or throws with a message worth printing.
function findByName(wanted) {
  const target = String(wanted).trim().toLowerCase();
  const matches = new Map(); // sessionId -> { sessionId, name, cwd, seenAt }

  try {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
    if (Array.isArray(arr)) {
      for (const s of arr) {
        if (!s || !s.id || typeof s.title !== 'string') continue;
        if (s.title.trim().toLowerCase() !== target) continue;
        matches.set(s.id, {
          sessionId: s.id,
          name: s.title,
          cwd: s.cwd || null,
          seenAt: s.lastActivityAt || 0,
        });
      }
    }
  } catch {
    // no persisted board yet: fall through to the transcript scan
  }

  if (matches.size === 0) {
    // Transcript fallback. Each project folder is an encoded cwd and each file is
    // <sessionId>.jsonl carrying a `customTitle` line for a named session.
    const projects = path.join(os.homedir(), '.claude', 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { dirs = []; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(projects, dir.name)); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const id = file.slice(0, -'.jsonl'.length);
        const full = path.join(projects, dir.name, file);
        const title = titleFromTranscriptFile(full);
        if (!title || title.trim().toLowerCase() !== target) continue;
        let seenAt = 0;
        let cwd = null;
        try { seenAt = fs.statSync(full).mtimeMs; } catch { seenAt = 0; }
        try { cwd = cwdFromTranscriptFile(full); } catch { cwd = null; }
        matches.set(id, { sessionId: id, name: title, cwd, seenAt });
      }
    }
  }

  const list = Array.from(matches.values()).sort((a, b) => b.seenAt - a.seenAt);
  if (list.length === 0) {
    throw new Error(
      'No session found named "' + wanted + '".\n' +
      'Names are matched exactly (case-insensitively). Check it with --list, or pass\n' +
      '--id <sessionId> --cwd <path> if you know them.'
    );
  }
  if (list.length > 1) {
    const lines = list.map((m) => '  ' + m.sessionId + '  ' + (m.cwd || 'unknown cwd'));
    throw new Error(
      list.length + ' sessions are named "' + wanted + '", so this will not guess.\n' +
      'Pick one with --id <sessionId> --cwd <path>:\n' + lines.join('\n')
    );
  }
  return list[0];
}

// Reads the head of a transcript for its `customTitle` (the session's name).
function titleFromTranscriptFile(file) {
  return firstFieldInTranscript(file, 'customTitle');
}

// Transcript entries carry the session's cwd; used when the board no longer knows it.
function cwdFromTranscriptFile(file) {
  return firstFieldInTranscript(file, 'cwd');
}

function firstFieldInTranscript(file, field) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj[field] === 'string' && obj[field].trim()) return obj[field].trim();
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
let explicitCwd = null;
let findName = null;
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
  else if (a === '--cwd') { explicitCwd = argv[i + 1] || null; i += 1; }
  else if (a === '--find') { findName = argv[i + 1] || null; i += 1; }
  else if (a === '--help' || a === '-h') mode = 'help';
  else noteWords.push(a);
}

if (mode === 'help') {
  process.stdout.write(
    'Flag this Claude Code session for later resume (Mission Control shows it under "Resume session").\n\n' +
    '  node scripts/flag-resume.mjs [note words...]   flag this session, optional free-text note\n' +
    '  node scripts/flag-resume.mjs --list            list what is flagged\n' +
    '  node scripts/flag-resume.mjs --unflag [id]     unflag this session, or the given one\n' +
    '  node scripts/flag-resume.mjs --find "<session name>"    flag an EARLIER session by its name\n' +
    '  node scripts/flag-resume.mjs --id <id> [--name <name>] [--cwd <path>]  flag one explicitly\n' +
    '\n' +
    '--find is for what Claude Code prints when a session ends (claude --resume "<name>"):\n' +
    'it resolves the name to that session id AND its working directory, and refuses rather\n' +
    'than guessing if the name matches nothing or more than one session.\n'
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

// --find resolves a NAME to an id and cwd, which is the shape Patrick actually has
// after a session ends (Claude Code prints `claude --resume "<name>"`). It never
// guesses: 0 or 2+ matches both refuse with something actionable.
let found = null;
if (findName) {
  try {
    found = findByName(findName);
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exit(1);
  }
}

const sessionId = explicitId || (found && found.sessionId) || process.env.CLAUDE_CODE_SESSION_ID || null;
if (!sessionId) {
  process.stderr.write(
    'Could not tell which session this is: CLAUDE_CODE_SESSION_ID is not set.\n' +
    'Run this from inside the session you want to flag, pass --find "<session name>",\n' +
    'or pass --id <sessionId>.\n'
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
// cwd precedence matters: it becomes the resumed tab's working directory, so a
// wrong value opens the session in the wrong folder. process.cwd() is LAST and is
// only right for the "flagging the session I am in" case; for --find and --id it
// would be this script's directory, which is why --find resolves a cwd too.
const cwd = explicitCwd || (found && found.cwd) || (entry && entry.cwd) || process.cwd();
const name = explicitName || (found && found.name) || (entry && entry.name) || nameFromTranscript(cwd, sessionId) || null;
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
