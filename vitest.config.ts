import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import {
  ROUTED,
  ROUTED_PROJECT,
  ROUTING_SETUP,
  SORTED,
  SORTED_PROJECT,
  SORTED_SETUP,
} from './tests/helpers/load-input-routes';

const CORE = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const ROARING = fileURLToPath(new URL('./packages/roaring/src', import.meta.url));
const S3 = fileURLToPath(new URL('./packages/s3/src', import.meta.url));
const GCS = fileURLToPath(new URL('./packages/gcs/src', import.meta.url));
const AZURE = fileURLToPath(new URL('./packages/azure-blob/src', import.meta.url));
const TOOLS = fileURLToPath(new URL('./packages/tools/src', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    // Configures fast-check for every property suite: verbose counterexamples, a seed per test that is printed
    // before its first property runs (`FC_SEED` replays it), and a time limit on each property so a hang fails
    // naming its seed. See the file for why the seed stays random by default.
    setupFiles: ['tests/setup-fast-check.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    passWithNoTests: false,
    // Three runs. `ids` is every test as written. `serialized` re-runs each load test with core's load handed
    // `{ serialized }` in place of the ids it was given, which is how a load from portable Roaring bytes is held to
    // every guarantee an id load has without a copy of any test. `sorted` re-runs them with the same ids sorted and
    // `sorted: true`, which holds the sorted load to the same guarantees. Which files, and why the rest are ids-only or
    // not sorted, is in `tests/helpers/load-input-routes.ts`; `tests/arch/load-input-coverage.test.ts` holds those
    // lists to the tree.
    projects: [
      {
        extends: true,
        test: { name: 'ids', include: ['tests/**/*.test.ts'], provide: { loadInput: 'ids' } },
      },
      {
        extends: true,
        test: {
          name: ROUTED_PROJECT,
          include: [...ROUTED],
          setupFiles: [ROUTING_SETUP],
          provide: { loadInput: ROUTED_PROJECT },
        },
      },
      {
        extends: true,
        test: {
          name: SORTED_PROJECT,
          include: [...SORTED],
          setupFiles: [SORTED_SETUP],
          provide: { loadInput: SORTED_PROJECT },
        },
      },
    ],
  },
  resolve: {
    // The test suite lives at the repo root and drives all six packages (many tests are white-box across
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
      { find: /^@\/lease-guards$/, replacement: ROARING + '/lease-guards.ts' },
      { find: /^@\/reserved-namespace$/, replacement: ROARING + '/reserved-namespace.ts' },
      { find: /^@\/system-clock$/, replacement: ROARING + '/system-clock.ts' },
      { find: /^@\/system-entropy$/, replacement: ROARING + '/system-entropy.ts' },
      { find: /^@\/testing\/(.*)$/, replacement: ROARING + '/testing/$1' },
      { find: /^@\/portable\/(.*)$/, replacement: ROARING + '/portable/$1' },
      { find: /^@\/bin\/(.*)$/, replacement: ROARING + '/bin/$1' },
      // The driver packages' own sources, for the white-box unit tests. Same idea as `@/index` above:
      // `@/…` addresses workspace sources, and which package a path lands in follows the topology.
      { find: /^@\/s3\/(.*)$/, replacement: S3 + '/$1' },
      { find: /^@\/gcs\/(.*)$/, replacement: GCS + '/$1' },
      { find: /^@\/azure-blob\/(.*)$/, replacement: AZURE + '/$1' },
      // The offline tools package's own sources, as the driver packages' are.
      { find: /^@\/tools\/(.*)$/, replacement: TOOLS + '/$1' },
      { find: /^@\/(.*)$/, replacement: CORE + '/$1' },
      { find: /^@cloudbitmaps\/s3$/, replacement: S3 + '/index.ts' },
      { find: /^@cloudbitmaps\/gcs$/, replacement: GCS + '/index.ts' },
      { find: /^@cloudbitmaps\/azure-blob$/, replacement: AZURE + '/index.ts' },
      { find: /^@cloudbitmaps\/tools$/, replacement: TOOLS + '/index.ts' },
      { find: /^@cloudbitmaps\/core$/, replacement: CORE + '/index.ts' },
      { find: /^@cloudbitmaps\/core\/(.*)$/, replacement: CORE + '/$1' },
    ],
  },
});
