import { writeSync } from 'node:fs';

/**
 * The share of a test's own timeout that one `fc.assert` may take. fast-check's failure, which names the seed, then
 * comes before vitest's timeout, which does not, and no property runs on after vitest has moved past its test.
 */
export const LIMIT_SHARE = 0.8;

/**
 * The time limit, in ms, to give fast-check for a test with this vitest timeout, or `undefined` for none: a timeout
 * of 0 or Infinity means the test is not bounded, so neither is the property.
 */
export function limitFor(timeout: number): number | undefined {
  return timeout > 0 && Number.isFinite(timeout) ? Math.floor(timeout * LIMIT_SHARE) : undefined;
}

/** The line that names a test's seed and how to replay it. */
export function seedLine(
  task: { readonly fullName: string; readonly file: string },
  seed: number,
): string {
  return (
    `fast-check seed ${seed}: ${task.fullName} (unless a call pins its own; ` +
    `replay: FC_SEED=${seed} pnpm vitest run ${task.file} -t "<test name>")\n`
  );
}

/**
 * Where the seed line goes. It is written straight to file descriptor 2, never through vitest's `console`: vitest
 * sends a log to the main process on a microtask, and a property whose awaits all resolve as microtasks starves the
 * event loop, so that microtask never runs. The worker's stderr is a pipe the main process forwards on its own.
 * A test swaps `write` to record the lines instead.
 */
export const seedWriter: { write: (line: string) => void } = {
  write: (line) => {
    writeSync(2, line);
  },
};
