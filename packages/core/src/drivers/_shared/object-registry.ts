/**
 * `ObjectStoreRegistry` — an {@link IRegistryDriver} over any object store with conditional writes.
 *
 * Lets a **read-mostly deployment run on one bucket alone** — cold `.crbm` generations plus the registry in
 * the same place, with no separate database. One tiny JSON object per segment at
 * `<prefix>registry/<ns>/<segment>.reg` holding the `{ deleted, record }` envelope (the same shape LocalFs
 * persists). The OCC token is a monotonic counter, advanced on every mutation and even across a `delete`
 * (which **tombstones** rather than removes the object) so a deleted-then-recreated row never re-issues an
 * old token (ABA-safe) — identical semantics to the LocalFs registry, so it passes the same conformance suite.
 *
 * **The atomic swap is offloaded to the store's conditional writes.** `create` writes only if absent (or
 * over a tombstone under its version), and `compareAndSwap`/`delete` write only if the object still carries
 * the version we read — so a concurrent writer between our read and our write loses, and the loss surfaces
 * as {@link WriteConflictError}. No in-process lock is needed (unlike LocalFs): the precondition fences
 * writers *across processes*.
 *
 * **Why this is shared rather than written per cloud.** Every object store worth using has the same two
 * primitives under different names — S3 `If-None-Match: *` / `If-Match: <etag>`, GCS `ifGenerationMatch: 0`
 * / `ifGenerationMatch: <generation>`, Azure `If-None-Match: *` / `If-Match: <etag>` — so the only thing
 * that differs is three I/O calls, which is what {@link ObjectRegistryStore} abstracts. The parts that are
 * genuinely hard (the ABA-safe counter, the tombstone, the bounded delete retry, the round-trip key check)
 * exist once. Three copies would be three chances for one cloud to drift, and a drifted registry is not a
 * visible bug — it is a lost `currentGen` swap.
 *
 * **Deployment requirements** (a backend that violates these silently corrupts the registry):
 * - The store **must honor the conditional write**. One that accepts the precondition header and ignores it
 *   degrades compare-and-swap to last-write-wins → lost `currentGen` swaps.
 * - Reads must be **strongly consistent** — true of S3 (since 2020), GCS and Azure Blob — since the registry
 *   advertises `strongRead` and generation resolution depends on it.
 * - **Do not apply a lifecycle-expiration rule to the `registry/` prefix.** `delete` tombstones (keeps the
 *   object with an advanced counter) for ABA-safety; expiring a tombstone would let a recreate reset the
 *   token to 0 and re-issue a stale one.
 */
import {
  IntegrityError,
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
import { mapWithConcurrency } from '@/core/concurrency';
import {
  applyRegistryPatch,
  parseRegistryEnvelope,
  recordFromNew,
  registryCounterOf,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  type RegistryEnvelope,
} from './registry';
import { parseRegistryKey, registryListPrefix, registryObjectKey } from './object-registry-keys';

/** Defensive cap on a single registry object read from storage, before allocation (rows are tiny; ~1 KB). */
export const MAX_ROW_BYTES = 1 * 1024 * 1024;
/** Bounded retry for `delete`'s read→tombstone under cross-process contention (converges; then fails typed). */
const MAX_DELETE_ATTEMPTS = 8;
/** In-flight reads per `list()` page — turns the serial N+1 into one list plus bounded parallel reads. */
const LIST_READ_CONCURRENCY = 16;

/** One object as read, with the opaque version that fences a later conditional write. */
export interface ObjectRow {
  readonly bytes: Uint8Array;
  /** The store's version fence — an S3/Azure ETag, a GCS generation. Opaque to this class. */
  readonly version: string;
}

/**
 * The three I/O calls an object store must provide to host a registry. Everything else — the OCC counter,
 * tombstones, the delete retry, key parsing — is implemented once above.
 */
export interface ObjectRegistryStore {
  /** A label for error messages, e.g. `GCS` or `Azure Blob`. */
  readonly label: string;
  /** Read one object, or `null` when it is absent. Must throw {@link TransientError} for retryable faults. */
  read(key: string): Promise<ObjectRow | null>;
  /**
   * Write one object under a precondition: `'absent'` means create-only, a version means
   * compare-and-swap against exactly that version. A lost race MUST throw {@link WriteConflictError}.
   */
  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void>;
  /** Every object key under `prefix`, paginated internally. */
  listKeys(prefix: string): AsyncIterable<string>;
}

export class ObjectStoreRegistry implements IRegistryDriver {
  constructor(
    private readonly store: ObjectRegistryStore,
    private readonly prefix: string | undefined,
    private readonly now: () => number,
  ) {}

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
    // Create-only when truly absent; overwrite the tombstone under its version when recreating. Either way
    // a concurrent create loses the precondition and surfaces as a conflict.
    await this.putRow(key, env, current ? { version: current.version } : 'absent');
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
    // The version we read fences a concurrent writer between that read and this write.
    await this.putRow(key, env, { version: current.version });
    return { token };
  }

  async *list(namespace?: string): AsyncIterable<RegistryRecord> {
    const prefix = registryListPrefix(this.prefix, namespace);
    // One list plus bounded parallel reads. A serial await-in-loop made this O(N) sequential round trips.
    let page: string[] = [];
    const flush = async function* (
      this: ObjectStoreRegistry,
      keys: string[],
    ): AsyncIterable<RegistryRecord> {
      const rows = await mapWithConcurrency(keys, LIST_READ_CONCURRENCY, (key) =>
        this.readRow(key),
      );
      for (const current of rows) {
        if (current && !current.env.deleted) yield current.env.record;
      }
    }.bind(this);

    for await (const key of this.store.listKeys(prefix)) {
      if (parseRegistryKey(this.prefix, key) === null) continue; // stray or foreign object
      page.push(key);
      if (page.length >= LIST_READ_CONCURRENCY) {
        yield* flush(page);
        page = [];
      }
    }
    if (page.length > 0) yield* flush(page);
  }

  async delete(ref: SegmentRef): Promise<void> {
    const key = registryObjectKey(this.prefix, ref);
    // Tombstone (advance the counter) rather than remove the object — keeps the token monotonic for
    // ABA-safety. Retry the read→tombstone on a cross-process race; it converges, then fails typed rather
    // than silently leaving the row live.
    for (let attempt = 0; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
      const current = await this.readRow(key);
      if (current === null || current.env.deleted) return; // idempotent — already gone
      const token = String(registryCounterOf(current.env.record) + 1);
      const env: RegistryEnvelope = {
        deleted: true,
        record: { ...current.env.record, token, updatedAt: this.now() },
      };
      try {
        await this.putRow(key, env, { version: current.version });
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

  /** Read + parse a registry object, returning its envelope and version fence, or null if absent. */
  private async readRow(
    objectKey: string,
  ): Promise<{ env: RegistryEnvelope; version: string } | null> {
    const row = await this.store.read(objectKey);
    if (row === null) return null;
    if (row.bytes.length > MAX_ROW_BYTES) {
      throw new IntegrityError(
        `registry object ${row.bytes.length}B exceeds cap ${MAX_ROW_BYTES}B`,
      );
    }
    if (row.version.length === 0) {
      // The version is the OCC fence for CAS; a backend that omits it cannot be used safely as a registry.
      throw new IntegrityError(
        `registry object has no version fence (needed for compare-and-swap): ${objectKey}`,
      );
    }
    const env = parseRegistryEnvelope(new TextDecoder().decode(row.bytes), objectKey);
    return { env, version: row.version };
  }

  /** Conditional write of an envelope. The store maps a lost precondition to {@link WriteConflictError}. */
  private async putRow(
    objectKey: string,
    env: RegistryEnvelope,
    expect: 'absent' | { version: string },
  ): Promise<void> {
    const body = new TextEncoder().encode(serializeRegistryEnvelope(env));
    if (body.length > MAX_ROW_BYTES) {
      // Belt-and-braces: the governance/DEK fields are already capped by validate*, so this cannot fire for
      // valid input — but never write a row that would later be unreadable.
      throw new ValidationError(`registry object ${body.length}B exceeds cap ${MAX_ROW_BYTES}B`);
    }
    await this.store.write(objectKey, body, expect);
  }
}
