/**
 * `AzureBlobRegistryDriver` — an {@link IRegistryDriver} over Azure Blob Storage.
 *
 * Lets an **Azure deployment run on one container alone** — cold `.crbm` generations and the registry in the
 * same place, with no second cloud involved. Before this existed, an Azure user had to point the registry at
 * DynamoDB, which meant holding an AWS account purely to store the pointer that says which generation is
 * current.
 *
 * The protocol (an ABA-safe OCC counter, tombstoning delete, the bounded retry, the key layout) lives once
 * in {@link ObjectStoreRegistry}; this file is only the three I/O calls Azure makes.
 *
 * **The atomic swap is offloaded to Azure's blob conditions**: `ifNoneMatch: '*'` is create-only and
 * `ifMatch: <etag>` is compare-and-swap — the same pair S3 spells `If-None-Match: *` / `If-Match: <etag>`,
 * and the same pair the cold driver already uses for write-once generations. A lost race returns `409`
 * (`BlobAlreadyExists`) or `412` → {@link WriteConflictError}. Reads are strongly consistent, satisfying the
 * registry's `strongRead` contract. The `ContainerClient` is **injected**, exactly like
 * {@link AzureBlobColdDriver} — it is already container-scoped, so there is no separate container option.
 *
 * **Deployment requirements** (a policy that violates these silently corrupts the registry):
 * - The principal needs read, write and list on the container (`Storage Blob Data Contributor` covers it).
 * - **Do not apply a lifecycle-management rule to the `registry/` prefix**, and do not enable an immutability
 *   policy or legal hold on it: `delete` tombstones by overwriting rather than removing, for ABA-safety, so a
 *   WORM policy would fail every tombstone. See {@link ObjectStoreRegistry}.
 * - Blob versioning and soft delete are neither required nor used; the driver always reads the current blob.
 */
import type { ContainerClient } from '@azure/storage-blob';
import { IntegrityError, TransientError, WriteConflictError } from '@/core/errors';
import {
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  ObjectVersionRaced,
  type ObjectRegistryStore,
  type ObjectRow,
} from '../_shared/object-registry';
import { normalizeObjectPrefix } from '../_shared/object-registry-keys';
import { isConditionalConflict, isNotFound, isTransient } from './azure-errors';

export interface AzureBlobRegistryDriverOptions {
  /** A constructed `@azure/storage-blob` `ContainerClient`, scoped to an existing container. */
  readonly containerClient: ContainerClient;
  /** Optional blob-name prefix under which all registry objects live (e.g. `cloudroaring/`). */
  readonly prefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The three calls {@link ObjectStoreRegistry} needs, in Azure's dialect. */
class AzureBlobStore implements ObjectRegistryStore {
  readonly label = 'Azure Blob';

  constructor(private readonly container: ContainerClient) {}

  async read(key: string): Promise<ObjectRow | null> {
    const blob = this.container.getBlockBlobClient(key);
    let etag: string;
    let size: number;
    try {
      const props = await blob.getProperties();
      etag = props.etag ?? '';
      size = props.contentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw mapError(err);
    }
    // Reject on the advertised length before buffering, so a hostile blob is never materialized.
    if (size > MAX_ROW_BYTES) {
      throw new IntegrityError(`registry object ${size}B exceeds cap ${MAX_ROW_BYTES}B`);
    }
    // A zero-length blob can carry no envelope; skip the fetch and let the caller's parse reject it.
    if (size === 0) return { bytes: new Uint8Array(0), version: etag };
    try {
      // Pin the download to the ETag we just read, so a concurrent overwrite between the two calls cannot
      // hand us bytes that do not match the fence we are about to compare-and-swap against. `count` is the
      // length we just measured rather than `undefined`, because `downloadToBuffer` answers a falsy count by
      // issuing its own `getProperties` — a third round trip for a number already in hand.
      const buf = await blob.downloadToBuffer(0, size, { conditions: { ifMatch: etag } });
      return { bytes: new Uint8Array(buf), version: etag };
    } catch (err) {
      // Losing the pin means the blob moved on (overwritten), or went away (deleted), between the two
      // calls. Neither is this read's answer: `read` reports whether the object exists, and most callers
      // here are read-only. Re-reading settles it — the next pass sees the new version, or a clean absence.
      if (isNotFound(err) || isConditionalConflict(err)) throw new ObjectVersionRaced(key);
      throw mapError(err);
    }
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    const blob = this.container.getBlockBlobClient(key);
    try {
      await blob.upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: expect === 'absent' ? { ifNoneMatch: '*' } : { ifMatch: expect.version },
      });
    } catch (err) {
      if (isConditionalConflict(err)) {
        throw new WriteConflictError(`registry OCC conflict for ${key}`);
      }
      throw mapError(err);
    }
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    try {
      // The SDK's async iterator pages internally, so this streams rather than draining every page first.
      for await (const item of this.container.listBlobsFlat({ prefix })) {
        yield item.name;
      }
    } catch (err) {
      throw mapError(err);
    }
  }
}

/** Reclassify a transient Azure fault as a retryable {@link TransientError}; pass everything else through. */
function mapError(err: unknown): unknown {
  if (isTransient(err)) {
    return new TransientError(
      `transient Azure Blob fault: ${(err as { name?: string } | null)?.name ?? 'unknown'}`,
      { cause: err },
    );
  }
  return err;
}

export class AzureBlobRegistryDriver extends ObjectStoreRegistry {
  constructor(options: AzureBlobRegistryDriverOptions) {
    super(
      new AzureBlobStore(options.containerClient),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
