'use strict';
/*
 * Package smoke test — the built library must import cleanly under BOTH module systems, on real Node,
 * through the paths a consumer actually resolves.
 *
 * Guards the `roaring` CJS→ESM interop: `roaring` is a CommonJS native addon, and a *named* ESM import of
 * it crashes Node's ESM loader (its static lexer can't see the CJS exports). We load the package **by name**
 * — so the package.json `exports` map and its `import`/`require` conditions are exercised too, not just the
 * dist files — via dynamic `import()` (ESM) and `require()` (CJS) for every subpath, then run the
 * roaring-backed load/read path. The roaring interop is exercised specifically by the main `.` entry (only it
 * pulls in the SafeBitmap); the `/s3` + `/dynamodb` entries additionally guard the exports map and their
 * AWS-SDK interop. The bin is a separate tsup build with its own bundled `roaring` import, so it's loaded
 * too. Any regression fails the build. Run via `pnpm smoke` (builds first) or `node scripts/smoke.cjs`.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Self-reference by name → resolves through the package `exports` map. This is the FLAVOR package (what
// users install); its driver subpaths re-export `@cloudbitmaps/core/<driver>`, so the smoke exercises the real
// two-package graph end to end, not just one bundle.
const PKG = '@cloudbitmaps/roaring';
const SUBPATHS = ['', '/s3', '/dynamodb', '/gcs', '/azure'];

// The loaded store's whole write path in one call: `bulkLoadCrbmGeneration` encodes the ids into one immutable
// `.crbm` generation and publishes it forward-only, and only then can a read see them. So this is also the
// narrowest round-trip that actually exercises the native codec through the built bundle — the ids span two
// 16-bit chunks, so chunk routing and the roaring encode/decode both run rather than a single-container no-op.
async function exerciseCore(label, m) {
  for (const name of [
    'CloudRoaring',
    'estimateCost',
    'MemoryColdDriver',
    'MemoryRegistryDriver',
    'MemoryColdChunkSource',
    'bulkLoadCrbmGeneration',
  ]) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  const cold = new m.MemoryColdDriver();
  const registry = new m.MemoryRegistryDriver({ now: () => 0 });
  await m.bulkLoadCrbmGeneration(cold, { segment: 'smoke', generation: 0 }, [42, 70_000], {
    registry,
  });
  const seg = new m.CloudRoaring({ cold, registry }).segment('smoke');
  const ok = (await seg.has(42)) && (await seg.has(70_000)) && (await seg.count()) === 2;
  if (!ok) throw new Error(`${label}: load/read round-trip returned a wrong result`);
}

/*
 * Cross-bundle error identity. A driver subpath (`/dynamodb`, `/s3`) is a SEPARATE bundle with
 * its OWN copy of the core error classes, so `instanceof` against the core entry's class fails in CJS — which
 * silently defeated transient-retry and publish-race handling. The brand-based predicates must still
 * classify a driver-bundle error. This asserts exactly that against the BUILT bundles (where the bug lived and
 * where the whole test suite — one source graph — could not see it). Trigger: the DynamoDb registry driver
 * validates its `keyPrefix` synchronously in the constructor and throws a ValidationError from its own bundle.
 */
function exerciseCrossBundleErrors(label, coreMod, dynamoMod) {
  let caught;
  try {
    new dynamoMod.DynamoDbRegistryDriver({ client: {}, tableName: 't', keyPrefix: 'a|b' });
  } catch (e) {
    caught = e;
  }
  if (caught === undefined)
    throw new Error(`${label}: expected a ValidationError from the /dynamodb bundle`);
  if (!coreMod.isValidationError(caught) || !coreMod.isCloudRoaringError(caught)) {
    throw new Error(
      `${label}: core predicates failed to classify a driver-bundle error — cross-bundle brand broken`,
    );
  }
  console.log(`  cross-bundle error predicates OK: ${label}`);
}

/*
 * Hard invariant 7, checked against the BUILT files — because that is the only place it is true or false.
 *
 * The eslint rule that enforces "the main entry stays SDK-free" reads STATIC imports. It cannot see
 * `await import('@cloudbitmaps/core/s3')` (proven: eslint exits 0 on exactly that), and nothing else in the
 * gate reads `dist/` at all. That gap is not hypothetical: a `connect(url)` feature that resolved a driver
 * from a runtime string put `require("@aws-sdk/client-s3")` into `dist/index.cjs` — the entry every consumer
 * loads — and shipped ~88 KB of driver code to people who never touch S3, while three documents went on
 * saying the entry was SDK-free. A full green local gate and 13 CI jobs passed over it. Measured against
 * esbuild and webpack, a consumer without the SDKs installed could no longer build at all, including one who
 * never called the feature: a bundler resolves specifiers before it tree-shakes.
 *
 * WHAT IS CHECKED. The CJS entry, the ESM entry, the chunks the ESM entry imports statically, and the
 * published `.d.ts` tree outside the driver subpaths — a type-only `import('@aws-sdk/client-s3')` in
 * `index.d.ts` is invisible to eslint (it is a `TSImportType`) and is a hard `Cannot find module` for any
 * consumer building with `skipLibCheck: false` who did not install the optional peer.
 *
 * WHAT IS NOT. The driver subpath bundles (`dist/s3/…`) are where an SDK belongs and are never read.
 * A lazily-imported chunk is not walked either — though note the CJS bundle has no code splitting, so it
 * inlines a lazy import anyway and catches it there; the ESM walk is insurance for the day CJS goes away,
 * which is why it asserts it actually found chunks rather than silently walking none.
 */
const { findSdkSpecifiers } = require('./sdk-specifiers.cjs');

/** Driver homes, relative to a package's `dist/` — the one place an SDK specifier is correct. */
const DRIVER_DIRS = ['s3', 'dynamodb', 'gcs', 'azure'];

function isDriverPath(rel) {
  const parts = rel.split(path.sep);
  return (
    DRIVER_DIRS.includes(parts[0]) || (parts[0] === 'drivers' && DRIVER_DIRS.includes(parts[1]))
  );
}

/** Every `.d.ts` under `dist/` that is not a driver's. */
function declarationFiles(dist) {
  const { readdirSync } = require('node:fs');
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.name.endsWith('.d.ts') && !isDriverPath(childRel)) out.push(childRel);
    }
  };
  walk(dist, '');
  return out;
}

function assertEntrySdkFree(pkgDir) {
  const { readFileSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');

  const esm = read('index.js');
  const staticChunks = [...esm.matchAll(/from\s*["'](\.\/chunk-[^"']+)["']/g)].map((m) =>
    m[1].replace('./', ''),
  );
  // `chunkNames: 'chunk-[hash]'` in scripts/build.mjs is an undocumented contract with the literal above.
  // Rename it there and this walk would quietly cover nothing, so make that loud instead.
  if (staticChunks.length === 0) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: dist/index.js imports no ./chunk-* file, so the chunk walk covers nothing. ` +
        `Either the build stopped splitting, or \`chunkNames\` in scripts/build.mjs no longer emits ` +
        `\`chunk-\` — update the pattern here to match.`,
    );
  }

  for (const file of ['index.cjs', 'index.js', ...staticChunks, ...declarationFiles(dist)]) {
    const hits = findSdkSpecifiers(read(file));
    if (hits.length > 0) {
      throw new Error(
        `@cloudbitmaps/${pkgDir}: dist/${file} names a cloud SDK (${hits.join(', ')}).\n` +
          `  The main entry must stay SDK-free so \`npm i\` pulls only the backends a consumer actually uses.\n` +
          `  A driver is reached ONLY through its own subpath entry (@cloudbitmaps/${pkgDir}/<cloud>), and the\n` +
          `  main entry must not name the SDK at all — not statically, not via \`import()\`, not in a type.\n` +
          `  If a main-entry module needs driver behaviour, put the behaviour behind a port in core/ports and\n` +
          `  let the caller inject a driver they imported themselves.`,
      );
    }
  }
  console.log(
    `  main entry SDK-free: @cloudbitmaps/${pkgDir} ` +
      `(cjs, esm, ${staticChunks.length} static chunk(s), ${declarationFiles(dist).length} .d.ts)`,
  );
}

async function main() {
  for (const sub of SUBPATHS) {
    await import(PKG + sub); // ESM `import` condition — the path that used to crash under Node ESM
    require(PKG + sub); // CJS `require` condition
    console.log(`  import + require OK: ${PKG}${sub || ''}`);
  }
  // The bin is built by scripts/build.mjs into dist/bin (its own bundle) and isn't in `exports`,
  // so load it by path. Safe: its run-guard only invokes main() when executed as the CLI, not on import.
  for (const bin of ['export-segments']) {
    await import(
      pathToFileURL(path.join(__dirname, '..', 'packages', 'roaring', 'dist', 'bin', `${bin}.js`))
        .href
    );
    console.log(`  esm import OK: bin/${bin}.js`);
  }

  await exerciseCore('esm', await import(PKG));
  await exerciseCore('cjs', require(PKG));

  exerciseCrossBundleErrors('esm', await import(PKG), await import(PKG + '/dynamodb'));
  exerciseCrossBundleErrors('cjs', require(PKG), require(PKG + '/dynamodb'));
  for (const pkgDir of require('node:fs')
    .readdirSync(path.join(__dirname, '..', 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)) {
    assertEntrySdkFree(pkgDir);
  }

  console.log(
    'smoke: ESM + CJS import (via exports map) + roaring round-trip + cross-bundle errors + SDK-free entries OK',
  );
}

main().catch((e) => {
  console.error('smoke FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
