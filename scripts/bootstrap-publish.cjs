'use strict';
/*
 * ONE-TIME bootstrap publish (see RELEASING.md "First publish (bootstrap)").
 *
 * A Trusted Publisher is a per-package npm setting and cannot be bound to a package that does not exist, so the
 * very first version of each package has to be published by hand with interactive 2FA. Every release after that
 * goes through the tokenless, provenance-signed pipeline in .github/workflows/release.yml — this script is a
 * bootstrap, not a release tool, and it refuses to act once the names exist.
 *
 * It exists because the hand-typed form of that step has several ways to go quietly wrong, and the step is
 * irreversible: npm allows unpublish only within 72 hours, and a name+version is burned forever either way.
 * So: every precondition is checked BEFORE anything is sent, and a real publish needs an explicit --confirm.
 * Without it this is a dry run that verifies the whole path and publishes nothing.
 *
 * The trap that motivated the --tag handling: `npm publish` defaults --tag to `latest` unconditionally and is
 * NOT semver-aware (`npm config get tag` -> latest). "Prereleases aren't installed by default" is a property of
 * range resolution and only holds while `latest` points elsewhere. On a FIRST publish there is nothing else for
 * it to point at, so an untagged 0.1.0-rc.0 becomes `latest` and plain `npm i` serves the throwaway. This
 * script derives the dist-tag from the prerelease identifier (0.1.0-rc.0 -> `rc`) and verifies afterwards that
 * `latest` was not created.
 *
 * Usage (via the pnpm entry, like every other script here — `pnpm audit`, `pnpm leak-scan`):
 *   pnpm release:bootstrap             # dry run — checks everything, publishes nothing
 *   pnpm release:bootstrap --confirm   # the irreversible one
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const KNOWN = new Set(['--confirm', '--allow-release']);
const unknown = argv.filter((a) => !KNOWN.has(a));
if (unknown.length > 0) {
  console.error(`bootstrap-publish: unknown argument(s): ${unknown.join(', ')}`);
  console.error('usage: pnpm release:bootstrap [--confirm] [--allow-release]');
  process.exit(2);
}
const CONFIRM = argv.includes('--confirm');
// Escape hatch for the "publish the real 0.1.0 by hand" variant of the bootstrap, which RELEASING.md
// documents but does not recommend: it trades the provenance attestation on the launch artifact for one
// fewer version on the registry.
const ALLOW_RELEASE = argv.includes('--allow-release');

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

/** Run a command whose non-zero exit is a legitimate answer (a 404 probe, a dirty tree). */
function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (err) {
    return { ok: false, out: String((err && (err.stdout || err.message)) || '').trim() };
  }
}

// ---------------------------------------------------------------- discover the publishable packages

const PKG_DIR = join(ROOT, 'packages');
const packages = readdirSync(PKG_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(PKG_DIR, e.name, 'package.json')))
  .map((e) => {
    const rel = `packages/${e.name}/package.json`;
    return { dir: e.name, rel, json: JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) };
  });

if (packages.length === 0) {
  console.error('bootstrap-publish: found no packages under packages/ — wrong directory?');
  process.exit(2);
}

console.log(`bootstrap-publish: ${CONFIRM ? 'LIVE' : 'DRY RUN'} · ${packages.length} package(s)\n`);

// ---------------------------------------------------------------- preconditions

// 1. Clean tree. A publish packs the working tree, so uncommitted edits would ship unrecorded.
const dirty = tryRun('git', ['status', '--porcelain']);
if (!dirty.ok) fail('not a git repository (or git failed)');
else if (dirty.out !== '') fail(`working tree is dirty — commit or stash first:\n${dirty.out}`);

// 2. One version across the family. The packages release in lockstep and release.yml enforces the same
//    invariant against the tag; breaking it here would produce a mismatched pair on the registry.
const versions = [...new Set(packages.map((p) => p.json.version))];
if (versions.length !== 1) {
  fail(
    `packages disagree on version: ${packages.map((p) => `${p.json.name}@${p.json.version}`).join(', ')}`,
  );
}
const version = versions[0];

// 3. Prerelease, unless explicitly overridden — see ALLOW_RELEASE above.
const prereleaseId = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.\d+)?$/.exec(version || '')?.[1];
if (!prereleaseId && !ALLOW_RELEASE) {
  fail(
    `version ${version} is not a prerelease. The bootstrap is meant to publish a throwaway (e.g. 0.1.0-rc.0) ` +
      `so the real release keeps its provenance attestation. Pass --allow-release to publish this version by ` +
      `hand anyway, accepting an unattested launch artifact.`,
  );
}
// Derived, never hardcoded: 0.1.0-rc.0 -> `rc`, 0.1.0-beta.2 -> `beta`.
const distTag = prereleaseId || 'latest';

// 4. `private: true` is the accidental-publish guard. pnpm SKIPS a private package silently (exit 0), so
//    without this check a dry run would look perfect and a live run would publish nothing.
for (const p of packages) {
  if (p.json.private === true) {
    fail(`${p.rel} still has "private": true — pnpm would skip it and report success`);
  }
  if (!p.json.publishConfig || p.json.publishConfig.access !== 'public') {
    fail(
      `${p.rel} is missing publishConfig.access = "public" (a scoped package defaults to restricted)`,
    );
  }
}

// 5. Logged in. Checked before the build so a missing login costs seconds, not a full build.
const who = tryRun('npm', ['whoami']);
if (!who.ok) fail('not logged in to npm — run `npm login` (interactive 2FA) first');
else notes.push(`npm user: ${who.out}`);

// 6. The names must NOT exist. If they do, the bootstrap already happened and the correct path is the
//    pipeline — republishing by hand would skip the gate and produce an unattested artifact.
for (const p of packages) {
  const probe = tryRun('npm', ['view', p.json.name, 'versions', '--json']);
  if (probe.ok) {
    fail(
      `${p.json.name} already exists on the registry. The bootstrap is one-time — ship further versions ` +
        `through the release workflow (tag vX.Y.Z), not this script.`,
    );
  }
}

// 7. Provenance attests to a public source repo, and the package links must resolve. A private repo does not
//    block THIS publish (it carries no attestation anyway) but it does mean the sequence is out of order.
const repoProbe = tryRun('gh', ['repo', 'view', '--json', 'visibility,nameWithOwner']);
if (repoProbe.ok) {
  try {
    const repo = JSON.parse(repoProbe.out);
    if (repo.visibility !== 'PUBLIC') {
      fail(
        `${repo.nameWithOwner} is ${repo.visibility} — RELEASING.md step 1 is "repo public first", so the ` +
          `package links resolve and the real release can be attested.`,
      );
    } else notes.push(`repo: ${repo.nameWithOwner} (public)`);
  } catch {
    notes.push('could not parse `gh repo view` output — repo visibility unverified');
  }
} else {
  notes.push('gh CLI unavailable — repo visibility unverified, check it by hand');
}

// ---------------------------------------------------------------- report

if (notes.length > 0) for (const n of notes) console.log(`  · ${n}`);
if (problems.length > 0) {
  console.error(`\nbootstrap-publish: ${problems.length} problem(s) — nothing was published:\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`\n  version:  ${version}`);
console.log(
  `  dist-tag: ${distTag}${distTag === 'latest' ? '  (this WILL become the default install)' : '  (latest stays unset until the real release)'}`,
);
for (const p of packages) console.log(`  publish:  ${p.json.name}`);

if (!CONFIRM) {
  console.log(
    '\nbootstrap-publish: dry run — every precondition passed and nothing was sent.\n' +
      'Re-run with `pnpm release:bootstrap --confirm` to publish. This is irreversible: npm allows unpublish only within 72 hours,\n' +
      'and the name+version is burned either way.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- the irreversible part

console.log('\nbootstrap-publish: building…');
run('pnpm', ['install', '--frozen-lockfile'], { stdio: ['ignore', 'inherit', 'inherit'] });
run('pnpm', ['build'], { stdio: ['ignore', 'inherit', 'inherit'] });

console.log(`bootstrap-publish: publishing under --tag ${distTag} (expect a 2FA prompt)…`);
// `--no-git-checks`: the tree state is already verified above, and pnpm's own check rejects a detached HEAD
// that is otherwise fine here. Interactive stdio so the 2FA prompt actually reaches the terminal.
run(
  'pnpm',
  [
    '-r',
    '--filter',
    './packages/**',
    'publish',
    '--access',
    'public',
    '--tag',
    distTag,
    '--no-git-checks',
  ],
  { stdio: ['inherit', 'inherit', 'inherit'] },
);

// ---------------------------------------------------------------- verify what actually landed

console.log('\nbootstrap-publish: verifying the registry…');
let bad = 0;
for (const p of packages) {
  const probe = tryRun('npm', ['view', p.json.name, 'dist-tags', '--json']);
  if (!probe.ok) {
    console.error(`  ✗ ${p.json.name}: not found after publish`);
    bad++;
    continue;
  }
  const tags = JSON.parse(probe.out);
  const under = tags[distTag];
  if (under !== version) {
    console.error(`  ✗ ${p.json.name}: ${distTag} is ${under ?? '(unset)'}, expected ${version}`);
    bad++;
  } else if (distTag !== 'latest' && tags.latest) {
    // The exact trap this script exists to catch: a `latest` on a throwaway means plain `npm i` serves it.
    console.error(
      `  ✗ ${p.json.name}: latest = ${tags.latest} — a prerelease must not hold latest. ` +
        `Fix with: npm dist-tag rm ${p.json.name} latest`,
    );
    bad++;
  } else {
    console.log(`  ✓ ${p.json.name}: ${distTag}=${version}, latest unset`);
  }
}

if (bad > 0) process.exit(1);
console.log(
  '\nbootstrap-publish: done. Next (RELEASING.md steps 4-6): bind a Trusted Publisher to each package,\n' +
    'set publishing access to "require 2FA and disallow tokens", create the GitHub `release` environment,\n' +
    'then ship the real release by tag. This script must never be run again.',
);
