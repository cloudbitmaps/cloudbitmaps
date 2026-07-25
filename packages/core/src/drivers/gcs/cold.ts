/**
 * `GcsColdDriver` — an {@link IColdDriver} over Google Cloud Storage (Phase 7).
 *
 * Uses the official `@google-cloud/storage`, an **optional peer dependency** — only consumers of
 * `cloud-roaring/gcs` install it. The `Storage` client is **injected** (dependency injection): the driver owns
 * no credential/project/endpoint logic, so it's thin, reuses the caller's client, and is testable against the
 * `fake-gcs-server` emulator (point a `Storage` at its `apiEndpoint`).
 *
 * Generations are write-once immutable objects: a resumable upload with the **`ifGenerationMatch: 0`**
 * precondition ("create only if it does not exist") makes the publish atomic — a second write to the same
 * object fails with 412 → {@link WriteConflictError}, never a silent overwrite (C13), the GCS analogue of S3's
 * `If-None-Match: *` and LocalFs's atomic `link`. **Writes stream in constant memory:** the codec's bytes are
 * piped into a GCS resumable-upload `Writable` (chunked/freed by the SDK as they go), so the daemon's write
 * footprint stays bounded regardless of segment size, up to the advertised `maxObjectBytes`. Drivers may use
 * `node:crypto`; only `core/` is bound by the determinism lint.
 */
import { createHash, type Hash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { Storage } from '@google-cloud/storage';
import type { BlobSink } from '@/core/blob';
import {
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
} from '@/core/errors';
import type { ColdCaps, GenKey, IColdDriver, SegmentRef } from '@/core/ports';
import {
  coldObjectName,
  normalizeGcsPrefix,
  parseGenerationFromName,
  segmentObjectPrefix,
} from './keys';
import { isInvalidRange, isNotFound, isPreconditionFailed, isTransient } from './gcs-errors';

/** Default object ceiling: GCS's 5 TiB per-object hard max. Set lower to fail fast on a runaway write. */
const DEFAULT_MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

/**
 * Objects at/under this size are uploaded in a **single simple (non-resumable) request**; larger ones switch to
 * a **resumable stream** (constant memory). Mirrors S3's single-PUT-vs-multipart split — the simple path buffers
 * only ≤ this many bytes, the resumable path streams. Default 8 MiB (≈ S3's part size), so peak write memory is
 * ~one threshold's worth regardless of object size.
 */
const DEFAULT_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface GcsColdDriverOptions {
  /** A constructed `@google-cloud/storage` `Storage` client (point `apiEndpoint` at fake-gcs-server locally). */
  readonly storage: Storage;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which all objects live (e.g. `cloudroaring/`). */
  readonly prefix?: string;
  /** Largest object this driver will write/advertise (default = GCS's 5 TiB max). */
  readonly maxObjectBytes?: number;
  /** Bytes at/under which a single non-resumable upload is used instead of a resumable stream (default 8 MiB). */
  readonly simpleUploadThresholdBytes?: number;
}

export class GcsColdDriver implements IColdDriver {
  private readonly storage: Storage;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly threshold: number;

  constructor(options: GcsColdDriverOptions) {
    this.storage = options.storage;
    this.bucket = options.bucket;
    this.prefix = normalizeGcsPrefix(options.prefix);
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.threshold = options.simpleUploadThresholdBytes ?? DEFAULT_UPLOAD_THRESHOLD_BYTES;
  }

  capabilities(): ColdCaps {
    return { rangeRead: true, maxObjectBytes: this.maxObjectBytes, conditionalPut: true };
  }

  private file(name: string) {
    return this.storage.bucket(this.bucket).file(name);
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectName = coldObjectName(this.prefix, key); // validates ref + generation
    const sink = new GcsUploadSink(this.file(objectName), this.maxObjectBytes, this.threshold);
    try {
      await write(sink);
      return await sink.finish();
    } catch (err) {
      await sink.abort(); // best-effort teardown of the in-flight upload
      // A lost write-once race — the object already existed, so `ifGenerationMatch: 0` failed with 412.
      if (isPreconditionFailed(err)) {
        throw new WriteConflictError(
          `generation already exists (write-once): ${key.segment}.${key.generation}`,
        );
      }
      if (isValidationError(err) || isWriteConflictError(err) || isNotFoundError(err)) throw err;
      throw this.mapError(err);
    }
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    if (length === 0) return new Uint8Array(0);
    const objectName = coldObjectName(this.prefix, key);
    try {
      // GCS `end` is inclusive.
      const [buf] = await this.file(objectName).download({
        start: offset,
        end: offset + length - 1,
      });
      // A short read means the range ran past EOF — treat as out-of-bounds, never a partial result.
      if (buf.length !== length) {
        throw new ValidationError(
          `range [${offset}, ${offset + length}) out of bounds (got ${buf.length}B)`,
        );
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const objectName = coldObjectName(this.prefix, key);
    try {
      // Two round-trips (metadata for the size, then a ranged download) vs S3's one (suffix-range +
      // Content-Range). This is on the per-*generation* open path, which the reader caches — NOT the per-op hot
      // path (add/has/count/intersect) — so it's amortized; collapsing to one RT is a tracked follow-up.
      const [meta] = await this.file(objectName).getMetadata();
      const size = Number(meta.size ?? 0);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new ValidationError(`GCS returned an invalid object size: ${String(meta.size)}`);
      }
      if (maxBytes <= 0 || size === 0) return { bytes: new Uint8Array(0), size };
      const start = Math.max(0, size - maxBytes);
      const [buf] = await this.file(objectName).download({ start, end: size - 1 });
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), size };
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: `ignoreNotFound` so a racing/retried GC sweep of an absent object is a no-op.
    try {
      await this.file(coldObjectName(this.prefix, key)).delete({ ignoreNotFound: true });
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const prefix = segmentObjectPrefix(this.prefix, ref); // validates ref
    let files;
    try {
      // autoPaginate (default) drains every page; a segment has few generations, so the set is small.
      [files] = await this.storage.bucket(this.bucket).getFiles({ prefix });
    } catch (err) {
      throw this.mapError(err);
    }
    for (const f of files) {
      const generation = parseGenerationFromName(prefix, f.name);
      if (generation !== null) {
        yield { namespace: ref.namespace, segment: ref.segment, generation };
      }
    }
  }

  /** Map GCS read errors to the driver vocabulary; pass everything else through {@link mapError}. */
  private mapReadError(err: unknown, key: GenKey): unknown {
    if (isValidationError(err)) return err;
    if (isNotFound(err))
      return new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
    // A fully out-of-range request (start past EOF) — the BlobReader contract treats range errors as
    // ValidationError, never a short/empty read.
    if (isInvalidRange(err)) {
      return new ValidationError(`range out of bounds for ${key.segment}.${key.generation}`);
    }
    return this.mapError(err);
  }

  /**
   * Reclassify a transient GCS fault (throttle/5xx/dropped connection) as a retryable {@link TransientError}
   * so the retry decorator can ride it out; everything else propagates unchanged. The final fallback at every
   * client-call site, so callers + the decorator only ever see typed errors.
   */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient GCS fault: ${(err as { code?: unknown } | null)?.code ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}

type GcsFile = ReturnType<ReturnType<Storage['bucket']>['file']>;

/** Concatenate byte chunks of known total length into one buffer. */
function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * {@link BlobSink} that uploads one GCS object write-once. It **buffers up to a threshold**: an object that
 * finishes at/under it is committed in a **single simple (non-resumable) request** (`file.save`) — the write-once
 * path both real GCS and `fake-gcs-server` enforce; a larger one switches to a **resumable stream**, flushing the
 * buffer then piping the rest in constant memory (peak ≈ one threshold). SHA-256 is hashed incrementally. Both
 * paths carry `ifGenerationMatch: 0` (create-only-if-absent) → a conflict is a 412, mapped by the driver to
 * {@link WriteConflictError}. On error the caller invokes {@link abort}.
 */
class GcsUploadSink implements BlobSink {
  private readonly hash: Hash = createHash('sha256');
  private total = 0;
  private readonly buffered: Uint8Array[] = [];
  private bufferedLen = 0;
  private stream: Writable | undefined; // set once we cross the threshold → resumable mode
  private done: Promise<unknown[]> | undefined;
  private failure: unknown;

  constructor(
    private readonly file: GcsFile,
    private readonly maxObjectBytes: number,
    private readonly threshold: number,
  ) {}

  private static readonly WRITE_OPTS = {
    preconditionOpts: { ifGenerationMatch: 0 as const }, // write-once: create only if absent
    metadata: { contentType: 'application/octet-stream' },
  };

  async write(bytes: Uint8Array): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (bytes.length === 0) return;
    this.total += bytes.length;
    if (this.total > this.maxObjectBytes) {
      throw new ValidationError(`object exceeds maxObjectBytes ${this.maxObjectBytes}`);
    }
    this.hash.update(bytes);
    if (this.stream !== undefined) {
      // Resumable mode: honor backpressure. `events.once(stream,'drain')` REJECTS if the stream emits 'error'
      // while we wait (that's its documented behavior for any awaited event except 'error'), and auto-removes
      // both listeners on settle — so there's no listener accumulation across drain cycles.
      if (!this.stream.write(bytes)) await once(this.stream, 'drain');
      return;
    }
    this.buffered.push(bytes);
    this.bufferedLen += bytes.length;
    if (this.bufferedLen > this.threshold) this.startResumable();
  }

  /** Cross into resumable streaming: open the stream, flush the buffered bytes, keep only ~one threshold resident. */
  private startResumable(): void {
    const stream = this.file.createWriteStream({ resumable: true, ...GcsUploadSink.WRITE_OPTS });
    this.stream = stream;
    this.done = once(stream, 'finish'); // resolves on a clean commit; rejects on 'error' (e.g. 412)
    stream.on('error', (e: unknown) => {
      this.failure ??= e; // a persistent listener so a stray 'error' is never an unhandled 'error' event
    });
    this.done.catch(() => undefined); // finish() awaits this; guard against unhandled rejection until then
    const buf = concatBytes(this.buffered, this.bufferedLen);
    this.buffered.length = 0;
    this.bufferedLen = 0;
    stream.write(buf); // ≤ threshold+one-chunk; backpressure is absorbed by the next write()'s drain-await / end()
  }

  async finish(): Promise<{ size: number; sha256: string }> {
    if (this.failure !== undefined) throw this.failure;
    const sha256 = this.hash.digest('hex');
    if (this.stream === undefined) {
      // Small object: a single simple (non-resumable) upload — write-once enforced everywhere (incl. the emulator).
      await this.file.save(concatBytes(this.buffered, this.bufferedLen), {
        resumable: false,
        ...GcsUploadSink.WRITE_OPTS,
      });
      return { size: this.total, sha256 };
    }
    this.stream.end();
    await this.done; // rejects if the commit fails (e.g. 412 write-once conflict)
    return { size: this.total, sha256 };
  }

  async abort(): Promise<void> {
    if (this.stream !== undefined && !this.stream.destroyed) this.stream.destroy();
  }
}
