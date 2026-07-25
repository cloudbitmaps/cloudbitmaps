/**
 * `S3ColdDriver` — an {@link IColdDriver} over S3-compatible object storage (Phase 3c).
 *
 * Works with AWS S3 and any compatible backend (MinIO, etc.) via the official `@aws-sdk/client-s3`, which
 * is an **optional peer dependency** — only consumers of `cloud-roaring/s3` install it. The client is
 * **injected** (dependency injection): the driver owns no credential/region/endpoint logic, so it's thin,
 * testable against MinIO (point a client at its endpoint), and reuses the caller's existing client.
 *
 * Generations are write-once immutable objects: a conditional `PutObject` with `If-None-Match: *` makes the
 * publish atomic — a second write to the same key fails with `WriteConflictError`, never a silent overwrite
 * (C13), the cloud analogue of the LocalFs atomic `link`. **This requires a backend that honors
 * `If-None-Match: *`** (AWS S3 — GA Aug 2024; recent MinIO): a backend that silently ignored the
 * precondition would break write-once immutability. **Writes stream (Phase 4f):** the object is uploaded in
 * constant memory — a small object is a single conditional `PutObject`; a large one is a **multipart upload**
 * (parts flushed as the codec writes, freed as they go) finished with a conditional `CompleteMultipartUpload`,
 * so the daemon's footprint stays ~one part regardless of segment size, up to the advertised `maxObjectBytes`
 * (default `partBytes × 10,000` — S3's per-upload part limit). Drivers may use `node:crypto`; only `core/`
 * is bound by the determinism lint.
 */
import { createHash, type Hash } from 'node:crypto';
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
  coldObjectKey,
  normalizeS3Prefix,
  parseGenerationFromKey,
  segmentObjectPrefix,
} from './keys';
import {
  isConditionalConflict,
  isInvalidRange,
  isNotFound,
  isTransient,
  totalFromContentRange,
} from './s3-errors';

/** Part size for multipart uploads. ≥ the S3 5 MiB minimum; an object that fits in one part uses a single
 * conditional PUT instead (no multipart overhead, strongest write-once). Peak write memory ≈ one part. */
const S3_PART_BYTES = 8 * 1024 * 1024;
/** S3 hard limit: a multipart upload has at most 10,000 parts. This × the part size is the real object ceiling. */
const S3_MAX_PARTS = 10_000;

export interface S3ColdDriverOptions {
  /** A constructed S3 client (point its `endpoint` at MinIO for local/integration use). */
  readonly client: S3Client;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which all objects live (e.g. `cloudroaring/`). */
  readonly prefix?: string;
  /**
   * Largest object this driver will write/advertise. Default = `partBytes × 10,000` (≈ 80 GiB at the default
   * 8 MiB part) — the honest ceiling reachable within S3's 10,000-part limit. Set it higher and `partBytes`
   * auto-grows so 10,000 parts still cover it (raising peak write memory to ~one part); up to the 5 TiB S3 max.
   */
  readonly maxObjectBytes?: number;
  /** Multipart part size in bytes (default 8 MiB; clamped to the S3 5 MiB minimum). Tunes peak write memory. */
  readonly partBytes?: number;
}

export class S3ColdDriver implements IColdDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly partBytes: number;

  constructor(options: S3ColdDriverOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = normalizeS3Prefix(options.prefix);
    const requestedPart = Math.max(options.partBytes ?? S3_PART_BYTES, 5 * 1024 * 1024);
    // Default the object cap to what the requested part size can actually cover within S3's 10,000-part limit;
    // if a larger cap is requested, grow the part size to keep it reachable (so the advertised cap is honest).
    this.maxObjectBytes = options.maxObjectBytes ?? requestedPart * S3_MAX_PARTS;
    this.partBytes = Math.max(requestedPart, Math.ceil(this.maxObjectBytes / S3_MAX_PARTS));
  }

  capabilities(): ColdCaps {
    return { rangeRead: true, maxObjectBytes: this.maxObjectBytes, conditionalPut: true };
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectKey = coldObjectKey(this.prefix, key); // validates ref + generation
    const sink = new S3MultipartSink(
      this.client,
      this.bucket,
      objectKey,
      this.partBytes,
      this.maxObjectBytes,
    );
    try {
      await write(sink);
      return await sink.finish();
    } catch (err) {
      await sink.abort(); // best-effort cleanup of any in-flight multipart upload
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
    const objectKey = coldObjectKey(this.prefix, key);
    if (length === 0) return new Uint8Array(0);
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: `bytes=${offset}-${offset + length - 1}`,
        }),
      );
      const bytes = await collect(res.Body);
      // A short read means the range ran past EOF — treat as out-of-bounds, never a partial result.
      if (bytes.length !== length) {
        throw new ValidationError(
          `range [${offset}, ${offset + length}) out of bounds (got ${bytes.length}B)`,
        );
      }
      return bytes;
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const objectKey = coldObjectKey(this.prefix, key);
    if (maxBytes <= 0) {
      // No tail bytes wanted — just resolve the size via a HEAD.
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        );
        return { bytes: new Uint8Array(0), size: head.ContentLength ?? 0 };
      } catch (err) {
        throw this.mapReadError(err, key);
      }
    }
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey, Range: `bytes=-${maxBytes}` }),
      );
      const bytes = await collect(res.Body);
      let size = totalFromContentRange(res.ContentRange);
      if (size === undefined) {
        // A spec-compliant backend omits Content-Range only on a 200 (whole object), where bytes.length
        // IS the size. If the body is exactly maxBytes we can't rule out a clamped partial from a
        // non-compliant backend — confirm the true size with a HEAD rather than trust a possibly-short read.
        if (bytes.length === maxBytes) {
          const head = await this.client.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
          );
          size = head.ContentLength ?? bytes.length;
        } else {
          size = bytes.length;
        }
      }
      return { bytes, size };
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: S3 DeleteObject succeeds even if the key is absent (GC may race / retry).
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: coldObjectKey(this.prefix, key) }),
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
      token = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  /** Map S3 read errors to the driver vocabulary; pass everything else through {@link mapError}. */
  private mapReadError(err: unknown, key: GenKey): unknown {
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
   * Reclassify a transient S3 fault (throttle/5xx/dropped connection) as a retryable {@link TransientError}
   * so the retry decorator can ride it out; everything else propagates unchanged. The final fallback at every
   * `client.send` site, so callers and the decorator only ever see typed errors.
   */
  private mapError(err: unknown): unknown {
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
 * Streaming {@link BlobSink} that uploads one S3 object in **constant memory** (Phase 4f). It buffers at most
 * one part: as the codec writes, full parts are flushed via `UploadPart` and freed. A small object that never
 * reaches one part is committed as a single conditional `PutObject`; a larger one is finished with a
 * conditional `CompleteMultipartUpload` — **both enforce write-once** via `If-None-Match: *`. SHA-256 is hashed
 * incrementally. On any error the caller invokes {@link abort} to clean up the in-flight multipart upload.
 */
class S3MultipartSink implements BlobSink {
  private readonly hash: Hash = createHash('sha256');
  private readonly pending: Uint8Array[] = [];
  private pendingLen = 0;
  private total = 0;
  private uploadId: string | undefined;
  private partNumber = 0;
  private readonly parts: { ETag: string | undefined; PartNumber: number }[] = [];

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly objectKey: string,
    private readonly partBytes: number,
    private readonly maxObjectBytes: number,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.total += bytes.length;
    if (this.total > this.maxObjectBytes) {
      // Fail fast + typed, rather than a late opaque S3 error (and abort the in-flight upload via the caller).
      throw new ValidationError(`object exceeds maxObjectBytes ${this.maxObjectBytes}`);
    }
    this.hash.update(bytes);
    this.pending.push(bytes);
    this.pendingLen += bytes.length;
    if (this.pendingLen >= this.partBytes) await this.flushPart();
  }

  /** Upload the buffered bytes (≥ one part) as a single part, freeing them. Starts the upload on first call. */
  private async flushPart(): Promise<void> {
    if (this.uploadId === undefined) {
      const res = await this.client.send(
        new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: this.objectKey }),
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
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey,
          Body: concatBytes(this.pending, this.pendingLen),
          IfNoneMatch: '*', // write-once
        }),
      );
      return { size: this.total, sha256 };
    }
    if (this.pendingLen > 0) await this.flushPart(); // the final part may be < partBytes (allowed)
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.objectKey,
        UploadId: this.uploadId,
        MultipartUpload: { Parts: this.parts },
        IfNoneMatch: '*', // write-once: fail if the object already exists
      }),
    );
    this.uploadId = undefined; // completed — nothing left to abort
    return { size: this.total, sha256 };
  }

  /** Best-effort cleanup of an in-flight multipart upload after an error (a leaked MPU is reaped by a bucket
   * lifecycle rule; never a correctness issue). No-op if nothing was started or it already completed. */
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

/**
 * Collect an S3 response body into a `Uint8Array`. `transformToByteArray` is added at runtime to the SDK's
 * Node stream by `@aws-sdk`'s sdk-stream-mixin, so the structural cast is sound on Node.
 */
async function collect(body: GetObjectCommandBody): Promise<Uint8Array> {
  if (body === undefined) {
    throw new NotFoundError('S3 GetObject returned an empty body');
  }
  return body.transformToByteArray();
}

/** The S3 `GetObject` Body type, narrowed to the part we use (`transformToByteArray`). */
type GetObjectCommandBody = { transformToByteArray(): Promise<Uint8Array> } | undefined;
