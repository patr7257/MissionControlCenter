// Lightweight "is there a newer release?" check for the desktop app.
// The repo is private, so instead of baking a token into the app this shells
// out to the locally authenticated gh CLI. Any failure (no gh, offline, not
// authed, bad JSON) resolves to "no update" silently.

import { spawn } from 'node:child_process';

const REPO = 'przrm/patrick-setup-and-features-improvements';
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
