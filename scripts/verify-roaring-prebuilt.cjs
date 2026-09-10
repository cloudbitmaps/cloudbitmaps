#!/usr/bin/env node
/*
 * The one runtime dependency, `roaring`, is a native addon that node-pre-gyp downloads as a prebuilt binary at
 * install time (compiling from source if no prebuilt matches). Our provenance-signed publish does not cover it —
 * it is not in our tarball — so this records what we got, per platform, and fails when it changes.
 *
 * Modes:
 *   - key known in scripts/roaring-prebuilt-checksums.json → sha256 must match, else exit 1;
 *   - key unknown → print a RECORD line (copy it into the JSON) and exit 0; `--strict` turns that into exit 1.
 * The key is the prebuilt's own directory name (version + node ABI + platform + arch + libc), so a from-source
 * build on some runner shows up as a mismatch there rather than being silently accepted.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const strict = process.argv.includes('--strict');
const pkgJson = require.resolve('roaring/package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
const nativeDir = path.join(path.dirname(pkgJson), 'native');
const table = path.join(__dirname, 'roaring-prebuilt-checksums.json');
const known = fs.existsSync(table) ? JSON.parse(fs.readFileSync(table, 'utf8')) : {};

const dirs = fs.existsSync(nativeDir)
  ? fs.readdirSync(nativeDir).filter((d) => fs.existsSync(path.join(nativeDir, d, 'roaring.node')))
  : [];
if (dirs.length === 0) {
  console.error(`verify-roaring-prebuilt: no roaring.node found under ${nativeDir}`);
  process.exit(1);
}
let failed = false;
for (const dir of dirs) {
  const file = path.join(nativeDir, dir, 'roaring.node');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const key = `${pkg.version}/${dir}`;
  const expected = known[key];
  if (expected === undefined) {
    console.log(`RECORD ${key} ${sha256}`);
    if (strict) failed = true;
  } else if (expected !== sha256) {
    console.error(
      `verify-roaring-prebuilt: MISMATCH for ${key}\n  expected ${expected}\n  got      ${sha256}`,
    );
    failed = true;
  } else {
    console.log(`verify-roaring-prebuilt: OK ${key}`);
  }
}
process.exit(failed ? 1 : 0);
