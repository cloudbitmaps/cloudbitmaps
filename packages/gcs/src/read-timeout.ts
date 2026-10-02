/**
 * The read timeout: `readTimeoutMs`, off (`0`) unless set. It bounds one driver read — a tail read (with the metadata
 * read it can fall back on), a range read, a registry read — as a whole: one deadline, started when the driver is
 * called, covers every attempt the driver makes at it and the backoff between them.
 *
 * `@google-cloud/storage` 8.x sets no working timeout of its own: it hands its `timeout` to an HTTP client that has no
 * such option, so a read on a connection that stops answering waits forever, and nothing above it ever gets a fault to
 * retry. When the deadline passes, the request in flight fails with {@link ReadTimedOut} (coded `ETIMEDOUT`), no
 * further attempt starts, and a backoff in progress ends with the same error; the driver reports it as
 * `TransientError`, its message naming the read and the timeout, for the store's read retry to run again.
 *
 * **What the clock counts.** Everything from the call into the driver: fetching or refreshing a credential, resolving
 * the project, waiting for a socket (Node's global agents, which the downloads use, set no socket limit unless the
 * process sets one, so by default there is no queue), each request, its headers and its whole body, and the driver's
 * backoff between attempts. It counts time the process spends busy too: Node runs a due timer before it reads a socket,
 * so a synchronous stretch longer than the timeout fails the reads in flight even when their responses have arrived.
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

/** A read the driver gave up on when its deadline passed. Coded `ETIMEDOUT`, as a timed-out connection is. */
export class ReadTimedOut extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(read: string, ms: number, cause?: unknown) {
    super(`GCS ${read} timed out after ${ms} ms`, cause === undefined ? undefined : { cause });
    this.name = 'ReadTimedOut';
  }
}

/** One driver read's deadline: `ms` from when it is made. `read` names the read in the error, e.g. `tail read of s.3`. */
export class Deadline {
  private readonly endsAt: number;

  constructor(
    readonly ms: number,
    readonly read: string,
  ) {
    this.endsAt = performance.now() + ms;
  }

  /** What is left of it, in milliseconds: 0 once it has passed. */
  remaining(): number {
    return Math.max(0, this.endsAt - performance.now());
  }

  /** The error a read fails with once this has passed; `cause` is the last attempt's own error, if one failed. */
  expired(cause?: unknown): ReadTimedOut {
    return new ReadTimedOut(this.read, this.ms, cause);
  }
}

/** The deadline a read made now runs under, or none when `ms` is 0 (no timeout). */
export function startDeadline(ms: number, read: string): Deadline | undefined {
  return ms === 0 ? undefined : new Deadline(ms, read);
}

/**
 * Settle with `request`, or with {@link ReadTimedOut} once `deadline` has passed. For a request the SDK cannot cancel: a
 * metadata read is one callback-style request that returns no handle to abort it, so at the deadline this stops waiting
 * and the request runs on until it is answered or its connection closes. The race keeps a handler on `request`, so what
 * it settles with then is dropped rather than raised.
 */
export function withDeadline<T>(request: Promise<T>, deadline: Deadline | undefined): Promise<T> {
  if (deadline === undefined) return request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(deadline.expired()), deadline.remaining());
  });
  return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}
