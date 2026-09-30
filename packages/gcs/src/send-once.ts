/**
 * `saveOnce` — upload one object in a single request, sent once, with no SDK retry around it.
 *
 * `file.save()` runs a single-request upload inside a retry loop, and it counts an upload that carries
 * `ifGenerationMatch` as safe to repeat, so after a lost response — a timeout, a reset connection, a 5xx — it sends
 * the upload again. When the first had landed, the second meets it: `ifGenerationMatch: 0` finds the object it
 * created, a generation fence finds the generation it replaced, and GCS answers `412`, which the driver can only report
 * as a lost race. The caller is told its write lost when it won. Only the caller can find out which happened, by
 * reading the pointer or listing the generations, so the write is sent once and a transient failure reaches it as
 * `TransientError`.
 *
 * `createWriteStream({ resumable: false })` is that same single multipart request without the loop: the SDK sends a
 * streamed upload with no retries of its own, since a stream it has read cannot be read again. The client is not
 * touched, so a caller's own client keeps its retry options for every other call.
 *
 * **`resumable: false` is load-bearing twice.** It is what makes this one request, and it is the path on which
 * fake-gcs-server enforces `ifGenerationMatch`, so the integration lane tests the precondition rather than passing over
 * a write with none.
 */
import { once } from 'node:events';
import type { CreateWriteStreamOptions, Storage } from '@google-cloud/storage';

type GcsFile = ReturnType<ReturnType<Storage['bucket']>['file']>;

/** Upload `body` to `file` in one request, sent once; resolves once GCS has stored it and its checksum matched. */
export async function saveOnce(
  file: GcsFile,
  body: Uint8Array,
  options: CreateWriteStreamOptions,
): Promise<void> {
  const stream = file.createWriteStream({ ...options, resumable: false });
  const stored = once(stream, 'finish'); // rejects on 'error', which is how a failed upload surfaces
  stream.end(body);
  await stored;
}
