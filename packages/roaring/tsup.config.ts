import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // `@cloudbitmaps/roaring` — the flavor users install. `.` is the roaring codec + the `CloudRoaring` facade
    // (which pre-wires that codec, so callers never pass one); the driver subpaths are thin re-exports of
    // `@cloudbitmaps/core/<driver>` so `@cloudbitmaps/roaring/postgres` keeps working as one name to know.
    // `@cloudbitmaps/core` + `roaring` are real dependencies ⇒ tsup leaves them external (never bundled in).
    entry: [
      'src/index.ts',
      'src/s3/index.ts',
      'src/dynamodb/index.ts',
      'src/gcs/index.ts',
      'src/azure/index.ts',
      'src/postgres/index.ts',
      'src/redis/index.ts',
      'src/mongodb/index.ts',
      'src/cassandra/index.ts',
      'src/mysql/index.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
  },
  {
    // The `compact-segments` + `export-segments` CLIs (Phase 4d / eject): ESM-only (they use `import.meta.url`)
    // with their `#!` shebang preserved. They wire a concrete roaring store, which is why they ship with the
    // flavor package rather than core. SDK-free — they import only the facade + LocalFs drivers.
    entry: {
      'bin/compact-segments': 'src/bin/compact-segments.ts',
      'bin/export-segments': 'src/bin/export-segments.ts',
    },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    treeshake: true,
  },
  {
    // Fuzz-only internals, CODEC half (test-strategy T3): just the real `SafeBitmap`, whose safe-deserialize is
    // the untrusted-bytes boundary one target fuzzes. Core's half is built separately from core itself, so
    // NEITHER published barrel gains a test-only export. Built to the git-ignored root `fuzz/build/`, never
    // into `dist/`. `roaring` stays EXTERNAL — esbuild cannot bundle a native `.node` addon; it resolves from
    // the repo-root `node_modules` at fuzz runtime.
    entry: { 'fuzz-codec': 'src/testing/fuzz-codec.ts' },
    outDir: '../../fuzz/build',
    format: ['esm'], // ESM only — the .mjs fuzz targets import the .js; no CJS consumer.
    dts: false,
    clean: false,
    sourcemap: false,
    treeshake: true,
  },
]);
