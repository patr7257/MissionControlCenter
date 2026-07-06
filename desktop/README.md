# Claude Mission Control, desktop app

Electron shell around the existing zero-dependency mission control backend. The backend
(`../server.mjs` and friends) runs unchanged as a detached process; this app just ensures the
hooks and server, then shows `http://127.0.0.1:4317` in a native window. Closing the window
leaves the monitor running, exactly like closing the browser tab. The menu action
"Stop server and remove hooks" is the real off switch.

## Dev loop

```
cd C:\Users\pr\repos\patrick-setup-and-features-improvements\claude-mission-control\desktop; npm install; npm start
```

Dev mode resolves the backend as the parent folder and coexists with `node start.mjs`
(shared lock file on port 4317; whichever starts the server first wins, both UIs attach).

## Build the MSI locally

```
cd C:\Users\pr\repos\patrick-setup-and-features-improvements\claude-mission-control\desktop; npm run dist
```

Output: `dist\Claude Mission Control-<version>.msi`. Per-user install (no UAC) into
`%LOCALAPPDATA%\Programs`. The installed app ships the backend under `resources\backend` and
registers hooks pointing at `resources\backend\send-event.mjs.cmd`, which runs the bundled
Electron binary as plain Node, so the machine needs no system Node.

## Releases (CI-built MSI)

Publishing a GitHub release with a tag like `fleet-v0.2.0` triggers
`.github/workflows/fleet-desktop-msi.yml`, which builds the MSI on `windows-latest` and
attaches it to the release. Rules:

- Tag format is `fleet-vX.Y.Z`, plain numbers only (MSI ProductVersion allows no suffixes).
- The version in this package.json is overridden by the tag at build time; no need to bump it.
- The MSI upgrades in place thanks to the fixed `upgradeCode` in `electron-builder.yml`.
  NEVER change that GUID. MSI refuses downgrades by design.
- The MSI is unsigned; SmartScreen shows "unknown publisher" on first run. Expected.

The app checks for newer `fleet-v*` releases via the locally authenticated `gh` CLI
(private repo, so no anonymous API and no baked-in token). If `gh` is missing the check
silently does nothing. "Check for updates" in the Fleet menu does the same on demand.
