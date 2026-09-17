/*
 * The package build. Run from a package directory (`pnpm -r run build` does): bundles the entries with esbuild,
 * emits declarations with tsc, and rewrites the `@/…` self-alias in the emitted .d.ts to relative paths.
 *
 * This replaced tsup. What it reproduces, on purpose:
 *   - one ESM (`.js`, code-split into shared chunks) + one CJS (`.cjs`, self-contained) bundle per entry —
 *     the main entry and each cloud subpath barrel — with sourcemaps, node platform, ES2022;
 *   - every bare import left EXTERNAL (`packages: 'external'`): dependencies, optional peers and node builtins
 *     resolve at runtime from the consumer's node_modules, so the main entry never pulls a cloud SDK in;
 *   - one `.d.ts` tree under dist/ mirroring src/ (the exports map already points at `dist/<entry>/index.d.ts`);
 *   - the ESM-only `export-segments` bin with its `#!` line preserved (esbuild keeps an entry's hashbang);
 *   - the fuzz-only bundles into the git-ignored repo-root `fuzz/build/`, never into dist/.
 * `node scripts/smoke.cjs` (ESM + CJS import of every entry, the bin, cross-bundle error identity) is the
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

const SUBPATHS = ['s3', 'gcs', 'azure'];
const entries = { index: 'src/index.ts' };
for (const s of SUBPATHS) {
  if (existsSync(path.join(pkgDir, 'src', s, 'index.ts')))
    entries[`${s}/index`] = `src/${s}/index.ts`;
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  packages: 'external',
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
await build({
  ...common,
  entryPoints: entries,
  format: 'cjs',
  outdir: dist,
  outExtension: { '.js': '.cjs' },
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
  `build ${pkg.name}: ${Object.keys(entries).length} entries (esm+cjs), declarations emitted (${rewritten} alias specifiers rewritten, ${extended} extensions added)`,
);
