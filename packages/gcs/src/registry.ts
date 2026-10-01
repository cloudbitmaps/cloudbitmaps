/**
 * `GcsRegistryDriver` — an {@link IRegistryDriver} over Google Cloud Storage.
 *
 * Lets a **GCS deployment run on one bucket alone** — storage `.crbm` generations and the registry in the same
 * place, with no second cloud involved.
 *
 * The protocol (an ABA-safe OCC counter, tombstoning delete, the bounded retry, the key layout) lives once
 * in {@link ObjectStoreRegistry}; this file is only the three I/O calls GCS makes.
 *
 * **The atomic swap is offloaded to GCS's object preconditions.** `ifGenerationMatch: 0` is create-only
 * ("only if it does not exist") and `ifGenerationMatch: <generation>` is compare-and-swap — the same pair S3
 * spells `If-None-Match: *` / `If-Match: <etag>`. A lost race returns `412` → {@link WriteConflictError}. Each write
 * is one request sent once ({@link saveOnce}), so a `412` means another write got there first, never this one meeting
 * itself after a lost response. A transient failure reaches the caller as {@link TransientError}: the write may or may
 * not have landed, and the caller re-reads the row to learn where it stands.
 *
 * **The version fence is the object's `generation`, not its ETag**: GCS mutates the generation on every
 * overwrite and it is the value `ifGenerationMatch` compares, so it is the only correct fence here. (Note
 * the unrelated collision of vocabulary — a GCS *object generation* has nothing to do with a CloudBitmaps
 * `.crbm` *generation*.) Reads are strongly consistent, satisfying the registry's `strongRead` contract.
 *
 * **Deployment requirements** (a policy that violates these silently corrupts the registry):
 * - The principal needs `storage.objects.get`, `create`, `update` and `list` on the bucket. Without `list`
 *   the registry cannot enumerate, and a missing-object read may surface as `403` rather than `404`.
 * - **Do not apply an Object Lifecycle rule to the `registry/` prefix that deletes a live object** (one on
 *   noncurrent versions only is safe), and do not enable a retention
 *   policy that blocks overwrite. `delete` tombstones rather than removing, for ABA-safety — see
 *   {@link ObjectStoreRegistry}.
 * - Object versioning is neither required nor used; the driver always reads the live generation. A read is one
 *   GET whose `x-goog-generation` header and body describe the same object, so a concurrent overwrite is simply
 *   observed as the older or the newer row, never as a torn pair or a missing one.
 */
import {
  IntegrityError,
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  TransientError,
  WriteConflictError,
  normalizeObjectPrefix,
} from '@cloudbitmaps/core/driver-kit';
import type { ObjectRegistryStore, ObjectRow } from '@cloudbitmaps/core/driver-kit';
import type { Storage } from '@google-cloud/storage';
import { isNotFound, isPreconditionFailed, isTransient } from './gcs-errors';
import { readOnce, singleHeader } from './read-once';
import { saveOnce } from './send-once';

export interface GcsRegistryDriverOptions {
  /** A constructed `@google-cloud/storage` `Storage` client (point `apiEndpoint` at fake-gcs-server locally). */
  readonly storage: Storage;
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional object-name prefix under which all registry objects live (e.g. `cloudbitmaps/`). */
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

  /** A handle on one registry object. */
  private file(name: string) {
    return this.storage.bucket(this.bucket).file(name);
  }

  async read(key: string): Promise<ObjectRow | null> {
    // One GET: the response headers carry the `generation` fence and the length, and the body is the same
    // observation of the object, so the pair cannot straddle a concurrent overwrite.
    let res;
    try {
      res = await readOnce(
        this.file(key),
        {},
        MAX_ROW_BYTES,
        (size) =>
          new IntegrityError(
            size === undefined
              ? `registry object exceeds cap ${MAX_ROW_BYTES}B`
              : `registry object ${size}B exceeds cap ${MAX_ROW_BYTES}B`,
          ),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw mapError(err);
    }
    if (res.status !== 200) {
      throw new IntegrityError(`registry read answered HTTP ${res.status}, not 200: ${key}`);
    }
    // The fence is compared by `ifGenerationMatch` on the next write, so it is parsed here, where a header that
    // is missing or malformed can be refused before it is mistaken for a version.
    const generation = singleHeader(res.headers, 'x-goog-generation');
    if (
      generation === undefined ||
      !/^[1-9]\d*$/.test(generation) ||
      !Number.isSafeInteger(Number(generation))
    ) {
      throw new IntegrityError(`registry read carries no usable x-goog-generation: ${key}`);
    }
    return { bytes: res.bytes, version: generation };
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    try {
      // One request, sent once: a replay of a write that landed would fail its own precondition, and read as a lost
      // race. A registry row is a few hundred bytes, so a resumable session would also carry one round trip's worth
      // of data over two.
      await saveOnce(this.file(key), body, {
        contentType: 'application/json',
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
 * the `x-goog-generation` header in {@link GcsStore.read}, so this cannot fire in practice — but `Number()` answers `NaN`
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
