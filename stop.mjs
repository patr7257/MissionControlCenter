// agent-fleet-monitor: stop the dashboard
// - removes our feeder hooks from ~/.claude/settings.json
// - stops the server process and clears the lock file

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { removeHooks } from './uninstall-hooks.mjs';

const LOCK_FILE = path.join(os.homedir(), '.claude', 'agent-fleet-monitor', 'server.lock');

function main() {
  const removed = removeHooks();

  let stopped = false;
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock && lock.pid) {
      try {
        process.kill(lock.pid);
        stopped = true;
      } catch {
        // already gone
      }
    }
  } catch {
    // no lock file
  }
  try {
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // ignore
  }

  process.stdout.write(
    `Fleet monitor stopped${stopped ? '' : ' (server was not running)'}; removed ${removed} hook group(s).\n`
  );
}

main();
