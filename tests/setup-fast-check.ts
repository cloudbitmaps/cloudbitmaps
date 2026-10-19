import { relative } from 'node:path';
import fc from 'fast-check';
import { beforeEach } from 'vitest';
import { limitFor, seedLine, seedWriter } from './helpers/fast-check-run';

/**
 * One fast-check configuration for the property suites, so a red run can be reproduced.
 *
 * WHY THIS EXISTS. A property suite draws a fresh random seed per run, which is the point — it is what lets
 * the suite find a case nobody thought to write down. The cost is that a failure is a one-off event: CI goes
 * red, the next run is green, and the counterexample is gone unless someone captured it.
 *
 * A red run then looks like a flake whether or not it is one, the only copy of its seed is in the CI log, and
 * without the counterexample a diagnosis is a guess: a plausible-looking sweep can blame inputs the arbitrary
 * cannot even draw, a theory that explains a failure it could not have caused.
 *
 * Three settings make a red run something to act on:
 *
 *   - `verbose` reports the failing counterexample, not just the assertion that tripped on it.
 *   - `includeErrorInReport` puts the thrown error in that report, so a property that fails by throwing (most
 *     of ours assert inside the predicate) says what threw rather than only which input was being tried.
 *   - `FC_SEED` pins the seed. Every test that runs a property prints its seed BEFORE the first run (and
 *     fast-check repeats it in a failure message); copy it and run `FC_SEED=<seed> pnpm vitest run <file> -t
 *     "<test name>"` to replay that exact run locally.
 *
 * Two more make a hang something to act on, not a silence until the job is cancelled:
 *
 *   - The seed line is written before the first run, by `fs.writeSync(2, …)` and not by vitest's `console`. A
 *     property whose awaits all resolve as microtasks starves the event loop: vitest's test timeout (a
 *     `setTimeout`) cannot fire, vitest's console never sends its log, and fast-check prints a seed only on a
 *     failure. The line goes through anyway, so a hung run still names its seed.
 *   - Each test's properties are bounded to 0.8 of the test's own timeout (`interruptAfterTimeLimit`, with
 *     `markInterruptAsFailure`), checked between runs. A property that overruns fails with "Property interrupted
 *     … seed: <n>" before vitest's timeout, instead of running until the job is cancelled.
 *
 * The seed stays RANDOM by default, deliberately. Pinning one in CI would make every run identical and turn
 * property testing into a fixed table of cases — the exploration is the value, and a case it finds is a case
 * worth having found. What a red run needs is not determinism; it is the ability to act on the failure.
 *
 * SCOPE, stated exactly: a per-call `fc.assert(…, { seed })` overrides this global, and two suites do pin
 * their own — `tests/core/crbm/property.test.ts` and `tests/core/crbm/fuzz.test.ts`, which are deliberately
 * deterministic corpus sweeps rather than exploratory. `FC_SEED` therefore steers the exploratory suites,
 * which are the ones whose failures are otherwise unreproducible; the pinned two already replay by
 * construction.
 *
 * KNOWN LIMITS. The time limit is checked between runs, so a single run that never returns is named by the seed
 * line but not ended. `fc.sample` is covered by neither the limit nor the seed line (none draws a random seed
 * today). Several `fc.assert` calls in one test share that test's seed (one replay line per test). A call that
 * pins its own `seed` or `interruptAfterTimeLimit` keeps it: per-call parameters win over the global ones, and
 * the line then says so ("unless a call pins its own").
 */
const pinned = process.env.FC_SEED;

// Validated BEFORE use, and the EMPTY STRING counts as unset rather than as a seed. `Number('')` is 0 and
// `Number.isFinite(0)` is true, so `FC_SEED=$SOMEVAR` with `SOMEVAR` unset would otherwise pin every
// exploratory suite to seed 0 — silently, with no signal that exploration had stopped.
const wanted = pinned === undefined || pinned === '' ? undefined : pinned;
if (wanted !== undefined && !Number.isFinite(Number(wanted))) {
  throw new Error(`FC_SEED must be a number; got ${JSON.stringify(pinned)}`);
}

const baseConfig = {
  verbose: fc.VerbosityLevel.Verbose,
  includeErrorInReport: true,
} as const;

// Top-level configuration, for any fast-check call made while a file is collected.
fc.configureGlobal({
  ...(wanted === undefined ? {} : { seed: Number(wanted) }),
  ...baseConfig,
});

/** The seed line of the running test, until its first property has written it. */
let pending: string | undefined;

beforeEach((ctx) => {
  const seed =
    wanted !== undefined ? Number(wanted) : (Date.now() ^ (Math.random() * 0x100000000)) | 0;
  const limit = limitFor(ctx.task.timeout);
  fc.configureGlobal({
    ...baseConfig,
    seed,
    ...(limit === undefined
      ? {}
      : { interruptAfterTimeLimit: limit, markInterruptAsFailure: true }),
  });
  pending = seedLine(
    { fullName: ctx.task.fullName, file: relative(process.cwd(), ctx.task.file.filepath) },
    seed,
  );
});

// Instantiated by fast-check at the start of every `fc.assert`, before its first run: the seed is in the log even
// if that run never returns. Once per test, and only in a test that runs a property.
fc.installGlobalPlugin(() => {
  if (pending !== undefined) {
    const line = pending;
    pending = undefined;
    seedWriter.write(line);
  }
  return {};
});
