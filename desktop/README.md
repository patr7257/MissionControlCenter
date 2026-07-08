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

## Installing the MSI (SmartScreen warning is expected)

The MSI is unsigned, so on the first run Windows SmartScreen shows a blue
"Windows protected your PC" dialog naming an unknown publisher. This is expected
until code signing is added (see below); the installer is safe to run. To proceed:

1. Double-click the `.msi`.
2. On the SmartScreen dialog, click "More info".
3. Click "Run anyway".
4. The install is per-user into `%LOCALAPPDATA%\Programs`, so there is no UAC
   admin prompt.

If a browser flagged the download itself, choose "Keep" on the download first.

## Code signing (future)

Not done yet: an Authenticode code-signing certificate removes the SmartScreen
warning for good. When a certificate is available, wire it into the release
workflow rather than signing by hand:

- Store the certificate (PFX, base64) and its password as GitHub Actions secrets.
- In `.github/workflows/fleet-desktop-msi.yml`, set electron-builder's signing env
  (`CSC_LINK`, `CSC_KEY_PASSWORD`) on the Build MSI step and drop the
  `CSC_IDENTITY_AUTO_DISCOVERY: "false"` line that currently forces an unsigned build.
- An OV certificate still needs reputation to build before SmartScreen trusts it; an
  EV certificate (hardware token) is trusted immediately but cannot live as a plain
  CI secret. Decide the certificate type before wiring this up.

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
