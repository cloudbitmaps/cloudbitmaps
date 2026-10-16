'use strict';
/*
 * Which `.d.ts` files of a built package a consumer can reach, and which are strays.
 *
 * tsc emits one declaration per source file while esbuild bundles the JavaScript, so a package's `dist/` holds a
 * declaration for every internal module. Only the ones an `exports` entry names, or that a reachable declaration
 * imports, can be loaded by a consumer; the rest are dead weight in the tarball. The build prunes them with
 * `pruneUnreachable`, and `scripts/smoke.cjs` fails on any that remain.
 *
 * Reachability starts from every `types` target of the `exports` map (conditions may nest) plus a top-level
 * `types` field, and follows each relative specifier of `import`/`export … from '…'` and `import('…')` type
 * queries. A `.js` specifier names the sibling `.d.ts`; a directory specifier its `index.d.ts`. Bare specifiers
 * (other packages, SDKs) are not followed. Comments are skipped, so a doc-comment example is not an edge.
 */
const fs = require('node:fs');
const path = require('node:path');
const { scanSpecifiers } = require('../dts-specifiers.cjs');

/** Every `types` string in an `exports` target, however deeply conditions nest it. */
function typesTargets(target, out = []) {
  if (!target || typeof target !== 'object') return out;
  for (const [key, value] of Object.entries(target)) {
    if (key === 'types' && typeof value === 'string') out.push(value);
    else typesTargets(value, out);
  }
  return out;
}

/** The declaration file a relative specifier of `from` names, or `null` when none exists. */
function resolveSpecifier(from, specifier) {
  const abs = path.resolve(path.dirname(from), specifier);
  const candidates = [
    abs.replace(/\.[cm]?js$/, '.d.ts'),
    `${abs}.d.ts`,
    path.join(abs, 'index.d.ts'),
  ];
  return candidates.find((c) => c.endsWith('.d.ts') && fs.existsSync(c)) ?? null;
}

/** The `.d.ts` files under `dir`, as absolute paths. */
function declarationsUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationsUnder(p));
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The absolute paths of the declarations reachable from a manifest's `types` targets. */
function reachableFrom(pkgDir, manifest) {
  const roots = [...typesTargets(manifest.exports)];
  if (typeof manifest.types === 'string') roots.push(manifest.types);
  const seen = new Set();
  const queue = roots.map((r) => path.resolve(pkgDir, r));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const { specifier } of scanSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const next = resolveSpecifier(file, specifier);
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

/** The unreachable declarations of the package at `pkgDir`, as paths relative to `pkgDir`, sorted. */
function unreachableDeclarations(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const dist = path.join(pkgDir, 'dist');
  if (!fs.existsSync(dist)) return [];
  const reached = reachableFrom(pkgDir, manifest);
  return declarationsUnder(dist)
    .filter((f) => !reached.has(f))
    .map((f) => path.relative(pkgDir, f).split(path.sep).join('/'))
    .sort();
}

/** Remove empty directories under `dir`, deepest first; `dir` itself stays. */
function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(dir, entry.name);
    removeEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
}

/** Delete the package's unreachable declarations and any directory that leaves empty; returns the count. */
function pruneUnreachable(pkgDir) {
  const stray = unreachableDeclarations(pkgDir);
  for (const rel of stray) fs.rmSync(path.join(pkgDir, rel));
  const dist = path.join(pkgDir, 'dist');
  if (fs.existsSync(dist)) removeEmptyDirs(dist);
  return stray.length;
}

module.exports = { typesTargets, reachableFrom, unreachableDeclarations, pruneUnreachable };
