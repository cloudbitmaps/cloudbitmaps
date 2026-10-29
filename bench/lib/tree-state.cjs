/*
 * Whether the tree a bench measured was the commit's own code, and what made it not.
 *
 * A pass records `tree`: `clean` when nothing but the bench's own results file differs from the commit, `dirty` when
 * anything else does (a tracked edit, a staged change, a deleted or renamed file, an untracked file), `unknown` when git
 * could not say. The results file is the bench's own output: a pass that was just written is not an edit of the code it
 * measured, so the next pass taken before that file is committed is still clean. Everything else counts, the sources
 * under `packages/`, every other file under `bench/` and the lockfile included, because the measured code must be the
 * commit's code.
 *
 * A dirty pass also records `dirtyPaths` (every path that differs, the results file included, sorted, at most `PATH_CAP`)
 * and `dirtyTotal` (how many there were), so a reader can tell a stray file from a change to the code. A pass taken before the field
 * existed has neither and stays valid.
 */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PATH_CAP = 20;

/** The paths in `git status --porcelain -z` output (a rename or copy lists both its paths). */
function pathsOfPorcelain(out) {
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      i++;
      if (parts[i]) paths.push(parts[i]);
    }
  }
  return paths;
}

/** The repo-relative path of `file` with forward slashes, or `undefined` when it is outside `root`. */
function relativeRecord(root, file) {
  if (file === undefined) return undefined;
  const rel = path.relative(root, path.resolve(root, file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/**
 * `{ tree }` for the checkout at `root`, with `dirtyPaths` and `dirtyTotal` when it is dirty. `record` is the bench's
 * own results file (absolute, or relative to `root`); changes to it alone leave the tree clean.
 */
function treeState({ root, record }) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1 << 28,
      },
    );
  } catch {
    return { tree: 'unknown' };
  }
  const own = relativeRecord(root, record);
  const changed = [...new Set(pathsOfPorcelain(out))].sort();
  if (changed.every((p) => p === own)) return { tree: 'clean' };
  return { tree: 'dirty', dirtyPaths: changed.slice(0, PATH_CAP), dirtyTotal: changed.length };
}

/** What is wrong with the tree fields of a pass's `environment`, as messages (empty for every earlier pass too). */
function treeProblems(label, environment) {
  const e = environment ?? {};
  const has = e.dirtyPaths !== undefined || e.dirtyTotal !== undefined;
  if (e.tree !== 'dirty') {
    return has ? [`${label}: a ${e.tree} tree records dirty paths`] : [];
  }
  if (!has) return [];
  const paths = e.dirtyPaths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
    return [`${label}: a dirty pass names no paths`];
  }
  const sorted = [...paths].sort();
  if (paths.some((p, i) => p !== sorted[i]) || new Set(paths).size !== paths.length) {
    return [`${label}: the dirty paths are not sorted and distinct`];
  }
  if (!Number.isInteger(e.dirtyTotal) || e.dirtyTotal < paths.length) {
    return [`${label}: the dirty total is not a count of at least the paths named`];
  }
  if (paths.length > PATH_CAP || (paths.length < PATH_CAP && e.dirtyTotal !== paths.length)) {
    return [`${label}: the dirty paths are not capped at ${PATH_CAP} with their total`];
  }
  return [];
}

module.exports = { PATH_CAP, pathsOfPorcelain, treeState, treeProblems };
