'use strict';
/*
 * Rewrite the `VERSION` constant to match the package manifests.
 *
 * `changeset version` bumps every `package.json` in the family and knows nothing about the source, but
 * `VERSION` is part of the public surface — it ships as a literal in the published `.d.ts`, so it cannot be
 * derived at runtime from a manifest the package does not read. That leaves one string to move by hand on
 * every release, which is exactly the shape of thing that gets forgotten.
 *
 * `tests/index.test.ts` already fails when it drifts, for every package, with the list read off the
 * filesystem. This script makes that gate cheap to satisfy rather than a manual edit; the gate stays the
 * thing that proves it happened.
 *
 * Usage:
 *   node scripts/sync-version.cjs
 *
 * There is deliberately no `--check` mode: `tests/index.test.ts` already asserts VERSION against every
 * manifest, so a second checker would be a duplicate gate with no caller.
 */
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SOURCE = join(ROOT, 'packages/roaring/src/index.ts');
/** `export const VERSION = '0.10.0';` — quote style is whatever prettier settled on, so accept either. */
const VERSION_RE = /(export const VERSION = )(['"])([^'"]+)\2/;
/** Below this, the package list is not a family and something upstream is wrong. */
const MIN_PACKAGES = 5;

/**
 * The one version the whole family is at.
 *
 * Throws rather than picking, in both failure cases. The family ships in lockstep, so disagreeing manifests
 * mean something went wrong before this ran, and writing a guess into the public surface would bury it. An
 * empty or short list is the other half: a comparison over nothing passes, which is the vacuous-green shape
 * this repo keeps being bitten by.
 */
function resolveVersion(manifests) {
  if (manifests.length < MIN_PACKAGES) {
    throw new Error(
      `expected at least ${MIN_PACKAGES} packages under packages/, found ${manifests.length}`,
    );
  }
  const distinct = [...new Set(manifests.map((m) => m.version))];
  if (distinct.length !== 1) {
    const detail = manifests.map((m) => `${m.name}@${m.version}`).join(', ');
    throw new Error(`the manifests disagree — ${detail}. Refusing to guess which is right.`);
  }
  return distinct[0];
}

/**
 * The source with `VERSION` set to `want`.
 *
 * Throws when the constant is not there — renamed, moved, or reformatted past the pattern. Returning the
 * source unchanged would be worse than failing: the release would ship a stale VERSION with a green run
 * behind it.
 */
function rewrite(source, want) {
  if (!VERSION_RE.test(source)) {
    throw new Error("no `export const VERSION = '…'` found. Refusing to continue.");
  }
  return source.replace(VERSION_RE, `$1$2${want}$2`);
}

/** Every package's declared version, read off the filesystem so a sixth package is covered on day one. */
function readManifests(packagesDir) {
  return readdirSync(packagesDir)
    .filter((d) => existsSync(join(packagesDir, d, 'package.json')))
    .map((name) => ({
      name,
      version: JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8')).version,
    }));
}

function main() {
  const want = resolveVersion(readManifests(join(ROOT, 'packages')));
  const source = readFileSync(SOURCE, 'utf8');
  const next = rewrite(source, want);
  if (next === source) {
    console.log(`sync-version: VERSION already ${want}`);
    return;
  }
  writeFileSync(SOURCE, next);
  console.log(`sync-version: VERSION → ${want}`);
}

module.exports = { resolveVersion, rewrite, readManifests, VERSION_RE, MIN_PACKAGES };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`sync-version: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
