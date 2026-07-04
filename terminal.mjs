// Windows Terminal control for a managed window named 'cmc'.
// Zero dependencies beyond Node built-ins.
// Every exported function is best effort: it must never throw out to its caller.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const WT_WINDOW = 'cmc';

// Ordered record of tabs we have opened into the managed window.
// { sessionId, cwd, title, launchedAt, tabIndex }
// Deliberately unbounded: `tabIndex` is each entry's position in this array,
// and it doubles as the literal `wt focus-tab -t <n>` argument, so it must
// match the real Windows Terminal tab position. Trimming old entries (from
// the front or anywhere else) would shift the indices of every entry after
// the trim point and desync them from the actual tabs, breaking focus for
// existing sessions. This process is restarted often enough (dev server,
// machine restarts) that the array never grows large in practice, so the
// unbounded growth is acceptable for a session-scoped tool.
export const managedTabs = [];

const BIND_WINDOW_MS = 60000;

function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Build the readable command string shown in the UI/logs. `quotedIndexes` is
// the set of positions in `args` (repoPath, title, cwd, and similar
// free-form values that may contain spaces) that should be wrapped in double
// quotes for readability; every other token (flags, subcommands, the window
// name, tab index, session id) is printed bare.
function buildReadableCommand(args, quotedIndexes) {
  const parts = ['wt'];
  args.forEach((a, i) => {
    parts.push(quotedIndexes.has(i) ? '"' + a + '"' : a);
  });
  return parts.join(' ');
}

// Fire-and-forget launch of wt.exe via cmd start, detached so Node never blocks.
function spawnWt(args) {
  spawn('cmd', ['/c', 'start', '', 'wt', ...args], { detached: true, stdio: 'ignore' }).unref();
}

export function listRepos() {
  try {
    const reposDir = path.join(os.homedir(), 'repos');
    const entries = fs.readdirSync(reposDir, { withFileTypes: true });
    const repos = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      repos.push({ name: entry.name, path: path.join(reposDir, entry.name) });
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return repos;
  } catch {
    return [];
  }
}

export function launchSession(repoPath, title) {
  try {
    const args = ['-w', WT_WINDOW, 'nt', '-d', repoPath, '--title', title, 'claude'];
    // Quote the repoPath (index 4) and title (index 6): the values that may
    // contain spaces. Everything else stays bare for readability.
    const command = buildReadableCommand(args, new Set([4, 6]));
    const tabIndex = managedTabs.length;

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push({ sessionId: null, cwd: repoPath, title, launchedAt: Date.now(), tabIndex });
      return { ok: true, command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push({ sessionId: null, cwd: repoPath, title, launchedAt: Date.now(), tabIndex });
    return { ok: true, command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function focusSession(sessionId, cwd) {
  try {
    const existing = managedTabs.find((t) => t.sessionId === sessionId);
    if (existing) {
      const args = ['-w', WT_WINDOW, 'focus-tab', '-t', String(existing.tabIndex)];
      const command = buildReadableCommand(args, new Set());
      if (process.env.CMC_DRY_RUN) {
        return { ok: true, mode: 'focused', command, dryRun: true };
      }
      spawnWt(args);
      return { ok: true, mode: 'focused', command };
    }

    // External or not yet bound: reattach via --resume in a new tab.
    const args = ['-w', WT_WINDOW, 'nt', '-d', cwd, 'claude', '--resume', sessionId];
    // Quote the cwd (index 4): it may contain spaces. sessionId stays bare.
    const command = buildReadableCommand(args, new Set([4]));
    const tabIndex = managedTabs.length;
    const entry = {
      sessionId,
      cwd,
      title: 'resume:' + sessionId,
      launchedAt: Date.now(),
      tabIndex,
    };

    if (process.env.CMC_DRY_RUN) {
      managedTabs.push(entry);
      return { ok: true, mode: 'reattached', command, dryRun: true };
    }

    spawnWt(args);
    managedTabs.push(entry);
    return { ok: true, mode: 'reattached', command };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function bindSession(cwd, sessionId) {
  try {
    const normalizedCwd = normalizePath(cwd);
    const now = Date.now();
    for (let i = managedTabs.length - 1; i >= 0; i -= 1) {
      const tab = managedTabs[i];
      if (tab.sessionId !== null) continue;
      if (normalizePath(tab.cwd) !== normalizedCwd) continue;
      if (now - tab.launchedAt > BIND_WINDOW_MS) continue;
      tab.sessionId = sessionId;
      return;
    }
  } catch {
    // best effort only, never throw
  }
}
