// Exercises scripts/flag-resume.mjs (the /resume-later skill's engine) against a
// hermetic HOME: flag, re-flag, list, unflag, and the failure modes. Nothing here
// touches the developer's real flag file, and it really spawns the script rather
// than importing pieces of it, because the CLI surface IS the contract the skill
// depends on. Platform neutral, so it runs in CI:
//   node scripts/check-flag-resume.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'flag-resume.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-flag-'));
const REG = path.join(HOME, '.claude', 'sessions');
fs.mkdirSync(REG, { recursive: true });
// A registry entry exactly as Claude Code writes one, so the name and cwd are
// picked up from it rather than guessed.
fs.writeFileSync(path.join(REG, '4242.json'), JSON.stringify({
  pid: 4242,
  sessionId: 'flag-me-1',
  cwd: 'C:/Users/pr/repos/2-ZRM/customers/Samberg',
  name: 'Samberg VIBE Extension',
  status: 'waiting',
}));
const FLAGS = path.join(HOME, '.claude', 'agent-fleet-monitor', 'resume-flags.json');

let failed = false;
function check(name, cond, detail) {
  process.stdout.write((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  <- ' + detail) + '\n');
  if (!cond) failed = true;
}
function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME, USERPROFILE: HOME, CLAUDE_PID: '4242', CLAUDE_CODE_SESSION_ID: 'flag-me-1', ...env },
  });
}
const flags = () => { try { return JSON.parse(fs.readFileSync(FLAGS, 'utf8')); } catch { return null; } };

let r = run(['paused', 'until', '16:00']);
check('flagging succeeds', r.status === 0, r.status + ' ' + r.stderr);
check('it reports the session NAME, not the id', /Flagged "Samberg VIBE Extension"/.test(r.stdout), r.stdout);
let f = flags();
check('one flag is written', Array.isArray(f) && f.length === 1, JSON.stringify(f));
check('the flag carries id, name, cwd, project and note from the registry',
  f[0].sessionId === 'flag-me-1' && f[0].name === 'Samberg VIBE Extension' &&
    f[0].project === 'Samberg' && f[0].note === 'paused until 16:00' && typeof f[0].flaggedAt === 'number',
  JSON.stringify(f[0]));

const firstAt = f[0].flaggedAt;
r = run(['different', 'note']);
f = flags();
check('re-flagging updates in place instead of duplicating',
  f.length === 1 && f[0].note === 'different note' && f[0].flaggedAt >= firstAt, JSON.stringify(f));

r = run(['--list']);
check('--list names the flagged session', /Samberg VIBE Extension/.test(r.stdout), r.stdout);

// A second session, flagged explicitly rather than from the environment.
r = run(['--id', 'flag-me-2', '--name', 'Second One'], { CLAUDE_CODE_SESSION_ID: '' });
f = flags();
check('--id plus --name flags a session with no environment of its own',
  r.status === 0 && f.length === 2 && f.some((x) => x.sessionId === 'flag-me-2' && x.name === 'Second One'),
  JSON.stringify(f));

r = run(['--unflag']);
f = flags();
check('--unflag drops THIS session only',
  r.status === 0 && f.length === 1 && f[0].sessionId === 'flag-me-2', JSON.stringify(f));
r = run(['--unflag']);
check('unflagging something already unflagged is not an error',
  r.status === 0 && /nothing changed/i.test(r.stdout), r.status + ' ' + r.stdout);

r = run(['--unflag', 'flag-me-2']);
f = flags();
check('--unflag <id> drops a named session', r.status === 0 && f.length === 0, JSON.stringify(f));

r = run([], { CLAUDE_CODE_SESSION_ID: '' });
check('with no session id and no --id it fails loudly rather than guessing',
  r.status === 1 && /CLAUDE_CODE_SESSION_ID/.test(r.stderr), r.status + ' ' + r.stderr);

// A session with no registry entry at all: the name is unknown, but flagging must
// still work, since resuming only needs the id.
fs.rmSync(path.join(REG, '4242.json'), { force: true });
r = run([], { CLAUDE_CODE_SESSION_ID: 'no-registry-session' });
f = flags();
check('a session with no registry entry can still be flagged',
  r.status === 0 && f.length === 1 && f[0].sessionId === 'no-registry-session', JSON.stringify(f));
check('and it says the picker will fall back to the project name',
  /No session name found/.test(r.stdout), r.stdout);

fs.rmSync(HOME, { recursive: true, force: true });
process.stdout.write(failed ? '\nRESULT: FAIL\n' : '\nRESULT: ALL PASS\n');
process.exit(failed ? 1 : 0);
