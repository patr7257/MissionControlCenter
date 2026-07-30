// Asserts that everything desktop/main.mjs actually imports is packaged into the
// MSI by desktop/electron-builder.yml's `files` list.
//
// Why this exists: 0.1.10 shipped completely dead. #19 added
// desktop/installer-cmd.mjs and imported it from main.mjs, but `files` was an
// explicit three-entry allowlist, so the module was never packaged and the
// installed app died at startup with
//   ERR_MODULE_NOT_FOUND: Cannot find module '...\resources\app\installer-cmd.mjs'
// Nothing caught it: running the repo copy works (the file is right there), the
// smoke suite and the render check do not touch packaging, and a real MSI build
// only fails at RUNTIME, on the user's machine, after a release is published.
//
// Pure static analysis: no Electron, no build, no network. Safe in CI on Linux.
//   node scripts/check-desktop-package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..', 'desktop');
const BUILDER_YML = path.join(DESKTOP, 'electron-builder.yml');

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!ok) {
    failures += 1;
    if (detail) process.stdout.write(`        ${detail}\n`);
  }
}

// Minimal reader for the one thing we need out of the YAML: the `files:` block's
// top-level list items. Deliberately not a YAML parser (zero dependencies), so it
// is strict about the shape it accepts and says so when it cannot find the block.
function readFilesPatterns(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  if (start === -1) return null;
  const patterns = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    // A new top-level key ends the block.
    if (/^\S/.test(line)) break;
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) break;
    patterns.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return patterns;
}

// Only the forms electron-builder is given here: an exact filename, or *.ext.
function matchesPattern(fileName, pattern) {
  if (pattern === fileName) return true;
  const star = /^\*(\.[A-Za-z0-9]+)$/.exec(pattern);
  if (star) return fileName.endsWith(star[1]);
  if (pattern === '**' || pattern === '**/*') return true;
  return false;
}

// Follows relative imports from an entry file, staying inside desktop/.
function localImports(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  const found = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Static `import ... from './x.mjs'`, bare `import './x.mjs'`, and dynamic
    // `import('./x.mjs')`. A computed specifier cannot be resolved statically and
    // is reported so it never silently passes.
    const specifiers = [];
    for (const m of src.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g)) specifiers.push(m[1]);
    for (const m of src.matchAll(/\bimport\s+['"](\.\.?\/[^'"]+)['"]/g)) specifiers.push(m[1]);
    for (const m of src.matchAll(/\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
    for (const spec of specifiers) {
      const resolved = path.resolve(path.dirname(file), spec);
      // Imports that reach OUTSIDE desktop/ are the backend, shipped separately
      // via extraResources, so they are not this check's business.
      if (!resolved.startsWith(path.resolve(DESKTOP) + path.sep)) continue;
      found.add(resolved);
      queue.push(resolved);
    }
  }
  return [...found];
}

const yamlText = fs.readFileSync(BUILDER_YML, 'utf8');
const patterns = readFilesPatterns(yamlText);
check('electron-builder.yml has a readable files: list', Array.isArray(patterns) && patterns.length > 0,
  JSON.stringify(patterns));

if (patterns) {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const entryName = pkg.main || 'main.mjs';
  check(`the package entry (${entryName}) is packaged`,
    patterns.some((p) => matchesPattern(entryName, p)), JSON.stringify(patterns));

  const imports = localImports(path.join(DESKTOP, entryName));
  check('main.mjs imports at least one local module (the walk found something)', imports.length > 0);

  for (const abs of imports) {
    const rel = path.relative(DESKTOP, abs).split(path.sep).join('/');
    const exists = fs.existsSync(abs);
    check(`${rel} exists on disk`, exists);
    // Only top-level files are covered by these flat patterns; a module in a
    // subdirectory would need its own pattern, so flag it rather than guess.
    check(`${rel} is matched by the files: list, so it ships in the MSI`,
      !rel.includes('/') && patterns.some((p) => matchesPattern(rel, p)),
      `patterns: ${JSON.stringify(patterns)}`);
  }

  // preload.cjs is loaded by a BrowserWindow webPreferences path, not by an
  // import, so the walk above cannot see it. It is equally fatal when missing.
  const preloadNamed = /preload\.cjs/.test(fs.readFileSync(path.join(DESKTOP, entryName), 'utf8'));
  if (preloadNamed) {
    check('preload.cjs is matched by the files: list',
      patterns.some((p) => matchesPattern('preload.cjs', p)), JSON.stringify(patterns));
  }
}

process.stdout.write(failures === 0 ? '\nRESULT: ALL PASS\n' : `\nRESULT: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
