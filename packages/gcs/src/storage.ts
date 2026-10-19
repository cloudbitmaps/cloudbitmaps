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
 * footprint stays bounded regardless of segment size, up to the advertised `maxObjectBytes`. Every object carries a
 * random write id in its custom metadata (`cbwid`), so a `412` that may be the write meeting itself can be read back:
 * a resumable upload's session is retried by the SDK, and a single-request upload is sent again by the driver after a
 * `429` or `503`, at most {@link THROTTLE_RESENDS} times with backoff, and after nothing else. Drivers may use
 * `node:crypto`; only `core/` is bound by the determinism lint.
 *
 * **A delete given `ifVersion` is sent with `ifGenerationMatch: <that object generation>`** when `conditionalDelete` is
 * set, which it is not by default, as for the registry: no run against real GCS has shown the service applies the
 * precondition to a delete, and fake-gcs-server accepts it and ignores it. A tail read reports the object's generation
 * as its version, from the `x-goog-generation` header of the GET that carried the bytes, or the metadata when none were
 * asked for. A `412` is the precondition failing, and is reported as {@link WriteConflictError} unless the metadata then
 * shows no object under the name: an absent object is a no-op, whether the service answers it `404` or `412`. The
 * delete keeps the SDK's retry, which re-sends a request with a precondition: a copy that meets its own landed delete
 * finds nothing, and one that meets an object stored since is refused.
 */
import {
  errorKind,
  NotFoundError,
  TransientError,
  ValidationError,
  WriteConflictError,
  concatBytes,
  normalizeObjectPrefix,
  parseGenerationFromKey,
  checkDeleteOptions,
  requireBool,
  requirePositiveInt,
  segmentObjectPrefix,
  storageObjectKey,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';
import type {
  BlobSink,
  GenKey,
  IStorageDriver,
  SegmentRef,
  StorageCaps,
  StorageDeleteOptions,
  TailRead,
} from '@cloudbitmaps/core/driver-kit';
import type { Clock, Rng } from '@cloudbitmaps/core';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { Storage } from '@google-cloud/storage';
import { BucketPresence } from './bucket-presence';
import {
  asMissingBucket,
  missingBucketError,
  isInvalidRange,
  isNotFound,
  isPreconditionFailed,
  isThrottle,
  isTransient,
  transientFaultMessage,
} from './gcs-errors';
import { retryDownload } from './download-retry';
import { scrubCredentials } from './scrub-error';
import { saveOnce } from './send-once';
import { downloadFile, readOnce, singleHeader, type ObjectRead } from './read-once';
import {
  ReadTimedOut,
  resolveReadTimeoutMs,
  startDeadline,
  withDeadline,
  type Deadline,
} from './read-timeout';

/** GCS's hard limit on one object (5 TiB), and the default ceiling. Set lower to fail fast on a runaway write. */
const GCS_MAX_OBJECT_BYTES = 5 * 1024 ** 4;

/** The custom-metadata name an object's write id is stored under. Short: it travels with every write. */
const WRITE_ID_KEY = 'cbwid';
/** How many times a throttled single-request upload is sent again: four sends in all, as the SDK's own retry makes. */
const THROTTLE_RESENDS = 3;
/** The backoff ceiling before the first re-send, doubling for each one after it. */
const THROTTLE_BASE_DELAY_MS = 500;

/** What the throttle backoff waits on. */
type Sleeper = Pick<Clock, 'sleep'>;

const REAL_TIME: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
/** Where the backoff's jitter comes from when none is injected. */
const REAL_RNG: Rng = { next: () => Math.random() };

/** A refusal this driver already typed: it passes on unmapped, where a raw SDK error is mapped. */
function isTypedPassThrough(err: unknown): boolean {
  const kind = errorKind(err);
  return kind === 'ValidationError' || kind === 'WriteConflictError' || kind === 'NotFoundError';
}

/**
 * Objects at/under this size are uploaded in a **single simple (non-resumable) request**; larger ones switch to
 * a **resumable stream** (constant memory). Mirrors S3's single-PUT-vs-multipart split — the simple path buffers
 * only ≤ this many bytes, the resumable path streams. Default 8 MiB (≈ S3's part size), so peak write memory is
 * ~one threshold's worth regardless of object size.
 */
const DEFAULT_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

interface GcsStorageDriverOptions {
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
  /**
   * Cut off a read that has run this long, in milliseconds: a tail read (with the metadata read it falls back on for
   * an empty object) or a range read, every attempt and the backoff between them included. `0` (the default) sets no
   * timeout. The clock starts at the call into the driver, so a credential fetch counts, and runs until the body has
   * ended; when it passes the read throws `TransientError` and no further attempt starts. Uploads, deletes and
   * listings are not timed. A non-negative safe integer no larger than 2,147,483,647.
   */
  readonly readTimeoutMs?: number;
  /** What the backoff before re-sending a throttled upload waits on; real time when absent. */
  readonly clock?: Sleeper;
  /** Where the jitter of that backoff is drawn from; `Math.random` when absent. */
  readonly rng?: Rng;
  /**
   * Whether a delete given `ifVersion` is sent with `ifGenerationMatch`, so it removes the object only while it is the
   * one that generation names. Defaults to `false`, on the public endpoint too, as the registry's option does: whether
   * real GCS applies `ifGenerationMatch` to a delete has not been verified by a run against the service, and
   * fake-gcs-server accepts the precondition and ignores it. Set `true` once you have. Until it is set, a delete
   * decided from one read of an object removes whatever is under the name by then: on GCS the window in which an
   * erasure's stalled delete takes a generation a load put under the number since stays open.
   */
  readonly conditionalDelete?: boolean;
}

export class GcsStorageDriver implements IStorageDriver {
  private readonly storage: Storage;
  private readonly readStorage: Storage;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly threshold: number;
  private readonly readTimeoutMs: number;
  private readonly clock: Sleeper;
  private readonly rng: Rng;
  private readonly presence: BucketPresence;
  private readonly conditionalDelete: boolean;

  constructor(options: GcsStorageDriverOptions) {
    this.storage = options.storage;
    this.conditionalDelete = requireBool('conditionalDelete', options.conditionalDelete) ?? false;
    this.clock = options.clock ?? REAL_TIME;
    this.rng = options.rng ?? REAL_RNG;
    this.readStorage = options.readStorage ?? options.storage;
    this.bucket = options.bucket;
    this.prefix = normalizeObjectPrefix(options.prefix);
    // Fail fast at the boundary: `??` only guards `undefined`, so NaN, 0, a negative or a fraction would otherwise
    // reject every write (cap) or corrupt the upload-path choice (threshold).
    requirePositiveInt('maxObjectBytes', options.maxObjectBytes);
    requirePositiveInt('simpleUploadThresholdBytes', options.simpleUploadThresholdBytes);
    // GCS's own limit on one object: a cap past it is advertised and never reachable.
    if (options.maxObjectBytes !== undefined && options.maxObjectBytes > GCS_MAX_OBJECT_BYTES) {
      throw new ValidationError(
        `maxObjectBytes must be at most GCS's 5 TiB object limit (${GCS_MAX_OBJECT_BYTES}); got ${options.maxObjectBytes}`,
      );
    }
    this.maxObjectBytes = options.maxObjectBytes ?? GCS_MAX_OBJECT_BYTES;
    this.threshold = options.simpleUploadThresholdBytes ?? DEFAULT_UPLOAD_THRESHOLD_BYTES;
    this.readTimeoutMs = resolveReadTimeoutMs(options.readTimeoutMs);
    this.presence = new BucketPresence(this.storage, this.bucket);
  }

  capabilities(): StorageCaps {
    return {
      rangeRead: true,
      maxObjectBytes: this.maxObjectBytes,
      conditionalPut: true,
      conditionalDelete: this.conditionalDelete,
    };
  }

  private file(name: string) {
    return this.storage.bucket(this.bucket).file(name);
  }

  /** The same object on the download client, off the SDK's shared agent ({@link downloadFile}). */
  private downloadable(name: string) {
    return downloadFile(this.readStorage, this.bucket, name);
  }

  /** The deadline a read of `key` made now runs under, every attempt included, named for its error; none when off. */
  private deadline(read: string, key: GenKey): Deadline | undefined {
    return startDeadline(this.readTimeoutMs, `${read} of ${key.segment}.${key.generation}`);
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectName = storageObjectKey(this.prefix, key); // validates ref + generation
    const sink = new GcsUploadSink(
      this.file(objectName),
      this.maxObjectBytes,
      this.threshold,
      this.clock,
      this.rng,
    );
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
      if (isTypedPassThrough(err)) throw err;
      // An upload's 404 can be the bucket's: settle it before it is passed on.
      if (isNotFound(err)) await this.presence.confirm();
      throw this.mapError(err);
    }
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    if (length === 0) return new Uint8Array(0);
    const objectName = storageObjectKey(this.prefix, key);
    try {
      // One request, buffering at most the bytes asked for. GCS `end` is inclusive. `decompress: false`, as for the tail:
      // the offsets are into the bytes as stored.
      const deadline = this.deadline('range read', key);
      const res = await retryDownload(
        () =>
          readOnce(
            this.downloadable(objectName),
            { start: offset, end: offset + length - 1, decompress: false },
            length,
            () => this.badRange(key, `the response is longer than the ${length}B requested`),
            deadline,
          ),
        deadline,
      );
      this.checkRange(res, key, offset, length);
      return res.bytes;
    } catch (err) {
      throw await this.readFailure(err, key);
    }
  }

  /**
   * Refuse a range response unless it is exactly the bytes asked for. A 206 must name them in `Content-Range: bytes
   * a-b/total`, starting at `offset`, and hold that many; a 200 (a server that ignored the range) is the whole object,
   * which is the range only when the range starts at 0. A short read means the range ran past the end of the object:
   * out of bounds, never a partial result.
   */
  private checkRange(res: ObjectRead, key: GenKey, offset: number, length: number): void {
    const received = res.bytes.length;
    if (res.status === 200) {
      if (offset !== 0)
        throw this.badRange(key, `whole object returned for a range from ${offset}`);
    } else if (res.status === 206) {
      const header = singleHeader(res.headers, 'content-range');
      const m = header === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
      if (m === null) throw this.badRange(key, 'Content-Range is missing or malformed');
      const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (![first, last, total].every(Number.isSafeInteger)) {
        throw this.badRange(key, 'Content-Range holds a number that is not a safe integer');
      }
      if (first !== offset || last - first + 1 !== received || last >= total) {
        throw this.badRange(
          key,
          `Content-Range ${first}-${last}/${total} disagrees with ${received}B received from ${offset}`,
        );
      }
    } else {
      throw this.badRange(key, `unexpected HTTP ${res.status}`);
    }
    if (received !== length) {
      throw new ValidationError(
        `range [${offset}, ${offset + length}) out of bounds (got ${received}B)`,
      );
    }
  }

  private badRange(key: GenKey, why: string): ValidationError {
    return new ValidationError(
      `GCS range read of ${key.segment}.${key.generation} refused: ${why}`,
    );
  }

  async getTail(key: GenKey, maxBytes: number): Promise<TailRead> {
    const objectName = storageObjectKey(this.prefix, key);
    // The rule every driver's tail read holds to: a safe integer, and zero or less an empty tail.
    if (!Number.isSafeInteger(maxBytes)) {
      throw new ValidationError(`invalid tail length ${String(maxBytes)}`);
    }
    // One deadline for the whole call: the tail's attempts, and the metadata read it may fall back on.
    const deadline = this.deadline('tail read', key);
    try {
      // Nothing to read: only the size is wanted, which the metadata answers in one request.
      if (maxBytes <= 0) {
        const meta = await this.metadataOf(objectName, deadline);
        return withVersion({ bytes: new Uint8Array(0), size: meta.size }, meta.version);
      }
      // One request: a suffix range (`Range: bytes=-N`, "the last N bytes") answers with the tail and, in
      // `Content-Range: bytes a-b/total`, the object's size. An object shorter than N comes back whole.
      let res;
      try {
        res = await retryDownload(
          () =>
            readOnce(
              this.downloadable(objectName),
              { end: -maxBytes, decompress: false },
              maxBytes,
              () => this.badTail(key, `the response is longer than the ${maxBytes}B requested`),
              deadline,
            ),
          deadline,
        );
      } catch (err) {
        // A zero-byte object has no suffix to satisfy, and a server may refuse the range with a 416. The metadata
        // settles whether that is an empty object (a valid, empty tail) or a real range fault.
        if (!isInvalidRange(err)) throw err;
        const meta = await this.metadataOf(objectName, deadline);
        if (meta.size !== 0) throw err;
        return withVersion({ bytes: new Uint8Array(0), size: 0 }, meta.version);
      }
      if (res.bytes.length === 0) {
        // No bytes came back for a positive request: only an empty object may do that.
        const meta = await this.metadataOf(objectName, deadline);
        if (meta.size !== 0) {
          throw this.badTail(key, `no bytes returned for an object of ${meta.size}B`);
        }
        return withVersion({ bytes: res.bytes, size: 0 }, meta.version);
      }
      // The version of the object the bytes came from: the generation the GET that carried them names.
      const size = this.tailSize(res, maxBytes, key);
      return withVersion(
        { bytes: res.bytes, size },
        objectGeneration(singleHeader(res.headers, 'x-goog-generation')),
      );
    } catch (err) {
      throw await this.readFailure(err, key);
    }
  }

  /**
   * The object's size from its metadata, validated, and its generation when the metadata names a usable one. Read on the
   * download client and retried as a download is, within the calling read's `deadline` ({@link withDeadline}), so
   * nothing but the one request in flight runs past it.
   */
  private async metadataOf(
    objectName: string,
    deadline: Deadline | undefined,
  ): Promise<{ size: number; version: string | undefined }> {
    const [meta] = await retryDownload(
      () => withDeadline(() => this.downloadable(objectName).getMetadata(), deadline),
      deadline,
    );
    const size = Number(meta.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ValidationError(`GCS returned an invalid object size: ${String(meta.size)}`);
    }
    return {
      size,
      version: objectGeneration(
        meta.generation === undefined ? undefined : String(meta.generation),
      ),
    };
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

  async delete(key: GenKey, options?: StorageDeleteOptions): Promise<void> {
    const objectName = storageObjectKey(this.prefix, key);
    const ifVersion = checkDeleteOptions(options);
    const conditional = ifVersion !== undefined && this.conditionalDelete;
    // Idempotent: a racing/retried GC sweep of an absent object is a no-op. Not the SDK's `ignoreNotFound`, which takes
    // every 404 and so would report a delete in a missing bucket as done.
    try {
      await this.file(objectName).delete(
        ...(conditional ? [{ ifGenerationMatch: generationOf(ifVersion, key) }] : []),
      );
    } catch (err) {
      if (isNotFound(err)) return this.presence.confirm();
      // A failed precondition is a conflict only while an object is under the name: a service may answer it for a name
      // with nothing there, a copy of this delete that landed first included.
      if (conditional && isPreconditionFailed(err)) {
        if (!(await this.exists(objectName))) return;
        throw new WriteConflictError(
          `generation ${key.segment}.${key.generation} is another object than the version given; not deleted`,
        );
      }
      throw this.mapError(err);
    }
  }

  /** Whether an object is under the name, from its metadata. A read that fails in any other way throws. */
  private async exists(objectName: string): Promise<boolean> {
    try {
      await this.downloadable(objectName).getMetadata();
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        await this.presence.confirm();
        return false;
      }
      throw this.mapError(scrubCredentials(err));
    }
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const prefix = segmentObjectPrefix(this.prefix, ref); // validates ref
    let files;
    try {
      // autoPaginate (default) drains every page; a segment has few generations, so the set is small.
      [files] = await this.storage.bucket(this.bucket).getFiles({ prefix });
    } catch (err) {
      // A listing names no object, so its 404 can only be the bucket's.
      if (isNotFound(err)) throw missingBucketError(this.bucket, scrubCredentials(err));
      throw this.mapError(err);
    }
    for (const f of files) {
      const generation = parseGenerationFromKey(prefix, f.name);
      if (generation !== null) {
        yield { namespace: ref.namespace, segment: ref.segment, generation };
      }
    }
  }

  /** A read's error, once a 404 is known to be the object's and not the bucket's ({@link BucketPresence}). */
  private async readFailure(err: unknown, key: GenKey): Promise<unknown> {
    if (isNotFound(err)) await this.presence.confirm();
    return this.mapReadError(err, key);
  }

  /** Map GCS read errors to the driver vocabulary; pass everything else through {@link mapError}. */
  private mapReadError(err: unknown, key: GenKey): unknown {
    err = scrubCredentials(err);
    if (errorKind(err) === 'ValidationError') return err;
    if (isNotFound(err))
      return new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
    // A fully out-of-range request (start past EOF) — the BlobReader contract treats range errors as
    // ValidationError, never a short/empty read.
    if (isInvalidRange(err)) {
      return new ValidationError(`range out of bounds for ${key.segment}.${key.generation}`);
    }
    // Timed out on every attempt: transient, in words that name the read and the timeout.
    if (err instanceof ReadTimedOut) return new TransientError(err.message, { cause: err });
    // A connection that failed or was cut off, after the driver's retries, is transient whichever code Node gave it:
    // `isTransient` takes every transport fault.
    return this.mapError(err);
  }

  /**
   * Reclassify a transient GCS fault (throttle/5xx/dropped connection) as a retryable {@link TransientError}, so the
   * store's read retry can ride it out and a write's caller can tell it from a deterministic failure, and a missing
   * bucket as a `ValidationError` that names it; everything else propagates unchanged. The final fallback at every
   * client-call site: an HTTP status and a fault in transit arrive typed, and anything else (a checksum mismatch, a
   * credentials failure) as the SDK raised it.
   */
  private mapError(err: unknown): unknown {
    const scrubbed = asMissingBucket(scrubCredentials(err), this.bucket);
    return toTransient(scrubbed, isTransient, transientFaultMessage);
  }
}

type GcsFile = ReturnType<ReturnType<Storage['bucket']>['file']>;

/** A tail read, with the version it was read at when there is one. */
function withVersion(
  tail: { bytes: Uint8Array; size: number },
  version: string | undefined,
): TailRead {
  return version === undefined ? tail : { ...tail, version };
}

/**
 * An object generation as GCS spells it, a positive decimal integer, or `undefined` for anything else: the version a
 * delete is conditioned on goes back to the service as a number, so one that does not parse as one is never reported.
 */
function objectGeneration(value: string | undefined): string | undefined {
  return value !== undefined && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? value
    : undefined;
}

/** The generation `ifGenerationMatch` takes, from a version this driver reported; any other is refused. */
function generationOf(version: string, key: GenKey): number {
  if (objectGeneration(version) === undefined) {
    throw new ValidationError(
      `ifVersion for ${key.segment}.${key.generation} is not a GCS object generation: ${version}`,
    );
  }
  return Number(version);
}

/**
 * {@link BlobSink} that uploads one GCS object write-once. It **buffers up to a threshold**: an object that
 * finishes at/under it is committed in a **single simple (non-resumable) request** ({@link saveOnce}) — the write-once
 * path both real GCS and `fake-gcs-server` enforce; a larger one switches to a **resumable stream**, flushing the
 * buffer then piping the rest in constant memory (peak ≈ one threshold). SHA-256 is hashed incrementally. Both
 * paths carry `ifGenerationMatch: 0` (create-only-if-absent) → a conflict is a 412, mapped by the driver to
 * {@link WriteConflictError}. On error the caller invokes {@link abort}.
 *
 * **The simple upload is sent with no SDK retry** ({@link saveOnce}): a replay of one that landed and lost its response
 * would find its own object and read as a lost race, so a lost response or a timeout throws {@link TransientError}. A
 * `429` or `503` is the one answer it is sent again after, by {@link sendSimple}. The resumable upload is a session of
 * requests, which the SDK retries within by asking the session how much it holds; the SDK takes that retry from the
 * client's options, not the call's, so it stays on. Each upload, of either kind, tags its object with a random id in
 * custom metadata, and a `412` that may be the upload meeting itself is read back: an object that carries this
 * upload's id is a success, and any other is the lost race. The read is paid only on that `412`.
 */
class GcsUploadSink implements BlobSink {
  private readonly hash: Hash = createHash('sha256');
  private total = 0;
  private readonly buffered: Uint8Array[] = [];
  private bufferedLen = 0;
  private stream: Writable | undefined; // set once we cross the threshold → resumable mode
  /** The SDK's resumable upload under {@link stream}, which {@link abort} ends with an error: see there. */
  private upload: Writable | undefined;
  /** Set by {@link abort}: the held upload starts no request from then on. */
  private abandoned = false;
  private done: Promise<unknown[]> | undefined;
  private failure: unknown;

  constructor(
    private readonly file: GcsFile,
    private readonly maxObjectBytes: number,
    private readonly threshold: number,
    private readonly clock: Sleeper,
    private readonly rng: Rng,
  ) {}

  private static readonly WRITE_OPTS = {
    preconditionOpts: { ifGenerationMatch: 0 as const }, // write-once: create only if absent
    metadata: { contentType: 'application/octet-stream' },
  };

  /**
   * This write's own id, stored in the object's custom metadata (outside the `.crbm` bytes) so a conflict can be told
   * from a replay of this same write: the resumable session's, or the simple upload's re-send after a throttle.
   */
  private readonly writeId = randomBytes(16).toString('hex');

  /** The upload options with this write's id in the object's custom metadata. */
  private tagged(): typeof GcsUploadSink.WRITE_OPTS & {
    metadata: { metadata: Record<string, string> };
  } {
    return {
      ...GcsUploadSink.WRITE_OPTS,
      metadata: {
        ...GcsUploadSink.WRITE_OPTS.metadata,
        metadata: { [WRITE_ID_KEY]: this.writeId },
      },
    };
  }

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
      // A copy, here and below: the caller may reuse its buffer once this write resolves, and the stream or the
      // buffered upload still holds what it was given.
      if (!this.stream.write(Buffer.from(bytes))) await once(this.stream, 'drain');
      return;
    }
    this.buffered.push(new Uint8Array(bytes));
    this.bufferedLen += bytes.length;
    if (this.bufferedLen > this.threshold) this.startResumable();
  }

  /** Cross into resumable streaming: open the stream, flush the buffered bytes, keep only ~one threshold resident. */
  private startResumable(): void {
    this.holdUpload();
    const stream = this.file.createWriteStream({ resumable: true, ...this.tagged() });
    this.stream = stream;
    this.done = once(stream, 'finish'); // resolves on a clean commit; rejects on 'error' (e.g. 412)
    stream.on('error', (e: unknown) => {
      this.failure ??= e; // a persistent listener so a stray 'error' is never an unhandled 'error' event
    });
    this.done.catch(() => undefined); // finish() awaits this; guard against unhandled rejection until then
    const buf = concatBytes(this.buffered);
    this.buffered.length = 0;
    this.bufferedLen = 0;
    stream.write(buf); // ≤ threshold+one-chunk; backpressure is absorbed by the next write()'s drain-await / end()
  }

  async finish(): Promise<{ size: number; sha256: string }> {
    const sha256 = this.hash.digest('hex');
    if (this.stream === undefined) {
      // Small object: one simple (non-resumable) upload — write-once enforced everywhere, the emulator too.
      await this.sendSimple(concatBytes(this.buffered));
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

  /**
   * Send the simple upload once, and again after a `429` or `503`, up to {@link THROTTLE_RESENDS} times, waiting a
   * full-jitter backoff before each. Any other failure is thrown at once. Once it has been sent again, a `412` can be
   * an earlier send that landed after all, so the object's write id decides: this write's own is a success, and any
   * other object, or one with no id, is the conflict. A failed read-back throws, and is neither. Exhausted, it throws
   * {@link TransientError}; nothing is deleted.
   */
  private async sendSimple(body: Uint8Array): Promise<void> {
    for (let resent = 0; ; resent++) {
      try {
        await saveOnce(this.file, body, this.tagged());
        return;
      } catch (err) {
        if (resent > 0 && isPreconditionFailed(err)) {
          if ((await this.storedWriteId()) === this.writeId) return;
          throw err;
        }
        if (!isThrottle(err)) throw err;
        if (resent >= THROTTLE_RESENDS) {
          throw new TransientError(
            `GCS upload was throttled on each of its ${resent + 1} sends; the object may or may not exist`,
            { cause: err },
          );
        }
        await this.clock.sleep(Math.floor(this.rng.next() * THROTTLE_BASE_DELAY_MS * 2 ** resent));
      }
    }
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

  /**
   * Keep the SDK's resumable upload, the writable its write stream pipes into, so {@link abort} can end its request.
   * The SDK hands it to the stream's duplex through `setWritable` in `startResumableUpload_`, a method of the `File`
   * its types declare; this wraps that method on this sink's own `File`, which no other write shares. Where the method
   * or the duplex's `setWritable` is missing, the SDK runs unchanged, nothing is kept, and an abort destroys the
   * stream alone, as it did before.
   */
  private holdUpload(): void {
    type Duplex = { setWritable?: (writable: Writable) => void };
    const file = this.file as unknown as {
      startResumableUpload_?: (dup: Duplex, options?: unknown) => void;
    };
    const start = file.startResumableUpload_;
    if (typeof start !== 'function') return;
    file.startResumableUpload_ = (dup, options) => {
      const setWritable = dup.setWritable;
      if (typeof setWritable === 'function') {
        dup.setWritable = (writable) => {
          this.hold(writable);
          setWritable.call(dup, writable);
        };
      }
      start.call(file, dup, options);
    };
  }

  /**
   * Keep `upload`, and let it start no request once this sink is abandoned. The SDK registers the listener that
   * aborts an upload's request only as that request starts, after the session is created, so an upload abandoned
   * before then would start its request anyway, with nothing left to end it. Each request that sends the upload's
   * bytes, its first and every retry, begins in `startUploading`, a public method of the SDK's `Upload`. On an
   * abandoned upload it resolves at once: the upload is destroyed already, and some of the SDK's callers do not
   * catch a rejection.
   */
  private hold(upload: Writable): void {
    this.upload = upload;
    const held = upload as Writable & { startUploading?: () => Promise<void> };
    const startUploading = held.startUploading;
    if (typeof startUploading !== 'function') return;
    held.startUploading = () => (this.abandoned ? Promise.resolve() : startUploading.call(held));
  }

  /**
   * End an upload that will not be committed. Destroying the write stream alone leaves the resumable upload's request
   * open: the SDK destroys its upload with no error, aborts the request only when the upload errors, and its request
   * body waits for bytes that never come, so the socket stays open and the process alive until the service drops the
   * connection. So the upload is destroyed with an error first, which aborts its request; the body was never ended, so
   * no object is finalized. An upload whose request has not started yet starts none: see {@link hold}. The error is
   * the sink's own and reaches no caller.
   */
  async abort(): Promise<void> {
    this.abandoned = true;
    const abandoned = new Error('the upload was abandoned before its object was committed');
    if (this.upload !== undefined && !this.upload.destroyed) this.upload.destroy(abandoned);
    if (this.stream !== undefined && !this.stream.destroyed) this.stream.destroy(abandoned);
  }
}
