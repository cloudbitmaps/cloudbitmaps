/**
 * `AzureBlobRegistryDriver` — an {@link IRegistryDriver} over Azure Blob Storage.
 *
 * Lets an **Azure deployment run on one container alone** — storage `.crbm` generations and the registry in the
 * same place, with no second cloud involved.
 *
 * The protocol (an ABA-safe OCC token, the delete and its tombstone, the bounded retry, the key layout) lives once
 * in {@link ObjectStoreRegistry}; this file is only the I/O calls Azure makes. A delete removes a row for good with a
 * Delete Blob under `ifMatch: <etag>`, unless `conditionalDelete` is turned off.
 *
 * **The atomic swap is offloaded to Azure's blob conditions**: `ifNoneMatch: '*'` is create-only and
 * `ifMatch: <etag>` is compare-and-swap — the same pair S3 spells `If-None-Match: *` / `If-Match: <etag>`,
 * and the same pair the storage driver already uses for write-once generations. A lost race returns `409`
 * (`BlobAlreadyExists`) or `412` → {@link WriteConflictError}. Reads are strongly consistent, satisfying the
 * registry's `strongRead` contract. The `ContainerClient` is **injected**, exactly like
 * {@link AzureBlobStorageDriver} — it is already container-scoped, so there is no separate container option.
 *
 * **A read is one GET of the whole blob**, whose `ETag` (the version fence) and length come from the response that
 * carries the bytes, so the pair describes one version: a concurrent overwrite is observed as the older row or the
 * newer one, never as bytes of one under the fence of the other. Everything in the response is untrusted: it is
 * refused with {@link IntegrityError} unless it is a `200` with an `ETag` and a length no larger than
 * {@link MAX_ROW_BYTES}, checked before a byte of the body is read, and the body is counted as it arrives, so a length
 * that understates it cannot make the read hold more than it said, nor more than the cap. With `readTimeoutMs` set,
 * the read is cut off after that long, its body included, and throws {@link TransientError}; writes and listings are
 * not timed (see `read-timeout.ts`).
 *
 * **Deployment requirements** (a policy that violates these silently corrupts the registry):
 * - The principal needs read, write and list on the container (`Storage Blob Data Contributor` covers it).
 * - **Do not apply a lifecycle-management rule to the `registry/` prefix that deletes a current blob** (one that
 *   deletes only previous versions is safe), and do not enable an immutability
 *   policy or legal hold on it: a WORM policy would fail every row delete and every tombstone, which overwrites the
 *   blob. See {@link ObjectStoreRegistry}.
 * - Blob versioning and soft delete are neither required nor used; the driver always reads the current blob.
 */
import {
  IntegrityError,
  isIntegrityError,
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  TransientError,
  WriteConflictError,
  normalizeObjectPrefix,
  requireBool,
  toTransient,
} from '@cloudbitmaps/core/driver-kit';
import type { ObjectRegistryStore, ObjectRow } from '@cloudbitmaps/core/driver-kit';
import type { BlobDownloadResponseParsed, ContainerClient } from '@azure/storage-blob';
import {
  isConditionalConflict,
  asMissingContainer,
  isNotFound,
  isPreconditionFailed,
  isTransient,
  transientFaultMessage,
} from './azure-errors';
import { collect, destroyBody } from './body';
import { resolveReadTimeoutMs, timedRead } from './read-timeout';
import { newWriteId, storedWriteId, writeIdMetadata } from './write-id';

interface AzureBlobRegistryDriverOptions {
  /** A constructed `@azure/storage-blob` `ContainerClient`, scoped to an existing container. */
  readonly containerClient: ContainerClient;
  /** Optional blob-name prefix under which all registry objects live (e.g. `cloudbitmaps/`). */
  readonly prefix?: string;
  /** Injected clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How long a row's read may take, in ms, its body included, before it is aborted and throws `TransientError`. The
   * clock starts at the call into the SDK, so time waiting for a socket or a credential's token counts. Writes and
   * listings are not timed. `0`, the default, sets no timeout; an integer from 0 to 2,147,483,647.
   */
  readonly readTimeoutMs?: number;
  /**
   * Whether a delete removes a row for good, by a Delete Blob sent with `ifMatch: <the ETag it read>`, rather than
   * leaving a tombstone. Defaults to `true`: Azure Blob applies `If-Match` on a delete, and Azurite does too.
   */
  readonly conditionalDelete?: boolean;
}

/** The calls {@link ObjectStoreRegistry} needs, in Azure's dialect. Exported for the tests that drive one directly. */
export class AzureBlobRegistryStore implements ObjectRegistryStore {
  readonly label = 'Azure Blob';

  constructor(
    private readonly container: ContainerClient,
    private readonly readTimeoutMs: number,
    readonly conditionalDelete: boolean,
  ) {}

  async read(key: string): Promise<ObjectRow | null> {
    const blob = this.container.getBlockBlobClient(key);
    // The read's signal is aborted if it fails or times out, which lets go of a response the SDK refused and left
    // unread, or of one the timer cut off.
    return timedRead('download', this.readTimeoutMs, async (abortSignal) => {
      let res: BlobDownloadResponseParsed;
      try {
        res = await blob.download(0, undefined, {
          abortSignal,
          // The SDK would re-request the rest of a body cut off part-way, from where it stopped; with none, the bytes
          // come from this one response or the read fails.
          maxRetryRequests: 0,
        });
      } catch (err) {
        if (isNotFound(err)) return null;
        // The SDK's own refusal of a response with no ETag or no length.
        if (err instanceof RangeError) {
          throw new IntegrityError(`registry read carries no usable ETag or length: ${key}`);
        }
        throw mapError(err, this.container.containerName);
      }
      try {
        return await readRow(res, key, new URL(blob.url).host, abortSignal);
      } catch (err) {
        throw isIntegrityError(err) ? err : mapError(err, this.container.containerName);
      }
    });
  }

  async write(
    key: string,
    body: Uint8Array,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    const blob = this.container.getBlockBlobClient(key);
    const writeId = newWriteId();
    try {
      await blob.upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: expect === 'absent' ? { ifNoneMatch: '*' } : { ifMatch: expect.version },
        metadata: writeIdMetadata(writeId),
      });
    } catch (err) {
      // A compare-and-swap whose row was deleted since it was read is a lost race, as a delete's 404 already is.
      if (expect !== 'absent' && isNotFound(err)) {
        throw new WriteConflictError(`registry OCC conflict for ${key}`);
      }
      if (!isConditionalConflict(err)) throw mapError(err, this.container.containerName);
      // The client's retry policy may have sent this write again after a lost response, and the replay meets the
      // row it just wrote. The row carries this write's id when that is what happened. The read-back is not
      // definitive: a writer that swapped in over ours before it shows its own id, and ours reports a conflict.
      let stored: string | undefined;
      try {
        stored = await storedWriteId(blob);
      } catch (readErr) {
        throw mapError(readErr, this.container.containerName);
      }
      if (stored === writeId) return;
      throw new WriteConflictError(`registry OCC conflict for ${key}`);
    }
  }

  async delete(key: string, expect: { version: string }): Promise<void> {
    try {
      // The client's retry policy may send this again after a lost response. The precondition names one ETag, so a
      // second copy removes nothing the first could not; one that meets the first's landed delete is a 404, a
      // conflict, and the registry re-reads and finds the row gone.
      await this.container
        .getBlockBlobClient(key)
        .delete({ conditions: { ifMatch: expect.version } });
    } catch (err) {
      // A 412 (the blob moved on) or a 404 (it is gone): the version to delete is not there.
      if (isPreconditionFailed(err) || isNotFound(err)) {
        throw new WriteConflictError(`registry OCC conflict deleting ${key}`);
      }
      throw mapError(err, this.container.containerName);
    }
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    try {
      // The SDK's async iterator pages internally, so this streams rather than draining every page first.
      for await (const item of this.container.listBlobsFlat({ prefix })) {
        yield item.name;
      }
    } catch (err) {
      throw mapError(err, this.container.containerName);
    }
  }
}

/**
 * The row `res` answers: its bytes, read whole and counted as they arrive, and its `ETag`, from this one response.
 *
 * The response is checked before a byte of the body is read, and refused unless it is a `200` (a `206` holds part of
 * the blob) from the container's own host, with an `ETag` and a length no larger than {@link MAX_ROW_BYTES}. The body
 * is refused at the first byte past that length. A refused response is let go: the body stream is destroyed, and the
 * read's request aborted when it fails, so the socket closes rather than holding a response nobody reads.
 */
async function readRow(
  res: BlobDownloadResponseParsed,
  key: string,
  host: string,
  abortSignal: AbortSignal,
): Promise<ObjectRow> {
  const body = res.readableStreamBody;
  if (body === undefined) throw new IntegrityError(`registry read returned no body: ${key}`);
  // Every refusal below is raised before a byte is read, and lets the body go first.
  const refuse = (err: Error): never => {
    destroyBody(body);
    throw err;
  };
  const status = res._response?.status;
  const etag = res.etag;
  const length = res.contentLength;
  if (status !== 200) {
    return refuse(new IntegrityError(`registry read answered HTTP ${status}, not 200: ${key}`));
  }
  // A client whose retry is set to read from a secondary (`retryOptions.secondaryHost`) sends a retried GET there, and a
  // secondary can answer with a row one or more writes behind, under its own ETag. The registry reads strongly, so
  // that answer is refused as transient, and the read is tried again.
  const served = res._response?.request?.url;
  if (served !== undefined && new URL(served).host !== host) {
    return refuse(
      new TransientError(`registry read answered by ${new URL(served).host}, not ${host}: ${key}`),
    );
  }
  if (typeof etag !== 'string' || etag.length === 0) {
    return refuse(new IntegrityError(`registry read carries no ETag: ${key}`));
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return refuse(new IntegrityError(`registry read carries no usable length: ${key}`));
  }
  // On the advertised length, before buffering, so a hostile blob is never materialized.
  if (length > MAX_ROW_BYTES) {
    return refuse(new IntegrityError(`registry object ${length}B exceeds cap ${MAX_ROW_BYTES}B`));
  }
  // Counted as the bytes arrive, against the advertised length, which is within the cap, so a length that
  // understates the body cannot make the read hold more than it said. A body that ends short of its length is the
  // SDK's to refuse, and it does: its stream fails one that ends early, rather than ending it. The length is the
  // bytes on the wire, which a client set to decode a checksummed transfer receives fewer of, so it bounds the bytes
  // here and is not held equal to them.
  const bytes = await collect(
    body,
    abortSignal,
    length,
    () => new IntegrityError(`registry read sent more than ${length}B: ${key}`),
  );
  return { bytes, version: etag };
}

/**
 * Reclassify a transient Azure fault as a retryable {@link TransientError} and a missing container as a
 * `ValidationError`; any other error is passed through.
 */
function mapError(err: unknown, container: string): unknown {
  return toTransient(asMissingContainer(err, container), isTransient, transientFaultMessage);
}

export class AzureBlobRegistryDriver extends ObjectStoreRegistry {
  constructor(options: AzureBlobRegistryDriverOptions) {
    super(
      new AzureBlobRegistryStore(
        options.containerClient,
        resolveReadTimeoutMs(options.readTimeoutMs),
        requireBool('conditionalDelete', options.conditionalDelete) ?? true,
      ),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
