/**
 * The read timeout: each read request the Azure Blob drivers send is cut off after `readTimeoutMs`, when one is set.
 *
 * It is off unless set. The SDK's own per-try timer stops once the response headers arrive, so a server that sends its
 * headers and then stalls holds a read for as long as the connection stays open, and the store's read retry never gets
 * a fault to retry. With `readTimeoutMs` set, a read still running when its timer fires throws {@link TransientError},
 * which the store's retry runs again, and is aborted through the `abortSignal` its SDK call was given, which ends the
 * request and destroys the response body, letting go of the socket. The client's retry policy does not send an aborted
 * request again.
 *
 * The timer covers one SDK call and the reading of its body: the call, any retries the client's retry policy makes of
 * it, and the body to its last byte. It starts at the call into the SDK, so time spent waiting for a socket and for a
 * token credential's token counts. The HTTP agent the SDK builds sets no limit on sockets, so a read through a client
 * of the SDK's own making does not wait for one. The read settles when the timer fires, whatever the layers under the
 * client do with the abort, because the timer's error is what the read throws.
 *
 * Writes are not timed, since an upload can rightly take longer than a read and a conditional write cut off may still
 * land; nor are deletes and listings.
 *
 * Every read gets a signal of its own, timed or not, and it is aborted when the read fails: the SDK refuses a response
 * with no ETag or no length by throwing, and leaves its body unread with the socket open, and the abort closes it. A
 * read passes the signal to its SDK call and attaches its listeners to the response body in the same turn the call
 * returns, before anything can abort it: a body stream that errors with nothing listening throws out of the event,
 * where no caller can catch it.
 */
import { TransientError, ValidationError } from '@cloudbitmaps/core/driver-kit';

/** The longest delay a Node timer holds. A longer one fires after 1 ms instead, so it is refused rather than passed on. */
const MAX_TIMER_MS = 2_147_483_647;

/** Validate a caller's `readTimeoutMs`: an integer from 0 to {@link MAX_TIMER_MS}, and 0, no timeout, when absent. */
export function resolveReadTimeoutMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new ValidationError(
      `readTimeoutMs must be a non-negative safe integer no larger than ${MAX_TIMER_MS}; got ${describe(value)}`,
    );
  }
  return value;
}

/** A value as an error message can show it: a string quoted, so `'200'` is not mistaken for `200`, and never a throw. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value === null ? 'null' : typeof value;
}

/** The SDK call a timed read makes, named in the error a timeout throws. */
export type ReadOperation = 'download' | 'getProperties';

/**
 * Run `read` with an abort signal of its own, under a `timeoutMs` timer (`0`: none). `read` passes the signal to its
 * SDK call and reads the body before it returns, so the timer covers both. The signal is aborted if the read fails, and
 * the timer is cleared however it settles.
 */
export async function timedRead<T>(
  operation: ReadOperation,
  timeoutMs: number,
  read: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === 0) return await read(controller.signal);
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Rejected before the abort, so the read settles with this error and not with the one the abort raises.
        reject(new TransientError(`Azure Blob ${operation} timed out after ${timeoutMs} ms`));
        controller.abort();
      }, timeoutMs);
    });
    // The race also takes the read's own rejection after an abort, so it never goes unhandled.
    return await Promise.race([read(controller.signal), timedOut]);
  } catch (err) {
    // Lets go of a response the SDK refused and left unread. After a response read whole, or a read aborted already,
    // it does nothing.
    controller.abort();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
