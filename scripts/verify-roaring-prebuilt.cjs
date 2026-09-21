#!/usr/bin/env node
/*
 * `@cloudbitmaps/roaring`'s one third-party dependency, `roaring`, is a native addon that node-pre-gyp
 * downloads as a prebuilt binary at install time (compiling from source if no prebuilt matches). Our
 * provenance-signed publish does not cover it — it is not in our tarball — so this records what we got,
 * per platform, and fails when it changes.
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
    // A mismatch here has one overwhelmingly likely cause, and it is not a changed upstream artifact: the
    // prebuilt DOWNLOAD failed and node-pre-gyp fell back to compiling from source. That happened on a
    // Windows runner when GitHub returned 500 for the release asset — the install log said so plainly
    // ("Pre-built binaries not installable … falling back to source compile with node-gyp") and the locally
    // compiled binary naturally hashed differently. The directory key is identical either way, so this
    // script cannot tell the two apart from the file alone; the install log can, which is why the message
    // says where to look rather than guessing.
    //
    // It deliberately does NOT retry or soften the verdict: this is a supply-chain check, and one that
    // retries until it likes the answer is not a check. The size is reported because it is the cheap tell —
    // a source build and a prebuilt differ in size, so the number distinguishes "built here" from "the
    // upstream artifact changed", which are very different problems.
    const again = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const bytes = fs.statSync(file).size;
    console.error(
      `verify-roaring-prebuilt: MISMATCH for ${key}\n  expected ${expected}\n  got      ${sha256}\n` +
        `  re-read  ${again === sha256 ? 'identical (stable on disk)' : `DIFFERENT (${again}) — the file is changing under us`}\n` +
        `  size     ${bytes} bytes\n` +
        `  FIRST check the install log above for "falling back to source compile": a failed prebuilt\n` +
        `  download means this binary was built here, and its hash will never match a recorded one.\n` +
        `  Only if a prebuilt really was downloaded is this an upstream artifact change — verify with the\n` +
        `  roaring maintainers before touching ${path.basename(table)}.`,
    );
    failed = true;
  } else {
    console.log(`verify-roaring-prebuilt: OK ${key}`);
  }
}
process.exit(failed ? 1 : 0);
