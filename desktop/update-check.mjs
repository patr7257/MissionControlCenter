// Lightweight "is there a newer release?" check for the desktop app.
// Shells out to the locally authenticated gh CLI rather than baking a token
// into the app. (The repo is PUBLIC as of 2026-07-30, so the listing would work
// unauthenticated too; gh is kept because `gh release download` in the install
// path uses it anyway, and it keeps both paths on one mechanism.) Any failure
// (no gh, offline, not authed, bad JSON) resolves to "no update" silently.
// Verified 2026-07-30 that the listing succeeds under either of the two GitHub
// accounts configured on this machine, so the per-account GH_CONFIG_DIR split
// does not affect update checks.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'patr7257/MissionControlCenter';
const TAG_PREFIX = 'fleet-v';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

function ghReleases() {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      // shell:true so gh.exe resolves via PATH on Windows.
      child = spawn('gh', ['api', `repos/${REPO}/releases`], {
        shell: true,
        windowsHide: true,
      });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, 5000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      try {
        finish(JSON.parse(out));
      } catch {
        finish(null);
      }
    });
  });
}

function parseVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Download the MSI asset of a given release tag using the locally authenticated
// gh CLI (same private-repo, no-baked-token model as findNewerRelease). Returns
// the absolute path to the downloaded .msi, or null on any failure (no gh,
// offline, not authed, no MSI asset, timeout). Never throws.
export async function downloadReleaseMsi(tag) {
  if (!tag) return null;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-update-'));
  } catch {
    return null;
  }
  const ok = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      // shell:true so gh.exe resolves via PATH on Windows. --clobber so a retry
      // into the same temp dir does not fail on an existing partial file.
      child = spawn(
        'gh',
        ['release', 'download', tag, '--repo', REPO, '--pattern', '*.msi', '--dir', dir, '--clobber'],
        { shell: true, windowsHide: true }
      );
    } catch {
      return finish(false);
    }
    // Generous: an MSI is tens of MB and the network may be slow.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(false);
    }, 120000);
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
  if (!ok) return null;
  try {
    const msi = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.msi'));
    return msi ? path.join(dir, msi) : null;
  } catch {
    return null;
  }
}

// Returns the newest fleet-v tag strictly newer than currentVersion, or null.
export async function findNewerRelease(currentVersion) {
  const current = parseVersion(currentVersion);
  if (!current) return null;
  const releases = await ghReleases();
  if (!Array.isArray(releases)) return null;
  let bestTag = null;
  let bestVersion = current;
  for (const r of releases) {
    const tag = r && r.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) continue;
    if (r.draft) continue;
    const v = parseVersion(tag.slice(TAG_PREFIX.length));
    if (v && isNewer(v, bestVersion)) {
      bestTag = tag;
      bestVersion = v;
    }
  }
  return bestTag;
}
