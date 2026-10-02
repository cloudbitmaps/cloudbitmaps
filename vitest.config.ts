import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { ROUTED, ROUTED_PROJECT, ROUTING_SETUP } from './tests/helpers/load-input-routes';

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
    exclude: ['tests/integration/**', 'node_modules/**'],
    passWithNoTests: false,
    // Two runs. `ids` is every test as written. `serialized` re-runs each load test with core's load handed
    // `{ serialized }` in place of the ids it was given, which is how a load from portable Roaring bytes is held to
    // every guarantee an id load has without a copy of any test. Which files, and why the rest are ids-only, is in
    // `tests/helpers/load-input-routes.ts`; `tests/arch/load-input-coverage.test.ts` holds that list to the tree.
    projects: [
      { extends: true, test: { name: 'ids', include: ['tests/**/*.test.ts'] } },
      {
        extends: true,
        test: { name: ROUTED_PROJECT, include: [...ROUTED], setupFiles: [ROUTING_SETUP] },
      },
    ],
  },
  resolve: {
    // The test suite lives at the repo root and drives all five packages (many tests are white-box across
    // the facade + core internals), so `@/…` is mapped onto the workspace here — which is why a test imports a
    // module by one alias whichever package holds it. Order matters: the exact matches win over the `@/*`
    // catch-all, so a new package's alias goes ABOVE it.
    //   @/index          → the roaring facade (the package entry the tests mean)
    //   @/roaring-codec  → the roaring codec
    //   @/*              → @cloudbitmaps/core internals
    alias: [
      { find: /^@\/index$/, replacement: ROARING + '/index.ts' },
      { find: /^@\/roaring-codec$/, replacement: ROARING + '/roaring-codec.ts' },
      { find: /^@\/option-keys$/, replacement: ROARING + '/option-keys.ts' },
      { find: /^@\/reserved-namespace$/, replacement: ROARING + '/reserved-namespace.ts' },
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
