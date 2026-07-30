// agent-fleet-monitor: merge the feeder hooks into ~/.claude/settings.json
// Idempotent and non-destructive: it only adds our entries, backs up first,
// and preserves everything else (permissions, env, other hooks).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = SETTINGS + '.fleet-monitor.bak';
const DATA_DIR = path.join(os.homedir(), '.claude', 'agent-fleet-monitor');

// Forward slashes work for node on every platform and avoid JSON escaping noise.
const SHIM = path.join(SKILL_DIR, 'send-event.mjs').split(path.sep).join('/');
// Match on the bare shim filename so uninstall finds our hooks regardless of which
// absolute path install recorded (skill-junction path vs the real repo path).
export const SHIM_MARK = 'send-event.mjs';
// The packaged desktop app overrides the command so hooks point at its shipped
// shim wrapper (send-event.mjs.cmd) instead of "node <repo path>".
const COMMAND = process.env.CMC_HOOK_COMMAND || `node "${SHIM}"`;

// Same idea as SHIM/SHIM_MARK/COMMAND above, for the statusLine wrapper
// instead of the event hooks: match on the bare filename so uninstall finds
// our wrapper regardless of which absolute path install recorded, and let a
// packaged app override the command (CMC_STATUSLINE_COMMAND) the same way
// CMC_HOOK_COMMAND overrides the hook shim.
const STATUSLINE_WRAPPER = path.join(SKILL_DIR, 'statusline-feed.mjs').split(path.sep).join('/');
export const STATUSLINE_MARK = 'statusline-feed.mjs';
const STATUSLINE_COMMAND = process.env.CMC_STATUSLINE_COMMAND || `node "${STATUSLINE_WRAPPER}"`;
// Where the user's real statusLine value (or its absence) is recorded before
// we overwrite settings.statusLine, so uninstall can restore it verbatim.
export const STATUSLINE_ORIGINAL_FILE = path.join(DATA_DIR, 'statusline-original.json');

// Events we feed, and whether the event supports a tool/agent matcher.
const MATCHED = ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse'];
const UNMATCHED = ['Stop', 'Notification', 'SessionStart', 'UserPromptSubmit', 'SessionEnd'];

function hookObj() {
  return { type: 'command', command: COMMAND, async: true, timeout: 10 };
}

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('Could not parse ~/.claude/settings.json, aborting: ' + e.message);
  }
}

function groupHasOurs(group) {
  return (group.hooks || []).some(
    (h) => typeof h.command === 'string' && h.command.includes(SHIM_MARK)
  );
}

// Installs the statusline wrapper in place of the user's real statusLine
// command, saving the original first so uninstall can restore it verbatim.
// Idempotent: a no-op (returns false) when settings.statusLine is already
// ours, which critically means a second install never overwrites the saved
// original with our own wrapper. Mutates `settings` in place; the caller is
// responsible for writing it to disk. Returns true iff it changed anything.
function installStatusline(settings) {
  const current = settings.statusLine;
  if (current && typeof current.command === 'string' && current.command.includes(STATUSLINE_MARK)) {
    return false; // already ours, nothing to do
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Record something unambiguous for "there was no statusLine at all" so
    // uninstall can tell that apart from "there was one and it looked like
    // this", rather than guessing from an empty object.
    const record = current ? { had: true, statusLine: current } : { had: false };
    fs.writeFileSync(STATUSLINE_ORIGINAL_FILE, JSON.stringify(record, null, 2) + '\n');
  } catch {
    // Could not record the original: do not touch statusLine, since uninstall
    // would then have nothing to restore it from.
    return false;
  }
  settings.statusLine = { ...(current || {}), type: 'command', command: STATUSLINE_COMMAND };
  return true;
}

export function addHooks() {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  const add = (event, withMatcher) => {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const arr = settings.hooks[event];
    if (arr.some(groupHasOurs)) return; // already installed
    arr.push(withMatcher ? { matcher: '*', hooks: [hookObj()] } : { hooks: [hookObj()] });
    added += 1;
  };

  for (const e of MATCHED) add(e, true);
  for (const e of UNMATCHED) add(e, false);

  const statuslineInstalled = installStatusline(settings);

  if (added > 0 || statuslineInstalled) {
    try {
      if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, BACKUP);
    } catch {
      // backup is best effort; uninstall does a clean targeted removal anyway
    }
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  }
  return added;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = addHooks();
  process.stdout.write(
    n > 0
      ? `Installed ${n} fleet-monitor hook(s) into ${SETTINGS}\n`
      : 'Fleet-monitor hooks already present, nothing to do.\n'
  );
}
