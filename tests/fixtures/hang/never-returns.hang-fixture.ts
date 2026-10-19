import { writeFileSync } from 'node:fs';
import fc from 'fast-check';

/**
 * Run only by `tests/ci/fast-check-bounds.test.ts`, in a child vitest (`vitest.hang.config.ts`): a property whose
 * third run never returns, by awaiting microtasks forever, which starves the event loop as the CI hang did. It is
 * kept outside the suite's include pattern (`tests/**` + `*.test.ts`), so the suite never runs it.
 */
const out = process.env.HANG_FIXTURE_OUT;

const note = (state: string, seed: number | undefined): void => {
  if (out !== undefined) writeFileSync(out, JSON.stringify({ state, seed }));
};

it('a property that never returns', { timeout: 10_000 }, async () => {
  let runs = 0;
  await fc.assert(
    fc.asyncProperty(fc.integer(), async () => {
      runs += 1;
      const seed = fc.readConfigureGlobal().seed;
      if (runs < 3) {
        note('running', seed);
        return;
      }
      note('spinning', seed);
      await new Promise<void>(() => {
        const spin = (): void => void Promise.resolve().then(spin);
        spin();
      });
    }),
  );
});
