import { writeSync } from 'node:fs';
import { FULL_STRENGTH_ASSIGNMENT } from './strength';

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

/**
 * The line that names a test's seed and the command that replays the run it came from: the strength the run had, the
 * vitest project it ran in (a load test runs once per project, and the seed is each run's own), the file, and the
 * test's own name as a pattern.
 */
export function seedLine(
  task: {
    readonly name: string;
    readonly fullName: string;
    readonly file: string;
    readonly project?: string;
  },
  seed: number,
  fullStrength: boolean,
): string {
  const pattern = task.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, `'\\''`);
  const replay =
    `${fullStrength ? `${FULL_STRENGTH_ASSIGNMENT} ` : ''}FC_SEED=${seed} pnpm vitest run ` +
    `${task.project ? `--project ${task.project} ` : ''}${task.file} -t '${pattern}'`;
  return `fast-check seed ${seed}: ${task.fullName} (unless a call pins its own; replay: ${replay})\n`;
}

/** Waits `ms` without yielding, which the seed line needs: the event loop may be the thing that is starved. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes the whole line to file descriptor 2. The worker's stderr is a non-blocking pipe, so a full pipe throws
 * `EAGAIN`: retry for about a tenth of a second, then drop the line. A missing seed line must never fail a test.
 */
export function writeStderr(line: string): void {
  const bytes = Buffer.from(line);
  let offset = 0;
  for (let attempt = 0; attempt < 20 && offset < bytes.length;) {
    try {
      offset += writeSync(2, bytes, offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') return;
      attempt += 1;
      pause(5);
    }
  }
}

/**
 * Where the seed line goes. It is written straight to file descriptor 2, never through vitest's `console`: vitest
 * sends a log to the main process on a microtask, and a property whose awaits all resolve as microtasks starves the
 * event loop, so that microtask never runs. The worker's stderr is a pipe the main process forwards on its own.
 * A test swaps `write` to record the lines instead.
 */
export const seedWriter: { write: (line: string) => void } = { write: writeStderr };
