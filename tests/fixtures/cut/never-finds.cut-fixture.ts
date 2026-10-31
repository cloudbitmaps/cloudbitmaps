import { writeFileSync } from 'node:fs';
import fc from 'fast-check';

/**
 * Run only by `tests/ci/fast-check-bounds.test.ts`, in a child vitest (`vitest.cut.config.ts`): a property that never
 * finds a counterexample, under a 2 s test timeout, with no time limit of its own. Only the setup's global limit
 * (0.8 of that timeout, 1.6 s) can end it before vitest's timeout does, with 0.4 s to spare for a run that ends late on
 * a loaded runner. It is kept outside the suite's include pattern
 * (`tests/**` + `*.test.ts`), so the suite never runs it.
 *
 * Each run awaits a timer, so the event loop turns between runs. A run that only awaited microtasks would starve the
 * timers and the limit's clock check would be reached no sooner than the work ended; the hang fixture covers that.
 */
const out = process.env.CUT_FIXTURE_OUT;

it('a property that never finds a counterexample', { timeout: 2_000 }, async () => {
  const started = Date.now();
  try {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async () => {
        await new Promise((r) => setTimeout(r, 5));
      }),
      { numRuns: 1_000_000 },
    );
  } finally {
    if (out !== undefined) writeFileSync(out, JSON.stringify({ elapsed: Date.now() - started }));
  }
});
