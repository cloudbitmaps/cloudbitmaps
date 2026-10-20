import { defineConfig } from 'vitest/config';

/** The child run of `tests/ci/fast-check-bounds.test.ts`: the hang fixture under the suite's real setup file. */
export default defineConfig({
  test: {
    globals: true,
    root: process.cwd(),
    setupFiles: ['tests/setup-fast-check.ts'],
    include: ['tests/fixtures/hang/*.hang-fixture.ts'],
  },
});
