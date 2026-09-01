// Deciding whether the backend needs starting, and waiting until it really
// answers. Split out of main.mjs so it can be tested without Electron, the same
// reason installer-cmd.mjs is its own module: the whole failure this fixes was
// invisible to review and only shows up as behaviour under a fake clock.
//
// The bug it replaces: main.mjs skipped spawning whenever server.lock held a pid
// that was merely ALIVE, then polled that port for 8 seconds and gave up on a
// dead-end error page with no retry and no log line. A live pid is not proof
// that anything serves: Windows recycles pids, so a lock left behind by a
// non-graceful exit can name an unrelated running process, and then nothing ever
// starts. So the lock is now only a HINT about which port to try first, and the
// only thing that counts as "running" is an HTTP answer.
//
// Every dependency is injected. Callers pass the real lock reader, probe, spawn
// and clock; the test passes fakes.

// 30s, not the old 8s. Warm, the packaged backend answers in about 0.5s
// (measured 2026-09-01: 304ms to "listening", 441ms to the first HTTP 200), but
// a first launch after a reboot pages a 232 MB Electron binary in past
// Defender's real-time scan, and there is no second attempt to fall back on.
export const STARTUP_TIMEOUT_MS = 30000;

// One probe of a port that is not being served fails fast (connection refused);
// this cap only bites when something accepts the connection and then says
// nothing, which is exactly the wedged-server case worth moving past.
export const PROBE_TIMEOUT_MS = 1000;

const DEFAULT_POLL_MS = 150;

/**
 * Make sure something is serving the dashboard, spawning the backend if not.
 *
 * @param {object} deps
 * @param {() => ({port?: number}|null)} deps.readLock  current server.lock, or null
 * @param {(port: number) => Promise<boolean>} deps.probe  does an HTTP GET answer?
 * @param {() => void} deps.spawnServer  start the detached backend
 * @param {number} deps.defaultPort  port to try when the lock names none
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} [deps.now]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.pollMs]
 * @returns {Promise<{ok: boolean, port: number, spawned: boolean, reason: string}>}
 */
export async function ensureServerReady(deps) {
  const {
    readLock,
    probe,
    spawnServer,
    defaultPort,
    sleep,
    now = () => Date.now(),
    timeoutMs = STARTUP_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  } = deps;

  const portFromLock = () => {
    let lock = null;
    try {
      lock = readLock();
    } catch {
      lock = null;
    }
    return (lock && lock.port) || defaultPort;
  };

  const deadline = now() + timeoutMs;

  // A lock exists, so something may already be serving: probe before spawning,
  // otherwise every launch would start a second backend that dies on
  // EADDRINUSE. With no lock at all there is nothing to probe, so skip straight
  // to the spawn and save the caller a round trip.
  let firstPort = portFromLock();
  let hadLock = false;
  try {
    hadLock = !!readLock();
  } catch {
    hadLock = false;
  }
  if (hadLock && (await probe(firstPort))) {
    return { ok: true, port: firstPort, spawned: false, reason: 'already-running' };
  }

  // Spawned exactly once. A respawn loop would pile up backends against a port
  // held by something else, and the retry path (a button on the error page) is
  // where a second attempt belongs, since by then the user can see it failed.
  spawnServer();

  while (now() < deadline) {
    // Re-read the lock every pass: the backend we just started writes its own,
    // and it may have resolved a different port than the one we guessed.
    const port = portFromLock();
    if (await probe(port)) {
      return { ok: true, port, spawned: true, reason: 'started' };
    }
    await sleep(pollMs);
  }

  return { ok: false, port: portFromLock(), spawned: true, reason: 'timeout' };
}
