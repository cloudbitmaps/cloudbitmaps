#!/usr/bin/env node
/*
 * Fails when an unpacked package could bring native code to a deployment. Used by the Lambda smoke and the layer
 * build on the packed tarballs, where nothing is installed, so a dependency on a native package would not show up as
 * a file: this reads the manifest as well as the tree.
 *
 * A package is refused when its manifest names a native-code package (`roaring`, or a build helper an addon needs) in
 * any field a consumer's install follows (not `devDependencies`), declares `gypfile`, or runs an install-time script, and when its tree holds a `.node` file or a
 * `binding.gyp`.
 *
 * Usage: `node scripts/check-no-native-package.cjs <unpacked-package-dir>...` (exit 1 on a finding).
 */
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const NATIVE_PACKAGES = new Set([
  'roaring',
  'roaring-node',
  'node-gyp',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'node-gyp-build',
  'node-addon-api',
  'prebuild-install',
  'prebuildify',
  'bindings',
  'nan',
  'cmake-js',
]);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** What in a parsed `package.json` brings native code, as a list of readable findings (empty when nothing does). */
function nativeFindings(manifest) {
  const found = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    const names = Array.isArray(value) ? value : Object.keys(value ?? {});
    for (const name of names) {
      if (NATIVE_PACKAGES.has(name)) found.push(`${field} names ${name}`);
    }
  }
  if (manifest.gypfile === true) found.push('gypfile is set');
  for (const script of INSTALL_SCRIPTS) {
    if (manifest.scripts && typeof manifest.scripts[script] === 'string') {
      found.push(`the ${script} script runs at install`);
    }
  }
  return found;
}

/** Files in a tree that are, or build, an addon. */
function nativeFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...nativeFiles(path));
    else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') found.push(path);
  }
  return found;
}

/** Every finding for one unpacked package directory. */
function check(dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return [`${dir}: no package.json`];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return [
    ...nativeFindings(manifest).map((f) => `${manifest.name ?? dir}: ${f}`),
    ...nativeFiles(dir).map((f) => `${manifest.name ?? dir}: holds ${f}`),
  ];
}

module.exports = { nativeFindings, nativeFiles, check };

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: check-no-native-package.cjs <unpacked-package-dir>...');
    process.exit(2);
  }
  const findings = dirs.flatMap(check);
  if (findings.length > 0) {
    console.error(`native code in a packed package:\n  ${findings.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-no-native-package: ${dirs.length} packages carry no native code`);
}
