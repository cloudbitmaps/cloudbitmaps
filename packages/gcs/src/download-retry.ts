/**
 * `retryDownload` — run one download again after the faults the SDK itself would have retried.
 *
 * The client `GcsStorage` builds sends a download once (see `backend.ts`: a download the SDK retries can crash the
 * process), which also took away the SDK's quiet retry of a connection fault and of a 408, 429, 500, 502, 503 or 504.
 * This puts that retry back inside the driver, so every caller keeps it: the store's admin and write-path registry
 * reads, and a store built with `retry: false`, included. Which faults: `isDownloadRetryable`. How many: three
 * retries, the SDK's default, with full-jitter backoff of at most about 0.7 s a call. A chunk read that the store's
 * own retry also repeats makes at most 16 requests, as it did with the SDK's retry. A 404, 412, 403 and every other
 * answer reach the caller on the first attempt. What the last attempt raised is rethrown as it is, for the driver to
 * classify.
 *
 * **Under a read timeout** (`readTimeoutMs`), one {@link Deadline} covers every attempt: each attempt passes it to its
 * request, so the request in flight when it passes fails with {@link ReadTimedOut}; no attempt starts after it; and a
 * backoff that would outlast it ends when it passes, with the same error. So a server that never answers is sent one
 * request per call, not four.
 */
import { isDownloadRetryable } from './gcs-errors';
import { ReadTimedOut, type Deadline } from './read-timeout';

const RETRIES = 3;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 1_000;

/**
 * Call `download`, and again after each retryable fault, up to {@link RETRIES} more times, within `deadline` when there
 * is one; rethrow the last error, or the deadline's once it has passed.
 */
export async function retryDownload<T>(
  download: () => Promise<T>,
  deadline?: Deadline,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download();
    } catch (err) {
      // The deadline passed during the attempt: nothing more is sent.
      if (err instanceof ReadTimedOut) throw err;
      if (attempt >= RETRIES || !isDownloadRetryable(err)) throw err;
      const left = deadline?.remaining() ?? Infinity;
      if (deadline !== undefined && left === 0) throw deadline.expired(err);
      const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      const delay = Math.random() * ceiling;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
      if (deadline !== undefined && delay >= left) throw deadline.expired(err);
    }
  }
}
