'use strict';
/*
 * Bootstrap publish: CREATE PACKAGE NAMES THAT DO NOT EXIST YET (see RELEASING.md "Bootstrapping a name").
 *
 * A Trusted Publisher is a per-package npm setting and cannot be bound to a package that does not exist, so the
 * very first version of each name has to be published by hand with interactive 2FA. Every release after that
 * goes through the tokenless, provenance-signed pipeline in .github/workflows/release.yml — this script is a
 * bootstrap, not a release tool, and it publishes ONLY the names the registry does not already have.
 *
 * It ran once for the whole family at launch, and it runs again whenever a package is ADDED to the family:
 * the storage split introduced @cloudbitmaps/s3, /gcs and /azure-blob into a workspace whose other two
 * packages were already published, and tagging that release without bootstrapping them first would have
 * published core, then failed on the first name with no Trusted Publisher — leaving the registry holding one
 * package of a five-package lockstep release, immutable. The earlier version of this script modelled only
 * "first publish of everything" and refused outright once ANY name existed, which made it useless for
 * exactly the case that needs it most.
 *
 * It exists because the hand-typed form of that step has several ways to go quietly wrong, and the step is
 * irreversible: npm allows unpublish only within 72 hours, and a name+version is burned forever either way.
 * So: every precondition is checked BEFORE anything is sent, and a real publish needs an explicit --confirm.
 * Without it this is a dry run that verifies the whole path and publishes nothing.
 *
 * The trap that motivated the --tag handling: `npm publish` defaults --tag to `latest` unconditionally and is
 * NOT semver-aware (`npm config get tag` -> latest). "Prereleases aren't installed by default" is a property of
 * range resolution and only holds while `latest` points elsewhere. On a FIRST publish there is nothing else for
 * it to point at, so an untagged 0.1.0-rc.0 becomes `latest` and plain `npm i` serves the throwaway. The
 * dist-tag is therefore derived from the prerelease identifier (0.1.0-rc.0 -> `rc`) rather than left to default.
 *
 * That is necessary but NOT sufficient, which was established against a real registry rather than assumed: a
 * registry may point `latest` at a package's first version anyway, and `npm dist-tag rm … latest` is refused.
 * So the post-publish check REPORTS which happened instead of failing — the publish already succeeded and is
 * irreversible, and the condition resolves itself when the real release claims `latest`.
 *
 * Usage (via the pnpm entry, like every other script here — `pnpm audit`, `pnpm leak-scan`):
 *   pnpm release:bootstrap             # dry run — checks everything, publishes nothing
 *   pnpm release:bootstrap --confirm   # the irreversible one
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
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

// Returns captured stdout, or '' when there is none to capture. `execFileSync` returns NULL — not a string —
// whenever stdout is inherited rather than piped, which is exactly what the build and publish steps do so the
// 2FA prompt and pnpm's progress reach the terminal. Calling .trim() on that result unconditionally throws
// `Cannot read properties of null`, and only on the live path, where the preconditions have already passed.
function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return typeof out === 'string' ? out.trim() : '';
}

/**
 * Run a command whose non-zero exit is a legitimate answer (a 404 probe, a dirty tree).
 *
 * Captures STDERR as well as stdout, which the first version discarded. That mattered: `npm view` exits
 * non-zero for a missing package AND for a 5xx, a rate limit, an ETIMEDOUT, a proxy failure and a bad
 * `.npmrc` — and only stderr says which. Without it the caller had to treat every failure alike.
 */
function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (err) {
    const stdout = String((err && err.stdout) || '');
    const stderr = String((err && err.stderr) || '');
    return {
      ok: false,
      out: (stdout || String((err && err.message) || '')).trim(),
      err: `${stdout}\n${stderr}\n${String((err && err.message) || '')}`,
    };
  }
}

/**
 * Did `npm view <name>` fail because the name genuinely is not on the registry?
 *
 * ONLY a 404 means "free". Everything else — a 500, a 429, ETIMEDOUT, ENOTFOUND, an auth or proxy failure —
 * means "unknown", and unknown must never be treated as free: this script's whole job is to hand-publish
 * the names it believes are missing, so a registry blip would otherwise make it publish an unattested
 * prerelease over packages that are already live, irreversibly. Fail loudly instead of guessing.
 */
function isRegistry404(probe) {
  return /\bE?404\b|not found|is not in (?:this|the) registry/i.test(probe.err ?? probe.out ?? '');
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

// 3. What gets published is a THROWAWAY PRERELEASE, never the version in the manifests.
//
//    A hand publish carries no provenance attestation — provenance attests to a workflow identity and a
//    laptop has none. Burning the family's real version here would therefore make the new packages the only
//    unattested tarballs in the release, and it would be worse than that: `pnpm publish` SILENTLY SKIPS a
//    version already on the registry (exit 0), so the pipeline would then skip those three names on the real
//    tag and report success having published nothing for them.
//
//    So the name is created at `<version>-rc.0` under the `rc` dist-tag, and the real version still ships
//    through the gated, attested pipeline. When the manifests already carry a prerelease (the launch case),
//    it is used as-is.
const prereleaseId = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.\d+)?$/.exec(version || '')?.[1];
const BOOTSTRAP_ID = 'rc';
// The version actually sent. Either the manifests' own prerelease, or one derived from a release version.
const publishVersion = prereleaseId ? version : `${version}-${BOOTSTRAP_ID}.0`;
const distTag = prereleaseId || BOOTSTRAP_ID;
if (!prereleaseId && ALLOW_RELEASE) {
  notes.push(
    `--allow-release: publishing ${version} itself rather than ${version}-${BOOTSTRAP_ID}.0 — these tarballs ` +
      `will carry NO provenance attestation, and the pipeline will skip these names on the real tag`,
  );
}
const effectiveVersion = !prereleaseId && ALLOW_RELEASE ? version : publishVersion;
const effectiveTag = !prereleaseId && ALLOW_RELEASE ? 'latest' : distTag;

// 4. `private: true` on a package manifest would make pnpm SKIP it silently (exit 0), so without this check
//    a dry run would look perfect and a live run would publish nothing. No package carries it today — only
//    the private ROOT manifest does, which is never published — so this is a guard against it being added,
//    not a launch gate that still has to be cleared.
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

// 6. Split the family by what the registry already has. A name that exists is SKIPPED, not a failure —
//    that is the whole point of being able to add a package to a published family. A name that exists must
//    never be republished by hand, because that would bypass the gate and drop the attestation.
const missing = [];
for (const p of packages) {
  const probe = tryRun('npm', ['view', p.json.name, 'versions', '--json']);
  if (probe.ok) {
    notes.push(`${p.json.name} already on the registry — skipping (ship it by tag)`);
  } else if (isRegistry404(probe)) {
    missing.push(p);
  } else {
    // NOT "free". See isRegistry404: guessing here publishes over a live package.
    fail(
      `could not determine whether ${p.json.name} exists — \`npm view\` failed with something other than a ` +
        `404, so this is a registry or network problem, not a missing name. Refusing to guess, because the ` +
        `guess would hand-publish an unattested version over a package that may already be live. ` +
        `Retry when the registry is reachable.\n      ${(probe.err ?? '').trim().split('\n').filter(Boolean).slice(0, 3).join('\n      ')}`,
    );
  }
}
if (missing.length === 0) {
  fail(
    `every package already exists on the registry — there is nothing to bootstrap. Ship this version ` +
      `through the release workflow (tag vX.Y.Z), not this script.`,
  );
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

console.log(`\n  family version: ${version}`);
console.log(`  publishing as:  ${effectiveVersion}`);
console.log(
  `  dist-tag:       ${effectiveTag}${effectiveTag === 'latest' ? '  (this WILL become the default install)' : '  (a registry may still point latest here on a first publish — reported after)'}`,
);
for (const p of missing) console.log(`  create:   ${p.json.name}`);

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

console.log(`bootstrap-publish: publishing under --tag ${effectiveTag} (expect a 2FA prompt)…`);
// `--no-git-checks`: the tree state is already verified above, and pnpm's own check rejects a detached HEAD
// that is otherwise fine here. Interactive stdio so the 2FA prompt actually reaches the terminal.
//
// No `--no-provenance` here, deliberately: pnpm does not forward that flag to npm, so it reads as a fix while
// doing nothing. Provenance is opt-IN at the call site instead — the release workflow passes `--provenance`
// explicitly — because `publishConfig.provenance: true` in the manifests made every manual publish impossible:
// npm honoured it, looked for a CI provider to mint the attestation from, found none on a laptop, and aborted
// with `EUSAGE: Automatic provenance generation not supported for provider: null`. Neither the CLI flag nor
// `NPM_CONFIG_PROVENANCE=false` could override the manifest. A bootstrap publish is unattested by design (see
// RELEASING.md), and that is now expressible rather than blocked.
//
// This stays `pnpm publish` rather than a per-package `npm publish`: every other package depends on core via
// `workspace:^`, and pnpm is what rewrites that to a real version range on the way out. npm would publish the
// protocol string verbatim and ship four packages nobody can install. `pnpm -r` also walks the workspace in
// topological order, so core goes up before the four that name it.
//
// Only the MISSING names are published, each named explicitly rather than by the `./packages/**` glob, so a
// name that already exists cannot be republished by hand even if the precondition above were wrong.
//
// The version is rewritten in place first, because neither npm nor pnpm can publish a version other than the
// one in the manifest, and the whole point is to create the name WITHOUT burning the family's real version.
// `restoreManifests` runs in a `finally`, so an interrupted run leaves the tree as it found it; the paths
// touched are printed either way, since a crash between write and restore would otherwise leave a version
// bump nobody made.
const touched = missing.map((p) => ({
  rel: p.rel,
  before: readFileSync(join(ROOT, p.rel), 'utf8'),
}));
let restored = false;
function restoreManifests() {
  if (restored) return; // the finally already ran; do not clobber a later edit
  restored = true;
  // Each write is guarded separately: an EACCES on the first file must not skip the other two, and must not
  // replace whatever exception the caller was already unwinding with.
  for (const t of touched) {
    try {
      writeFileSync(join(ROOT, t.rel), t.before);
    } catch (e) {
      console.error(
        `bootstrap-publish: COULD NOT RESTORE ${t.rel} — put it back by hand: ${e.message}`,
      );
    }
  }
}
// DELIBERATELY NO SIGINT/SIGTERM HANDLERS. An earlier version of this file registered them, reasoning that
// `process.on('exit')` does not run when node is killed by a signal. Measured, that "fix" was strictly worse
// than nothing on all three counts:
//
//   1. It never ran. This script is synchronous, so while `execFileSync` holds the thread libuv never polls
//      the signal self-pipe and the queued callback is simply dropped.
//   2. Registering a listener REPLACES node's default die-on-signal. So a `kill -TERM` mid-publish was
//      swallowed: the publish ran to completion and the process exited 0. On a step whose whole point is
//      that it cannot be undone, that turns "stop now" into "ignored" — an operator who realises mid-run
//      that they are publishing the wrong thing could no longer stop it. Verified: 143 without the
//      handlers, 0 with them.
//   3. Had it ever fired, `process.kill(process.pid, sig)` re-enters the still-registered listener and
//      spins at 100% CPU.
//
// What actually restores the manifests is the `catch`/`finally` below, and it covers the case that matters:
// a real terminal Ctrl-C is SIGINT to the whole process GROUP, so `pnpm` dies, `execFileSync` throws, and
// the catch runs synchronously. Verified end to end with a process-group interrupt.
process.on('exit', restoreManifests);
try {
  if (effectiveVersion !== version) {
    for (const t of touched) {
      const after = t.before.replace(`"version": "${version}"`, `"version": "${effectiveVersion}"`);
      // An unchecked `String.replace` is a SILENT NO-OP when the manifest is formatted differently — no
      // space after the colon, say. That hands pnpm the family's REAL version: published by hand and so
      // unattested, and then skipped by the pipeline on the real tag because the registry already has it.
      // Assert the rewrite landed before anything is sent.
      if (after === t.before) {
        restoreManifests();
        console.error(
          `bootstrap-publish: could not rewrite the version in ${t.rel} — expected the literal ` +
            `"version": "${version}" and did not find it. Nothing was published.`,
        );
        process.exit(1);
      }
      writeFileSync(join(ROOT, t.rel), after);
    }
    console.log(`  (manifests temporarily set to ${effectiveVersion}; restored when this exits)`);
  }
  run(
    'pnpm',
    [
      ...missing.flatMap((p) => ['--filter', p.json.name]),
      'publish',
      '--access',
      'public',
      '--tag',
      effectiveTag,
      '--no-git-checks',
    ],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );
} catch (e) {
  // `pnpm publish` stops at the FIRST failure, so some names may already be live and irreversible. A raw
  // stack would bury that, and the Trusted-Publisher guidance below would never print — at the one moment
  // it matters most.
  restoreManifests();
  console.error(
    `\nbootstrap-publish: the publish FAILED PART-WAY. ${missing.length} name(s) were attempted:\n` +
      missing.map((p) => `  · ${p.json.name}`).join('\n') +
      `\n\nSome may already be on the registry and CANNOT be unpublished outside 72 hours. Check each with\n` +
      `\`npm access get status <name>\` before re-running — this script skips the ones that landed.\n` +
      `For every name that DID land, still bind its Trusted Publisher before tagging.\n\n${e.message}`,
  );
  process.exit(1);
} finally {
  restoreManifests();
}

// ---------------------------------------------------------------- verify what actually landed

console.log('\nbootstrap-publish: verifying the registry…');

// npm ACKs a publish on the write path, but `npm view` reads a replica that lags — measured at ~7 minutes for
// a brand-new package, with the write already returned `PUT 200`. Probing once and calling it a failure told
// the operator the publish had failed when both packages were live and correct, which is the worst possible
// wrong answer directly after an irreversible step. `--prefer-online` defeats npm's own cache (which has just
// cached the pre-publish 404 from the precondition probe); the wait defeats the replica.
const PROPAGATION_TRIES = 20;
// Overridable so the regression test can exercise the retry without a 15s wall-clock cost per attempt. Not a
// knob anyone running a release should touch.
const PROPAGATION_GAP_MS = Number(process.env.CR_BOOTSTRAP_PROPAGATION_GAP_MS ?? 15_000);

function viewDistTags(name) {
  for (let attempt = 1; attempt <= PROPAGATION_TRIES; attempt++) {
    const probe = tryRun('npm', ['view', name, 'dist-tags', '--json', '--prefer-online']);
    if (probe.ok) return probe;
    if (attempt === PROPAGATION_TRIES) return probe;
    if (attempt === 1) {
      console.log(`    … ${name} not on the read path yet — waiting for propagation`);
    }
    // Synchronous sleep: this is a single-shot CLI with nothing else to do, and blocking keeps the output
    // ordered with the publish above it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROPAGATION_GAP_MS);
  }
  return { ok: false, out: '' };
}

let bad = 0;
let latestOnPrerelease = false;
for (const p of missing) {
  const probe = viewDistTags(p.json.name);
  if (!probe.ok) {
    console.error(
      `  ✗ ${p.json.name}: still not on the read path after ` +
        `${Math.round((PROPAGATION_TRIES * PROPAGATION_GAP_MS) / 60000)} min. If the publish log shows ` +
        `\`PUT 200\`, it succeeded and this is replica lag — confirm with \`npm access get status ${p.json.name}\`, ` +
        `which reads the authoritative API, before assuming anything failed.`,
    );
    bad++;
    continue;
  }
  const tags = JSON.parse(probe.out);
  const under = tags[effectiveTag];
  if (under !== effectiveVersion) {
    // A hard failure: the tag we asked for is the one the operator was told to expect.
    console.error(
      `  ✗ ${p.json.name}: ${effectiveTag} is ${under ?? '(unset)'}, expected ${effectiveVersion}`,
    );
    bad++;
    continue;
  }
  console.log(`  ✓ ${p.json.name}: ${effectiveTag}=${effectiveVersion}`);
  if (effectiveTag !== 'latest' && tags.latest) {
    // Reported, NOT failed. Whether a registry also points `latest` at a first publish is up to the registry
    // — verdaccio does it unconditionally — and `--tag` does not override that. Failing here would report a
    // successful, irreversible publish as an error, and the obvious repair does not exist: npm's registry
    // refuses to remove the `latest` tag, and verdaccio silently re-adds it. Shipping the real release is the
    // fix, because that moves `latest` forward.
    console.log(`    ! latest = ${tags.latest}`);
    latestOnPrerelease = true;
  }
}

if (bad > 0) process.exit(1);
if (latestOnPrerelease) {
  console.log(
    `\nbootstrap-publish: NOTE — the registry also pointed \`latest\` at ${effectiveVersion}, so a plain\n` +
      "`npm i` currently resolves the prerelease. This is the registry's own behaviour for a package's first\n" +
      'version and `--tag` does not prevent it; `npm dist-tag rm … latest` is rejected, so there is nothing to\n' +
      'undo. It corrects itself the moment the real release publishes and claims `latest` — so treat the\n' +
      'remaining steps as time-sensitive rather than optional.',
  );
}
// The rc tarballs are NAME PLACEHOLDERS, not installable packages, and saying so here is cheaper than
// letting someone discover it by trying. Only the missing manifests are rewritten to the rc version, so
// `packages/core/package.json` keeps the real one and pnpm resolves each `workspace:^` against THAT — the rc
// tarballs therefore declare `@cloudbitmaps/core@^<real version>`, which the registry does not have yet.
// That is correct for the job they do (exist, so a Trusted Publisher can bind) and broken for any other use.
console.log(
  '\nbootstrap-publish: NOTE — these rc tarballs are not installable. They depend on the real version of\n' +
    '@cloudbitmaps/core, which is not on the registry until the tagged release. They exist only so a name\n' +
    'exists for a Trusted Publisher to bind to. Do not point anyone at them.',
);
console.log(
  `\nbootstrap-publish: done — ${missing.length} name(s) created. Next, for EACH of them: bind a Trusted\n` +
    'Publisher on npmjs.com (GitHub Actions · this repo · release.yml · environment `release`) and set\n' +
    'publishing access to "require 2FA and disallow tokens". Until a name has a Trusted Publisher the\n' +
    'tokenless pipeline cannot publish it, and a tag would fail PART-WAY through the family. Then ship the\n' +
    'real version by tag. Do not run this script again for these names.',
);
