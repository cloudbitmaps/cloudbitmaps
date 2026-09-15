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
 * The main entry stays SDK-free — asserted against the BUILT files, because that is the only place the claim
 * is true or false. The eslint rule that enforces it reads STATIC imports of a cloud driver; it cannot see
 * `await import('@cloudbitmaps/core/s3')`, and nothing else in the gate looks at `dist/` at all. That gap had
 * already cost something: `connect`'s dynamic imports inlined the S3 and DynamoDB drivers into
 * `dist/index.cjs` (which has no code splitting, so a lazy import lands in the bundle rather than a chunk),
 * putting `require("@aws-sdk/client-s3")` in the entry every consumer loads and shipping ~88 KB of driver code
 * to people who never touch S3 — while three documents went on saying the entry was SDK-free.
 *
 * Checks the CJS entry, the ESM entry, and every chunk the ESM entry imports STATICALLY. A chunk reached only
 * by a lazy import is exactly what is supposed to happen and is not walked.
 */
const SDK_SPECIFIER =
  /(?:require\(|from\s*|import\()\s*["'](@aws-sdk\/[^"']*|@google-cloud\/[^"']*|@azure\/[^"']*|aws-sdk)["']/g;

function assertEntrySdkFree(pkgDir) {
  const { readFileSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');

  const esm = read('index.js');
  // Only STATIC chunk imports: `import ... from "./chunk-X.js"` at the top level of the entry.
  const staticChunks = [...esm.matchAll(/from\s*["'](\.\/chunk-[^"']+)["']/g)].map((m) =>
    m[1].replace('./', ''),
  );

  for (const file of ['index.cjs', 'index.js', ...staticChunks]) {
    const hits = [...read(file).matchAll(SDK_SPECIFIER)].map((m) => m[1]);
    if (hits.length > 0) {
      throw new Error(
        `@cloudbitmaps/${pkgDir}: dist/${file} reaches a cloud SDK (${[...new Set(hits)].join(', ')}). ` +
          `The main entry must stay SDK-free — a driver is reached through its own subpath entry, so ` +
          `\`npm i\` pulls only the backends actually used. If a main-entry module needs a driver, it imports ` +
          `it dynamically AND that specifier belongs in \`external\` in scripts/build.mjs.`,
      );
    }
  }
  console.log(
    `  main entry SDK-free: @cloudbitmaps/${pkgDir} (cjs, esm, ${staticChunks.length} static chunk(s))`,
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

  assertEntrySdkFree('core');
  assertEntrySdkFree('roaring');

  // `connect` through the BUILT CJS bundle: its driver imports are external now, so this is the one place
  // that proves the specifier still resolves from a consumer's `require` rather than only from source.
  const { connect } = require(PKG);
  const connected = await connect('s3://smoke-bucket/pfx?region=us-east-1');
  if (connected == null) throw new Error('smoke: connect("s3://…") returned nothing');
  console.log('  connect() resolves a driver subpath from the built CJS bundle');

  console.log(
    'smoke: ESM + CJS import (via exports map) + roaring round-trip + cross-bundle errors + SDK-free entries OK',
  );
}

main().catch((e) => {
  console.error('smoke FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
