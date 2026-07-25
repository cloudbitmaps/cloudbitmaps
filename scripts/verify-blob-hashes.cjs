#!/usr/bin/env node
'use strict';

// Content-verify a repo migration before retiring the original — the Stage-7 gate in
// docs/internal/11-RELEASE.md.
//
// Going public splits one private repo into a public snapshot plus a docs-only internal repo, renaming and
// restructuring on the way. Path matching therefore lies: a file that moved from `src/core/x.ts` to
// `packages/core/src/core/x.ts` is *not* missing. So this compares **git blob hashes**, which are computed
// from content alone — same bytes, same hash, whatever the path.
//
// Every blob in the source (cold-backup) repo must be either present in one of the destination repos, or an
// intentionally-edited counterpart you can name. The report separates the two so the leftovers are a short,
// reviewable list rather than a wall.
//
// Usage
//   node scripts/verify-blob-hashes.cjs <source-repo> <dest-repo> [<dest-repo> …]
//   node scripts/verify-blob-hashes.cjs . ../cloudbitmaps-public ../cloudbitmaps-internal
//
// Options
//   --ref <rev>   the commit to read in every repo (default: HEAD)
//   --strict      exit non-zero when anything is unmatched (default: report and exit 0, since some
//                 unmatched files are legitimately expected — a curated CHANGELOG, retargeted links)

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { basename, resolve } = require('node:path');

const USAGE =
  'usage: verify-blob-hashes.cjs <source-repo> <dest-repo> [<dest-repo> …] [--ref <rev>|--ref=<rev>] [--strict]';

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
// Accept both `--ref <rev>` and `--ref=<rev>`. The `=` form used to be dropped as an unrecognised flag while
// REF silently stayed at HEAD — the gate then scanned the wrong ref and printed a line that read as correct.
const refAt = argv.indexOf('--ref');
const refEq = argv.find((a) => a.startsWith('--ref='));
const REF =
  refEq !== undefined ? refEq.slice('--ref='.length) : refAt >= 0 ? argv[refAt + 1] : 'HEAD';
if (REF === undefined || REF === '') {
  console.error('verify-blob-hashes: --ref needs a value');
  console.error(USAGE);
  process.exit(2);
}
// A typo in `--strict` must not silently turn the gate back into a report.
const KNOWN = new Set(['--strict', '--ref']);
const badFlags = argv.filter((a) => a.startsWith('-') && !KNOWN.has(a) && !a.startsWith('--ref='));
if (badFlags.length > 0) {
  console.error(`verify-blob-hashes: unknown flag(s): ${badFlags.join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}
// Positional args are the repos: drop the flags, and drop `--ref`'s value (only when the spaced form was
// actually given — otherwise `refAt + 1` is 0 and would silently swallow the source repo).
const repos = argv.filter((a, i) => !a.startsWith('-') && !(refAt >= 0 && i === refAt + 1));

if (repos.length < 2) {
  console.error(USAGE);
  process.exit(2);
}

/** `Map<blobHash, string[] paths>` for one repo at REF. */
function blobs(repoPath) {
  const dir = resolve(repoPath);
  if (!existsSync(dir)) {
    console.error(`verify-blob-hashes: no such directory: ${dir}`);
    process.exit(2);
  }
  let out;
  try {
    // `-z` (NUL-separated, unquoted paths): without it git QUOTES any path with a non-ASCII or control
    // character, so the field arrives as `"docs/internal/caf\303\251.md"` — leading quote and all — and the
    // `docs/internal/` prefix test below silently fails, filing a missing private doc under the quiet bucket.
    out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', REF], {
      cwd: dir,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch {
    console.error(
      `verify-blob-hashes: '${dir}' is not a git repo, or '${REF}' does not resolve there`,
    );
    process.exit(2);
  }
  const map = new Map();
  for (const record of out.split('\0')) {
    if (record === '') continue;
    // `<mode> <type> <hash>\t<path>`
    const [meta, path] = record.split('\t');
    const parts = (meta ?? '').split(/\s+/);
    if (parts[1] !== 'blob') continue; // skip submodule gitlinks
    const hash = parts[2];
    if (hash === undefined || path === undefined) continue;
    map.set(hash, [...(map.get(hash) ?? []), path]);
  }
  return map;
}

/**
 * The hash of a zero-length blob. Every empty file in every repo shares it, so "this hash exists in the
 * destination" proves nothing for one: a deleted empty file matches an unrelated `.gitkeep` and is reported
 * as surviving. Empty files are matched by PATH instead.
 */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const [sourceRepo, ...destRepos] = repos;
const source = blobs(sourceRepo);
const dests = destRepos.map((r) => ({ name: basename(resolve(r)), blobs: blobs(r) }));

console.log(`verify-blob-hashes: ref ${REF}`);
console.log(`  source ${resolve(sourceRepo)} — ${source.size} unique blob(s)`);
for (const d of dests) console.log(`  dest   ${d.name} — ${d.blobs.size} unique blob(s)`);

/** Every path in every destination, so an empty-file match can be checked by path. */
const destPaths = new Set(dests.flatMap((d) => [...d.blobs.values()].flat()));

/** Paths whose exact content survives somewhere, vs. paths with no byte-identical counterpart. */
const matched = [];
const unmatched = [];
for (const [hash, paths] of source) {
  for (const path of paths) {
    if (hash === EMPTY_BLOB) {
      // Content proves nothing for an empty file — require the path itself to exist somewhere downstream.
      if (destPaths.has(path)) matched.push({ path, where: 'same path (empty file)', at: [path] });
      else unmatched.push(path);
      continue;
    }
    const found = dests.find((d) => d.blobs.has(hash));
    if (found) matched.push({ path, where: found.name, at: found.blobs.get(hash) ?? [] });
    else unmatched.push(path);
  }
}

/**
 * Hash matching answers "did this CONTENT survive", not "did THIS FILE survive". Duplicated content makes the
 * difference material: this repo ships `LICENSE` and `NOTICE` three times (root + both packages) and
 * `PRIVACY.md` twice, so dropping the per-package copies during curation — a legally material slip, since each
 * published package needs its own — would match the root copy and report clean. Flag any source path whose
 * match landed only at a *different* path so the operator sees it rather than a bare count.
 */
const relocated = matched.filter((m) => !m.at.includes(m.path));

// `docs/internal/` is expected to live on in exactly one destination; call that out separately so a missing
// internal doc can't hide among the deliberately-edited public files.
const unmatchedInternal = unmatched.filter((p) => p.startsWith('docs/internal/')).sort();
const unmatchedPublic = unmatched.filter((p) => !p.startsWith('docs/internal/')).sort();

console.log(`\nbyte-identical elsewhere: ${matched.length} file(s)`);

if (relocated.length > 0) {
  console.log(
    `\nmatched only at a DIFFERENT path — ${relocated.length} (a rename, or duplicated content masking a loss):`,
  );
  for (const m of relocated.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`  ${m.path}  →  ${m.at.join(', ')}  [${m.where}]`);
  }
  console.log(
    '  Expected for the package split. But if a line reads like a file that should still exist under its own\n' +
      '  name (a per-package LICENSE/NOTICE, say), the match is another copy of the same bytes — not survival.',
  );
}

if (unmatchedInternal.length > 0) {
  console.log(
    `\n⚠ private docs with NO byte-identical copy in any destination — ${unmatchedInternal.length}:`,
  );
  for (const p of unmatchedInternal) console.log(`  ${p}`);
  console.log(
    '  These should have arrived unchanged via the mirror-push. Investigate before archiving.',
  );
}

if (unmatchedPublic.length > 0) {
  console.log(`\nunmatched (expect edits here — name each one) — ${unmatchedPublic.length}:`);
  for (const p of unmatchedPublic) console.log(`  ${p}`);
  console.log(
    '\n  Legitimate reasons a file is unmatched: the curated CHANGELOG rewrite, retargeted doc links,\n' +
      '  rewritten old-owner URLs, removed `private: true`, and files deliberately dropped from the public\n' +
      '  snapshot. If you cannot name the reason for a line above, do NOT archive the source repo yet.',
  );
}

if (unmatched.length === 0) console.log('\nverify-blob-hashes: every source blob survives — clean');

const failed = STRICT && unmatched.length > 0;
if (failed)
  console.error(`\nverify-blob-hashes: FAILED (--strict) — ${unmatched.length} unmatched file(s)`);
process.exit(failed ? 1 : 0);
