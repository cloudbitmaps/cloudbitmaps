import { defineConfig } from 'vitest/config';

/** The child run of `tests/ci/fast-check-bounds.test.ts` for the setup's own limit: the cut fixture under the suite's real setup file. */
export default defineConfig({
  test: {
    globals: true,
    root: process.cwd(),
    setupFiles: ['tests/setup-fast-check.ts'],
    include: ['tests/fixtures/cut/*.cut-fixture.ts'],
  },
});
