// Tests desktop/server-ready.mjs, the startup decision the desktop shell makes
// before it can show anything: is the backend already serving, and if not, does
// it come up inside the budget.
//
// Why this is a test and not a review: the bug it covers looked correct on the
// page. main.mjs trusted `server.lock` naming a LIVE pid as proof the backend was
// running, so it skipped the spawn; Windows recycles pids, so a lock left by a
// non-graceful exit could name an unrelated process and nothing ever started.
// The app then sat on an 8 second timeout and showed a dead-end error page. Only
// the sequence of calls proves the difference, so every dependency is injected
// and the clock is fake (the whole file runs in milliseconds).
//
// Zero dependencies, no Electron: server-ready.mjs deliberately imports nothing.

import { ensureServerReady, STARTUP_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../desktop/server-ready.mjs';

let failures = 0;
function check(label, ok) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}\n`);
  if (!ok) failures += 1;
}

// A fake clock the sleeps drive, so a 30s budget costs no wall-clock time.
function harness({ lock, answersAfterSpawn = 0, neverAnswers = false, answersBeforeSpawn = false }) {
  const state = {
    now: 0,
    spawns: 0,
    probes: [],
    sleeps: 0,
  };
  const deps = {
    readLock: () => lock,
    probe: async (port) => {
      state.probes.push(port);
      if (neverAnswers) return false;
      if (state.spawns === 0) return answersBeforeSpawn;
      // A started backend needs a moment: it answers once this many poll waits
      // have gone by, which is what makes "waited rather than assumed" testable.
      return state.sleeps >= answersAfterSpawn;
    },
    spawnServer: () => {
      state.spawns += 1;
    },
    defaultPort: 4317,
    sleep: async (ms) => {
      state.sleeps += 1;
      state.now += ms;
    },
    now: () => state.now,
  };
  return { state, deps };
}

// 1. Something really is serving on the locked port: no spawn at all. This is the
//    ordinary second launch, and spawning here would start a backend that dies on
//    EADDRINUSE every time.
{
  const { state, deps } = harness({ lock: { port: 4317, pid: 1 }, answersBeforeSpawn: true });
  const r = await ensureServerReady(deps);
  check('a lock whose port answers is reported running', r.ok === true && r.reason === 'already-running');
  check('a lock whose port answers spawns nothing', state.spawns === 0);
  check('the answering port is the one reported', r.port === 4317);
}

// 2. THE BUG. A lock exists (pid alive, but recycled: nothing serves), so the old
//    code skipped the spawn and failed. The lock must be treated as a port hint
//    only, and the backend started.
{
  const { state, deps } = harness({ lock: { port: 4317, pid: 4242 }, answersAfterSpawn: 2 });
  const r = await ensureServerReady(deps);
  check('a stale lock that does not answer still starts the backend', state.spawns === 1 && r.spawned === true);
  check('the started backend is waited for, not assumed', r.ok === true && r.reason === 'started');
  check('waiting really polled rather than returning at once', state.sleeps >= 2);
}

// 3. No lock at all (a first ever launch, or a clean shutdown): spawn, wait, done.
{
  const { state, deps } = harness({ lock: null, answersAfterSpawn: 1 });
  const r = await ensureServerReady(deps);
  check('no lock starts the backend', state.spawns === 1 && r.ok === true);
  check('no lock probes the default port', state.probes.every((p) => p === 4317));
}

// 4. Nothing ever answers: fail after the budget, having spawned exactly once. A
//    respawn loop would pile up backends against a port held by another program.
{
  const { state, deps } = harness({ lock: null, neverAnswers: true });
  const r = await ensureServerReady(deps);
  check('a backend that never answers reports failure', r.ok === false && r.reason === 'timeout');
  check('a failing start spawns exactly once, never in a loop', state.spawns === 1);
  check('the whole budget is used before giving up', state.now >= STARTUP_TIMEOUT_MS - 150);
}

// 5. The budget itself. 8s was too short for a first launch after a reboot (a
//    232 MB Electron binary paged in past Defender), which is what produced the
//    "sometimes it just fails" report; 30s is the deliberate replacement.
check('the startup budget is 30s, not the old 8s', STARTUP_TIMEOUT_MS === 30000);
check('a single probe is bounded so a wedged server cannot eat the budget', PROBE_TIMEOUT_MS <= 2000);

// 6. A lock that cannot be parsed must not throw out of the whole startup: a
//    corrupt lock file has to degrade to "assume the default port".
{
  const state = { spawns: 0, now: 0 };
  const r = await ensureServerReady({
    readLock: () => {
      throw new Error('corrupt lock');
    },
    probe: async () => state.spawns > 0,
    spawnServer: () => {
      state.spawns += 1;
    },
    defaultPort: 4317,
    sleep: async () => {},
    now: () => state.now,
  });
  check('a corrupt lock file falls back to the default port instead of throwing', r.ok === true && r.port === 4317);
}

// 7. STATIC read of the retry wiring, labelled as such. Whether the button on a
//    data: URL error page really reaches the main process can only be settled by
//    running Electron, which this check deliberately does not do. What it CAN
//    prove is the half that silently breaks: a channel name that stops matching
//    between the page, the preload bridge and the ipcMain handler. The page also
//    degrades to naming the Fleet menu item when the bridge is absent, so a
//    missing bridge is a worse label, not a dead end.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const main = fs.readFileSync(path.join(here, '..', 'desktop', 'main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(here, '..', 'desktop', 'preload.cjs'), 'utf8');
  const CHANNEL = 'cmc:retry-server';
  check('static: main.mjs handles the retry channel', main.includes(`ipcMain.handle('${CHANNEL}'`));
  check('static: preload.cjs invokes the SAME channel name', preload.includes(`ipcRenderer.invoke('${CHANNEL}')`));
  check('static: the bridge the error page calls is the one preload exposes',
    preload.includes("exposeInMainWorld('cmcRetry'") && main.includes('window.cmcRetry'));
  check('static: the error page falls back to naming the menu item when the bridge is missing',
    main.includes('Fleet > Retry starting server') && main.includes("label: 'Retry starting server'"));
  check('static: the error page quotes the real budget rather than a hardcoded 8 seconds',
    main.includes('STARTUP_TIMEOUT_MS / 1000') && !main.includes('within 8 seconds'));
}

process.stdout.write(failures === 0 ? 'check-server-ready: all checks passed\n' : `check-server-ready: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
