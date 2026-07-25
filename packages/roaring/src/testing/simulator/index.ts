/**
 * Deterministic simulator — barrel for the test harness.
 *
 * Consumed in-repo by the simulation tests via the `@/` alias. Like the conformance suite, it is **test
 * infrastructure**: never imported by the library entry point (`src/index.ts`), so it stays out of the
 * published runtime bundle. A public export is out of scope until there's an external consumer (YAGNI).
 */
export { SeededRng } from './rng';
export { SimClock } from './clock';
export { Scheduler } from './scheduler';
export {
  ScheduledWarmDriver,
  ScheduledColdDriver,
  ScheduledRegistryDriver,
  CrashInjector,
  SimCrash,
} from './fakes';
export type { FaultOptions } from './fakes';
export { simulate, SimulationError } from './simulate';
export type { SimOptions, SimResult } from './simulate';
