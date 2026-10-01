/**
 * `retryDownload` — run one download again after the faults the SDK itself would have retried, and no others.
 *
 * The client `GcsStorage` builds sends a download once (see `backend.ts`: a download the SDK retries can crash the
 * process), which also took away the SDK's quiet retry of a reset connection, a 408, a 429 and a 5xx. This puts that
 * retry back inside the driver, so every caller, the store's admin and write-path registry reads and a store built with
 * `retry: false` included, keeps what the SDK gave it. It is bounded (three retries, as the SDK's default), backs off
 * with full jitter, and leaves 404, 412, 403 and every other answer to the caller on the first attempt.
 */
import { isDownloadRetryable } from './gcs-errors';

const RETRIES = 3;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 1_000;

/** Call `download`, and again after each retryable fault, up to {@link RETRIES} more times; rethrow the last error. */
export async function retryDownload<T>(download: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download();
    } catch (err) {
      if (attempt >= RETRIES || !isDownloadRetryable(err)) throw err;
      const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
    }
  }
}
