'use strict';

// What every published `@cloudbitmaps/*` manifest must say about the family and about itself.
//
// The six packages release at one version and a package reaches into core's internal entry, so a published
// package must name the other packages at exactly its own version. A range (`^0.23.0`) would let a later core
// patch resolve under an older roaring, and the two would then disagree about an entry nothing promises to keep
// stable. And every package exports its own `package.json`, so a tool can find a package's root or version with
// `require.resolve('@cloudbitmaps/<pkg>/package.json')`; without the export that throws
// `ERR_PACKAGE_PATH_NOT_EXPORTED`.
//
// One function, two callers: smoke runs it on the source manifests (where an exact pin is written
// `workspace:*`, which pnpm publishes as the exact version), and the tarball scan runs it on each packed
// `package.json` (where only an exact version is acceptable).

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The problems with one manifest, as sentences. `familyNames` is every published package name in the family.
 * `source` lets `workspace:*` pass, because that is how a source manifest spells the exact pin.
 */
function manifestProblems(manifest, familyNames, { source = false } = {}) {
  const problems = [];
  const family = new Set(familyNames);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!family.has(dep)) continue;
      const ok = EXACT_VERSION.test(range) || (source && range === 'workspace:*');
      if (!ok) {
        problems.push(
          `${manifest.name}: ${field}.${dep} is "${range}"; the family ships as one set, so it must be an exact version` +
            (source ? ' (`workspace:*`)' : ''),
        );
      }
    }
  }
  if (manifest.exports?.['./package.json'] !== './package.json') {
    problems.push(`${manifest.name}: exports has no "./package.json": "./package.json" entry`);
  }
  return problems;
}

module.exports = { manifestProblems };
