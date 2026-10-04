/**
 * `AzureBlobStorageDriver` — an {@link IStorageDriver} over Azure Blob Storage.
 *
 * Uses the official `@azure/storage-blob`, a real dependency of this package — installing
 * `@cloudbitmaps/azure-blob` is what installs it. A `ContainerClient` is **injected** (dependency injection): the driver owns
 * no credential/account/endpoint logic, so it's thin, reuses the caller's client, and is testable against the
 * Azurite emulator (point a `ContainerClient` at its connection string). The container must already exist —
 * the Azure analogue of the S3 bucket / GCS bucket. (Unlike the S3/GCS drivers, which inject a top-level
 * client + a `bucket` *name*, Azure's `ContainerClient` is already container-scoped, so there is no separate
 * container-name option — the caller scopes it. This is the idiomatic Azure handle and keeps the driver pure DI.)
 *
 * Generations are write-once immutable blobs: the conditional **`ifNoneMatch: '*'`** ("create only if it does
 * not exist") makes the publish atomic — a second write to the same blob fails with 409 `BlobAlreadyExists` →
 * {@link WriteConflictError}, never a silent overwrite (hard invariant 2: storage objects are immutable and
 * never overwritten in place), the Azure analogue of S3's `If-None-Match: *`, GCS's `ifGenerationMatch: 0`,
 * and LocalFs's atomic `link`. **Empirically verified against Azurite** that the
 * precondition is enforced on BOTH upload paths below. **Writes stream in constant memory**:
 * a small blob is a single conditional `upload`; a larger one is **staged as blocks** (each `stageBlock`
 * flushes and frees ~one block) finished with a conditional `commitBlockList`, so a load's write footprint
 * stays ~one block regardless of segment size, up to the advertised `maxObjectBytes`. Drivers may use
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
import type { ContainerClient } from '@azure/storage-blob';
import {
  storageObjectName,
  normalizeAzurePrefix,
  parseGenerationFromName,
  segmentObjectPrefix,
} from './keys';
import { isConditionalConflict, isInvalidRange, isNotFound, isTransient } from './azure-errors';
import { resolveReadTimeoutMs, timedRead } from './read-timeout';
import { newWriteId, storedWriteId, writeIdMetadata } from './write-id';

/** Flush threshold for staged uploads: the sink buffers until `pending` reaches this, then stages it as one
 * block. A blob that never reaches it is a single conditional `upload` instead (no block-list overhead,
 * strongest write-once). It bounds peak write memory to ≈ one block *given codec-granularity writes* (the
 * `.crbm` codec writes small per-chunk buffers, so a block ≈ this size); a single larger `write()` becomes one
 * larger block. Default 8 MiB (≈ S3's part). */
const AZURE_BLOCK_BYTES = 8 * 1024 * 1024;
/** Azure hard limit: a block blob has at most 50,000 committed blocks. This × the block size is the ceiling. */
const AZURE_MAX_BLOCKS = 50_000;

const OCTET_STREAM = { blobContentType: 'application/octet-stream' } as const;
/** Write-once precondition shared by both upload paths: create only if the blob is absent. */
const IF_ABSENT = { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: OCTET_STREAM } as const;

export interface AzureBlobStorageDriverOptions {
  /** A constructed `@azure/storage-blob` `ContainerClient`, scoped to an existing container (point it at
   * Azurite's connection string for local/integration use). */
  readonly containerClient: ContainerClient;
  /** Optional blob-name prefix under which all objects live (e.g. `cloudbitmaps/`). */
  readonly prefix?: string;
  /**
   * Largest blob this driver will write/advertise. Default = `blockBytes × 50,000` (≈ 400 GiB at the default
   * 8 MiB block) — the honest ceiling reachable within Azure's 50,000-block limit. Set it higher and
   * `blockBytes` auto-grows so 50,000 blocks still cover it (raising peak write memory to ~one block).
   */
  readonly maxObjectBytes?: number;
  /** Staged block size in bytes (default 8 MiB). Tunes peak write memory. */
  readonly blockBytes?: number;
  /**
   * How long each read request may take, in ms, its response body included, before it is aborted and throws
   * `TransientError` for the store's read retry: a range read, and a tail read's properties and its ranged download,
   * each on its own. The clock starts at the call into the SDK, so time waiting for a socket or a credential's token
   * counts. Writes, deletes and listings are not timed. `0`, the default, sets no timeout; an integer from 0 to
   * 2,147,483,647.
   */
  readonly readTimeoutMs?: number;
}

export class AzureBlobStorageDriver implements IStorageDriver {
  private readonly container: ContainerClient;
  private readonly prefix: string | undefined;
  private readonly maxObjectBytes: number;
  private readonly blockBytes: number;
  private readonly readTimeoutMs: number;

  constructor(options: AzureBlobStorageDriverOptions) {
    this.container = options.containerClient;
    this.prefix = normalizeAzurePrefix(options.prefix);
    this.readTimeoutMs = resolveReadTimeoutMs(options.readTimeoutMs);
    // Fail fast at the boundary: nullish-coalescing only guards `undefined`, so an explicit 0 / negative /
    // fractional value would otherwise slip through and silently reject every write (cap) or corrupt the flush
    // threshold (block size).
    const requestedBlock = options.blockBytes ?? AZURE_BLOCK_BYTES;
    if (!Number.isSafeInteger(requestedBlock) || requestedBlock < 1) {
      throw new ValidationError(
        `blockBytes must be a positive safe integer; got ${requestedBlock}`,
      );
    }
    if (
      options.maxObjectBytes !== undefined &&
      (!Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes < 1)
    ) {
      throw new ValidationError(
        `maxObjectBytes must be a positive safe integer; got ${options.maxObjectBytes}`,
      );
    }
    // Default the object cap to what the requested block size can cover within the 50,000-block limit; if a
    // larger cap is requested, grow the block size so the advertised cap stays honest (and reachable).
    this.maxObjectBytes = options.maxObjectBytes ?? requestedBlock * AZURE_MAX_BLOCKS;
    this.blockBytes = Math.max(requestedBlock, Math.ceil(this.maxObjectBytes / AZURE_MAX_BLOCKS));
  }

  capabilities(): StorageCaps {
    return { rangeRead: true, maxObjectBytes: this.maxObjectBytes, conditionalPut: true };
  }

  private blob(name: string) {
    return this.container.getBlockBlobClient(name);
  }

  async putImmutable(
    key: GenKey,
    write: (sink: BlobSink) => Promise<void>,
  ): Promise<{ size: number; sha256: string }> {
    const objectName = storageObjectName(this.prefix, key); // validates ref + generation
    const sink = new AzureBlockBlobSink(
      this.blob(objectName),
      this.blockBytes,
      this.maxObjectBytes,
    );
    try {
      await write(sink);
      return await sink.finish();
    } catch (err) {
      // A lost write-once race — the blob already existed, so `ifNoneMatch: '*'` failed (409). Correctness is
      // safe with no explicit teardown: staged-but-uncommitted blocks are never a visible blob (a reader only
      // ever sees a committed block list). Azure has no "abort block list" API (unlike S3's AbortMultipartUpload
      // / GCS's stream.destroy), so on the staged path they linger as *billed* storage until Azure's uncommitted-
      // block GC reaps them (~7 days). Recommend a container lifecycle rule to auto-delete uncommitted blocks
      // (operational notes); such races are rare (two loads of one segment picking the same generation number
      // at the same moment).
      if (isConditionalConflict(err)) {
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
      return await timedRead('download', this.readTimeoutMs, async (abortSignal) => {
        const res = await this.blob(objectName).download(offset, length, { abortSignal });
        const bytes = await collect(res.readableStreamBody, abortSignal);
        // A short read means the range ran past EOF — treat as out-of-bounds, never a partial result. (Azurite
        // returns a clamped-short body here rather than a 416; a start fully past EOF does 416 → mapReadError.)
        if (bytes.length !== length) {
          throw new ValidationError(
            `range [${offset}, ${offset + length}) out of bounds (got ${bytes.length}B)`,
          );
        }
        return bytes;
      });
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async getTail(key: GenKey, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
    const objectName = storageObjectName(this.prefix, key);
    try {
      // Two round-trips (properties for the size, then a ranged download) vs S3's one (suffix-range +
      // Content-Range). The Blob service takes no suffix range, only `bytes=start-` and `bytes=start-end`, so a
      // tail read needs the size first, and it stays two. This is on the per-*generation* open path, which the
      // reader caches — NOT the per-op cache path (has/count/intersect) — so it's amortized.
      // Each request is timed on its own: the properties, then the ranged download and its body.
      const props = await timedRead('getProperties', this.readTimeoutMs, (abortSignal) =>
        this.blob(objectName).getProperties({ abortSignal }),
      );
      const size = props.contentLength ?? 0;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new ValidationError(`Azure returned an invalid blob size: ${String(size)}`);
      }
      if (maxBytes <= 0 || size === 0) return { bytes: new Uint8Array(0), size };
      const take = Math.min(maxBytes, size);
      const bytes = await timedRead('download', this.readTimeoutMs, async (abortSignal) => {
        const res = await this.blob(objectName).download(size - take, take, { abortSignal });
        return collect(res.readableStreamBody, abortSignal);
      });
      return { bytes, size };
    } catch (err) {
      throw this.mapReadError(err, key);
    }
  }

  async delete(key: GenKey): Promise<void> {
    // Idempotent: `deleteIfExists` is a no-op (no throw) on an absent blob, so a racing/retried GC sweep is safe.
    try {
      await this.blob(storageObjectName(this.prefix, key)).deleteIfExists();
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async *list(ref: SegmentRef): AsyncIterable<GenKey> {
    const prefix = segmentObjectPrefix(this.prefix, ref); // validates ref
    try {
      // The async paging iterator drains every page; a segment has few generations, so the set is small.
      for await (const item of this.container.listBlobsFlat({ prefix })) {
        const generation = parseGenerationFromName(prefix, item.name);
        if (generation !== null) {
          yield { namespace: ref.namespace, segment: ref.segment, generation };
        }
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Map Azure read errors to the driver vocabulary; pass everything else through {@link mapError}. */
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
   * Reclassify a transient Azure fault (throttle/5xx/dropped connection) as a retryable {@link TransientError},
   * so the store's read retry can ride it out and a write's caller can tell it from a deterministic failure;
   * everything else propagates unchanged. The final fallback at every client-call site, so callers and the read
   * retry only ever see typed errors.
   */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient Azure fault: ${(err as { code?: unknown } | null)?.code ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}

type BlockBlob = ReturnType<ContainerClient['getBlockBlobClient']>;

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
 * Streaming {@link BlobSink} that uploads one Azure block blob in **constant memory**. It buffers at most one
 * block: as the codec writes, full blocks are staged via `stageBlock` and freed (the awaited request is the
 * natural backpressure). A small blob that never reaches one block is committed as a single conditional
 * `upload`; a larger one is finished with a conditional `commitBlockList` — **both enforce write-once** via
 * `ifNoneMatch: '*'`. SHA-256 is hashed incrementally.
 */
class AzureBlockBlobSink implements BlobSink {
  private readonly hash: Hash = createHash('sha256');
  private readonly pending: Uint8Array[] = [];
  private pendingLen = 0;
  private total = 0;
  private readonly blockIds: string[] = [];
  /**
   * A random per-sink nonce folded into every block id. Azure pools **uncommitted** blocks per *blob name*,
   * keyed by id — so two writers racing the same generation key on the staged path MUST use disjoint id spaces,
   * else one would overwrite the other's staged blocks and a commit could reference an interleaved mix of both
   * writers' bytes (a corrupt blob whose committed content wouldn't match the returned SHA-256). A per-instance
   * nonce makes each writer's ids unique, so the winner commits only its own blocks and the loser cleanly 409s.
   * 6 random bytes → 12 fixed hex chars, keeping every id equal-length (Azure's within-blob id requirement).
   */
  private readonly uploadNonce = randomBytes(6).toString('hex');
  /** This write's own id, stored in the blob's metadata: see {@link storedWriteId}. */
  private readonly writeId = newWriteId();

  constructor(
    private readonly blob: BlockBlob,
    private readonly blockBytes: number,
    private readonly maxObjectBytes: number,
  ) {}

  /** Fixed-width (constant length within a blob) AND per-sink-unique block id: `<nonce>-<zero-padded index>`. */
  private blockId(n: number): string {
    return Buffer.from(`${this.uploadNonce}-${String(n).padStart(6, '0')}`).toString('base64');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.total += bytes.length;
    if (this.total > this.maxObjectBytes) {
      // Fail fast + typed, rather than a late opaque Azure error.
      throw new ValidationError(`object exceeds maxObjectBytes ${this.maxObjectBytes}`);
    }
    this.hash.update(bytes);
    // Copy on retain: the SHA-256 is committed to these exact bytes now, but they sit in `pending` across the
    // `write()` boundary until the next flush — the `BlobSink` contract (see core/blob.ts) lets a caller reuse
    // its buffer after `write()` resolves, so a shared reference could let the committed content diverge from
    // the already-hashed bytes. `new Uint8Array(bytes)` copies UNCONDITIONALLY — note `bytes.slice()` would NOT:
    // the payload is a `Buffer` (roaring serialize), whose `slice()` returns an aliasing view, not a copy.
    // (S3/GCS + `BufferSink` share this retain-by-reference pattern; tracked as a cross-driver follow-up.)
    this.pending.push(new Uint8Array(bytes));
    this.pendingLen += bytes.length;
    if (this.pendingLen >= this.blockBytes) await this.flushBlock();
  }

  /** Stage the buffered bytes (≥ one block) as a single block, freeing them. */
  private async flushBlock(): Promise<void> {
    if (this.blockIds.length >= AZURE_MAX_BLOCKS) {
      // Unreachable for valid input (the maxObjectBytes byte-cap, sized to ≤ 50,000 blocks, fires first) — a
      // typed guard so the Azure hard limit is never a raw 4xx.
      throw new ValidationError(`upload exceeded the Azure ${AZURE_MAX_BLOCKS}-block limit`);
    }
    const body = concatBytes(this.pending, this.pendingLen);
    this.pending.length = 0;
    this.pendingLen = 0;
    const id = this.blockId(this.blockIds.length);
    await this.blob.stageBlock(id, body, body.length);
    this.blockIds.push(id);
  }

  /**
   * Commit the blob: a single conditional `upload` if it fit in one block, else commit the staged block list. Both
   * tag the blob with this write's id. The client's retry policy may send the commit again after a lost response,
   * and the replay meets the blob it just wrote: a conflict whose stored blob carries this write's id is a success.
   */
  async finish(): Promise<{ size: number; sha256: string }> {
    const sha256 = this.hash.digest('hex');
    const options = { ...IF_ABSENT, metadata: writeIdMetadata(this.writeId) };
    try {
      if (this.blockIds.length === 0) {
        const body = concatBytes(this.pending, this.pendingLen);
        await this.blob.upload(body, body.length, options); // write-once (single-shot path)
      } else {
        if (this.pendingLen > 0) await this.flushBlock(); // the final block may be < blockBytes (allowed)
        await this.blob.commitBlockList(this.blockIds, options); // write-once (staged path)
      }
    } catch (err) {
      // A write-once blob is never overwritten, so the id it holds says who wrote it. A failed read-back throws,
      // and reaches the caller as `TransientError` when the fault is transient: neither a success nor a conflict.
      if (!isConditionalConflict(err) || (await storedWriteId(this.blob)) !== this.writeId)
        throw err;
    }
    return { size: this.total, sha256 };
  }
}

/**
 * Collect an Azure download's Node readable body into a `Uint8Array`. Called in the turn the download returns: the
 * loop listens for the body's errors from its first step, before the read's timer can abort it.
 */
async function collect(
  body: NodeJS.ReadableStream | undefined,
  abortSignal: AbortSignal,
): Promise<Uint8Array> {
  if (body === undefined) {
    throw new NotFoundError('Azure download returned no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const u8 =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk as Buffer);
      chunks.push(u8);
      total += u8.length;
    }
  } catch (err) {
    // The SDK fails a body whose connection dropped part-way with an `AbortError`. This read's own signal aborts only
    // on its timer, whose error the read has already thrown, so an `AbortError` with the signal unaborted is the
    // dropped connection, and retryable, as the registry reads it.
    if (!abortSignal.aborted && (err as { name?: unknown } | null)?.name === 'AbortError') {
      throw Object.assign(
        new Error('Azure Blob read was cut off before the response completed', { cause: err }),
        { code: 'ECONNRESET' },
      );
    }
    throw err;
  }
  return concatBytes(chunks, total);
}
