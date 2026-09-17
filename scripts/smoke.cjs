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
 * pulls in the SafeBitmap); the `/s3` + `/gcs` + `/azure` entries additionally guard the exports map and their
 * AWS-SDK interop. The bin is a separate tsup build with its own bundled `roaring` import, so it's loaded
 * too. Any regression fails the build. Run via `pnpm smoke` (builds first) or `node scripts/smoke.cjs`.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Self-reference by name → resolves through the package `exports` map. This is the FLAVOR package (what
// users install); its driver subpaths re-export `@cloudbitmaps/core/<driver>`, so the smoke exercises the real
// two-package graph end to end, not just one bundle.
const PKG = '@cloudbitmaps/roaring';
const SUBPATHS = ['', '/s3', '/gcs', '/azure'];

// The loaded store's whole write path in one call: `bulkLoadCrbmGeneration` encodes the ids into one immutable
// `.crbm` generation and publishes it forward-only, and only then can a read see them. So this is also the
// narrowest round-trip that actually exercises the native codec through the built bundle — the ids span two
// 16-bit chunks, so chunk routing and the roaring encode/decode both run rather than a single-container no-op.
async function exerciseCore(label, m) {
  for (const name of [
    'CloudRoaring',
    'estimateCost',
    'MemoryStorageDriver',
    'MemoryRegistryDriver',
    'MemoryStorageChunkSource',
    'bulkLoadCrbmGeneration',
  ]) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  // A BACKEND, which is what the docs tell users to build. This previously wired a raw driver plus a
  // `registry` option — and that option stopped existing when the backend class landed, so the pointer path
  // it meant to exercise had been silently dead here ever since: a store with one generation list-scans to
  // the same answer, so the round-trip kept passing. This file is plain CJS, so no compiler was going to say.
  const backend = new m.MemoryStorage({ now: () => 0 });
  await m.bulkLoadCrbmGeneration(
    backend.storage,
    { segment: 'smoke', generation: 0 },
    [42, 70_000],
    {
      registry: backend.registry,
    },
  );
  const seg = new m.CloudRoaring({ storage: backend }).segment('smoke');
  const ok = (await seg.has(42)) && (await seg.has(70_000)) && (await seg.count()) === 2;
  if (!ok) throw new Error(`${label}: load/read round-trip returned a wrong result`);
}

/*
 * Cross-bundle error identity. A driver subpath (`/s3`, `/gcs`, `/azure`) is a SEPARATE bundle with
 * its OWN copy of the core error classes, so `instanceof` against the core entry's class fails in CJS — which
 * silently defeated transient-retry and publish-race handling. The brand-based predicates must still
 * classify a driver-bundle error. This asserts exactly that against the BUILT bundles (where the bug lived and
 * where the whole test suite — one source graph — could not see it). Trigger: the S3 registry driver
 * validates its `prefix` synchronously in the constructor and throws a ValidationError from its own bundle.
 *
 * **Only the CJS leg can actually fail.** esbuild's ESM output code-splits, so `dist/index.js` and
 * `dist/s3/index.js` import ONE shared copy of `core/errors` and `instanceof` works there by construction —
 * the ESM call is a cheap consistency check, not the guard. CJS is where each bundle gets its own copy of the
 * class and where the bug lived. Both are run so that a future build change which stops sharing the ESM chunk
 * is covered without anyone having to remember to add it.
 */
function exerciseCrossBundleErrors(label, coreMod, driverMod) {
  let caught;
  try {
    new driverMod.S3RegistryDriver({ client: {}, bucket: 'b', prefix: '..' });
  } catch (e) {
    caught = e;
  }
  if (caught === undefined)
    throw new Error(`${label}: expected a ValidationError from the /s3 bundle`);
  if (!coreMod.isValidationError(caught) || !coreMod.isCloudRoaringError(caught)) {
    throw new Error(
      `${label}: core predicates failed to classify a driver-bundle error — cross-bundle brand broken`,
    );
  }
  console.log(`  cross-bundle error predicates OK: ${label}`);

  // Same boundary, second brand. A backend built in the /s3 bundle must be recognised by the store in the
  // MAIN bundle — that is the whole reason the brand is a registered `Symbol.for` and not a class check or a
  // module-local symbol. Nothing else pins it: switching it to plain `Symbol()` leaves lint, typecheck, the
  // full 2200-test suite and this script's other checks green, while every CJS user of a driver subpath gets
  // `storage must be a backend` for a backend they just constructed. ESM cannot see it — esbuild shares one
  // chunk across ESM subpaths — so the CJS half of this check is the load-bearing one.
  const s3Backend = new driverMod.S3Storage({ bucket: 'smoke', region: 'us-east-1' });
  if (!coreMod.isStorageBackend(s3Backend)) {
    throw new Error(
      `${label}: a backend from the /s3 bundle is not recognised by core — cross-bundle brand broken`,
    );
  }
  let backendErr;
  try {
    new coreMod.CloudRoaring({ storage: s3Backend });
  } catch (e) {
    backendErr = e;
  }
  if (backendErr !== undefined)
    throw new Error(`${label}: the store rejected an /s3 backend: ${backendErr.message}`);
  console.log(`  cross-bundle backend brand OK: ${label}`);
}

/*
 * Hard invariant 7, checked against the BUILT files — because that is the only place it is true or false.
 *
 * The eslint rule that enforces "the main entry stays SDK-free" reads STATIC imports. It cannot see
 * `await import('@cloudbitmaps/core/s3')` (proven: eslint exits 0 on exactly that), and nothing else in the
 * gate reads `dist/` at all. That gap is not hypothetical: a `connect(url)` feature that resolved a driver
 * from a runtime string put `require("@aws-sdk/client-s3")` into what was then the CJS entry every consumer
 * loaded — and shipped ~88 KB of driver code to people who never touch S3, while three documents went on
 * saying the entry was SDK-free. A full green local gate and 13 CI jobs passed over it. Measured against
 * esbuild and webpack, a consumer without the SDKs installed could no longer build at all, including one who
 * never called the feature: a bundler resolves specifiers before it tree-shakes.
 *
 * WHAT IS CHECKED. The ESM entry, every module reachable from it (transitively, lazy `import()` included),
 * and the published `.d.ts` tree outside the driver subpaths — a type-only `import('@aws-sdk/client-s3')` in
 * `index.d.ts` is invisible to eslint (it is a `TSImportType`) and is a hard `Cannot find module` for any
 * consumer building with `skipLibCheck: false` who did not install the optional peer.
 *
 * WHAT IS NOT. The driver subpath bundles (`dist/s3/…`) are where an SDK belongs and are never read, and
 * neither is the chunk only they share — unreachable from the main entry, which is the whole point.
 * The walk asserts it actually reached a chunk rather than silently covering none.
 */
const { findSdkSpecifiers } = require('./sdk-specifiers.cjs');
const { findSpecifiers, allSpecifiers, EXTENSIONED } = require('./dts-specifiers.cjs');

/** Driver homes, relative to a package's `dist/` — the one place an SDK specifier is correct. */
const DRIVER_DIRS = ['s3', 'gcs', 'azure'];

function isDriverPath(rel) {
  const parts = rel.split(path.sep);
  return (
    DRIVER_DIRS.includes(parts[0]) || (parts[0] === 'drivers' && DRIVER_DIRS.includes(parts[1]))
  );
}

/**
 * Every `.d.ts` under `dist/`, as a path relative to `dist`. `includeDrivers` distinguishes the two
 * callers: the SDK sweep must skip the driver trees (naming an SDK is exactly what they are for), while
 * the specifier sweep covers them too — a driver subpath is published with the same resolution rules.
 */
function declarationFiles(dist, { includeDrivers = false } = {}) {
  const { readdirSync } = require('node:fs');
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.name.endsWith('.d.ts') && (includeDrivers || !isDriverPath(childRel)))
        out.push(childRel);
    }
  };
  walk(dist, '');
  return out;
}

function assertEntrySdkFree(pkgDir) {
  const { readFileSync, existsSync, statSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');

  // Everything the main entry can reach, followed TRANSITIVELY and through lazy `import()` as well as
  // static `from`.
  //
  // This used to read `index.cjs` plus the chunks `index.js` imported statically — one level, static only —
  // and the CJS bundle covered everything past that level, because with no code splitting it inlined the
  // entry's whole transitive closure into one file. Dropping it removed that cover, so the walk has to
  // reproduce the set directly.
  //
  // It reproduces it and does not exceed it: comparing the modules named in the sourcemaps, the old pair
  // covered 48 source modules and this walk covers the same set. The point is not more coverage — it is the
  // same coverage that no longer depends on a second bundle format existing, and that keeps holding if a
  // lazy `import()` or a chunk-imported-by-chunk ever appears. Neither does today: there is not one dynamic
  // import in either package's source, which is why both entries report 2 reachable modules.
  //
  // It also stays correctly SCOPED. A driver-only chunk is not reachable from `index.js` — verified: each
  // package emits one chunk shared by the three driver subpaths and never imported by the main entry — so
  // it is not walked, which is right, since naming an SDK is exactly what a driver is for.
  const reachable = (entry) => {
    const seen = new Set();
    const queue = [entry];
    while (queue.length > 0) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const spec of allSpecifiers(read(rel))) {
        const next = path.normalize(path.join(path.dirname(rel), spec));
        // Stay inside dist/, and only follow real files. Without the first check a stray `../package.json`
        // would be read and reported as a leak, naming the SDKs in `peerDependencies` — an accusation about
        // a file that is not even shipped. Without the second, a directory specifier passes `existsSync`
        // and then throws EISDIR out of `readFileSync`, which names no gate and no cause.
        if (next.startsWith('..')) continue;
        if (!statSync(path.join(dist, next), { throwIfNoEntry: false })?.isFile()) continue;
        queue.push(next);
      }
    }
    return [...seen];
  };
  const entryGraph = reachable('index.js');

  // `chunkNames: 'chunk-[hash]'` in scripts/build.mjs is an undocumented contract with the literal below.
  // Rename it there and this walk would quietly cover less, so make that loud instead.
  if (!entryGraph.some((f) => path.basename(f).startsWith('chunk-'))) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: dist/index.js reaches no ./chunk-* file, so the chunk walk covers nothing. ` +
        `Either the build stopped splitting, or \`chunkNames\` in scripts/build.mjs no longer emits ` +
        `\`chunk-\` — update the pattern here to match.`,
    );
  }

  for (const file of [...entryGraph, ...declarationFiles(dist)]) {
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
      `(${entryGraph.length} reachable module(s), ${declarationFiles(dist).length} .d.ts)`,
  );

  // Every relative specifier in an emitted .d.ts must carry an explicit extension, and must resolve.
  //
  // Without an extension, `moduleResolution: node16`/`nodenext` cannot resolve it (TS2834) — and the failure
  // is SILENT for almost everyone, because the near-universal `skipLibCheck: true` suppresses the error and
  // TypeScript then types everything reached through that specifier as `any`. Since an entry re-exports
  // nearly everything, that is nearly the whole published surface — and a consumer gets no diagnostic at
  // all; they just lose it, including compile-time guards meant to refuse a bad wiring.
  //
  // The scanner is the same module `scripts/build.mjs` rewrites with, so the gate cannot check something
  // other than what the build fixes, and neither one touches a relative path inside a doc-comment.
  //
  // The second half checks the build's own work: a specifier the rewrite produced that points at no file
  // would be just as unresolvable, and is the one remaining way to ship a broken `.d.ts` quietly.
  const bad = [];
  const unresolvable = [];
  const allDts = declarationFiles(dist, { includeDrivers: true });
  for (const file of allDts) {
    const source = read(file);
    for (const spec of findSpecifiers(source)) bad.push(`${file} → ${spec}`);
    for (const spec of allSpecifiers(source)) {
      if (!EXTENSIONED.test(spec)) continue; // already reported above
      const abs = path.resolve(path.dirname(path.join(dist, file)), spec);
      const candidates = [
        abs, // .json, and anything already naming a real file
        abs.replace(/\.js$/, '.d.ts'),
        abs.replace(/\.mjs$/, '.d.mts'),
        abs.replace(/\.cjs$/, '.d.cts'),
      ];
      if (!candidates.some((c) => existsSync(c))) unresolvable.push(`${file} → ${spec}`);
    }
  }
  const report = (list, what) => {
    const shown = list.slice(0, 5).join('\n  ');
    const rest = list.length > 5 ? `\n  … and ${list.length - 5} more` : '';
    return `${list.length} ${what}\n  ${shown}${rest}`;
  };
  if (bad.length > 0) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: ` +
        report(bad, 'extensionless relative specifier(s) in emitted .d.ts — ') +
        `\n  node16/nodenext consumers would silently get \`any\` for everything behind it.`,
    );
  }
  if (unresolvable.length > 0) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: ` +
        report(unresolvable, 'relative specifier(s) in emitted .d.ts pointing at no file — ') +
        `\n  The extension pass in scripts/build.mjs produced a path that does not resolve.`,
    );
  }
  console.log(
    `  .d.ts specifiers all extensioned and resolvable: @cloudbitmaps/${pkgDir} ` +
      `(${allDts.length} file(s))`,
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

  exerciseCrossBundleErrors('esm', await import(PKG), await import(PKG + '/s3'));
  exerciseCrossBundleErrors('cjs', require(PKG), require(PKG + '/s3'));
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
