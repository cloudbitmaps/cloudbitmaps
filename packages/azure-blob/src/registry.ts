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
  MAX_ROW_BYTES,
  ObjectStoreRegistry,
  TransientError,
  ValidationError,
  WriteConflictError,
  normalizeObjectPrefix,
} from '@cloudbitmaps/core/driver-kit';
import type { ObjectRegistryStore, ObjectRow } from '@cloudbitmaps/core/driver-kit';
import type { BlobDownloadResponseParsed, ContainerClient } from '@azure/storage-blob';
import {
  isConditionalConflict,
  isNotFound,
  isPreconditionFailed,
  isTransient,
} from './azure-errors';
import { resolveReadTimeoutMs, timedRead } from './read-timeout';
import { newWriteId, storedWriteId, writeIdMetadata } from './write-id';

export interface AzureBlobRegistryDriverOptions {
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
   * leaving a tombstone. Only a row born with an incarnation id is removed; a row a release before 0.12 wrote is
   * always tombstoned. Defaults to `true`: Azure Blob applies `If-Match` on a delete, and Azurite does too.
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
        throw mapError(err);
      }
      try {
        return await readRow(res, key, new URL(blob.url).host);
      } catch (err) {
        throw err instanceof IntegrityError ? err : mapError(err);
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

/**
 * The row `res` answers: its bytes, read whole and counted as they arrive, and its `ETag`, from this one response.
 *
 * The response is checked before a byte of the body is read, and refused unless it is a `200` (a `206` holds part of
 * the blob) from the container's own host, with an `ETag` and a length no larger than {@link MAX_ROW_BYTES}. The body
 * is refused at the first byte past that length. A refused response is let go: the body stream is destroyed, and the
 * read's request aborted when it fails, so the socket closes rather than holding a response nobody reads.
 */
function readRow(res: BlobDownloadResponseParsed, key: string, host: string): Promise<ObjectRow> {
  return new Promise<ObjectRow>((resolve, reject) => {
    const body: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined =
      res.readableStreamBody;
    if (body === undefined) {
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
      reject(err);
    };
    // Listened for before anything can end the stream, and for its whole life: a body stream that errors with nothing
    // listening throws out of the event, where no caller can catch it, and an abort makes it error. The read is aborted
    // only once it has failed, or by its timer, whose error the read has already thrown, so an `AbortError` this read
    // settles with is the SDK's word for a connection cut off mid-body.
    body.on('error', (err: unknown) =>
      fail(
        (err as { name?: unknown } | null)?.name === 'AbortError'
          ? Object.assign(
              new Error('Azure Blob read was cut off before the response completed', {
                cause: err,
              }),
              {
                code: 'ECONNRESET',
              },
            )
          : err,
      ),
    );
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
    // A client whose retry is set to read from a secondary (`retryOptions.secondaryHost`) sends a retried GET there, and a
    // secondary can answer with a row one or more writes behind, under its own ETag. The registry reads strongly, so
    // that answer is refused as transient, and the read is tried again.
    const served = res._response?.request?.url;
    if (served !== undefined && new URL(served).host !== host) {
      return fail(
        new TransientError(
          `registry read answered by ${new URL(served).host}, not ${host}: ${key}`,
        ),
      );
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
    // Counted as the bytes arrive, against the advertised length, which is within the cap, so a length that
    // understates the body cannot make the read hold more than it said.
    body.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += bytes.length;
      if (total > length) {
        return fail(new IntegrityError(`registry read sent more than ${length}B: ${key}`));
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

/** {@link AzureBlobRegistryDriverOptions.conditionalDelete}, checked, or its default (on). */
function resolveConditionalDelete(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`conditionalDelete must be a boolean; got ${String(value)}`);
  }
  return value;
}

export class AzureBlobRegistryDriver extends ObjectStoreRegistry {
  constructor(options: AzureBlobRegistryDriverOptions) {
    super(
      new AzureBlobRegistryStore(
        options.containerClient,
        resolveReadTimeoutMs(options.readTimeoutMs),
        resolveConditionalDelete(options.conditionalDelete),
      ),
      normalizeObjectPrefix(options.prefix),
      options.now ?? ((): number => Date.now()),
    );
  }
}
