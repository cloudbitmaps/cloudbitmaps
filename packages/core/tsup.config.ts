import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // `@cloudbitmaps/core` entries: the codec-agnostic engine (`.`) plus every storage driver on its own
    // subpath — `./s3`, `./gcs`, `./azure` (cold) and `./dynamodb`, `./postgres`, `./redis`, `./mongodb`,
    // `./cassandra`, `./mysql` (warm). Keeping each driver on its own subpath means its backend SDK (an
    // optional peer dep) is pulled in only by consumers of that subpath, so the `.` entry stays SDK-free.
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
    // Fuzz-only internals, CORE half (test-strategy T3) — includes the non-public `parseIndex`. Built to the
    // git-ignored repo-root `fuzz/build/`, so it NEVER enters `dist/` or the published package, and the public
    // barrel stays untouched. `clean: false` so it doesn't wipe the library dist above.
    entry: { 'fuzz-core': 'src/testing/fuzz-core.ts' },
    outDir: '../../fuzz/build',
    format: ['esm'], // ESM only — the .mjs fuzz targets import the .js.
    dts: false,
    clean: false,
    sourcemap: false,
    treeshake: true,
  },
]);
