// Proves the in-app updater's install command really delivers the MSI path to
// msiexec unmangled, by spawning the EXACT shape from desktop/installer-cmd.mjs
// with a stand-in for msiexec that prints the argv it received.
//
// Why this exists: `spawn('cmd', ['/c', 'ping ... & msiexec /i "<path>"'])` looks
// obviously correct and is not. Node quotes that argv element (it contains
// spaces) and escapes the embedded double quotes as \", which cmd.exe passes
// through literally, so msiexec hunts for a file whose name contains quote
// characters and dies with "This installation package could not be opened."
// Static review read the line as fine; one real spawn settled it (issue #18).
//
// Windows only, since it is Windows quoting that is under test. SKIPS with exit 0
// elsewhere, so CI on Linux can call it safely.
//   node scripts/check-installer-launch.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerSpawnArgs, INSTALLER_DELAY_PINGS } from '../desktop/installer-cmd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== 'win32') {
  process.stdout.write('SKIP  not Windows, the quoting under test is Windows-only\n');
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!ok) {
    failures += 1;
    if (detail) process.stdout.write(`        ${detail}\n`);
  }
}

// A path with a space AND a directory that really exists, so this also covers the
// case the installed app hits (%TEMP% is space-free, but Program Files is not).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-installer probe-'));
const msiPath = path.join(dir, 'Mission.Control.Center.9.9.9.msi');
fs.writeFileSync(msiPath, 'not a real msi');

const printer = path.join(dir, 'print-argv.cmd');
// %* is the raw argument tail, so a mangled quote shows up verbatim.
fs.writeFileSync(printer, '@echo off\r\necho ARGS:%*\r\n');

const { args, options } = installerSpawnArgs(msiPath);
// Same command line, with the printer standing in for msiexec and the delay cut
// to one ping, captured instead of detached so the output can be asserted. The
// leading `ping` is KEPT on purpose: `cmd /c` strips the outer quote pair when the
// command line starts with a quote, which breaks a quoted program path containing
// spaces. Dropping the ping while writing this check reproduced exactly that
// ("'C:\\Users\\pr\\AppData\\Local\\Temp\\cmc-installer' is not recognized"), so the
// unquoted first token is load-bearing in the real command too.
const line = args[1]
  .replace(`ping -n ${INSTALLER_DELAY_PINGS} `, 'ping -n 1 ')
  .replace('msiexec /i ', `"${printer}" `);

const out = await new Promise((resolve) => {
  let buf = '';
  const child = spawn('cmd', ['/c', line], {
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    windowsHide: true,
  });
  child.stdout.on('data', (d) => (buf += d));
  child.stderr.on('data', (d) => (buf += d));
  child.on('close', () => resolve(buf));
  child.on('error', () => resolve(buf));
});

const argsLine = (out.split(/\r?\n/).find((l) => l.startsWith('ARGS:')) || '').slice(5).trim();
check('the stand-in for msiexec was reached at all', argsLine.length > 0, JSON.stringify(out));
check('the MSI path arrives with no backslash-escaped quotes (the bug)',
  !argsLine.includes('\\"'), argsLine);
check('the MSI path arrives intact, spaces and all',
  argsLine.replace(/^"|"$/g, '') === msiPath, `${argsLine} != ${msiPath}`);
check('the path the command carries actually exists', fs.existsSync(msiPath));

fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
