'use strict';
/*
 * Which `.d.ts` files of a built package a consumer can reach, and which are strays.
 *
 * tsc emits one declaration per source file while esbuild bundles the JavaScript, so a package's `dist/` holds a
 * declaration for every internal module. Only the ones an `exports` entry names, or that a reachable declaration
 * imports, can be loaded by a consumer; the rest are dead weight in the tarball. The build prunes them with
 * `pruneUnreachable`; `scripts/smoke.cjs` then checks the result with the TypeScript compiler itself, which
 * does not share this walk's blind spots.
 *
 * Reachability starts from every `types` target of the `exports` map (conditions may nest) plus a top-level
 * `types` field, and follows each relative specifier of `import`/`export … from '…'`, `import x = require('…')`,
 * `declare module '…'` and `import('…')` type queries. A `.js` specifier names the sibling `.d.ts`; a directory
 * specifier its `index.d.ts`. Bare specifiers (other packages, SDKs) are not followed. Comments are skipped, so
 * a doc-comment example is not an edge.
 *
 * Because it DELETES files, the walk fails closed: it throws, and so fails the build, on anything it cannot
 * classify instead of guessing which files are dead. Known limits, each one a throw:
 *   - a missing `package.json`, no `types` root at all, or a `types` root whose file does not exist;
 *   - a relative specifier that resolves to no `.d.ts`;
 *   - `/// <reference path=…>` and `/// <reference types=…>` directives (`lib` is not a file edge and is fine);
 *   - a relative specifier ending `.mjs`, `.cjs`, `.mts` or `.cts`, and any `.d.mts`/`.d.cts` output;
 *   - an `exports` target that is an array, a plain string, has no `types` condition, whose `types` is not a
 *     string, uses a `types@<range>` condition, or whose subpath key holds a `*` wildcard;
 *   - a manifest `imports` field, and any `#…` specifier;
 *   - any `.d.ts.map` under `dist/` (a pruned declaration would orphan its map).
 * `typesVersions` is not read: it must point at files `exports` also names, which the smoke check verifies.
 * `pkgDir` may be relative; it is resolved to an absolute path first.
 */
const fs = require('node:fs');
const path = require('node:path');
const { scanSpecifiers, blankComments } = require('../dts-specifiers.cjs');

/** `exports` keys are subpaths (start with `.`) or conditions; the two never mix in one object. */
const isSubpathMap = (exportsField) =>
  exportsField !== null &&
  typeof exportsField === 'object' &&
  !Array.isArray(exportsField) &&
  Object.keys(exportsField).some((k) => k.startsWith('.'));

/** The `types` strings of one exports target, however deeply conditions nest; throws on shapes it cannot read. */
function typesTargets(target, where = 'exports', out = []) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`${where}: target must be an object of conditions with a "types" condition`);
  }
  for (const [key, value] of Object.entries(target)) {
    if (key.startsWith('types@'))
      throw new Error(`${where}: versioned condition "${key}" is not supported`);
    if (key === 'types') {
      if (typeof value !== 'string') throw new Error(`${where}: "types" must be a string`);
      out.push(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      typesTargets(value, `${where}.${key}`, out);
    } else if (Array.isArray(value)) {
      throw new Error(`${where}.${key}: an array target is not supported`);
    }
  }
  return out;
}

/** Every `types` root a manifest declares; throws when an `exports` entry has none or the shape is unreadable. */
function typesRoots(manifest) {
  if (manifest.imports !== undefined) throw new Error('package.json "imports" is not supported');
  const roots = [];
  const field = manifest.exports;
  if (field !== undefined && field !== null) {
    const entries = isSubpathMap(field) ? Object.entries(field) : [['.', field]];
    for (const [subpath, target] of entries) {
      if (subpath.includes('*'))
        throw new Error(`exports "${subpath}": wildcard subpaths are not supported`);
      if (target === null) continue; // a blocked subpath names no file
      const found = typesTargets(target, `exports "${subpath}"`);
      if (found.length === 0) throw new Error(`exports "${subpath}": no "types" condition`);
      roots.push(...found);
    }
  }
  if (typeof manifest.types === 'string') roots.push(manifest.types);
  if (roots.length === 0) throw new Error('package.json names no `types` root');
  return roots;
}

/** The declaration file a relative specifier of `from` names, or throws when none exists. */
function resolveSpecifier(from, specifier) {
  if (/\.[cm][jt]s$/.test(specifier)) {
    throw new Error(
      `${from}: specifier '${specifier}' names a .mjs/.cjs/.mts/.cts module, not supported`,
    );
  }
  const abs = path.resolve(path.dirname(from), specifier);
  const candidates = [
    abs.replace(/\.[cm]?js$/, '.d.ts'),
    `${abs}.d.ts`,
    path.join(abs, 'index.d.ts'),
  ];
  const found = candidates.find((c) => c.endsWith('.d.ts') && fs.existsSync(c));
  if (found === undefined)
    throw new Error(`${from}: relative specifier '${specifier}' resolves to no .d.ts`);
  return found;
}

/** Throws on a reference directive or a `#…` import specifier; `lib` references name no file of ours. */
function assertNoReferences(file, source) {
  if (
    /(?:\bfrom|\bimport|\brequire|\bdeclare\s+module)\s*\(?\s*(['"])#/.test(blankComments(source))
  ) {
    throw new Error(`${file}: a '#…' import specifier is not supported`);
  }
  if (/^\s*\/\/\/\s*<reference\s+(?:path|types)\s*=/m.test(source)) {
    throw new Error(`${file}: a /// <reference path|types> directive is not supported`);
  }
}

/** The `.d.ts` files under `dir`, as absolute paths; throws on outputs the walk does not model. */
function declarationsUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationsUnder(p));
    else if (/\.d\.[cm]ts$/.test(p)) throw new Error(`${p}: .d.mts/.d.cts output is not supported`);
    else if (p.endsWith('.d.ts.map')) throw new Error(`${p}: declaration maps are not supported`);
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The absolute paths of the declarations reachable from a manifest's `types` roots. */
function reachableFrom(pkgDir, manifest) {
  const seen = new Set();
  const queue = typesRoots(manifest).map((r) => {
    const root = path.resolve(pkgDir, r);
    if (/\.d\.[cm]ts$/.test(root))
      throw new Error(`${root}: a .d.mts/.d.cts root is not supported`);
    if (!fs.existsSync(root)) throw new Error(`${root}: the types root does not exist`);
    return root;
  });
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    assertNoReferences(file, source);
    for (const { specifier } of scanSpecifiers(source))
      queue.push(resolveSpecifier(file, specifier));
  }
  return seen;
}

/** The unreachable declarations of the package at `pkgDir`, as paths relative to it, sorted. */
function unreachableDeclarations(pkgDirArg) {
  const pkgDir = path.resolve(pkgDirArg);
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
function pruneUnreachable(pkgDirArg) {
  const pkgDir = path.resolve(pkgDirArg);
  const stray = unreachableDeclarations(pkgDir);
  for (const rel of stray) fs.rmSync(path.join(pkgDir, rel));
  const dist = path.join(pkgDir, 'dist');
  if (fs.existsSync(dist)) removeEmptyDirs(dist);
  return stray.length;
}

module.exports = { typesTargets, reachableFrom, unreachableDeclarations, pruneUnreachable };
