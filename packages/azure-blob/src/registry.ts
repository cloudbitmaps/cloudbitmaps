/**
 * `AzureBlobRegistryDriver` — an {@link IRegistryDriver} over Azure Blob Storage.
 *
 * Lets an **Azure deployment run on one container alone** — storage `.crbm` generations and the registry in the
 * same place, with no second cloud involved.
 *
 * The protocol (an ABA-safe OCC counter, tombstoning delete, the bounded retry, the key layout) lives once
 * in {@link ObjectStoreRegistry}; this file is only the three I/O calls Azure makes.
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
 * that understates it cannot make the read hold more than it said, nor more than the cap.
 *
 * **Deployment requirements** (a policy that violates these silently corrupts the registry):
 * - The principal needs read, write and list on the container (`Storage Blob Data Contributor` covers it).
 * - **Do not apply a lifecycle-management rule to the `registry/` prefix that deletes a current blob** (one that
 *   deletes only previous versions is safe), and do not enable an immutability
 *   policy or legal hold on it: `delete` tombstones by overwriting rather than removing, for ABA-safety, so a
 *   WORM policy would fail every tombstone. See {@link ObjectStoreRegistry}.
 * - Blob versioning and soft delete are neither required nor used; the driver always reads the current blob.
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
import type { BlobDownloadResponseParsed, ContainerClient } from '@azure/storage-blob';
import { isConditionalConflict, isNotFound, isTransient } from './azure-errors';
import { newWriteId, storedWriteId, writeIdMetadata } from './write-id';

export interface AzureBlobRegistryDriverOptions {
  /** A constructed `@azure/storage-blob` `ContainerClient`, scoped to an existing container. */
  readonly containerClient: ContainerClient;
  /** Optional blob-name prefix under which all registry objects live (e.g. `cloudbitmaps/`). */
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
    // Aborted on every refusal: the SDK throws on a response with no ETag or no length and leaves its body unread,
    // with the socket under it open, and this is the one handle on that request left. After a response that was read
    // whole, or answered with an error the SDK read whole, the abort does nothing.
    const request = new AbortController();
    let res: BlobDownloadResponseParsed;
    try {
      res = await blob.download(0, undefined, {
        abortSignal: request.signal,
        // The SDK would re-request the rest of a body cut off part-way, from where it stopped; with none, the bytes
        // come from this one response or the read fails.
        maxRetryRequests: 0,
      });
    } catch (err) {
      request.abort();
      if (isNotFound(err)) return null;
      // The SDK's own refusal of a response with no ETag or no length.
      if (err instanceof RangeError) {
        throw new IntegrityError(`registry read carries no usable ETag or length: ${key}`);
      }
      throw mapError(err);
    }
    try {
      return await readRow(res, key, () => request.abort());
    } catch (err) {
      throw err instanceof IntegrityError ? err : mapError(err);
    }
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
      if (!isConditionalConflict(err)) throw mapError(err);
      // The client's retry policy may have sent this write again after a lost response, and the replay meets the
      // row it just wrote. The row carries this write's id when that is what happened. The read-back is not
      // definitive: a writer that swapped in over ours before it shows its own id, and ours reports a conflict.
      let stored: string | undefined;
      try {
        stored = await storedWriteId(blob);
      } catch (readErr) {
        throw mapError(readErr);
      }
      if (stored === writeId) return;
      throw new WriteConflictError(`registry OCC conflict for ${key}`);
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

/**
 * The row `res` answers: its bytes, read whole and counted as they arrive, and its `ETag`, from this one response.
 *
 * The response is checked before a byte of the body is read, and refused unless it is a `200` (a `206` holds part of
 * the blob) with an `ETag` and a length no larger than {@link MAX_ROW_BYTES}. The body is refused at the first byte
 * past that length, or past the cap. A refused response is let go: the body stream is destroyed and the request
 * aborted, so the socket closes rather than holding a response nobody reads.
 */
function readRow(
  res: BlobDownloadResponseParsed,
  key: string,
  abort: () => void,
): Promise<ObjectRow> {
  return new Promise<ObjectRow>((resolve, reject) => {
    const body: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined =
      res.readableStreamBody;
    if (body === undefined) {
      abort();
      reject(new IntegrityError(`registry read returned no body: ${key}`));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      body.destroy?.();
      abort();
      reject(err);
    };
    // Listened for before anything can end the stream, and for its whole life: a body stream that errors with nothing
    // listening throws out of the event, where no caller can catch it, and the abort makes it error.
    body.on('error', fail);
    // A stream that closes without ending or erring was cut off all the same: a dropped connection, and retryable.
    body.on('close', () =>
      fail(
        Object.assign(new Error('Azure Blob read ended before the response completed'), {
          code: 'ECONNRESET',
        }),
      ),
    );
    const status = res._response?.status;
    const etag = res.etag;
    const length = res.contentLength;
    if (status !== 200) {
      return fail(new IntegrityError(`registry read answered HTTP ${status}, not 200: ${key}`));
    }
    if (typeof etag !== 'string' || etag.length === 0) {
      return fail(new IntegrityError(`registry read carries no ETag: ${key}`));
    }
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return fail(new IntegrityError(`registry read carries no usable length: ${key}`));
    }
    // On the advertised length, before buffering, so a hostile blob is never materialized.
    if (length > MAX_ROW_BYTES) {
      return fail(new IntegrityError(`registry object ${length}B exceeds cap ${MAX_ROW_BYTES}B`));
    }
    // Counted as the bytes arrive, against the advertised length and the cap both, so a length that understates the
    // body cannot make the read hold more than either.
    const bound = Math.min(length, MAX_ROW_BYTES);
    body.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += bytes.length;
      if (total > bound) {
        return fail(new IntegrityError(`registry read sent more than ${bound}B: ${key}`));
      }
      chunks.push(bytes);
    });
    // A body that ends short of its length is the SDK's to refuse, and it does: its stream fails one that ends early,
    // rather than ending it. The length is the bytes on the wire, which a client set to decode a checksummed transfer
    // receives fewer of, so it bounds the bytes here and is not held equal to them.
    body.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ bytes: new Uint8Array(Buffer.concat(chunks, total)), version: etag });
    });
  });
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
