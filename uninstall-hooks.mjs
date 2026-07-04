// agent-fleet-monitor: remove only our feeder hooks from ~/.claude/settings.json
// Leaves every other setting untouched. Safe to run repeatedly.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSettings, SHIM_MARK } from './install-hooks.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export function removeHooks() {
  const settings = readSettings();
  if (!settings.hooks) return 0;

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((group) => {
      const ours = (group.hooks || []).some(
        (h) => typeof h.command === 'string' && h.command.includes(SHIM_MARK)
      );
      if (ours) removed += 1;
      return !ours;
    });
    if (kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed > 0) fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return removed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = removeHooks();
  process.stdout.write(
    n > 0 ? `Removed ${n} fleet-monitor hook group(s).\n` : 'No fleet-monitor hooks found.\n'
  );
}
