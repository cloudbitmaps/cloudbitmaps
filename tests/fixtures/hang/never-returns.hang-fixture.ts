import { renameSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';

/**
 * Run only by `tests/ci/fast-check-bounds.test.ts`, in a child vitest (`vitest.hang.config.ts`): a property whose
 * third run does not return for 20 s, by awaiting microtasks, which starves the event loop as the CI hang did. It is
 * kept outside the suite's include pattern (`tests/**` + `*.test.ts`), so the suite never runs it.
 */
const out = process.env.HANG_FIXTURE_OUT;

const note = (state: string, seed: number | undefined): void => {
  if (out === undefined) return;
  // Written under another name and renamed, so a reader never sees it half written.
  writeFileSync(`${out}.tmp`, JSON.stringify({ state, seed }));
  renameSync(`${out}.tmp`, out);
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
      // Spins in microtasks for 20 s of wall-clock time, then returns to the event loop, so the test's own timeout
      // fails it and the process exits, whatever became of the process that started it.
      const end = Date.now() + 20_000;
      await new Promise<void>(() => {
        const spin = (): void => {
          if (Date.now() < end) void Promise.resolve().then(spin);
        };
        spin();
      });
    }),
  );
});
