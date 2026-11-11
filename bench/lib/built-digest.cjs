/*
 * Which build a bench measured.
 *
 * `bitmap-api.cjs` imports the built `@cloudbitmaps/roaring`, which imports the built `@cloudbitmaps/core`. `dist/` is
 * ignored by git, so the commit a pass records (`head`) and a clean tree say nothing about those files: a run by hand
 * over a stale build records a `head` the measured code did not come from. A pass therefore records `built`, one SHA-256
 * for each built package the bench imports, taken from the files on disk when the pass starts:
 *
 *   built: { "packages/core/dist": "<64 hex>", "packages/roaring/dist": "<64 hex>" }
 *
 * A digest covers every `.js`, `.mjs` and `.cjs` file under the folder (declarations and source maps are not code that
 * runs), as the sorted lines `<path relative to the folder> <SHA-256 of the file>`, so it changes when a file's bytes
 * change, when a file is added or removed, and when one is renamed. It says which build a pass measured; it does not say
 * the build came from `head`. Comparing it with a fresh build of `head` is a separate check.
 *
 * A pass numbered `LAST_PASS_WITHOUT_BUILT` or below was committed before the field existed and stays valid as it is;
 * every later pass must record it, in the shape above.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** The built folders `bitmap-api.cjs` runs, relative to the repository root. */
const BUILT_DIRS = ['packages/core/dist', 'packages/roaring/dist'];

/** The last pass of `bitmap-api-results.json` that was committed without the field. */
const LAST_PASS_WITHOUT_BUILT = 6;

const CODE = /\.(?:js|mjs|cjs)$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Every code file under `dir`, as paths relative to it with forward slashes, sorted. */
function codeFiles(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), rel);
      else if (entry.isFile() && CODE.test(entry.name)) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** The digest of one built folder; throws when the folder is missing or holds no code (run `pnpm build` first). */
function digestOf(dir) {
  let files;
  try {
    files = codeFiles(dir);
  } catch {
    throw new Error(`${dir}: no built folder to digest: run pnpm build first`);
  }
  if (files.length === 0) throw new Error(`${dir}: no built code to digest: run pnpm build first`);
  const hash = createHash('sha256');
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    hash.update(`${rel} ${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return hash.digest('hex');
}

/** `{ <folder>: <digest> }` for each built folder under `root`. */
function builtDigest(root, dirs = BUILT_DIRS) {
  const out = {};
  for (const dir of dirs) out[dir] = digestOf(path.join(root, dir));
  return out;
}

/**
 * What is wrong with the `built` field of a pass's `environment`, as messages. `number` is the pass's number in the
 * record: a pass at or below `LAST_PASS_WITHOUT_BUILT` predates the field and is not asked for it (one that has it is
 * read like any other); a pass with another or no number is a new one.
 */
function builtProblems(label, environment, number, dirs = BUILT_DIRS) {
  const e = environment ?? {};
  const old = Number.isInteger(number) && number <= LAST_PASS_WITHOUT_BUILT;
  if (e.built === undefined) {
    return old ? [] : [`${label}: the pass does not record the digest of the build it measured`];
  }
  const built = e.built;
  if (built === null || typeof built !== 'object' || Array.isArray(built)) {
    return [`${label}: the build digest is not an object`];
  }
  const names = Object.keys(built).sort();
  if (names.join('\n') !== [...dirs].sort().join('\n')) {
    return [
      `${label}: the build digest names ${JSON.stringify(names)}, not ${JSON.stringify(dirs)}`,
    ];
  }
  return dirs
    .filter((d) => !HEX64.test(built[d]))
    .map((d) => `${label}: the build digest of ${d} is not a SHA-256`);
}

module.exports = { BUILT_DIRS, LAST_PASS_WITHOUT_BUILT, builtDigest, builtProblems, digestOf };
