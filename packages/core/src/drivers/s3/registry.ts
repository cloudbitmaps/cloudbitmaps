/**
 * `S3RegistryDriver` — an {@link IRegistryDriver} over S3-compatible object storage (Phase 7).
 *
 * Lets a **read-mostly deployment run on S3 alone** — cold `.crbm` generations + the registry in one bucket,
 * no DynamoDB. One tiny JSON object per segment at `<prefix>registry/<ns>/<segment>.reg` holding the
 * `{ deleted, record }` envelope (the same shape LocalFs persists). The OCC token is a monotonic counter,
 * advanced on every mutation and even across a `delete` (which **tombstones** rather than removes the object)
 * so a deleted-then-recreated row never re-issues an old token (ABA-safe) — identical semantics to the
 * LocalFs + DynamoDB registries, so it passes the same conformance suite.
 *
 * **The atomic swap is offloaded to S3's conditional writes** (GA Nov 2024): `create` uses `If-None-Match: *`
 * (write-once, or `If-Match` over a tombstone), and `compareAndSwap`/`delete` use `If-Match: <etag>` so a
 * concurrent writer between our read and our PUT loses with a `412` → {@link WriteConflictError}. No in-process
 * lock is needed (unlike LocalFs) — the ETag precondition fences writers *across processes*. Reads are
 * strongly consistent (S3, since 2020), satisfying the registry's `strongRead` contract. The client is
 * **injected**, exactly like {@link S3ColdDriver}.
 *
 * **Deployment requirements** (a backend/policy that violates these silently corrupts the registry):
 * - The backend **must honor `If-Match`** (AWS S3; recent MinIO). One that returns ETags but ignores the
 *   precondition degrades compare-and-swap to last-write-wins → lost `currentGen` swaps. Verified against real
 *   S3 semantics by the MinIO integration lane.
 * - The IAM principal needs **`s3:ListBucket`** on the bucket. Without it, `GetObject` on a missing key returns
 *   `403` (not `404`), so the "absent segment → `null`" contract (and `create`'s bootstrap read) breaks — and
 *   `list()` needs it regardless.
 * - **Do not apply an S3 lifecycle-expiration rule to the `registry/` prefix.** `delete` tombstones (keeps the
 *   object with an advanced counter) for ABA-safety; expiring a tombstone would let a recreate reset the token
 *   to 0 and re-issue a stale one.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  IntegrityError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isWriteConflictError,
} from '@/core/errors';
import type {
  IRegistryDriver,
  NewRegistryRecord,
  RegCaps,
  RegistryPatch,
  RegistryRecord,
  SegmentRef,
  Token,
} from '@/core/ports';
import {
  applyRegistryPatch,
  parseRegistryEnvelope,
  recordFromNew,
  registryCounterOf,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  type RegistryEnvelope,
} from '../_shared/registry';
import { normalizeS3Prefix, parseRegistryKey, registryListPrefix, registryObjectKey } from './keys';
import { isConditionalConflict, isNotFound, isTransient } from './s3-errors';
import { mapWithConcurrency } from '@/core/concurrency';

/** Defensive cap on a single registry object read from storage, before allocation (rows are tiny; ~1 KB). */
const MAX_ROW_BYTES = 1 * 1024 * 1024;
/** Bounded retry for `delete`'s read→tombstone under cross-process contention (converges; then fails typed). */
const MAX_DELETE_ATTEMPTS = 8;
/** In-flight `readRow` GETs per `list()` page — turns the serial N+1 into one LIST + bounded parallel GETs. */
const LIST_READ_CONCURRENCY = 16;

/** A conditional-write precondition: exactly one of write-once (`If-None-Match: *`) or CAS (`If-Match: etag`). */
type PutCondition = { readonly ifNoneMatch: '*' } | { readonly ifMatch: string };

export interface S3RegistryDriverOptions {
  /** A constructed S3 client (point its `endpoint` at MinIO for local/integration use). */
  readonly client: S3Client;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which all registry objects live (e.g. `cloudroaring/`). */
  readonly prefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class S3RegistryDriver implements IRegistryDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly now: () => number;

  constructor(options: S3RegistryDriverOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = normalizeS3Prefix(options.prefix);
    this.now = options.now ?? ((): number => Date.now());
  }

  capabilities(): RegCaps {
    return { strongRead: true };
  }

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    const current = await this.readRow(registryObjectKey(this.prefix, ref));
    return current && !current.env.deleted ? current.env.record : null;
  }

  async create(ref: SegmentRef, record: NewRegistryRecord): Promise<{ token: Token }> {
    validateNewRegistryRecord(record);
    const key = registryObjectKey(this.prefix, ref);
    const current = await this.readRow(key);
    if (current !== null && !current.env.deleted) {
      throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
    }
    // Advance across a tombstone so a recreate never re-issues an old token (ABA-safe).
    const token = String(current ? registryCounterOf(current.env.record) + 1 : 0);
    const env: RegistryEnvelope = {
      deleted: false,
      record: recordFromNew(ref, record, this.now(), token),
    };
    // Write-once when truly absent; overwrite the tombstone under its ETag when recreating. Either way a
    // concurrent create loses with a 412 → WriteConflictError.
    await this.putRow(key, env, current ? { ifMatch: current.etag } : { ifNoneMatch: '*' });
    return { token };
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
  ): Promise<{ token: Token }> {
    validateRegistryPatch(patch);
    const key = registryObjectKey(this.prefix, ref);
    const current = await this.readRow(key);
    if (current === null || current.env.deleted || current.env.record.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    const token = String(registryCounterOf(current.env.record) + 1);
    const env: RegistryEnvelope = {
      deleted: false,
      record: applyRegistryPatch(current.env.record, patch, this.now(), token),
    };
    // If-Match on the ETag we read fences a concurrent writer between our read and this PUT (412 → conflict).
    await this.putRow(key, env, { ifMatch: current.etag });
    return { token };
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    const prefix = registryListPrefix(this.prefix, namespace);
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
      // Registry keys in this page (skipping stray/foreign objects). `readRow` is one GET each — a serial
      // await-in-loop made `list()` O(N) sequential round-trips (the N+1). Fan them out with a bounded pool:
      // one LIST + up to `LIST_READ_CONCURRENCY` parallel GETs per page, order-preserving so the yielded
      // stream stays deterministic.
      const keys = (res.Contents ?? [])
        .map((obj) => obj.Key)
        .filter((k): k is string => k !== undefined && parseRegistryKey(this.prefix, k) !== null);
      const rows = await mapWithConcurrency(keys, LIST_READ_CONCURRENCY, (key) =>
        this.readRow(key),
      );
      for (const current of rows) {
        if (current && !current.env.deleted) yield current.env.record;
      }
      token = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async delete(ref: SegmentRef): Promise<void> {
    const key = registryObjectKey(this.prefix, ref);
    // Tombstone (advance the counter) rather than remove the object — keeps the token monotonic for
    // ABA-safety. Retry the read→tombstone on a cross-process race (a concurrent write bumps the ETag → 412);
    // it converges, then fails typed rather than silently leaving the row live.
    for (let attempt = 0; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
      const current = await this.readRow(key);
      if (current === null || current.env.deleted) return; // idempotent — already gone
      const token = String(registryCounterOf(current.env.record) + 1);
      const env: RegistryEnvelope = {
        deleted: true,
        record: { ...current.env.record, token, updatedAt: this.now() },
      };
      try {
        await this.putRow(key, env, { ifMatch: current.etag });
        return;
      } catch (err) {
        if (isWriteConflictError(err)) continue; // raced — re-read and re-tombstone
        throw err;
      }
    }
    throw new WriteConflictError(
      `registry delete: contention tombstoning "${ref.segment}" — retry`,
    );
  }

  /** GET + parse a registry object, returning its envelope + ETag (for a later If-Match), or null if absent. */
  private async readRow(
    objectKey: string,
  ): Promise<{ env: RegistryEnvelope; etag: string } | null> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw this.mapError(err);
    }
    if ((res.ContentLength ?? 0) > MAX_ROW_BYTES) {
      throw new IntegrityError(
        `registry object ${res.ContentLength}B exceeds cap ${MAX_ROW_BYTES}B`,
      );
    }
    if (res.Body === undefined) {
      throw new IntegrityError(`registry object has an empty body: ${objectKey}`);
    }
    const bytes = await (
      res.Body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    if (bytes.length > MAX_ROW_BYTES) {
      throw new IntegrityError(`registry object ${bytes.length}B exceeds cap ${MAX_ROW_BYTES}B`);
    }
    const env = parseRegistryEnvelope(Buffer.from(bytes).toString('utf8'), objectKey);
    if (res.ETag === undefined || res.ETag.length === 0) {
      // The ETag is the OCC fence for CAS; a backend that omits it can't be used safely as a registry.
      throw new IntegrityError(
        `registry object has no ETag (needed for compare-and-swap): ${objectKey}`,
      );
    }
    return { env, etag: res.ETag };
  }

  /** Conditional PUT of an envelope; maps a `412` precondition failure to {@link WriteConflictError}. */
  private async putRow(
    objectKey: string,
    env: RegistryEnvelope,
    cond: PutCondition,
  ): Promise<void> {
    const Body = Buffer.from(serializeRegistryEnvelope(env), 'utf8');
    if (Body.length > MAX_ROW_BYTES) {
      // Belt-and-braces: the governance/DEK fields are already capped by validate*, so this can't fire for
      // valid input — but never write a row that would later be unreadable.
      throw new ValidationError(`registry object ${Body.length}B exceeds cap ${MAX_ROW_BYTES}B`);
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body,
          ContentType: 'application/json',
          IfNoneMatch: 'ifNoneMatch' in cond ? cond.ifNoneMatch : undefined,
          IfMatch: 'ifMatch' in cond ? cond.ifMatch : undefined,
        }),
      );
    } catch (err) {
      // A lost conditional-write race (412 precondition, or 409 concurrent-conflict) is an OCC conflict.
      if (isConditionalConflict(err)) {
        throw new WriteConflictError(`registry OCC conflict for ${objectKey}`);
      }
      throw this.mapError(err);
    }
  }

  /** Reclassify a transient S3 fault as a retryable {@link TransientError}; pass everything else through. */
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
