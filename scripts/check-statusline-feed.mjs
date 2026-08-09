// Exercises statusline-feed.mjs (the wrapper install-hooks.mjs points
// settings.statusLine at) against a hermetic HOME. Nothing here touches the
// developer's real statusline record, and it really SPAWNS the wrapper rather
// than importing pieces of it, for two reasons: importing the module runs its
// stdin wiring and would hang, and the whole contract here is process-shaped
// (stdout forwarded, exit code adopted, env sanitised, stdin piped through).
//
// The load-bearing case is ELECTRON_RUN_AS_NODE. In a packaged install this
// wrapper is launched by desktop/assets/statusline-feed.mjs.cmd, which sets that
// variable so the Electron binary runs as plain Node. If it leaked into the
// user's real statusline command and that command is itself an Electron app, the
// app would run as a bare Node interpreter and print nothing: a blank statusline
// with no clue why. Static review cannot settle that, which is the same reason
// scripts/check-installer-launch.mjs really spawns the updater command.
//
// Platform neutral, so it runs in CI:
//   node scripts/check-statusline-feed.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'statusline-feed.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-statusline-'));
const DATA_DIR = path.join(HOME, '.claude', 'agent-fleet-monitor');
const RECORD = path.join(DATA_DIR, 'statusline-original.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let failed = false;
function check(name, cond, detail) {
  process.stdout.write((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  <- ' + detail) + '\n');
  if (!cond) failed = true;
}

// The stand-in for "the user's real statusline command". It lives in a folder
// whose name contains a space on purpose: the recorded value is a command
// STRING run through a shell, so a quoted path with spaces is the normal case
// and must survive. It echoes back what it was given so the assertions below can
// see the child's own view rather than trusting the parent's.
const ORIG_DIR = path.join(HOME, 'my statusline');
fs.mkdirSync(ORIG_DIR, { recursive: true });
const ORIG = path.join(ORIG_DIR, 'orig.mjs');
fs.writeFileSync(
  ORIG,
  [
    "let body = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { body += c; });",
    "process.stdin.on('end', () => {",
    "  let sid = '(unparsed)';",
    '  try { sid = JSON.parse(body).session_id; } catch {}',
    "  process.stdout.write('ORIG session=' + sid + ' electron=' + (process.env.ELECTRON_RUN_AS_NODE || '(unset)'));",
    '  process.exit(Number(process.env.ORIG_EXIT || 0));',
    '});',
  ].join('\n')
);
const ORIG_COMMAND = `"${process.execPath}" "${ORIG}"`;

const PAYLOAD = JSON.stringify({
  session_id: 'statusline-1',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1754500000 } },
});

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    input: PAYLOAD,
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      // No server lock file exists under this HOME, so the fire-and-forget POST
      // is a no-op; CMC_DRY_RUN makes that explicit rather than incidental.
      CMC_DRY_RUN: '1',
      ...env,
    },
  });
}

// ---- The normal case: a recorded command, run with the parent polluted by the
// very variable the .cmd wrapper sets.
fs.writeFileSync(RECORD, JSON.stringify({ had: true, statusLine: { type: 'command', command: ORIG_COMMAND } }));
let r = run({ ELECTRON_RUN_AS_NODE: '1' });
check('the original statusline command runs and its stdout is forwarded',
  /^ORIG session=statusline-1/.test(String(r.stdout)), JSON.stringify(r.stdout));
check('ELECTRON_RUN_AS_NODE never reaches the original command',
  /electron=\(unset\)/.test(String(r.stdout)), JSON.stringify(r.stdout));
check('the stdin payload is piped through to the original command unchanged',
  /session=statusline-1/.test(String(r.stdout)), JSON.stringify(r.stdout));
check('a quoted command path containing spaces survives the shell',
  !/(unparsed)/.test(String(r.stderr || '')) && r.status === 0, r.status + ' ' + r.stderr);

// ---- windowsHide (issue #43). Honestly labelled: this one is STATIC, a read of
// the module source, unlike everything else in this file. Proving the real thing
// means spawning and then ENUMERATING WINDOWS to see whether a console appeared,
// and that is exactly what must not run: without the flag, 0.1.19 opened a fresh
// Windows Terminal window per statusline render and flooded the desktop until it
// crashed, so a test that reproduced it would be the bug.
//
// The behavioural half is already above and is the part that matters most: those
// assertions run WITH the flag set, so "stdout is forwarded" and "our exit code
// is the child's" now double as proof that windowsHide suppresses the console
// WITHOUT touching stdio.
const feedSource = fs.readFileSync(SCRIPT, 'utf8');
const spawnOpts = /spawn\(originalCommand,\s*\{([\s\S]*?)\}\)/.exec(feedSource);
check('the wrapper spawn still hides the console window (static read of the source)',
  !!spawnOpts && /windowsHide:\s*true/.test(spawnOpts[1]) && /shell:\s*true/.test(spawnOpts[1]),
  spawnOpts ? spawnOpts[1].replace(/\s+/g, ' ').trim() : 'spawn(originalCommand, {...}) not found');

// ---- The exit code belongs to the child, never to us. A statusline command
// that fails must look failed to Claude Code.
r = run({ ORIG_EXIT: '7' });
check('our exit code is the original command exit code', r.status === 7, String(r.status));

// ---- No statusline before we wrapped: printing nothing is the CORRECT result,
// and must stay distinguishable from the broken case below.
fs.writeFileSync(RECORD, JSON.stringify({ had: false }));
r = run();
check('a recorded "no statusline" prints nothing and exits 0',
  r.status === 0 && String(r.stdout) === '', r.status + ' ' + JSON.stringify(r.stdout));

// ---- Installed but the record is gone (data dir wiped, half-written). Blanking
// a statusline the user DOES have, with no clue why, is the failure mode this
// message exists to prevent.
fs.rmSync(RECORD, { force: true });
r = run();
check('a missing record names the problem instead of silently blanking',
  r.status === 0 && /record missing/.test(String(r.stdout)), r.status + ' ' + JSON.stringify(r.stdout));

fs.writeFileSync(RECORD, '{ not json');
r = run();
check('an unreadable record is treated as missing, not as "no statusline"',
  r.status === 0 && /record missing/.test(String(r.stdout)), r.status + ' ' + JSON.stringify(r.stdout));

// ---- A recorded command that does not exist. Note this does NOT reach the
// wrapper's child.on('error') path: with shell:true the SHELL spawns fine and
// then reports the failure itself, so what matters is that the wrapper stays
// faithful, printing nothing of its own on stdout and passing the shell's
// non-zero code through rather than masking a broken statusline as healthy.
fs.writeFileSync(RECORD, JSON.stringify({
  had: true,
  statusLine: { type: 'command', command: `"${path.join(HOME, 'no-such-binary-xyz')}"` },
}));
r = run();
check('a nonexistent original prints nothing of ours and passes its failure through',
  r.status !== 0 && String(r.stdout) === '', r.status + ' ' + JSON.stringify(r.stdout));

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  // best effort only
}

process.stdout.write(failed ? '\nSTATUSLINE FEED CHECK FAILED\n' : '\nstatusline feed check passed\n');
process.exit(failed ? 1 : 0);
