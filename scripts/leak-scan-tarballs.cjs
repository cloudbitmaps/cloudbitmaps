#!/usr/bin/env node
'use strict';

// Leak-scan what actually SHIPS: the packed npm tarballs, not the source tree.
//
// `scripts/leak-scan.cjs` in its default mode enumerates **tracked** files, and its `--history` mode enumerates
// git blobs. Neither can see `dist/` — it is gitignored — yet `dist/` is the overwhelming majority of the
// published bytes, and tsup preserves JSDoc while the sourcemaps carry `sourcesContent`, i.e. every comment
// from `src` verbatim. So the one artifact a consumer actually downloads is the one artifact the existing
// modes structurally cannot inspect. The scan-the-tarball recipe was written down in leak-scan.cjs's header
// from the start; this file is that recipe, executable and wired into the release gate, because a recipe a
// human has to remember to run is not a gate.
//
// Why it must run BEFORE `pnpm publish`: an npm tarball is immutable outside the 72-hour unpublish window.
// There is no "fix it in the next patch" for a string that has already shipped — the old version stays
// downloadable. This is the last point at which a leak is still cheap.
//
// Needles. The employer-name class of needle lives in a gitignored `.leak-needles` (committing it would BE the
// leak) or in `LEAK_SCAN_EXTRA`. Neither exists on a CI runner unless a repo secret supplies it, and
// `--snapshot` deliberately REFUSES to certify without them. So the strictness is chosen from what is actually
// available: with needles → `--snapshot`, where the migration class is fatal too; without → the default mode,
// where the HARD class (credentials, private keys, real email addresses, absolute local paths) still fails the
// build. That is a real gate either way, and it degrades to "less strict", never to "silently off" — the
// chosen mode is printed on every run.
//
// The obvious worry, answered: the HARD class includes absolute local paths (`/Users/…`, `/home/…`), and a CI
// runner builds under a `/home/<user>/work/…` path — so would this step go permanently red on CI? (Written with
// a placeholder rather than the real runner path on purpose: the first draft of this comment spelled it out and
// tripped the scanner's own rule, which is a fair demonstration that the rule works.) No. tsup writes
// sourcemap `sources` RELATIVE to the outfile and sets no `sourceRoot`, so no build-root path reaches the
// tarball. Verified rather than assumed: the same scan is clean locally, where the build root is an absolute
// `/Users/…` path that this very regex would have caught. If it ever does fire, the finding is real.

const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep'); // leave the unpacked trees behind for eyeballing

/** Run a command, letting its output through, and throw with a useful message if it fails. */
function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * Every publishable package manifest. A `private: true` package is skipped by `pnpm publish` and so ships
 * nothing — scanning it would be scanning bytes no consumer can obtain.
 */
function publishablePackages() {
  const dir = join(ROOT, 'packages');
  if (!existsSync(dir)) throw new Error(`no packages/ directory at ${dir}`);
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(dir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private === true) continue;
    found.push({ name: pkg.name, dir: join(dir, entry.name) });
  }
  // A glob that matches nothing is the failure mode this guard exists for: an empty list would make every
  // downstream loop a no-op and the whole gate would report success having scanned zero bytes.
  if (found.length === 0)
    throw new Error('found no publishable package under packages/ — refusing to pass');
  return found;
}

const needles =
  (process.env.LEAK_SCAN_EXTRA ?? '').trim() !== '' || existsSync(join(ROOT, '.leak-needles'));
const strict = needles ? ['--snapshot'] : [];

const work = mkdtempSync(join(tmpdir(), 'cbm-tarball-scan-'));
let failures = 0;
try {
  const pkgs = publishablePackages();
  console.log(
    `leak-scan-tarballs: ${pkgs.length} package(s) · ${
      needles
        ? 'SNAPSHOT mode (needles configured, migration findings fatal)'
        : 'default mode (no needles — HARD findings only)'
    }`,
  );

  for (const pkg of pkgs) {
    const dest = join(work, pkg.name.replace(/[^a-z0-9]+/gi, '-'));
    // `pnpm pack` runs the package's own `prepack` (a build), so the tarball is the real, built artifact and
    // not whatever happened to be sitting in dist/.
    run('pnpm', ['pack', '--pack-destination', dest], pkg.dir);
    const tarballs = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly 1 tarball for ${pkg.name}, got ${tarballs.length}`);
    }
    run('tar', ['-xzf', join(dest, tarballs[0]), '-C', dest], ROOT);
    // npm tarballs always root everything under `package/`.
    const tree = join(dest, 'package');
    if (!existsSync(tree)) throw new Error(`unpacked ${tarballs[0]} has no package/ directory`);

    console.log(`\n── ${pkg.name} (${tarballs[0]}) ──`);
    try {
      run('node', [join(ROOT, 'scripts', 'leak-scan.cjs'), ...strict, '--dir', tree], ROOT);
    } catch {
      // leak-scan already printed the findings (redacted where the needle class requires it). Keep going so a
      // single run reports every package, rather than making the maintainer fix-and-rerun once per package.
      failures++;
    }
  }
} finally {
  if (KEEP) console.log(`\nleak-scan-tarballs: unpacked trees left at ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nleak-scan-tarballs: FAILED — ${failures} package tarball(s) have findings`);
  process.exit(1);
}
console.log('\nleak-scan-tarballs: all package tarballs clean');
