// How the MSI is handed to msiexec. Lives in its own module, importable without
// Electron, so the exact spawn shape can be asserted by a test instead of only
// being discovered by a user watching an installer fail.
//
// THE BUG THIS ENCODES (fixed 2026-07-30, issue #18). The obvious form
//
//   spawn('cmd', ['/c', `ping -n 6 127.0.0.1 & msiexec /i "${msiPath}"`], { ... })
//
// is broken on Windows. That single argv element contains spaces, so Node quotes
// it for the command line AND escapes the embedded double quotes as \". cmd.exe
// does not understand \", so msiexec receives
//   \"C:\Users\...\Mission.Control.Center.0.1.9.msi\"
// and looks for a file whose name literally contains quote characters, failing
// with "This installation package could not be opened. Verify that the package
// exists...". The `ping` half is unaffected, so the symptom is a delay window
// followed by what looks like a corrupt download, while the MSI sits perfectly
// fine in %TEMP%. windowsVerbatimArguments turns Node's quoting off, so the
// string reaches cmd exactly as written.
//
// SECOND TRAP, also load-bearing: the command line must NOT start with a quote.
// `cmd /c` strips the outer quote pair when its command line begins with one,
// which then breaks a quoted program path containing spaces. The leading `ping`
// keeps the first token unquoted, so the quotes around the MSI path survive.
// Reproduced while writing scripts/check-installer-launch.mjs, by dropping the
// ping: cmd answered "'C:\Users\pr\AppData\Local\Temp\cmc-installer' is not
// recognized as an internal or external command".
//
// Why a detached `cmd` with a delay at all: msiexec must not start while this app
// (or the backend process it spawned from the same installed binary) is alive, or
// the installer's "Files in Use" page lists Mission Control Center and a
// surviving backend keeps holding the port. `ping` is the dependency-free sleep;
// `timeout` needs a console and fails in a detached process. No `start` wrapper
// (msiexec is on PATH and `start` wants a title argument that is easy to mangle)
// and no `>nul` (stdio is already ignored, and the redirect was observed emitting
// "The system cannot find the path specified.").
export const INSTALLER_DELAY_PINGS = 6;

// Returns { file, args, options } ready to hand to child_process.spawn.
export function installerSpawnArgs(msiPath) {
  return {
    file: 'cmd',
    args: ['/c', `ping -n ${INSTALLER_DELAY_PINGS} 127.0.0.1 & msiexec /i "${msiPath}"`],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // Load-bearing: without this Node rewrites the quotes around msiPath as \"
      // and msiexec cannot open the package. See the comment above.
      windowsVerbatimArguments: true,
    },
  };
}
