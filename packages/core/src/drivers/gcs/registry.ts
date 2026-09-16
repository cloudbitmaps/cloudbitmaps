/**
 * `GcsRegistryDriver` — an {@link IRegistryDriver} over Google Cloud Storage.
 *
 * Lets a **GCS deployment run on one bucket alone** — cold `.crbm` generations and the registry in the same
 * place, with no second cloud involved. Before this existed, a GCS user had to point the registry at
 * DynamoDB, which meant holding an AWS account purely to store the pointer that says which generation is
 * current.
 *
 * The protocol (an ABA-safe OCC counter, tombstoning delete, the bounded retry, the key layout) lives once
 * in {@link ObjectStoreRegistry}; this file is only the three I/O calls GCS makes.
 *
 * **The atomic swap is offloaded to GCS's object preconditions.** `ifGenerationMatch: 0` is create-only
 * ("only if it does not exist") and `ifGenerationMatch: <generation>` is compare-and-swap — the same pair S3
 * spells `If-None-Match: *` / `If-Match: <etag>`. A lost race returns `412` → {@link WriteConflictError}.
 * **The version fence is the object's `generation`, not its ETag**: GCS mutates the generation on every
 * overwrite and it is the value `ifGenerationMatch` compares, so it is the only correct fence here. (Note
 * the unrelated collision of vocabulary — a GCS *object generation* has nothing to do with a CloudBitmaps
 * `.crbm` *generation*.) Reads are strongly consistent, satisfying the registry's `strongRead` contract.
 *
 * **Deployment requirements** (a policy that violates these silently corrupts the registry):
 * - The principal needs `storage.objects.get`, `create`, `update` and `list` on the bucket. Without `list`
 *   the registry cannot enumerate, and a missing-object read may surface as `403` rather than `404`.
 * - **Do not apply an Object Lifecycle rule to the `registry/` prefix**, and do not enable a retention
 *   policy that blocks overwrite. `delete` tombstones rather than removing, for ABA-safety — see
 *   {@link ObjectStoreRegistry}.
 * - Object versioning is neither required nor used; the driver always reads the live generation.
 */
import type { Storage } from '@google-cloud/storage';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  type ObjectRegistryStore,
  type ObjectRow,
} from '../_shared/object-registry';
import { normalizeObjectPrefix } from '../_shared/object-registry-keys';
import { isNotFound, isPreconditionFailed, isTransient } from './gcs-errors';

export interface GcsRegistryDriverOptions {
  /** A constructed `@google-cloud/storage` `Storage` client (point `apiEndpoint` at fake-gcs-server locally). */
  readonly storage: Storage;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which all registry objects live (e.g. `cloudroaring/`). */
  readonly prefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The three calls {@link ObjectStoreRegistry} needs, in GCS's dialect. */
class GcsStore implements ObjectRegistryStore {
  readonly label = 'GCS';

  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
  ) {}

  /** A file handle, optionally pinned to one object generation (GCS's version fence). */
  private file(name: string, generation?: string) {
    return generation === undefined
      ? this.storage.bucket(this.bucket).file(name)
      : this.storage.bucket(this.bucket).file(name, { generation });
  }

  async read(key: string): Promise<ObjectRow | null> {
    // Metadata first: it carries the `generation` fence AND the size, so a hostile object is rejected on its
    // advertised length before any of it is buffered.
    let generation: string;
    let size: number;
    try {
      const [meta] = await this.file(key).getMetadata();
      generation = String(meta.generation ?? '');
      size = Number(meta.size ?? 0);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw mapError(err);
    }
    if (size > MAX_ROW_BYTES) {
      throw new IntegrityError(`registry object ${size}B exceeds cap ${MAX_ROW_BYTES}B`);
    }
    try {
      // Pin the download to the generation we just measured, so a concurrent overwrite between the two calls
      // cannot hand us bytes that do not match the fence we are about to compare-and-swap against.
      const [buf] = await this.file(key, generation).download();
      return { bytes: new Uint8Array(buf), version: generation };
    } catch (err) {
      if (isNotFound(err)) return null; // raced with a delete between metadata and download
      throw mapError(err);
    }
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    try {
      await this.file(key).save(Buffer.from(body), {
        contentType: 'application/json',
        preconditionOpts: {
          ifGenerationMatch: expect === 'absent' ? 0 : Number(expect.version),
        },
      });
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw new WriteConflictError(`registry OCC conflict for ${key}`);
      }
      throw mapError(err);
    }
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    let pageToken: string | undefined;
    do {
      let files;
      let next: { pageToken?: string } | null | undefined;
      try {
        // Explicit paging rather than autoPaginate: a registry can hold far more rows than a segment holds
        // generations, and draining every page into memory first is what `list()` exists to avoid.
        [files, next] = await this.storage
          .bucket(this.bucket)
          .getFiles({ prefix, autoPaginate: false, maxResults: 1000, pageToken });
      } catch (err) {
        throw mapError(err);
      }
      for (const f of files ?? []) yield f.name;
      pageToken = next?.pageToken;
    } while (pageToken !== undefined);
  }
}

/** Reclassify a transient GCS fault as a retryable {@link TransientError}; pass everything else through. */
function mapError(err: unknown): unknown {
  if (isTransient(err)) {
    return new TransientError(
      `transient GCS fault: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
      { cause: err },
    );
  }
  return err;
}

export class GcsRegistryDriver extends ObjectStoreRegistry {
  constructor(options: GcsRegistryDriverOptions) {
    super(
      new GcsStore(options.storage, options.bucket),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
