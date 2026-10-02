/**
 * The read timeout: with `readTimeoutMs` set, each `GetObject` and `HeadObject` the S3 drivers send is cut off after
 * it. It is off by default (`0`).
 *
 * The SDK sets no timeout of its own, so a read on a connection that stops answering waits as long as the connection
 * stays open, and the store's read retry never gets a fault to retry. A read still running when its timer fires throws
 * {@link TransientError}, which the store's retry runs again, and is aborted through the `abortSignal` its
 * `client.send` was given, which ends the request and destroys the response body, letting go of the socket. The SDK
 * does not send an aborted request again.
 *
 * The timer starts when the read is handed to the SDK and covers everything until its body is read: waiting for one
 * of the client's sockets, fetching credentials, an adaptive retry mode's rate-limiter wait, the request, any retries
 * the SDK makes of it, and reading the body. A server that sends its headers and then stalls part-way through the body
 * is cut off too, and so is a read that only queued too long. The read settles when the timer fires whatever the layers
 * under the client do with the abort, because the timer's error is what the read throws.
 *
 * It is per request, never the HTTP handler's timeout, for two reasons: writes are not timed, since an upload's part can
 * rightly take longer than a read, and a `client` the caller passes in is used as it is.
 */
import { TransientError, ValidationError } from '@cloudbitmaps/core/driver-kit';

/** No timeout unless one is set: the value a read takes stays the caller's until in-region measurements justify one. */
export const DEFAULT_READ_TIMEOUT_MS = 0;

/** The longest delay a Node timer holds. A longer one fires after 1 ms instead, so it is refused rather than passed on. */
const MAX_TIMER_MS = 2_147_483_647;

/** Validate a caller's `readTimeoutMs`, defaulting it: an integer from 0 (no timeout) to {@link MAX_TIMER_MS}. */
export function resolveReadTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new ValidationError(
      `readTimeoutMs must be a non-negative safe integer no larger than ${MAX_TIMER_MS}; got ${value}`,
    );
  }
  return value;
}

/** The options a timed read passes to its `client.send`: the abort signal, or nothing when the timeout is off. */
export type ReadSendOptions = { readonly abortSignal: AbortSignal } | undefined;

/**
 * Run `read` under a `timeoutMs` timer (`0`: none). `read` passes `options` to its `client.send` and reads the body
 * before it returns, so the timer covers both. The timer is cleared when the read settles.
 */
export async function timedRead<T>(
  operation: 'GetObject' | 'HeadObject',
  timeoutMs: number,
  read: (options: ReadSendOptions) => Promise<T>,
): Promise<T> {
  // No options at all, rather than an empty signal: a client built with `cacheMiddleware: true` reuses its cached
  // handler only for a `send` given none.
  if (timeoutMs === 0) return read(undefined);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejected before the abort, so the read settles with this error and not with the one the abort raises.
      reject(new TransientError(`S3 ${operation} timed out after ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // The race also takes the read's own rejection after an abort, so it never goes unhandled.
    return await Promise.race([read({ abortSignal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
