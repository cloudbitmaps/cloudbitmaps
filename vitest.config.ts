import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const CORE = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const ROARING = fileURLToPath(new URL('./packages/roaring/src', import.meta.url));
const S3 = fileURLToPath(new URL('./packages/s3/src', import.meta.url));
const GCS = fileURLToPath(new URL('./packages/gcs/src', import.meta.url));
const AZURE = fileURLToPath(new URL('./packages/azure-blob/src', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // Configures fast-check once for all eight property suites: verbose counterexamples, and `FC_SEED` to
    // replay a CI failure locally. See the file for why the seed stays random by default.
    setupFiles: ['tests/setup-fast-check.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    passWithNoTests: false,
  },
  resolve: {
    // The test suite lives at the repo root and drives all five packages (many tests are white-box across
    // the facade + core internals), so `@/…` is mapped onto the workspace here — which is why the family
    // split needed no churn in 100+ test files. Order matters: the exact matches win over the `@/*`
    // catch-all, so a new package's alias goes ABOVE it.
    //   @/index          → the roaring facade (the package entry the tests mean)
    //   @/roaring-codec  → the roaring codec (was `@/core/bitmap` before the split)
    //   @/*              → @cloudbitmaps/core internals
    alias: [
      { find: /^@\/index$/, replacement: ROARING + '/index.ts' },
      { find: /^@\/roaring-codec$/, replacement: ROARING + '/roaring-codec.ts' },
      { find: /^@\/moved-options$/, replacement: ROARING + '/moved-options.ts' },
      { find: /^@\/system-clock$/, replacement: ROARING + '/system-clock.ts' },
      { find: /^@\/testing\/(.*)$/, replacement: ROARING + '/testing/$1' },
      { find: /^@\/portable\/(.*)$/, replacement: ROARING + '/portable/$1' },
      { find: /^@\/bin\/(.*)$/, replacement: ROARING + '/bin/$1' },
      // The driver packages' own sources, for the white-box unit tests. Same idea as `@/index` above:
      // `@/…` addresses workspace sources, and which package a path lands in follows the topology.
      { find: /^@\/s3\/(.*)$/, replacement: S3 + '/$1' },
      { find: /^@\/gcs\/(.*)$/, replacement: GCS + '/$1' },
      { find: /^@\/azure-blob\/(.*)$/, replacement: AZURE + '/$1' },
      { find: /^@\/(.*)$/, replacement: CORE + '/$1' },
      { find: /^@cloudbitmaps\/s3$/, replacement: S3 + '/index.ts' },
      { find: /^@cloudbitmaps\/gcs$/, replacement: GCS + '/index.ts' },
      { find: /^@cloudbitmaps\/azure-blob$/, replacement: AZURE + '/index.ts' },
      { find: /^@cloudbitmaps\/core$/, replacement: CORE + '/index.ts' },
      { find: /^@cloudbitmaps\/core\/(.*)$/, replacement: CORE + '/$1' },
    ],
  },
});
