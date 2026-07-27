'use strict';
/*
 * Package smoke test — the built library must import cleanly under BOTH module systems, on real Node,
 * through the paths a consumer actually resolves.
 *
 * Guards the `roaring` CJS→ESM interop: `roaring` is a CommonJS native addon, and a *named* ESM import of
 * it crashes Node's ESM loader (its static lexer can't see the CJS exports). We load the package **by name**
 * — so the package.json `exports` map and its `import`/`require` conditions are exercised too, not just the
 * dist files — via dynamic `import()` (ESM) and `require()` (CJS) for every subpath, then run the
 * roaring-backed add/has path. The roaring interop is exercised specifically by the main `.` entry (only it
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
const SUBPATHS = [
  '',
  '/s3',
  '/dynamodb',
  '/gcs',
  '/azure',
  '/postgres',
  '/redis',
  '/mongodb',
  '/cassandra',
  '/mysql',
];

async function exerciseCore(label, m) {
  for (const name of [
    'CloudRoaring',
    'estimateCost',
    'MemoryWarmDriver',
    'MemoryColdChunkSource',
  ]) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  const store = new m.CloudRoaring({
    warm: new m.MemoryWarmDriver(),
    cold: new m.MemoryColdChunkSource(),
  });
  const seg = store.segment('smoke');
  await seg.add(42);
  if (!(await seg.has(42))) throw new Error(`${label}: add/has round-trip failed`);
}

/*
 * Cross-bundle error identity. A driver subpath (`/dynamodb`, `/s3`) is a SEPARATE bundle with
 * its OWN copy of the core error classes, so `instanceof` against the core entry's class fails in CJS — which
 * silently defeated OCC/transient retry + compaction race-handling. The brand-based predicates must still
 * classify a driver-bundle error. This asserts exactly that against the BUILT bundles (where the bug lived and
 * where the whole test suite — one source graph — could not see it). Trigger: the DynamoDb driver validates its
 * `keyPrefix` synchronously and throws a ValidationError from its own bundle.
 */
function exerciseCrossBundleErrors(label, coreMod, dynamoMod) {
  let caught;
  try {
    new dynamoMod.DynamoDbWarmDriver({ client: {}, tableName: 't', keyPrefix: 'a|b' });
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

async function main() {
  for (const sub of SUBPATHS) {
    await import(PKG + sub); // ESM `import` condition — the path that used to crash under Node ESM
    require(PKG + sub); // CJS `require` condition
    console.log(`  import + require OK: ${PKG}${sub || ''}`);
  }
  // The bins are built by a separate tsup config (their own bundled `roaring` import) and aren't in `exports`,
  // so load them by path. Safe: their run-guard only invokes main() when executed as the CLI, not on import.
  for (const bin of ['compact-segments', 'export-segments']) {
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
  console.log(
    'smoke: ESM + CJS import (via exports map) + roaring round-trip + cross-bundle errors OK',
  );
}

main().catch((e) => {
  console.error('smoke FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
