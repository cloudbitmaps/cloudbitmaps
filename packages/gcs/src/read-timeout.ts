/**
 * The read timeout: `readTimeoutMs`, off (`0`) unless set. Each download the GCS drivers make, and the metadata read a
 * tail read can fall back on, is cut off once it has run that long.
 *
 * `@google-cloud/storage` 8.x sets no working timeout of its own: it hands its `timeout` to an HTTP client that has no
 * such option, so a read on a connection that stops answering waits forever, and nothing above it ever gets a fault to
 * retry. A download cut off by this timer fails with {@link ReadTimedOut}, coded `ETIMEDOUT`, which the driver retries
 * as the connection fault it is (`download-retry.ts`); one that times out on every attempt reaches the caller as
 * `TransientError`, its message naming the read and the timeout.
 *
 * **What the clock counts.** It starts when the driver calls into the SDK, so everything the SDK does before the bytes
 * arrive counts: fetching or refreshing a credential, resolving the project, waiting for a socket (neither agent a
 * download can use limits its sockets, so in practice there is no queue), the request, the headers and the whole body.
 * Each attempt has its own clock.
 *
 * Uploads, deletes, listings and the conditional writes are not timed: an upload can rightly take longer than a read,
 * and a write cut off may still land.
 */
import { ValidationError } from '@cloudbitmaps/core/driver-kit';

/** The default: no timeout. */
const DEFAULT_READ_TIMEOUT_MS = 0;

/** The longest delay a Node timer holds. A longer one fires after 1 ms instead, so it is refused rather than passed on. */
const MAX_TIMER_MS = 2_147_483_647;

/** Validate a caller's `readTimeoutMs`, defaulting it: an integer from 0 (no timeout) to {@link MAX_TIMER_MS}. */
export function resolveReadTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_READ_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new ValidationError(
      `readTimeoutMs must be a non-negative safe integer no larger than ${MAX_TIMER_MS}; got ${String(value)}`,
    );
  }
  return value;
}

/** A read the driver gave up on after its timeout. Coded `ETIMEDOUT`, so it is retried like any timed-out connection. */
export class ReadTimedOut extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(read: string, ms: number) {
    super(`GCS ${read} timed out after ${ms} ms`);
    this.name = 'ReadTimedOut';
  }
}

/** The timeout one read runs under: `ms` (`0`: none) and what to call the read in the error, e.g. `tail read of s.3`. */
export interface ReadDeadline {
  readonly ms: number;
  readonly read: string;
}

/**
 * Settle with `request`, or with {@link ReadTimedOut} once `deadline.ms` have passed. For a request the SDK cannot
 * cancel: a metadata read is one callback-style request that returns no handle to abort it, so on a timeout this stops
 * waiting and the request runs on until it is answered or its connection closes; what it settles with then is dropped.
 */
export function withDeadline<T>(request: Promise<T>, deadline: ReadDeadline): Promise<T> {
  if (deadline.ms === 0) return request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut(deadline.read, deadline.ms)), deadline.ms);
  });
  request.catch(() => undefined); // an answer that comes after the timeout has no one to hear it
  return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}
