import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const CORE = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const ROARING = fileURLToPath(new URL('./packages/roaring/src', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    passWithNoTests: false,
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
      { find: /^@\/system-clock$/, replacement: ROARING + '/system-clock.ts' },
      { find: /^@\/testing\/(.*)$/, replacement: ROARING + '/testing/$1' },
      { find: /^@\/bin\/(.*)$/, replacement: ROARING + '/bin/$1' },
      { find: /^@\/(.*)$/, replacement: CORE + '/$1' },
      { find: /^@cloudbitmaps\/core$/, replacement: CORE + '/index.ts' },
      { find: /^@cloudbitmaps\/core\/(.*)$/, replacement: CORE + '/$1' },
    ],
  },
});
