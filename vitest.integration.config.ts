import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const CORE = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const ROARING = fileURLToPath(new URL('./packages/roaring/src', import.meta.url));

// Integration suite — runs against DynamoDB-Local + MinIO via `docker compose` (see docker-compose.yml).
// Phase 3c adds the first real integration test: the S3 cold driver vs MinIO.
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    passWithNoTests: true,
    // S3/MinIO round-trips + bucket setup need more than the default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    // The test suite lives at the repo root and drives BOTH packages (many tests are white-box across the
    // facade + core internals), so `@/…` is mapped onto the workspace here — which is why the family split
    // needed no churn in 100+ test files. Order matters: the two exact matches win over the `@/*` catch-all.
    //   @/index          → the roaring facade (the package entry the tests mean)
    //   @/roaring-codec  → the roaring codec (was `@/core/bitmap` before the split)
    //   @/*              → @cloudbitmaps/core internals
    alias: [
      { find: /^@\/index$/, replacement: ROARING + '/index.ts' },
      { find: /^@\/roaring-codec$/, replacement: ROARING + '/roaring-codec.ts' },
      { find: /^@\/testing\/(.*)$/, replacement: ROARING + '/testing/$1' },
      { find: /^@\/bin\/(.*)$/, replacement: ROARING + '/bin/$1' },
      { find: /^@\/(.*)$/, replacement: CORE + '/$1' },
      { find: /^@cloudbitmaps\/core$/, replacement: CORE + '/index.ts' },
      { find: /^@cloudbitmaps\/core\/(.*)$/, replacement: CORE + '/$1' },
    ],
  },
});
