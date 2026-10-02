/**
 * `S3RegistryDriver` — an {@link IRegistryDriver} over S3-compatible object storage.
 *
 * Lets a **read-mostly deployment run on S3 alone** — storage `.crbm` generations + the registry in one bucket,
 * no separate database. The protocol (an ABA-safe OCC token, the delete and its tombstone, the bounded retry, the key
 * layout) lives once in {@link ObjectStoreRegistry}; this file is only the I/O calls S3 makes, so the S3, GCS
 * and Azure registries cannot drift from one another.
 *
 * **A delete removes the row for good** with a `DeleteObject` under `If-Match: <etag>`, sent once like the writes,
 * when `conditionalDelete` is on: by default for AWS S3, and off for a client with a custom endpoint, since an
 * S3-compatible store may accept the header and ignore it (MinIO does).
 *
 * **The atomic swap is offloaded to S3's conditional writes** (GA Nov 2024): `If-None-Match: *` for
 * create-only and `If-Match: <etag>` for compare-and-swap, so a concurrent writer between our read and our
 * PUT loses with a `412` → {@link WriteConflictError}. Each conditional PUT is sent once, with the SDK's retry off
 * for it ({@link sendOnce}), so a `412` means another write got there first, never this one meeting itself after a
 * lost response. A transient failure reaches the caller as {@link TransientError}: the write may or may not have
 * landed, and the caller re-reads the row to learn where it stands. Reads are strongly consistent (S3, since 2020),
 * satisfying the registry's `strongRead` contract, and each can be timed as the storage driver's are ({@link timedRead}):
 * with `readTimeoutMs` set, a row's `GetObject` that has not finished, body included, after it throws
 * {@link TransientError}. It is off by default, and the writes and listings are never timed. The client is **injected**, exactly like {@link S3StorageDriver}.
 *
 * **Deployment requirements** (a backend/policy that violates these silently corrupts the registry):
 * - The backend **must honor `If-Match`** (AWS S3; recent MinIO). One that returns ETags but ignores the
 *   precondition degrades compare-and-swap to last-write-wins → lost `currentGen` swaps. Verified against
 *   real S3 semantics by the MinIO integration lane.
 * - The IAM principal needs **`s3:ListBucket`** on the bucket. Without it, `GetObject` on a missing key
 *   returns `403` (not `404`), so the "absent segment → `null`" contract (and `create`'s bootstrap read)
 *   breaks — and `list()` needs it regardless.
 * - **Do not apply an S3 lifecycle-expiration rule to the `registry/` prefix that expires a current version**
 *   (`NoncurrentVersionExpiration` is safe). See {@link ObjectStoreRegistry}.
 */
import {
  IntegrityError,
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  TransientError,
  ValidationError,
  WriteConflictError,
  normalizeObjectPrefix,
} from '@cloudbitmaps/core/driver-kit';
import type { ObjectRegistryStore, ObjectRow } from '@cloudbitmaps/core/driver-kit';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { resolveReadTimeoutMs, timedRead } from './read-timeout';
import { isConditionalConflict, isNotFound, isTransient } from './s3-errors';
import { sendOnce } from './send-once';

export interface S3RegistryDriverOptions {
  /** A constructed S3 client (point its `endpoint` at MinIO for local/integration use). */
  readonly client: S3Client;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which all registry objects live (e.g. `cloudbitmaps/`). */
  readonly prefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How long one read of a row — its `GetObject`, the body included — may take before it is abandoned and throws
   * `TransientError`, in ms. `0`, the default, sets no timeout. Must be a non-negative safe integer no larger than
   * 2,147,483,647. Writes and listings are not timed.
   *
   * The clock starts when the read is handed to the SDK, so it also counts the time the read waits for one of the
   * client's sockets (50 by default) and the time spent fetching credentials, and under `retryMode: 'adaptive'` the
   * SDK's rate-limiter wait. A burst of concurrent reads larger than the socket pool can therefore time out with
   * nothing slow on the wire: size the timeout above the worst queueing your concurrency implies, or raise the client's
   * `maxSockets`. On a client built with `cacheMiddleware: true`, a timed read resolves its middleware each time.
   */
  readonly readTimeoutMs?: number;
  /**
   * Whether a delete removes a row for good, by a `DeleteObject` sent with `If-Match: <the ETag it read>`, rather than
   * leaving a tombstone. Only a row born with an incarnation id is removed; a row a release before 0.12 wrote is
   * always tombstoned. Defaults to `true` for a client with no custom endpoint, which is AWS S3, where `If-Match` on
   * `DeleteObject` is documented for general purpose and directory buckets, and to `false` for a client with an
   * `endpoint`. An S3-compatible store must apply the precondition before you set it there: MinIO, for one, ignores it
   * and deletes anyway, and on such a store two sweepers and a re-create can delete a live row.
   */
  readonly conditionalDelete?: boolean;
}

/** The calls {@link ObjectStoreRegistry} needs, in S3's dialect. Exported for the tests that drive one directly. */
export class S3RegistryStore implements ObjectRegistryStore {
  readonly label = 'S3';

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly readTimeoutMs: number,
    readonly conditionalDelete: boolean,
  ) {}

  read(key: string): Promise<ObjectRow | null> {
    return timedRead('GetObject', this.readTimeoutMs, async (options) => {
      let res;
      try {
        res = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          options,
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw mapError(err);
      }
      try {
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
      } catch (err) {
        // A row refused before its body is read would otherwise hold its connection open until the server gives up
        // on it; destroying the body closes the socket. On a body that already failed it changes nothing.
        destroyBody(res.Body);
        // A body cut off part-way is a dropped connection, and transient; a refused row is not.
        throw err instanceof IntegrityError ? err : mapError(err);
      }
    });
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    try {
      // Sent once: a replay of a write that landed would fail its own precondition, and read as a lost race.
      await sendOnce(
        this.client,
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

  async delete(key: string, expect: { version: string }): Promise<void> {
    try {
      // Sent once, as the writes are: a replay that met its own landed delete would read as a lost race.
      await sendOnce(
        this.client,
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key, IfMatch: expect.version }),
      );
    } catch (err) {
      // A 412 (the object moved on), a 409 (a concurrent conditional request) or a 404 (it is gone) all mean the
      // version this delete was conditioned on is not there to delete.
      if (isConditionalConflict(err) || isNotFound(err)) {
        throw new WriteConflictError(`registry OCC conflict deleting ${key}`);
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

/** Destroy a response body left unread, which releases its connection; a body with no `destroy` is left alone. */
function destroyBody(body: unknown): void {
  (body as { destroy?: () => void } | undefined)?.destroy?.();
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

/**
 * Whether `client` was built with an endpoint of its own: an S3-compatible store, or a private AWS endpoint. The SDK
 * records it on the resolved config; a client without that config (a test double) reads as AWS.
 */
function hasCustomEndpoint(client: S3Client): boolean {
  return (client as { config?: { isCustomEndpoint?: unknown } }).config?.isCustomEndpoint === true;
}

/** {@link S3RegistryDriverOptions.conditionalDelete}, checked, or its default for `client`. */
function resolveConditionalDelete(value: unknown, client: S3Client): boolean {
  if (value === undefined) return !hasCustomEndpoint(client);
  if (typeof value !== 'boolean') {
    throw new ValidationError(`conditionalDelete must be a boolean; got ${String(value)}`);
  }
  return value;
}

export class S3RegistryDriver extends ObjectStoreRegistry {
  constructor(options: S3RegistryDriverOptions) {
    super(
      new S3RegistryStore(
        options.client,
        options.bucket,
        resolveReadTimeoutMs(options.readTimeoutMs),
        resolveConditionalDelete(options.conditionalDelete, options.client),
      ),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
