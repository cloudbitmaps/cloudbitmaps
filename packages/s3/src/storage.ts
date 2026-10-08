/**
 * `S3StorageDriver` — an {@link IStorageDriver} over S3-compatible object storage.
 *
 * Works with AWS S3 and any compatible backend (MinIO, etc.) via the official `@aws-sdk/client-s3`, a real
 * dependency of this package — installing `@cloudbitmaps/s3` is what installs it. The client is
 * **injected** (dependency injection): the driver owns no credential/region/endpoint logic, so it's thin,
 * testable against MinIO (point a client at its endpoint), and reuses the caller's existing client.
 *
 * Generations are write-once immutable objects: a conditional `PutObject` with `If-None-Match: *` makes the
 * publish atomic — a second write to the same key fails with `WriteConflictError`, never a silent overwrite
 * (hard invariant 2: storage objects are immutable and never overwritten in place), the cloud analogue of
 * the LocalFs atomic `link`. **This requires a backend that honors
 * `If-None-Match: *`** (AWS S3 — GA Aug 2024; recent MinIO): a backend that silently ignored the
 * precondition would break write-once immutability. **Writes stream:** the object is uploaded in
 * constant memory — a small object is a single conditional `PutObject`; a large one is a **multipart upload**
 * (parts flushed as the codec writes, freed as they go) finished with a conditional `CompleteMultipartUpload`,
 * so a load's footprint stays ~one part regardless of segment size, up to the advertised `maxObjectBytes`
 * (default `partBytes × 10,000` — S3's per-upload part limit). **Each conditional request is sent with the SDK's retry
 * off for it** ({@link sendOnce}): a replay of a write that landed and lost its response would find its own object and
 * read as a lost race. A lost response or a timeout throws {@link TransientError}, and the object may or may not exist.
 * A `503 SlowDown` is the one answer the driver sends the commit again after, at most {@link THROTTLE_RESENDS} times with
 * backoff: every object carries a random write id in its user metadata (`x-amz-meta-cbwid`), and once the commit has
 * been sent again, a precondition failure reads the object's metadata back, so a first send that landed after all is
 * this write's own and any other object is the conflict it reads as. The unconditional requests — the reads, the
 * delete, and a multipart upload's own start, parts and abort —
 * keep the SDK's retry. **Each read can be timed** ({@link timedRead}): with `readTimeoutMs` set, a `GetObject` or
 * `HeadObject` that has not finished, body included, after it throws {@link TransientError}. It is off by default, and
 * nothing else is timed. Drivers may use `node:crypto`; only `core/` is bound by the determinism lint.
 */
import {
  IntegrityError,
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
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  storageObjectKey,
  normalizeS3Prefix,
  parseGenerationFromKey,
  segmentObjectPrefix,
} from './keys';
import {
  isConditionalConflict,
  isInvalidRange,
  isNoSuchUpload,
  isNotFound,
  spanFromContentRange,
  isPreconditionFailed,
  isThrottle,
  isTransient,
  totalFromContentRange,
} from './s3-errors';
import { resolveReadTimeoutMs, timedRead, type ReadSendOptions } from './read-timeout';
import type { SocketAdvisory } from './socket-advisory';
import { sendOnce } from './send-once';
import { readBounded } from './bounded-body';
import { scrubCredentials } from './scrub-error';

/** Part size for multipart uploads. ≥ the S3 5 MiB minimum; an object that fits in one part uses a single
 * conditional PUT instead (no multipart overhead, strongest write-once). Peak write memory ≈ one part. */
const S3_PART_BYTES = 8 * 1024 * 1024;
/** S3 hard limit: a multipart upload has at most 10,000 parts. This × the part size is the real object ceiling. */
const S3_MAX_PARTS = 10_000;
/** S3 hard limits on one object (5 TiB) and one part (5 GiB). */
const S3_MAX_OBJECT_BYTES = 5 * 1024 ** 4;
const S3_MAX_PART_BYTES = 5 * 1024 ** 3;
/** The user-metadata name an object's write id is stored under (`x-amz-meta-cbwid`). Short: every write sends it. */
const WRITE_ID_KEY = 'cbwid';
/** How many times a throttled commit is sent again: four sends in all, as many as the SDK's own retry makes. */
const THROTTLE_RESENDS = 3;
/** The backoff ceiling before the first re-send, doubling for each one after it: the SDK's own base for a throttle. */
const THROTTLE_BASE_DELAY_MS = 500;

/** What the throttle backoff waits on. */
interface Sleeper {
  sleep(ms: number): Promise<void>;
}

const REAL_TIME: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface S3StorageDriverOptions {
  /** A constructed S3 client (point its `endpoint` at MinIO for local/integration use). */
  readonly client: S3Client;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which all objects live (e.g. `cloudbitmaps/`). */
  readonly prefix?: string;
  /**
   * Largest object this driver will write/advertise. Default = `partBytes × 10,000` (≈ 80 GiB at the default
   * 8 MiB part) — the honest ceiling reachable within S3's 10,000-part limit. Set it higher and `partBytes`
   * auto-grows so 10,000 parts still cover it (raising peak write memory to ~one part); up to the 5 TiB S3 max.
   */
  readonly maxObjectBytes?: number;
  /** Multipart part size in bytes (default 8 MiB; a smaller value is raised to the S3 5 MiB minimum). Must be a
   * positive safe integer. Tunes peak write memory. */
  readonly partBytes?: number;
  /**
   * How long one read — a `GetObject` or `HeadObject`, its body included — may take before it is abandoned and throws
   * `TransientError`, in ms. `0`, the default, sets no timeout. Must be a non-negative safe integer no larger than
   * 2,147,483,647. Writes and listings are not timed.
   *
   * The clock starts when the read is handed to the SDK, so it also counts the time the read waits for one of the
   * client's sockets (128 by default on the client the store builds, 50 on the SDK's own) and the time spent fetching
   * credentials, and under `retryMode: 'adaptive'` the SDK's rate-limiter wait. A burst of concurrent reads larger than
   * the socket pool can therefore time out with nothing slow on the wire: size the timeout above the worst queueing
   * your concurrency implies, or raise `maxSockets` (the store's option, or your own client's). On a client built with
   * `cacheMiddleware: true`, a timed read resolves its middleware each time.
   */
  readonly readTimeoutMs?: number;
  /** The socket-pool check, run as each read finishes; absent for a driver built on its own. */
  readonly sockets?: SocketAdvisory;
  /** What the backoff before re-sending a throttled commit waits on; real time when absent. */
  readonly clock?: Sleeper;
}

export class S3StorageDriver implements IStorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly partBytes: number;
  private readonly readTimeoutMs: number;
  private readonly clock: Sleeper;
  private readonly sockets: SocketAdvisory | undefined;

  constructor(options: S3StorageDriverOptions) {
    this.client = options.client;
    this.sockets = options.sockets;
    this.bucket = options.bucket;
    this.prefix = normalizeS3Prefix(options.prefix);
    this.clock = options.clock ?? REAL_TIME;
    // Fail fast at the boundary: `??` only guards `undefined`, so NaN, 0, a negative or a fraction would otherwise
    // reach the arithmetic below and size every part (and the advertised cap) from garbage.
    for (const [name, value] of [
      ['partBytes', options.partBytes],
      ['maxObjectBytes', options.maxObjectBytes],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new ValidationError(`${name} must be a positive safe integer; got ${value}`);
      }
    }
    // Past S3's own limits a cap is not reachable: the part grown to cover it would pass the part limit, an object up
    // to that size would be held in memory whole, and one PutObject of it would be refused.
    if (options.maxObjectBytes !== undefined && options.maxObjectBytes > S3_MAX_OBJECT_BYTES) {
      throw new ValidationError(
        `maxObjectBytes must be at most S3's 5 TiB object limit (${S3_MAX_OBJECT_BYTES}); got ${options.maxObjectBytes}`,
      );
    }
    if (options.partBytes !== undefined && options.partBytes > S3_MAX_PART_BYTES) {
      throw new ValidationError(
        `partBytes must be at most S3's 5 GiB part limit (${S3_MAX_PART_BYTES}); got ${options.partBytes}`,
      );
    }
    const requestedPart = Math.max(options.partBytes ?? S3_PART_BYTES, 5 * 1024 * 1024);
    // Default the object cap to what the requested part size can actually cover within S3's 10,000-part limit;
    // if a larger cap is requested, grow the part size to keep it reachable (so the advertised cap is honest).
    this.maxObjectBytes = options.maxObjectBytes ?? requestedPart * S3_MAX_PARTS;
    this.partBytes = Math.max(requestedPart, Math.ceil(this.maxObjectBytes / S3_MAX_PARTS));
    this.readTimeoutMs = resolveReadTimeoutMs(options.readTimeoutMs);
  }

  capabilities(): StorageCaps {
    return { rangeRead: true, maxObjectBytes: this.maxObjectBytes, conditionalPut: true };
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectKey = storageObjectKey(this.prefix, key); // validates ref + generation
    const sink = new S3MultipartSink(
      this.client,
      this.bucket,
      objectKey,
      this.partBytes,
      this.maxObjectBytes,
      this.readTimeoutMs,
      this.clock,
    );
    try {
      await write(sink);
      return await sink.finish();
    } catch (err) {
      // Best-effort cleanup of any in-flight multipart upload, sent after an ambiguous or exhausted completion too.
      // S3 completes an upload atomically, so the abort never tears an object: a completion that had landed survives
      // it (the abort then answers NoSuchUpload, which is swallowed), and one that had not is cancelled and its parts
      // are reclaimed. No object is deleted here, and one that survives is the load's orphan above the pointer.
      await sink.abort();
      // A lost conditional-write race — the precondition failed (412) or S3 rejected concurrent conditional
      // writes to the key (409) — is the write-once conflict, never a silent overwrite.
      if (isConditionalConflict(err)) {
        throw new WriteConflictError(
          `generation already exists (write-once): ${key.segment}.${key.generation}`,
        );
      }
      if (isValidationError(err) || isWriteConflictError(err) || isNotFoundError(err)) {
        throw err;
      }
      throw this.mapError(err);
    }
  }

  async getRange(key: GenKey, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new ValidationError(`invalid range offset=${offset} length=${length}`);
    }
    const objectKey = storageObjectKey(this.prefix, key);
    if (length === 0) return new Uint8Array(0);
    return this.read('GetObject', key, async (options) => {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: `bytes=${offset}-${offset + length - 1}`,
        }),
        options,
      );
      const bytes = await readBounded(
        res.Body,
        length,
        () => this.badRead(key, 'range', `the response is longer than the ${length}B requested`),
        res.ContentLength,
      );
      // A short read means the range ran past EOF — treat as out-of-bounds, never a partial result.
      if (bytes.length !== length) {
        throw new ValidationError(
          `range [${offset}, ${offset + length}) out of bounds (got ${bytes.length}B)`,
        );
      }
      // The bytes must be the ones asked for, not as many from elsewhere: a range answer names its span, and one
      // without it (a 200, the whole object) is the range only when the range starts at 0.
      const span = spanFromContentRange(res.ContentRange);
      const wanted =
        span === undefined
          ? offset === 0
          : span.start === offset && span.end === offset + length - 1;
      if (!wanted) {
        throw this.badRead(
          key,
          'range',
          `the response holds ${res.ContentRange === undefined ? 'the object from its start' : `bytes ${res.ContentRange}`}, not [${offset}, ${offset + length})`,
        );
      }
      return bytes;
    });
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const objectKey = storageObjectKey(this.prefix, key);
    if (maxBytes <= 0) {
      // No tail bytes wanted — just resolve the size via a HEAD.
      return { bytes: new Uint8Array(0), size: (await this.headSize(key, objectKey)) ?? 0 };
    }
    const read = await this.read('GetObject', key, async (options) => {
      try {
        const res = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            Range: `bytes=-${maxBytes}`,
          }),
          options,
        );
        const bytes = await readBounded(
          res.Body,
          maxBytes,
          () => this.badRead(key, 'tail', `the response is longer than the ${maxBytes}B requested`),
          res.ContentLength,
        );
        return { bytes, contentRange: res.ContentRange };
      } catch (err) {
        // A zero-byte object has no suffix to satisfy, so S3 refuses the range with a 416. The HEAD below settles
        // whether that is an empty object or a real range fault.
        if (isInvalidRange(err)) return { refused: err };
        throw err;
      }
    });
    if ('refused' in read) {
      if ((await this.headSize(key, objectKey)) !== 0) throw this.mapReadError(read.refused, key);
      return { bytes: new Uint8Array(0), size: 0 };
    }
    const { bytes, contentRange } = read;
    let size = totalFromContentRange(contentRange);
    if (size === undefined) {
      // A spec-compliant backend omits Content-Range only on a 200 (whole object), where bytes.length
      // IS the size. If the body is exactly maxBytes we can't rule out a clamped partial from a
      // non-compliant backend — confirm the true size with a HEAD rather than trust a possibly-short read.
      size =
        bytes.length === maxBytes
          ? ((await this.headSize(key, objectKey)) ?? bytes.length)
          : bytes.length;
    }
    return { bytes, size };
  }

  private badRead(key: GenKey, what: 'range' | 'tail', why: string): ValidationError {
    return new ValidationError(
      `S3 ${what} read of ${key.segment}.${key.generation} refused: ${why}`,
    );
  }

  /** The object's size from a `HeadObject`, or `undefined` when the response does not carry one. */
  private headSize(key: GenKey, objectKey: string): Promise<number | undefined> {
    return this.read('HeadObject', key, async (options) => {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        options,
      );
      return head.ContentLength;
    });
  }

  /**
   * One read request under the read timeout, its failures mapped to the driver vocabulary. The timeout's own
   * `TransientError` is raised outside the mapping, so it reaches the caller as it is.
   */
  private read<T>(
    operation: 'GetObject' | 'HeadObject',
    key: GenKey,
    run: (options: ReadSendOptions) => Promise<T>,
  ): Promise<T> {
    return timedRead(operation, this.readTimeoutMs, async (options) => {
      try {
        return await run(options);
      } catch (err) {
        throw this.mapReadError(err, key);
      } finally {
        this.sockets?.afterRequest();
      }
    });
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: S3 DeleteObject succeeds even if the key is absent (GC may race / retry).
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageObjectKey(this.prefix, key) }),
      );
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const prefix = segmentObjectPrefix(this.prefix, ref); // validates ref
    let token: string | undefined;
    do {
      let res;
      try {
        res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
      } catch (err) {
        throw this.mapError(err);
      }
      for (const obj of res.Contents ?? []) {
        if (obj.Key === undefined) continue;
        const generation = parseGenerationFromKey(prefix, obj.Key);
        if (generation !== null) {
          yield { namespace: ref.namespace, segment: ref.segment, generation };
        }
      }
      // A page that says more follow and gives no way to ask for them would end the listing short, silently.
      if (res.IsTruncated === true && res.NextContinuationToken === undefined) {
        throw new IntegrityError('S3 listing says it is truncated but gives no continuation token');
      }
      token = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /** Map S3 read errors to the driver vocabulary; pass everything else through {@link mapError}. */
  private mapReadError(err: unknown, key: GenKey): unknown {
    err = scrubCredentials(err);
    if (isValidationError(err)) return err;
    if (isNotFound(err)) {
      return new NotFoundError(`no such generation: ${key.segment}.${key.generation}`);
    }
    // A fully out-of-range request (start past EOF) — the BlobReader contract treats range errors as
    // ValidationError, never a short/empty read.
    if (isInvalidRange(err)) {
      return new ValidationError(`range out of bounds for ${key.segment}.${key.generation}`);
    }
    return this.mapError(err);
  }

  /**
   * Reclassify a transient S3 fault (throttle/5xx/dropped connection) as a retryable {@link TransientError},
   * so the store's read retry can ride it out and a write's caller can tell it from a deterministic failure;
   * everything else propagates unchanged. The final fallback at every `client.send` site, so callers and the
   * read retry only ever see typed errors.
   */
  private mapError(err: unknown): unknown {
    err = scrubCredentials(err);
    if (isTransient(err)) {
      return new TransientError(
        `transient S3 fault: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}

/** Concatenate a list of byte chunks of known total length into one buffer. */
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
 * Streaming {@link BlobSink} that uploads one S3 object in **constant memory**. It buffers at most
 * one part: as the codec writes, full parts are flushed via `UploadPart` and freed. A small object that never
 * reaches one part is committed as a single conditional `PutObject`; a larger one is finished with a
 * conditional `CompleteMultipartUpload` — **both enforce write-once** via `If-None-Match: *`, and both are sent
 * with the SDK's retry off, again only after a throttle ({@link commit}). SHA-256 is hashed incrementally. On any error
 * the caller invokes {@link abort} to clean up the in-flight multipart upload.
 */
class S3MultipartSink implements BlobSink {
  private readonly hash: Hash = createHash('sha256');
  private readonly pending: Uint8Array[] = [];
  private pendingLen = 0;
  private total = 0;
  private uploadId: string | undefined;
  private partNumber = 0;
  private readonly parts: { ETag: string | undefined; PartNumber: number }[] = [];
  /** This write's own id, stored in the object's user metadata, outside the `.crbm` bytes: see {@link commit}. */
  private readonly writeId = randomBytes(16).toString('hex');

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly objectKey: string,
    private readonly partBytes: number,
    private readonly maxObjectBytes: number,
    private readonly readTimeoutMs: number,
    private readonly clock: Sleeper,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.total += bytes.length;
    if (this.total > this.maxObjectBytes) {
      // Fail fast + typed, rather than a late opaque S3 error (and abort the in-flight upload via the caller).
      throw new ValidationError(`object exceeds maxObjectBytes ${this.maxObjectBytes}`);
    }
    this.hash.update(bytes);
    // A copy: the caller may reuse its buffer once this write resolves, and the part is sent later.
    this.pending.push(new Uint8Array(bytes));
    this.pendingLen += bytes.length;
    if (this.pendingLen >= this.partBytes) await this.flushPart();
  }

  /** Upload the buffered bytes (≥ one part) as a single part, freeing them. Starts the upload on first call. */
  private async flushPart(): Promise<void> {
    if (this.uploadId === undefined) {
      const res = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.objectKey,
          Metadata: { [WRITE_ID_KEY]: this.writeId }, // stored on the object the completion makes
        }),
      );
      if (res.UploadId === undefined) {
        throw new TransientError('S3 CreateMultipartUpload returned no UploadId');
      }
      this.uploadId = res.UploadId;
    }
    const body = concatBytes(this.pending, this.pendingLen);
    this.pending.length = 0;
    this.pendingLen = 0;
    this.partNumber += 1;
    if (this.partNumber > S3_MAX_PARTS) {
      // Unreachable for valid input (the maxObjectBytes byte-cap, sized to ≤ S3_MAX_PARTS parts, fires first) —
      // a typed guard so the S3 hard limit is never a raw 400.
      throw new ValidationError(`multipart upload exceeded the S3 ${S3_MAX_PARTS}-part limit`);
    }
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.objectKey,
        UploadId: this.uploadId,
        PartNumber: this.partNumber,
        Body: body,
      }),
    );
    this.parts.push({ ETag: res.ETag, PartNumber: this.partNumber });
  }

  /** Commit the object: a single conditional PUT if it fit in one part, else complete the multipart upload. */
  async finish(): Promise<{ size: number; sha256: string }> {
    const sha256 = this.hash.digest('hex');
    if (this.uploadId === undefined) {
      const body = concatBytes(this.pending, this.pendingLen);
      await this.commit('PutObject', () =>
        sendOnce(
          this.client,
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.objectKey,
            Body: body,
            IfNoneMatch: '*', // write-once
            Metadata: { [WRITE_ID_KEY]: this.writeId },
          }),
        ),
      );
      return { size: this.total, sha256 };
    }
    if (this.pendingLen > 0) await this.flushPart(); // the final part may be < partBytes (allowed)
    const uploadId = this.uploadId;
    await this.commit('CompleteMultipartUpload', () =>
      sendOnce(
        this.client,
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.objectKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: this.parts },
          IfNoneMatch: '*', // write-once: fail if the object already exists
        }),
      ),
    );
    this.uploadId = undefined; // completed — nothing left to abort
    return { size: this.total, sha256 };
  }

  /**
   * Send the commit (`send` sends it once, with the SDK's retry off), and again after a throttle, up to
   * {@link THROTTLE_RESENDS} times, waiting a full-jitter backoff before each. Any other failure is thrown at once.
   * Once the commit has been sent again, an answer that can be an earlier send that landed or is still landing (a
   * precondition failure, a concurrent-write conflict, or an upload S3 no longer knows) is settled by reading the
   * object back. The object is never overwritten, so the id it holds says who wrote it:
   *
   * - this write's own id: a success;
   * - another's id, or none (an object an earlier release wrote): the conflict it reads as;
   * - nothing stored: a `412` still reads as the conflict it answered (an object was there, and is gone). A `409`
   *   and an unknown upload are an unknown outcome, since the first send may still be applying: {@link TransientError},
   *   and never a report that nothing was written.
   *
   * A failed read-back throws, and is neither. Exhausted, it throws {@link TransientError}; nothing is deleted.
   */
  private async commit(
    operation: 'PutObject' | 'CompleteMultipartUpload',
    send: () => Promise<unknown>,
  ): Promise<void> {
    for (let resent = 0; ; resent++) {
      try {
        await send();
        return;
      } catch (raw) {
        const err = scrubCredentials(raw);
        if (resent > 0 && (isConditionalConflict(err) || isNoSuchUpload(err))) {
          const stored = await this.storedObject();
          if (stored?.id === this.writeId) return;
          if (stored === undefined && !isPreconditionFailed(err)) {
            throw new TransientError(
              `S3 ${operation}: ${this.objectKey} is not stored, and the first send may still be applying`,
              { cause: err },
            );
          }
          if (isConditionalConflict(err)) throw err;
          throw new WriteConflictError(`generation already exists (write-once): ${this.objectKey}`);
        }
        if (!isThrottle(err)) throw err;
        if (resent >= THROTTLE_RESENDS) {
          throw new TransientError(
            `S3 ${operation} was throttled on each of its ${resent + 1} sends; the object may or may not exist`,
            { cause: err },
          );
        }
        await this.clock.sleep(Math.floor(Math.random() * THROTTLE_BASE_DELAY_MS * 2 ** resent));
      }
    }
  }

  /**
   * The object stored under the key: `undefined` when none is there, otherwise the write id it carries (`id` is
   * `undefined` for an object that carries none). A failed read throws.
   */
  private storedObject(): Promise<{ readonly id: string | undefined } | undefined> {
    return timedRead('HeadObject', this.readTimeoutMs, async (options) => {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey }),
          options,
        );
        return { id: head.Metadata?.[WRITE_ID_KEY] };
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    });
  }

  /** Best-effort cleanup of an in-flight multipart upload after an error (a leaked MPU is reaped by a bucket
   * lifecycle rule; never a correctness issue). No-op if nothing was started or it already completed. It aborts an
   * upload, never an object: a completion that landed survives it. */
  async abort(): Promise<void> {
    if (this.uploadId === undefined) return;
    const id = this.uploadId;
    this.uploadId = undefined;
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.objectKey, UploadId: id }),
      );
    } catch {
      // swallow — best-effort
    }
  }
}
