/*
 * The package build. Run from a package directory (`pnpm -r run build` does): bundles the entries with esbuild,
 * emits declarations with tsc, and rewrites the `@/…` self-alias in the emitted .d.ts to relative paths.
 *
 * This replaced tsup. What it reproduces, on purpose:
 *   - one ESM bundle per entry (`.js`, code-split into shared chunks) — every entry the package's own
 *     `exports` map declares — with sourcemaps, node platform, ES2022. ESM ONLY: the package is
 *     `"type": "module"` and the exports map offers a single `default` condition, so `require()` resolves to
 *     the same file and Node's `require(esm)` loads it (Node >=22.12, which `engines` pins). Shipping a
 *     second self-contained CJS bundle bought nothing: it duplicated every module, and it forced the types
 *     to describe an ESM file while the runtime served CJS;
 *   - every bare import left EXTERNAL (`packages: 'external'` plus `@cloudbitmaps/*`): dependencies, the
 *     other workspace packages and node builtins all resolve at runtime from the consumer's node_modules.
 *     That is what keeps a cloud SDK out of a main entry, and what gives the whole install ONE copy of
 *     `@cloudbitmaps/core` — so the error classes are the same objects and `instanceof` holds across
 *     packages. esbuild applies tsconfig `paths` BEFORE `packages: 'external'`, which is why the
 *     `@cloudbitmaps/*` entry has to be spelled out rather than left to the flag;
 *   - one `.d.ts` tree under dist/ mirroring src/ (the exports map already points at `dist/<entry>/index.d.ts`);
 *   - the ESM-only `export-segments` bin with its `#!` line preserved (esbuild keeps an entry's hashbang);
 *   - the fuzz-only bundles into the git-ignored repo-root `fuzz/build/`, never into dist/.
 * `node scripts/smoke.cjs` (ESM import + `require()` of every entry, the bin, cross-bundle error identity) is the
 * check that the output still behaves.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgDir = process.cwd();
const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
const short = pkg.name.split('/').pop();
const dist = path.join(pkgDir, 'dist');
const fuzzBuild = path.resolve(pkgDir, '..', '..', 'fuzz', 'build');

await rm(dist, { recursive: true, force: true });

// Entries come from the package's OWN `exports` map, so the two cannot disagree.
//
// This used to be a hardcoded `['s3', 'gcs', 'azure']`, which was the same list of driver subpaths written
// down in three places — here, each manifest's `exports`, and `scripts/smoke.cjs`. Splitting the drivers into
// their own packages would have meant editing all three; deriving it means editing none. A subpath that is
// declared and not built now fails the build rather than 404-ing for a consumer, and `smoke.cjs` independently
// loads every entry the map declares, so the map is checked from both directions.
const entries = {};
for (const key of Object.keys(pkg.exports ?? { '.': null })) {
  const name = key === '.' ? 'index' : key.replace(/^\.\//, '');
  const dir = path.join('src', name, 'index.ts');
  const flat = path.join('src', `${name}.ts`);
  if (existsSync(path.join(pkgDir, dir)))
    entries[`${name}/index`.replace(/^index\/index$/, 'index')] = dir;
  else if (existsSync(path.join(pkgDir, flat))) entries[name] = flat;
  else
    throw new Error(`${pkg.name}: exports declares "${key}" but neither ${dir} nor ${flat} exists`);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  packages: 'external',
  // Our OWN packages too, which `packages: 'external'` does not cover on its own.
  //
  // Each package's tsconfig maps `@cloudbitmaps/core` through `paths` to core's SOURCE, so it typechecks
  // without core being built first — and esbuild applies `paths` BEFORE it decides what to externalise, so
  // without this line every dependent inlined its own private copy of core. That had three costs, all
  // measured: a flavor bundle of 232 KB against 70 KB, four copies of the same classes in one install, and a
  // published `.d.ts` asserting `extends ObjectStoreRegistry` that was false at runtime because the base
  // class in the driver's copy was not the one core exports.
  //
  // External means the declared `dependencies: { '@cloudbitmaps/core': … }` is load-bearing at runtime
  // rather than types-only, there is exactly one copy of core in an ordinary install, and `instanceof`
  // across our packages holds.
  external: ['@cloudbitmaps/*'],
  logLevel: 'warning',
  absWorkingDir: pkgDir,
};

await build({
  ...common,
  entryPoints: entries,
  format: 'esm',
  outdir: dist,
  splitting: true,
  chunkNames: 'chunk-[hash]',
});
if (existsSync(path.join(pkgDir, 'src', 'bin', 'export-segments.ts'))) {
  await build({
    ...common,
    entryPoints: { 'bin/export-segments': 'src/bin/export-segments.ts' },
    format: 'esm',
    outdir: dist,
  });
}

// Declarations: tsc emits a tree mirroring src/ (tsconfig.build.json owns the emit options). Roaring's build
// config resolves `@cloudbitmaps/core` to core's BUILT declarations rather than its source, so core's files never
// enter roaring's program — the first cut aliased to source and tsc wrote core's .d.ts next to core's .ts files.
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: pkgDir,
  stdio: 'inherit',
});

// tsc does not rewrite path aliases in emitted declarations, so `from '@/core/ports'` would reach a consumer
// verbatim and resolve to nothing. Rewrite every `@/…` specifier to a path relative to the declaring file.
async function* dts(dir) {
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    if ((await stat(p)).isDirectory()) yield* dts(p);
    else if (p.endsWith('.d.ts')) yield p;
  }
}
const ALIAS = /((?:from|import)\s*\(?\s*)(['"])@\/([^'"]+)\2/g;
let rewritten = 0;
for await (const file of dts(dist)) {
  const src = await readFile(file, 'utf8');
  if (!src.includes("'@/") && !src.includes('"@/')) continue;
  const out = src.replace(ALIAS, (_m, lead, q, spec) => {
    let rel = path.relative(path.dirname(file), path.join(dist, spec)).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    rewritten++;
    return `${lead}${q}${rel}${q}`;
  });
  await writeFile(file, out);
}

// Every relative specifier in an emitted .d.ts needs an explicit `.js` extension.
//
// WHY. `tsc` emits `from './core/engine'`, and so does the alias rewrite above. Under
// `moduleResolution: node16`/`nodenext` — the correct setting for a modern Node ESM consumer — that is
// TS2834, "relative import paths need explicit file extensions". The failure is not loud: the near-universal
// `skipLibCheck: true` suppresses the error, TypeScript then cannot resolve the module, and **every type
// reached through one of those specifiers silently becomes `any`**. A consumer sees no diagnostic at all;
// they just lose that whole type surface, including the compile-time half of guards that are supposed to
// refuse a bad wiring. Measured on a packed install: 113 of 115 runtime exports were `any`, the survivors
// being the few declared directly in an entry rather than re-exported.
//
// Verified before and after with a probe project resolving through the real exports map: `nodenext` accepted
// `const leak: string = someStorageBackend` (i.e. `any`) before this, and rejects it after.
//
// `.js` and not `.d.ts`: a declaration file names the RUNTIME specifier, and TypeScript maps `./x.js` to
// `./x.d.ts` itself. A directory specifier becomes `/index.js` for the same reason.
//
// The scanner is shared with the gate in `scripts/smoke.cjs` (see `scripts/dts-specifiers.cjs`) so the two
// can never drift into fixing and checking different things. It skips comments, so a doc-comment example
// showing a relative import is neither rewritten here nor flagged there.
const { rewriteSpecifiers } = require('./dts-specifiers.cjs');
let extended = 0;
for await (const file of dts(dist)) {
  const src = await readFile(file, 'utf8');
  const { text, count } = rewriteSpecifiers(src, (spec) => {
    const abs = path.resolve(path.dirname(file), spec);
    if (existsSync(`${abs}.d.ts`)) return `${spec}.js`;
    // `replace` because a trailing slash would otherwise double it (`./sub/` → `./sub//index.js`).
    if (existsSync(path.join(abs, 'index.d.ts'))) return `${spec.replace(/\/$/, '')}/index.js`;
    // Nothing to point at, so there is no right extension to add. Left as-is on purpose: the smoke gate
    // fails the build on exactly this specifier, with the file and the specifier in the message, which is a
    // better error than a guessed extension that resolves to nothing.
    return null;
  });
  extended += count;
  if (text !== src) await writeFile(file, text);
}

// Fuzz-only bundles — into the repo-root fuzz/build, never into dist/.
const fuzzEntry =
  short === 'core'
    ? 'src/testing/fuzz-core.ts'
    : short === 'roaring'
      ? 'src/testing/fuzz-codec.ts'
      : null;
if (fuzzEntry && existsSync(path.join(pkgDir, fuzzEntry))) {
  await build({
    ...common,
    sourcemap: false,
    entryPoints: { [path.basename(fuzzEntry, '.ts')]: fuzzEntry },
    format: 'esm',
    outdir: fuzzBuild,
  });
}

console.log(
  `build ${pkg.name}: ${Object.keys(entries).length} entries (esm), declarations emitted (${rewritten} alias specifiers rewritten, ${extended} extensions added)`,
);
