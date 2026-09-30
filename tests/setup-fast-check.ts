import fc from 'fast-check';

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
 *   - `FC_SEED` pins the seed. fast-check prints the seed it used in every failure message; copy it and run
 *     `FC_SEED=<seed> pnpm test <file>` to replay that exact run locally.
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
 */
const pinned = process.env.FC_SEED;

// Validated BEFORE use, and the EMPTY STRING counts as unset rather than as a seed. `Number('')` is 0 and
// `Number.isFinite(0)` is true, so `FC_SEED=$SOMEVAR` with `SOMEVAR` unset would otherwise pin every
// exploratory suite to seed 0 — silently, with no signal that exploration had stopped.
const wanted = pinned === undefined || pinned === '' ? undefined : pinned;
if (wanted !== undefined && !Number.isFinite(Number(wanted))) {
  throw new Error(`FC_SEED must be a number; got ${JSON.stringify(pinned)}`);
}

fc.configureGlobal({
  ...(wanted === undefined ? {} : { seed: Number(wanted) }),
  verbose: fc.VerbosityLevel.Verbose,
  includeErrorInReport: true,
});
