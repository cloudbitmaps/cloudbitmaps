/**
 * Whether the bucket a driver names exists, asked when a request first answers 404.
 *
 * GCS answers a missing bucket and a missing object with the same status and reason (`404 notFound`), and a
 * GCS-compatible server may not even word them apart. Read as a missing object, a misnamed or deleted bucket would
 * answer every read as an empty segment. An object listing tells them apart: it names no object, so its 404 can only
 * be the bucket's.
 *
 * ```
 *   a request answers 404 ──▶ confirm() ──▶ bucket seen before? ── yes ──▶ the 404 is an object's
 *                                              │ no
 *                                              ▼
 *                              list one object in the bucket
 *                               ├─ answered ──────────▶ remember the bucket; the 404 is an object's
 *                               ├─ 404 ───────────────▶ reject: the bucket does not exist
 *                               ├─ transient ─────────▶ reject: TransientError (asked again next time)
 *                               ├─ 403 ───────────────▶ remember it as unknowable; the 404 is an object's
 *                               └─ anything else ─────▶ the 404 is an object's (asked again next time)
 * ```
 *
 * A process pays one listing at most while its bucket exists, and concurrent 404s share it. An identity without
 * `storage.objects.list` is answered `403`, which says nothing about the bucket, so its 404s read as they always did.
 * Any other failure (a credential that could not be fetched, a 401) says nothing either, but may not last, so it is
 * not remembered. Once seen, the bucket is not asked about again: one deleted later in the process's life reads as an
 * empty store, as it did before this check, while every write to it fails.
 */

import { TransientError } from '@cloudbitmaps/core/driver-kit';
import type { Storage } from '@google-cloud/storage';
import { isTransient } from './gcs-errors';
import { scrubCredentials } from './scrub-error';

export class BucketPresence {
  private settled = false;
  private asking: Promise<void> | undefined;

  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
  ) {}

  /** Resolve when a 404 can be read as an object's; reject when the bucket does not exist or the listing failed in transit. */
  async confirm(): Promise<void> {
    if (this.settled) return;
    this.asking ??= this.ask().finally(() => {
      this.asking = undefined;
    });
    return this.asking;
  }

  private async ask(): Promise<void> {
    let failure: { raised: unknown } | undefined;
    try {
      await this.storage.bucket(this.bucket).getFiles({ maxResults: 1, autoPaginate: false });
    } catch (raised) {
      failure = { raised };
    }
    if (failure !== undefined) {
      // The cause is the credential-free copy, never the SDK's error as raised.
      const err = scrubCredentials(failure.raised);
      const status = (err as { code?: unknown } | null)?.code;
      if (status === 404) {
        throw new Error(`the GCS bucket does not exist: ${this.bucket}`, { cause: err });
      }
      if (isTransient(err)) {
        throw new TransientError(
          `transient GCS fault confirming the bucket exists: ${String(status)}`,
          {
            cause: err,
          },
        );
      }
      // Refused or otherwise unanswerable: nothing is known about the bucket, so a 404 reads as an object's as it did
      // before this check. Only a refusal (no list permission) is sure to answer the same again, so only it is kept.
      if (status !== 403) return;
    }
    this.settled = true;
  }
}
