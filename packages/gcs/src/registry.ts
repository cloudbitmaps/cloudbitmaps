/**
 * `GcsRegistryDriver` — an {@link IRegistryDriver} over Google Cloud Storage.
 *
 * Lets a **GCS deployment run on one bucket alone** — storage `.crbm` generations and the registry in the same
 * place, with no second cloud involved. Before this existed, a GCS user had to point the registry at a
 * separate AWS-hosted table, which meant holding an AWS account purely to store the pointer that says which
 * generation is current.
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
 * - Object versioning is neither required nor used; the driver always reads the live generation. Because a
 *   non-versioned bucket retires a superseded generation immediately, a read whose pinned generation is
 *   overwritten mid-flight reports {@link ObjectVersionRaced} and is retried by {@link ObjectStoreRegistry},
 *   never mistaken for an absent row.
 */
import {
  IntegrityError,
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  ObjectVersionRaced,
  TransientError,
  WriteConflictError,
  normalizeObjectPrefix,
} from '@cloudbitmaps/core/driver-kit';
import type { ObjectRegistryStore, ObjectRow } from '@cloudbitmaps/core/driver-kit';
import type { Storage } from '@google-cloud/storage';
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
      // A 404 on the PINNED download does not mean the object is gone — it means the generation we pinned
      // is. Buckets here run without Object Versioning (the registry neither needs nor uses it), so an
      // overwrite retires the superseded generation immediately and this is simply what losing the pin looks
      // like. Reporting it as absence would make a live row disappear from `get`, hand `delete` a false
      // success, and silently drop rows from `list`; the caller re-reads instead.
      if (isNotFound(err)) throw new ObjectVersionRaced(key);
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
        // `resumable: false` is load-bearing, not a tuning knob. `save()` otherwise opens a resumable
        // session, and a registry row is a few hundred bytes — one round trip's worth of data carried over
        // two. It also costs the fence: fake-gcs-server does not enforce `ifGenerationMatch` on the
        // resumable path, so the whole integration lane would pass over a registry with no
        // compare-and-swap at all. `GcsStorageDriver` pins the same flag for the same reason.
        resumable: false,
        preconditionOpts: {
          ifGenerationMatch: expect === 'absent' ? 0 : generationFence(expect.version, key),
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

/**
 * Narrow a version fence back to the number `ifGenerationMatch` takes. The fence always originates as
 * `meta.generation` in {@link GcsStore.read}, so this cannot fire in practice — but `Number()` answers `NaN`
 * for anything non-numeric, and `ifGenerationMatch: NaN` serializes to a precondition GCS ignores. That
 * failure is invisible (writes simply stop being fenced), so it is checked rather than assumed.
 */
function generationFence(version: string, key: string): number {
  const generation = Number(version);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new IntegrityError(`registry version fence is not a GCS generation: ${key}`);
  }
  return generation;
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
