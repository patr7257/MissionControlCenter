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

// Forward slashes work for node on every platform and avoid JSON escaping noise.
const SHIM = path.join(SKILL_DIR, 'send-event.mjs').split(path.sep).join('/');
// Match on the bare shim filename so uninstall finds our hooks regardless of which
// absolute path install recorded (skill-junction path vs the real repo path).
export const SHIM_MARK = 'send-event.mjs';
const COMMAND = `node "${SHIM}"`;

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

  if (added > 0) {
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
