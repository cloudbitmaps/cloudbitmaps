/**
 * `S3RegistryDriver` — an {@link IRegistryDriver} over S3-compatible object storage.
 *
 * Lets a **read-mostly deployment run on S3 alone** — cold `.crbm` generations + the registry in one bucket,
 * no separate database. The protocol (an ABA-safe OCC counter, tombstoning delete, the bounded retry, the key layout)
 * lives once in {@link ObjectStoreRegistry}; this file is only the three I/O calls S3 makes, so the S3, GCS
 * and Azure registries cannot drift from one another.
 *
 * **The atomic swap is offloaded to S3's conditional writes** (GA Nov 2024): `If-None-Match: *` for
 * create-only and `If-Match: <etag>` for compare-and-swap, so a concurrent writer between our read and our
 * PUT loses with a `412` → {@link WriteConflictError}. Reads are strongly consistent (S3, since 2020),
 * satisfying the registry's `strongRead` contract. The client is **injected**, exactly like
 * {@link S3ColdDriver}.
 *
 * **Deployment requirements** (a backend/policy that violates these silently corrupts the registry):
 * - The backend **must honor `If-Match`** (AWS S3; recent MinIO). One that returns ETags but ignores the
 *   precondition degrades compare-and-swap to last-write-wins → lost `currentGen` swaps. Verified against
 *   real S3 semantics by the MinIO integration lane.
 * - The IAM principal needs **`s3:ListBucket`** on the bucket. Without it, `GetObject` on a missing key
 *   returns `403` (not `404`), so the "absent segment → `null`" contract (and `create`'s bootstrap read)
 *   breaks — and `list()` needs it regardless.
 * - **Do not apply an S3 lifecycle-expiration rule to the `registry/` prefix.** See {@link ObjectStoreRegistry}.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  type ObjectRegistryStore,
  type ObjectRow,
} from '../_shared/object-registry';
import { normalizeObjectPrefix } from '../_shared/object-registry-keys';
import { isConditionalConflict, isNotFound, isTransient } from './s3-errors';

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

/** The three calls {@link ObjectStoreRegistry} needs, in S3's dialect. */
class S3Store implements ObjectRegistryStore {
  readonly label = 'S3';

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async read(key: string): Promise<ObjectRow | null> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw mapError(err);
    }
    // Check the advertised length BEFORE allocating, so a hostile object cannot make us buffer it first.
    if ((res.ContentLength ?? 0) > MAX_ROW_BYTES) {
      throw new IntegrityError(
        `registry object ${res.ContentLength}B exceeds cap ${MAX_ROW_BYTES}B`,
      );
    }
    if (res.Body === undefined) {
      throw new IntegrityError(`registry object has an empty body: ${key}`);
    }
    const bytes = await (
      res.Body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    return { bytes, version: res.ETag ?? '' };
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: expect === 'absent' ? '*' : undefined,
          IfMatch: expect === 'absent' ? undefined : expect.version,
        }),
      );
    } catch (err) {
      // A lost conditional-write race (412 precondition, or 409 concurrent-conflict) is an OCC conflict.
      if (isConditionalConflict(err)) {
        throw new WriteConflictError(`registry OCC conflict for ${key}`);
      }
      throw mapError(err);
    }
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
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
        throw mapError(err);
      }
      for (const obj of res.Contents ?? []) {
        if (obj.Key !== undefined) yield obj.Key;
      }
      token = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
  }
}

/** Reclassify a transient S3 fault as a retryable {@link TransientError}; pass everything else through. */
function mapError(err: unknown): unknown {
  if (isTransient(err)) {
    return new TransientError(
      `transient S3 fault: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
      { cause: err },
    );
  }
  return err;
}

export class S3RegistryDriver extends ObjectStoreRegistry {
  constructor(options: S3RegistryDriverOptions) {
    super(
      new S3Store(options.client, options.bucket),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
