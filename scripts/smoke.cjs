'use strict';
/*
 * Package smoke test — the built library must import cleanly under BOTH module systems, on real Node,
 * through the paths a consumer actually resolves.
 *
 * Guards the `roaring` CJS→ESM interop: `roaring` is a CommonJS native addon, and a *named* ESM import of
 * it crashes Node's ESM loader (its static lexer can't see the CJS exports). We load the package **by name**
 * — so the package.json `exports` map and its `import`/`require` conditions are exercised too, not just the
 * dist files — via dynamic `import()` (ESM) and `require()` (CJS) for every entry of every package, then run
 * the roaring-backed load/read path. The roaring interop is exercised specifically by the flavor's main `.`
 * entry (only it pulls in the SafeBitmap); the three driver packages additionally guard their own exports
 * maps and their cloud-SDK interop. The bin is a separate tsup build with its own bundled `roaring` import, so it's loaded
 * too. Any regression fails the build. Run via `pnpm smoke` (builds first) or `node scripts/smoke.cjs`.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Self-reference by name → resolves through the package `exports` map. `PKG` is the flavor and `S3` one of
// the driver packages a user installs beside it; naming them separately is what lets the checks below cross
// a real package boundary rather than staying inside one bundle.
const PKG = '@cloudbitmaps/roaring';
const CORE = '@cloudbitmaps/core';
const S3 = '@cloudbitmaps/s3';
/**
 * The packages whose whole job is to name a cloud SDK. Everything else must not.
 *
 * This used to be a list of DIRECTORIES inside one package (`dist/s3`, `dist/drivers/s3`), because the
 * drivers were subpaths of core. They are packages now, so the boundary moved from a path prefix to a
 * package name — and the SDK-free sweep skips these three rather than skipping three folders in each.
 */
const DRIVER_PACKAGES = ['s3', 'gcs', 'azure-blob'];

/**
 * Every relative specifier in an emitted `.d.ts` must carry an explicit extension, and must resolve.
 *
 * Runs for EVERY package, including the driver packages the SDK sweep deliberately skips. Those two checks
 * used to share one function, so skipping the SDK sweep for a driver package silently skipped this as well —
 * and the driver packages publish `.d.ts` like any other, so they need it just as much.
 */
function assertDtsSpecifiers(pkgDir) {
  const { readFileSync, existsSync } = require('node:fs');
  const dist = path.join(__dirname, '..', 'packages', pkgDir, 'dist');
  const read = (f) => readFileSync(path.join(dist, f), 'utf8');
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
  const allDts = declarationFiles(dist);
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

/**
 * A declared subpath must also be reachable by a resolver that cannot read `exports`.
 *
 * `moduleResolution: node`/`node10` ignores `exports` entirely and looks at `types`/`typesVersions`. So a
 * subpath like `@cloudbitmaps/core/driver-kit` resolves for a modern consumer and is INVISIBLE to a node10
 * one — and because the driver packages name it in twelve shipped `.d.ts` files, everything behind it
 * silently became `any` there, which `skipLibCheck: true` then hides completely.
 *
 * That is the same silent-`any` failure `scripts/build.mjs` documents at length for extensionless relative
 * specifiers, arriving by a different route: a bare cross-package specifier. Second occurrence of one class
 * earns a gate, so this asserts the manifest-level invariant rather than re-deriving resolution — every
 * subpath in `exports` has a `typesVersions` entry pointing at a real declaration file.
 */
function assertSubpathsResolveWithoutExports(pkgDir) {
  const { readFileSync, existsSync } = require('node:fs');
  const root = path.join(__dirname, '..', 'packages', pkgDir);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const subpaths = Object.keys(manifest.exports ?? {}).filter((k) => k !== '.');
  if (subpaths.length === 0) return;
  const tv = manifest.typesVersions?.['*'] ?? {};
  const missing = [];
  for (const key of subpaths) {
    const name = key.replace(/^\.\//, '');
    const target = tv[name]?.[0];
    if (target === undefined || !existsSync(path.join(root, target))) {
      missing.push(
        `${manifest.name}/${name}${target === undefined ? '' : ` -> ${target} (no such file)`}`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${manifest.name}: ${missing.length} declared subpath(s) have no usable \`typesVersions\` entry, so a ` +
        `\`moduleResolution: node\` consumer cannot resolve their types and everything behind them becomes ` +
        `\`any\` — silently, because skipLibCheck hides the diagnostic.\n  ` +
        missing.join('\n  '),
    );
  }
  console.log(`  subpaths resolve without exports: @cloudbitmaps/${pkgDir} (${subpaths.length})`);
}

/** Every package directory in the workspace. */
function packageDirs() {
  return require('node:fs')
    .readdirSync(path.join(__dirname, '..', 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every entry a package declares, as a specifier — derived from its own `exports`, never a written list. */
function entriesOf(pkgDir) {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(
      path.join(__dirname, '..', 'packages', pkgDir, 'package.json'),
      'utf8',
    ),
  );
  const name = manifest.name;
  return Object.keys(manifest.exports ?? { '.': null }).map((k) =>
    k === '.' ? name : `${name}/${k.replace(/^\.\//, '')}`,
  );
}

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
 * Cross-COPY error and backend identity — the reason the brands are registered `Symbol.for`s.
 *
 * When two copies of the error classes are in play, a driver throws a *different* class object than the code
 * catching it would `instanceof`-check, and the check silently stops matching — defeating transient-retry
 * and publish-race handling with no error of its own. The brand-based predicates must classify the error
 * anyway. This asserts that against the BUILT packages, where the whole test suite — one source graph —
 * cannot see it. Trigger: the S3 registry driver validates its `prefix` synchronously in the constructor and
 * throws a ValidationError from its own copy.
 *
 * WHICH BOUNDARY IS LOAD-BEARING changed when the packages went ESM-only, and the previous answer here is
 * why this comment is worth reading. It used to say the CJS leg was the only one that could fail, because
 * each CJS bundle carried its own class copy while the ESM subpaths shared a chunk. There is no CJS bundle
 * now: `require()` resolves to the same ESM files through `require(esm)`, so BOTH legs load one shared chunk
 * and neither can observe a mismatch. Run as-was, this check had become vacuous — replacing every
 * `Symbol.for(…)` with `Symbol(…)` in the built chunk left it green.
 *
 * Nor is the PACKAGE boundary load-bearing any more, and this comment previously claimed it was — it said
 * each package carried its own copy of the error classes, which stopped being true the moment the build
 * started marking `@cloudbitmaps/*` external. `assertPackagesShareOneCopy` now asserts the opposite: one
 * copy of core across all five packages, so `instanceof` holds and the identity the predicates defend is
 * the one a normal install already has.
 *
 * So what these checks pin is the BRAND itself, not any particular boundary. Every `Symbol.for` here is a
 * registered symbol precisely so it survives the cases a build cannot see — a consumer's bundler inlining
 * core twice, two majors resolved side by side, a worker or vm realm. None of those can be reproduced here,
 * so what is asserted is that the brand is registered and the predicates read it: switching a
 * `Symbol.for(…)` to a plain `Symbol(…)` in the built chunk must turn this red. Keep both legs running for
 * the same reason — a future build change that stops sharing the ESM chunk is then covered without anyone
 * remembering to add it.
 */
function exerciseCrossBundleErrors(label, coreMod, driverMod, storeMod = coreMod) {
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

  // Same boundary, second brand. A backend built in the driver bundle must be recognised by the store —
  // the whole reason the brand is a registered `Symbol.for` and not a class check or a module-local symbol.
  // Nothing else pins it: switching it to a plain `Symbol()` leaves lint, typecheck and the full suite green
  // while every user of a driver package gets `storage must be a backend` for a backend they just built.
  const s3Backend = new driverMod.S3Storage({ bucket: 'smoke', region: 'us-east-1' });
  if (!coreMod.isStorageBackend(s3Backend)) {
    throw new Error(
      `${label}: a backend from the /s3 bundle is not recognised — cross-copy brand broken`,
    );
  }
  let backendErr;
  try {
    new storeMod.CloudRoaring({ storage: s3Backend });
  } catch (e) {
    backendErr = e;
  }
  if (backendErr !== undefined)
    throw new Error(`${label}: the store rejected an /s3 backend: ${backendErr.message}`);
  console.log(`  cross-bundle backend brand OK: ${label}`);
}

/**
 * Prove our packages share ONE copy of core — the property that makes `instanceof` work across them.
 *
 * This assertion used to say the opposite, and was right to: every dependent bundled its own private copy of
 * core, because each tsconfig maps `@cloudbitmaps/core` through `paths` to core's source and esbuild applies
 * `paths` before deciding externals. `scripts/build.mjs` now marks `@cloudbitmaps/*` external, so there is
 * one copy, and the assertion inverts with it.
 *
 * It is worth keeping in the new direction because the old behaviour is one missing line away: drop that
 * `external` and every dependent silently re-inlines core, `instanceof` silently stops matching, and the
 * published `.d.ts` goes back to asserting an `extends` that is false at runtime. Nothing else notices —
 * lint, typecheck and the whole suite compile one source graph and cannot see it.
 *
 * The `Symbol.for` predicates stay the documented way to classify an error even so, because a consumer can
 * still end up with two copies through version skew between our packages, and there `instanceof` fails again.
 */
function assertPackagesShareOneCopy(coreMod, flavorMod, driverMod) {
  if (coreMod.ValidationError !== flavorMod.ValidationError) {
    throw new Error(
      'core and the flavor no longer share one copy of the error classes — `@cloudbitmaps/*` has stopped ' +
        'being external in scripts/build.mjs, so each package inlined its own core again. `instanceof` ' +
        'across our packages is now silently false for every consumer.',
    );
  }
  let caught;
  try {
    new driverMod.S3RegistryDriver({ client: {}, bucket: 'b', prefix: '..' });
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof coreMod.ValidationError)) {
    throw new Error(
      'an error thrown by the S3 driver package is not `instanceof` the class core exports, so the driver ' +
        'package is carrying its own copy of core.',
    );
  }
  console.log('  one shared copy of core: instanceof holds across packages');
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
 * WHAT IS CHECKED. For `@cloudbitmaps/core` and `@cloudbitmaps/roaring`: the ESM entry, every module
 * reachable from it (transitively, lazy `import()` included), and the published `.d.ts` tree. A type-only
 * `import('@aws-sdk/client-s3')` in `index.d.ts` is invisible to eslint (it is a `TSImportType`) and is a
 * hard `Cannot find module` for any consumer building with `skipLibCheck: false`.
 *
 * WHAT IS NOT. The three driver packages, which name an SDK because that is what they are for. The boundary
 * used to be a directory inside core and is now a package name, which is why this is a list of packages to
 * skip rather than a path prefix to avoid — and why core is now SDK-free unconditionally rather than
 * SDK-free outside three directories.
 */
const { findSdkSpecifiers } = require('./sdk-specifiers.cjs');
const { findSpecifiers, allSpecifiers, EXTENSIONED } = require('./dts-specifiers.cjs');

/**
 * Every `.d.ts` under `dist/`, as a path relative to `dist`. Both sweeps take the whole tree; which
 * PACKAGES each one runs over is decided by the caller, since the SDK sweep skips the driver packages while
 * the specifier sweep covers all five.
 */
function declarationFiles(dist) {
  const { readdirSync } = require('node:fs');
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.name.endsWith('.d.ts')) out.push(childRel);
    }
  };
  walk(dist, '');
  return out;
}

function assertEntrySdkFree(pkgDir) {
  const { readFileSync, statSync } = require('node:fs');
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
  // Scoping is now a package boundary rather than a chunk boundary: an SDK lives in a driver PACKAGE, which
  // this walk never enters, so there is no longer a driver-only chunk inside core or the flavor for it to
  // have to avoid.
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
  //
  // Only for a package with MORE THAN ONE entry, because only then is there anything to code-split. A
  // single-entry package legitimately emits no chunk — everything lands in `index.js`, so walking that one
  // file already covers the whole reachable graph. Requiring a chunk unconditionally turned the package
  // split into a false alarm: the flavor dropped from four entries to one and this fired saying the build
  // had stopped splitting, which was true and fine.
  const entryCount = entriesOf(pkgDir).length;
  if (entryCount > 1 && !entryGraph.some((f) => path.basename(f).startsWith('chunk-'))) {
    throw new Error(
      `@cloudbitmaps/${pkgDir}: dist/index.js reaches no ./chunk-* file although the package declares ` +
        `${entryCount} entries, so the chunk walk covers nothing. Either the build stopped splitting, or ` +
        `\`chunkNames\` in scripts/build.mjs no longer emits \`chunk-\` — update the pattern here to match.`,
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
}

/**
 * The bin must still run when it is reached through a SYMLINK, because that is how it is always reached.
 *
 * Every normal install puts a symlink at `node_modules/.bin/<name>`, and `npx` and every npm script invoke
 * that path. Node resolves a module's `import.meta.url` through symlinks but leaves `process.argv[1]` as
 * typed, so a run-guard comparing the two disagreed with itself and the CLI exited 0 having done nothing.
 * Nothing caught it: the guard is module-level, so no unit test reaches it; importing the module (the check
 * above) deliberately must NOT run it; and pnpm writes shell shims that exec the real path, so this repo's
 * own package manager hid the failure while npm and yarn-classic users got silence.
 *
 * Invoked with no configuration, so the CLI's own required-variable error is the signal that it ran at all.
 * Both halves are asserted: a non-zero exit AND the message. Exit code alone would pass if the process died
 * for some unrelated reason, and the message alone would not distinguish running from printing usage.
 */
function assertBinRunsThroughSymlink(bin, binPath) {
  const { symlinkSync, rmSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  // The link goes NEXT TO the real file, not in a temp dir. Under `--preserve-symlinks-main` Node resolves
  // the module's own imports relative to the LINK, so a link anywhere else cannot find `roaring` or
  // `@cloudbitmaps/core` and dies with ERR_MODULE_NOT_FOUND before the run-guard is ever consulted — which
  // looks like a failure but tests nothing. `dist/` is generated and gitignored, so writing here is safe.
  const link = path.join(path.dirname(binPath), `.smoke-${bin}-link`);
  rmSync(link, { force: true });
  try {
    symlinkSync(path.basename(binPath), link);
    const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
    const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const direct = run([binPath]);
    // Both invocations a real install produces. `--preserve-symlinks-main` is the second because it INVERTS
    // which comparison in the run-guard holds — it stops Node resolving the main entry, so the guard has to
    // accept the unresolved path too. Some monorepo and bundler setups set it in NODE_OPTIONS globally.
    for (const [how, viaLink] of [
      ['a symlink', run([link])],
      ['a symlink under --preserve-symlinks-main', run(['--preserve-symlinks-main', link])],
    ]) {
      assertRanLikeDirect(bin, how, viaLink, direct, out);
    }
    console.log(
      `  cli runs through a symlink (plain + --preserve-symlinks-main): bin/${bin} (exit ${direct.status})`,
    );
  } finally {
    rmSync(link, { force: true });
  }
}

function assertRanLikeDirect(bin, how, viaLink, direct, out) {
  const side = `  via ${how}: ${JSON.stringify(out(viaLink).trim().slice(0, 140))}\n  direct: ${JSON.stringify(out(direct).trim().slice(0, 140))}`;
  if (viaLink.status === 0 || !/CR_EXPORT_ROOT/.test(out(viaLink))) {
    throw new Error(
      `bin/${bin} did not run when invoked through ${how} (exit ${viaLink.status}). The run-guard decides ` +
        `whether this module is the CLI by comparing process.argv[1] with import.meta.url; Node resolves ` +
        `symlinks in one of them and not the other, and which one depends on --preserve-symlinks-main. ` +
        `That is the path npx and every npm script use, so a mismatch means the command silently does ` +
        `nothing.\n${side}`,
    );
  }
  if (viaLink.status !== direct.status || out(viaLink) !== out(direct)) {
    throw new Error(
      `bin/${bin} behaves differently through ${how} (exit ${viaLink.status}) than directly ` +
        `(exit ${direct.status}); they must be identical.\n${side}`,
    );
  }
}

async function main() {
  for (const pkgDir of packageDirs()) {
    for (const specifier of entriesOf(pkgDir)) {
      await import(specifier); // ESM `import` condition
      require(specifier); // CJS `require` condition, which on >=22.12 is `require(esm)`
      console.log(`  import + require OK: ${specifier}`);
    }
  }
  // The bin is built by scripts/build.mjs into dist/bin (its own bundle) and isn't in `exports`,
  // so load it by path. Safe: its run-guard only invokes main() when executed as the CLI, not on import.
  for (const bin of ['export-segments']) {
    const binPath = path.join(__dirname, '..', 'packages', 'roaring', 'dist', 'bin', `${bin}.js`);
    await import(pathToFileURL(binPath).href);
    console.log(`  esm import OK: bin/${bin}.js`);
    assertBinRunsThroughSymlink(bin, binPath);
  }

  await exerciseCore('esm', await import(PKG));
  await exerciseCore('cjs', require(PKG));

  // Same-package legs: cheap consistency, and cover for a future build that stops sharing the ESM chunk.
  exerciseCrossBundleErrors('esm', await import(CORE), await import(S3), await import(PKG));
  exerciseCrossBundleErrors('cjs', require(CORE), require(S3), require(PKG));
  // The leg that can actually fail: two separately bundled packages, each with its own class copy.
  assertPackagesShareOneCopy(require(CORE), require(PKG), require(S3));
  for (const pkgDir of packageDirs()) {
    // The SDK sweep skips the driver packages — naming an SDK is what they exist for. The specifier check
    // does not: they publish `.d.ts` like everything else.
    if (!DRIVER_PACKAGES.includes(pkgDir)) assertEntrySdkFree(pkgDir);
    assertDtsSpecifiers(pkgDir);
    assertSubpathsResolveWithoutExports(pkgDir);
  }

  console.log(
    'smoke: ESM + CJS import (via exports map) + roaring round-trip + cross-bundle errors + SDK-free entries OK',
  );
}

main().catch((e) => {
  console.error('smoke FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
