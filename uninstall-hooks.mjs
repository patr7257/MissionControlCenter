// agent-fleet-monitor: remove only our feeder hooks from ~/.claude/settings.json
// Leaves every other setting untouched. Safe to run repeatedly.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readSettings, SHIM_MARK, STATUSLINE_MARK, STATUSLINE_ORIGINAL_FILE } from './install-hooks.mjs';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Restores settings.statusLine to whatever it was before installStatusline()
// overwrote it, in the same targeted, non-destructive style as the hook
// removal below: only acts when the CURRENT statusLine is ours (never clobber
// one the user changed by hand while we were installed), and always removes
// the original-record file afterwards so a later install starts clean.
// Mutates `settings` in place; the caller is responsible for writing it to
// disk. Returns { changed, note }: `note`, when set, is a message the caller
// should surface (e.g. the original record was missing).
function removeStatusline(settings) {
  const current = settings.statusLine;
  if (!current || typeof current.command !== 'string' || !current.command.includes(STATUSLINE_MARK)) {
    return { changed: false, note: null };
  }

  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(STATUSLINE_ORIGINAL_FILE, 'utf8'));
  } catch {
    record = null;
  }

  let note = null;
  if (record && record.had === true && record.statusLine) {
    settings.statusLine = record.statusLine;
  } else if (record && record.had === false) {
    delete settings.statusLine;
  } else {
    // The record is missing or unreadable, but our wrapper IS installed:
    // delete it rather than leave settings.statusLine pointing at a command
    // path in this repo that may no longer exist.
    delete settings.statusLine;
    note = 'No recorded original statusLine found; removed the fleet-monitor wrapper instead of restoring it.';
  }

  try {
    fs.rmSync(STATUSLINE_ORIGINAL_FILE, { force: true });
  } catch {
    // best effort only
  }

  return { changed: true, note };
}

export function removeHooks() {
  const settings = readSettings();

  let removed = 0;
  if (settings.hooks) {
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
  }

  const statuslineResult = removeStatusline(settings);
  if (statuslineResult.note) process.stdout.write(statuslineResult.note + '\n');

  if (removed > 0 || statuslineResult.changed) {
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  }
  // Returns both outcomes, not just the hook count: a run that restored the
  // statusline but found no hooks still changed settings.json, and reporting
  // only `removed` there would print "nothing found" over a real edit.
  return { hooks: removed, statusline: statuslineResult.changed };
}

// Human-readable summary of a removeHooks() result, shared with stop.mjs so
// both entry points describe the same run the same way.
export function describeRemoval(result) {
  const parts = [];
  if (result.hooks > 0) parts.push(`removed ${result.hooks} hook group(s)`);
  if (result.statusline) parts.push('restored the original statusLine');
  return parts.length ? parts.join(' and ') : 'found nothing to remove';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = removeHooks();
  process.stdout.write(`Fleet monitor uninstall: ${describeRemoval(result)}.\n`);
}
