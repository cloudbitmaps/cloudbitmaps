/**
 * `GcsStorageDriver` — an {@link IStorageDriver} over Google Cloud Storage.
 *
 * Uses the official `@google-cloud/storage`, a real dependency of this package — installing
 * `@cloudbitmaps/gcs` is what installs it. The `Storage` client is **injected** (dependency injection): the driver owns
 * no credential/project/endpoint logic, so it's thin, reuses the caller's client, and is testable against the
 * `fake-gcs-server` emulator (point a `Storage` at its `apiEndpoint`).
 *
 * Generations are write-once immutable objects: a resumable upload with the **`ifGenerationMatch: 0`**
 * precondition ("create only if it does not exist") makes the publish atomic — a second write to the same
 * object fails with 412 → {@link WriteConflictError}, never a silent overwrite (hard invariant 2: storage
 * objects are immutable and never overwritten in place), the GCS analogue of S3's `If-None-Match: *` and
 * LocalFs's atomic `link`. **Writes stream in constant memory:** the codec's bytes are
 * piped into a GCS resumable-upload `Writable` (chunked/freed by the SDK as they go), so a load's write
 * footprint stays bounded regardless of segment size, up to the advertised `maxObjectBytes`. Drivers may use
 * `node:crypto`; only `core/` is bound by the determinism lint.
 */
import {
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
} from '@cloudbitmaps/core/driver-kit';
import type {
  BlobSink,
  GenKey,
  IStorageDriver,
  SegmentRef,
  StorageCaps,
} from '@cloudbitmaps/core/driver-kit';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { Storage } from '@google-cloud/storage';
import {
  storageObjectName,
  normalizeGcsPrefix,
  parseGenerationFromName,
  segmentObjectPrefix,
} from './keys';
import { isInvalidRange, isNotFound, isPreconditionFailed, isTransient } from './gcs-errors';
import { retryDownload } from './download-retry';
import { saveOnce } from './send-once';
import { readOnce, singleHeader, type ObjectRead } from './read-once';

/** Default object ceiling: GCS's 5 TiB per-object hard max. Set lower to fail fast on a runaway write. */
const DEFAULT_MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

/** The custom-metadata name a resumable upload stores its write id under. Short: it travels with every such write. */
const WRITE_ID_KEY = 'cbwid';

/**
 * Objects at/under this size are uploaded in a **single simple (non-resumable) request**; larger ones switch to
 * a **resumable stream** (constant memory). Mirrors S3's single-PUT-vs-multipart split — the simple path buffers
 * only ≤ this many bytes, the resumable path streams. Default 8 MiB (≈ S3's part size), so peak write memory is
 * ~one threshold's worth regardless of object size.
 */
const DEFAULT_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface GcsStorageDriverOptions {
  /** A constructed `@google-cloud/storage` `Storage` client (point `apiEndpoint` at fake-gcs-server locally). */
  readonly storage: Storage;
  /**
   * The client the downloads go through; `storage` when absent. `GcsStorage` passes one built with the SDK's request
   * retries off (the read client built in its constructor), because a download the SDK retries can crash the process;
   * the driver retries a download itself instead.
   */
  readonly readStorage?: Storage;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which all objects live (e.g. `cloudbitmaps/`). */
  readonly prefix?: string;
  /** Largest object this driver will write/advertise (default = GCS's 5 TiB max). Must be a positive safe integer. */
  readonly maxObjectBytes?: number;
  /** Bytes at/under which a single non-resumable upload is used instead of a resumable stream (default 8 MiB).
   * Must be a positive safe integer. */
  readonly simpleUploadThresholdBytes?: number;
}

export class GcsStorageDriver implements IStorageDriver {
  private readonly storage: Storage;
  private readonly readStorage: Storage;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly threshold: number;

  constructor(options: GcsStorageDriverOptions) {
    this.storage = options.storage;
    this.readStorage = options.readStorage ?? options.storage;
    this.bucket = options.bucket;
    this.prefix = normalizeGcsPrefix(options.prefix);
    // Fail fast at the boundary: `??` only guards `undefined`, so NaN, 0, a negative or a fraction would otherwise
    // reject every write (cap) or corrupt the upload-path choice (threshold).
    for (const [name, value] of [
      ['maxObjectBytes', options.maxObjectBytes],
      ['simpleUploadThresholdBytes', options.simpleUploadThresholdBytes],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new ValidationError(`${name} must be a positive safe integer; got ${value}`);
      }
    }
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.threshold = options.simpleUploadThresholdBytes ?? DEFAULT_UPLOAD_THRESHOLD_BYTES;
  }

  capabilities(): StorageCaps {
    return { rangeRead: true, maxObjectBytes: this.maxObjectBytes, conditionalPut: true };
  }

  private file(name: string) {
    return this.storage.bucket(this.bucket).file(name);
  }

  /** The same object on the download client. */
  private downloadable(name: string) {
    return this.readStorage.bucket(this.bucket).file(name);
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectName = storageObjectName(this.prefix, key); // validates ref + generation
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
    const objectName = storageObjectName(this.prefix, key);
    try {
      // GCS `end` is inclusive.
      const [buf] = await retryDownload(() =>
        this.downloadable(objectName).download({ start: offset, end: offset + length - 1 }),
      );
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
    const objectName = storageObjectName(this.prefix, key);
    try {
      // Nothing to read: only the size is wanted, which the metadata answers in one request.
      if (maxBytes <= 0) return { bytes: new Uint8Array(0), size: await this.sizeOf(objectName) };
      if (!Number.isSafeInteger(maxBytes)) {
        throw new ValidationError(`invalid tail length ${maxBytes}`);
      }
      // One request: a suffix range (`Range: bytes=-N`, "the last N bytes") answers with the tail and, in
      // `Content-Range: bytes a-b/total`, the object's size. An object shorter than N comes back whole.
      let res;
      try {
        res = await retryDownload(() =>
          readOnce(
            this.downloadable(objectName),
            { end: -maxBytes, decompress: false },
            maxBytes,
            () => this.badTail(key, `the response is longer than the ${maxBytes}B requested`),
          ),
        );
      } catch (err) {
        // A zero-byte object has no suffix to satisfy, and a server may refuse the range with a 416. The metadata
        // settles whether that is an empty object (a valid, empty tail) or a real range fault.
        if (!isInvalidRange(err)) throw err;
        const size = await this.sizeOf(objectName);
        if (size !== 0) throw err;
        return { bytes: new Uint8Array(0), size };
      }
      if (res.bytes.length === 0) {
        // No bytes came back for a positive request: only an empty object may do that.
        const size = await this.sizeOf(objectName);
        if (size !== 0) throw this.badTail(key, `no bytes returned for an object of ${size}B`);
        return { bytes: res.bytes, size };
      }
      return { bytes: res.bytes, size: this.tailSize(res, maxBytes, key) };
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  /** The object's size from its metadata, validated. */
  private async sizeOf(objectName: string): Promise<number> {
    const [meta] = await this.file(objectName).getMetadata();
    const size = Number(meta.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ValidationError(`GCS returned an invalid object size: ${String(meta.size)}`);
    }
    return size;
  }

  /**
   * The object's total size from a tail response, refused unless every header agrees with the bytes received. A 206
   * must carry `Content-Range: bytes a-b/total` that names exactly the suffix asked for and exactly the bytes held;
   * a 200 (a server that ignored the range) is the whole object, and is accepted only when it fits in the request.
   */
  private tailSize(res: ObjectRead, maxBytes: number, key: GenKey): number {
    const received = res.bytes.length;
    if (res.status === 200) {
      if (received > maxBytes)
        throw this.badTail(key, 'whole object returned past the requested length');
      return received;
    }
    if (res.status !== 206) throw this.badTail(key, `unexpected HTTP ${res.status}`);
    const header = singleHeader(res.headers, 'content-range');
    const m = header === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
    if (m === null) throw this.badTail(key, `Content-Range is missing or malformed`);
    const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (![first, last, total].every(Number.isSafeInteger)) {
      throw this.badTail(key, 'Content-Range holds a number that is not a safe integer');
    }
    if (
      last !== total - 1 ||
      first !== Math.max(0, total - maxBytes) ||
      last - first + 1 !== received
    ) {
      throw this.badTail(
        key,
        `Content-Range ${first}-${last}/${total} disagrees with ${received}B received for a ${maxBytes}B tail`,
      );
    }
    return total;
  }

  private badTail(key: GenKey, why: string): ValidationError {
    return new ValidationError(`GCS tail read of ${key.segment}.${key.generation} refused: ${why}`);
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: `ignoreNotFound` so a racing/retried GC sweep of an absent object is a no-op.
    try {
      await this.file(storageObjectName(this.prefix, key)).delete({ ignoreNotFound: true });
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
   * Reclassify a transient GCS fault (throttle/5xx/dropped connection) as a retryable {@link TransientError},
   * so the store's read retry can ride it out and a write's caller can tell it from a deterministic failure;
   * everything else propagates unchanged. The final fallback at every client-call site, so callers and the read
   * retry only ever see typed errors.
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
 * finishes at/under it is committed in a **single simple (non-resumable) request** ({@link saveOnce}) — the write-once
 * path both real GCS and `fake-gcs-server` enforce; a larger one switches to a **resumable stream**, flushing the
 * buffer then piping the rest in constant memory (peak ≈ one threshold). SHA-256 is hashed incrementally. Both
 * paths carry `ifGenerationMatch: 0` (create-only-if-absent) → a conflict is a 412, mapped by the driver to
 * {@link WriteConflictError}. On error the caller invokes {@link abort}.
 *
 * **The simple upload is sent once** ({@link saveOnce}): a replay of one that landed and lost its response would find
 * its own object and read as a lost race, so a transient failure throws {@link TransientError} instead. The resumable
 * upload is a session of requests, which the SDK retries within by asking the session how much it holds; the SDK takes
 * that retry from the client's options, not the call's, so it stays on. Instead, each resumable upload tags its
 * object with a random id in custom metadata, and a `412` on its commit is read back: an object that carries this
 * upload's id is a success, and any other is the lost race. The read is paid only on that `412`.
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

  /**
   * This write's own id, which the resumable upload stores in the object's custom metadata (outside the `.crbm`
   * bytes) so a conflict can be told from a replay of this same write. The simple upload is sent once and needs none.
   */
  private readonly writeId = randomBytes(16).toString('hex');

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
    const stream = this.file.createWriteStream({
      resumable: true,
      ...GcsUploadSink.WRITE_OPTS,
      metadata: {
        ...GcsUploadSink.WRITE_OPTS.metadata,
        metadata: { [WRITE_ID_KEY]: this.writeId },
      },
    });
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
    const sha256 = this.hash.digest('hex');
    if (this.stream === undefined) {
      // Small object: one simple (non-resumable) upload, sent once — write-once enforced everywhere, the emulator too.
      await saveOnce(
        this.file,
        concatBytes(this.buffered, this.bufferedLen),
        GcsUploadSink.WRITE_OPTS,
      );
      return { size: this.total, sha256 };
    }
    try {
      if (this.failure !== undefined) throw this.failure;
      this.stream.end();
      await this.done; // rejects if the commit fails (e.g. 412 write-once conflict)
    } catch (err) {
      // The SDK retries a resumable session, so a commit that landed and lost its response can be answered `412` by
      // its own replay. Nothing overwrites a write-once object, so the id it holds says who wrote it. A failed
      // read-back throws, and reaches the caller as `TransientError` when the fault is transient: neither a success
      // nor a conflict.
      if (!isPreconditionFailed(err) || (await this.storedWriteId()) !== this.writeId) throw err;
    }
    return { size: this.total, sha256 };
  }

  /** The id the stored object carries in its custom metadata, or `undefined` when it carries none or is gone. */
  private async storedWriteId(): Promise<string | undefined> {
    try {
      const [meta] = await this.file.getMetadata();
      return meta.metadata?.[WRITE_ID_KEY] as string | undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async abort(): Promise<void> {
    if (this.stream !== undefined && !this.stream.destroyed) this.stream.destroy();
  }
}
