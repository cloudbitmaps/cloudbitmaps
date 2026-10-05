/**
 * `ObjectStoreRegistry` — an {@link IRegistryDriver} over any object store with conditional writes.
 *
 * Lets a **read-mostly deployment run on one bucket alone** — storage `.crbm` generations plus the registry in
 * the same place, with no separate database. One tiny JSON object per segment at
 * `<prefix>registry/<ns>/<segment>.reg` holding the `{ deleted, record }` envelope (the same shape LocalFs
 * persists). The OCC token is a random incarnation id drawn when the row is created, a counter advanced on every
 * mutation, and a random part drawn for every write, so with overwhelming probability a deleted-then-recreated row, or
 * one restored from a backup, never re-issues an old token (ABA-safe) — identical semantics to the LocalFs registry, so it passes the same
 * conformance suite.
 *
 * **`delete` removes a row for good where the store vouches for a conditional delete** (`If-Match: <etag>`,
 * `ifGenerationMatch: <generation>`), and only a row whose token carries an incarnation id: a re-create draws a new
 * incarnation, so nothing of the old row is needed to keep its tokens apart, and a full `list()` no longer reads a
 * row for every name it ever held. Every other row is **tombstoned**: the object stays, its counter advanced, and a
 * re-create carries the counter on. A row a release before 0.12 wrote has a bare decimal token and is always
 * tombstoned, since a process still on that release, re-creating the name over nothing, would start its counter at 0
 * again and issue the old row's tokens.
 *
 * **The atomic swap is offloaded to the store's conditional writes.** `create` writes only if absent (or
 * over a tombstone under its version), and `compareAndSwap`/`delete` write (or delete) only if the object still
 * carries the version we read — so a concurrent writer between our read and our write loses, and the loss surfaces
 * as {@link WriteConflictError}. No in-process lock is needed (unlike LocalFs): the precondition fences
 * writers *across processes*.
 *
 * **A caller that already read the row can spare the read before its write.** `get` remembers the version of the
 * object it read, against the record it returned. A `compareAndSwap` handed that very record as `held` conditions its
 * write on that version and sends it at once, and a `create` handed `null` (the caller found no row) sends its
 * create-only write at once. The store's condition stays the fence: a row that changed since fails the write as a lost
 * race, so a stale `held` can lose a write and never land one. A record this registry did not return (a copy, another
 * registry's) is read for as without the hint.
 *
 * **Why this is shared rather than written per cloud.** Every object store worth using has the same two
 * primitives under different names — S3 `If-None-Match: *` / `If-Match: <etag>`, GCS `ifGenerationMatch: 0`
 * / `ifGenerationMatch: <generation>`, Azure `If-None-Match: *` / `If-Match: <etag>` — so the only thing
 * that differs is a few I/O calls, which is what {@link ObjectRegistryStore} abstracts. The parts that are
 * genuinely hard (the ABA-safe token, the delete and its tombstone, the bounded delete retry, the round-trip key check)
 * exist once. Three copies would be three chances for one cloud to drift, and a drifted registry is not a
 * visible bug — it is a lost `currentGen` swap.
 *
 * **Deployment requirements** (a backend that violates these silently corrupts the registry):
 * - The store **must honor the conditional write**. One that accepts the precondition header and ignores it
 *   degrades compare-and-swap to last-write-wins → lost `currentGen` swaps.
 * - Reads must be **strongly consistent** — true of S3 (since 2020), GCS and Azure Blob — since the registry
 *   advertises `strongRead` and generation resolution depends on it.
 * - **Do not apply a lifecycle-expiration rule to the `registry/` prefix that expires a current version.**
 *   Expiring a live row loses its pointer. A tombstone `delete` left keeps the counter for a re-create; one expired
 *   by a rule is no worse than a row removed for good, since a recreate draws a fresh incarnation and its tokens are
 *   new but for a collision of probability 2^-128 per pair of incarnations, but a rule cannot tell a tombstone from a
 *   live row.
 * - **A store's conditional delete must be honoured by its backend** before the store sets `conditionalDelete`.
 *   One that ignores the precondition lets two sweepers and a re-create delete a live row.
 *
 * **`list()` is fail-closed, and one bad object stops it for everyone.** An object under the `registry/`
 * prefix whose key parses but whose body does not aborts the whole enumeration — every namespace, not just
 * the affected segment — and it stays that way until an operator removes the object. The error names the
 * offending key.
 *
 * That is the deliberate choice, and it is the *safer* one rather than the more convenient one. Skipping the
 * unreadable row would keep discovery running, but `list()` is what tells orphan generation collection which
 * segments exist: a row missing from the enumeration makes its storage `.crbm` generations look unreferenced,
 * and the next GC pass would delete them. Silently skipping turns a parse error into data loss. Refusing to
 * enumerate keeps every sweep off a set it cannot vouch for (invariant 5 — bytes from the tier are
 * untrusted). **Recovery:** read the named object, and either restore a valid envelope or delete it; nothing
 * else is damaged, and discovery resumes on its own.
 */
import {
  IntegrityError,
  TransientError,
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
  RegistryWriteOptions,
  SegmentRef,
  Token,
} from '@/core/ports';
import type { Entropy } from '@/core/determinism';
import { mapWithConcurrency } from '@/core/concurrency';
import {
  applyRegistryPatch,
  incarnationOf,
  newIncarnationToken,
  nextRegistryToken,
  parseRegistryEnvelope,
  recordFromNew,
  serializeRegistryEnvelope,
  validateNewRegistryRecord,
  validateRegistryPatch,
  type RegistryEnvelope,
} from './registry';
import { entropyIsAvailable, webCryptoEntropy } from './entropy';
import { parseRegistryKey, registryListPrefix, registryObjectKey } from './object-registry-keys';

/** Defensive cap on a single registry object read from storage, before allocation (rows are tiny; ~1 KB). */
export const MAX_ROW_BYTES = 1 * 1024 * 1024;
/** Bounded retry for `delete`'s read then delete or tombstone, under cross-process contention (then fails typed). */
const MAX_DELETE_ATTEMPTS = 8;
/** Bounded re-read when a store's pinned version is overwritten mid-read (see {@link ObjectVersionRaced}). */
const MAX_READ_ATTEMPTS = 8;
/** In-flight reads per `list()` page — turns the serial N+1 into one list plus bounded parallel reads. */
const LIST_READ_CONCURRENCY = 48;

/**
 * Raised by a store when the version it pinned for a read vanished before it could fetch the bytes —
 * a concurrent writer overwrote or deleted the object in between.
 *
 * This is deliberately **neither** of the two things it superficially resembles. It is not absence: the row
 * is very likely still live, just one version further on. And it is not a write conflict: the caller may be
 * a read-only `get()`, which has nothing to conflict with. Either is an easy misreading for a store that reads a
 * row in two calls, metadata and then bytes pinned to it, which is why the signal is part of the port rather than
 * left to each store's judgement. {@link ObjectStoreRegistry} answers it the only way that is correct for every
 * caller: it reads again.
 *
 * Stores whose read is atomic can never raise it, and every shipped store's is: S3 serves bytes and `ETag` from one
 * `GetObject`, GCS bytes and `generation` from one GET, and Azure Blob bytes and `ETag` from one GET.
 */
export class ObjectVersionRaced extends Error {
  constructor(objectKey: string) {
    super(`registry object was overwritten mid-read: ${objectKey}`);
    this.name = 'ObjectVersionRaced';
  }
}

/** One object as read, with the opaque version that fences a later conditional write. */
export interface ObjectRow {
  readonly bytes: Uint8Array;
  /** The store's version fence — an S3/Azure ETag, a GCS generation. Opaque to this class. */
  readonly version: string;
}

/**
 * The I/O calls an object store must provide to host a registry: three, and an optional conditional delete. Everything
 * else — the OCC token, tombstones, the delete retry, key parsing — is implemented once above.
 */
export interface ObjectRegistryStore {
  /** A label for error messages, e.g. `GCS` or `Azure Blob`. */
  readonly label: string;
  /**
   * Read one object, or `null` when it is absent.
   *
   * **`null` means the object does not exist** — nothing weaker. A store that reads in two round trips
   * (metadata for the version fence, then the bytes pinned to it) can find that version already gone; it
   * MUST report that with {@link ObjectVersionRaced} rather than `null` or {@link WriteConflictError}, and
   * the caller re-reads. Retryable faults throw {@link TransientError}.
   *
   * `bytes` and `version` MUST describe the **same** observation of the object: `version` is the fence a
   * later conditional write is conditioned on, so a pair drawn from two different versions would either
   * fail a write that should have succeeded or, worse, pass one that should not.
   */
  read(key: string): Promise<ObjectRow | null>;
  /**
   * Write one object under a precondition: `'absent'` means create-only, a version means
   * compare-and-swap against exactly that version. A lost race MUST throw {@link WriteConflictError}.
   *
   * A store must not replay this write after a lost response without telling the replay apart: the replay meets
   * the row it just wrote and its precondition fails, which would read as a lost race. Send it once, or store a
   * write id with the row and treat a conflict whose stored row carries it as success. Retryable faults throw
   * {@link TransientError}.
   */
  write(key: string, body: Uint8Array, expect: 'absent' | { version: string }): Promise<void>;
  /** Every object key under `prefix`, paginated internally. */
  listKeys(prefix: string): AsyncIterable<string>;
  /**
   * Optional: delete one object, and only while it is still at exactly `expect.version`, by a precondition the
   * backend applies (`If-Match: <etag>`, `ifGenerationMatch: <generation>`). An object that was overwritten, or is
   * gone, MUST throw {@link WriteConflictError} and delete nothing. Retryable faults throw {@link TransientError}.
   *
   * Sending it again after a lost response is safe, unlike a write: the precondition names one version, so a second
   * copy can remove nothing the first was not allowed to. A copy that meets its own landed delete fails the
   * precondition and reports a conflict; the registry re-reads, and finds the row gone.
   *
   * The registry calls it only when {@link conditionalDelete} is `true`.
   */
  delete?(key: string, expect: { version: string }): Promise<void>;
  /**
   * Whether {@link delete} may be relied on: `true` only where the backend is known to apply the precondition. A
   * backend that accepts the header and ignores it would let a delete remove a row written after the delete read it,
   * a live one included. Absent or `false`, the registry never calls `delete` and tombstones every row instead.
   */
  readonly conditionalDelete?: boolean;
}

/** A row as read: its envelope, the bytes it was parsed from, and the version that fences a write to it. */
interface ReadRow extends ObjectRow {
  readonly env: RegistryEnvelope;
}

/** What a record `get` returned was read from. */
interface ObservedRow extends ObjectRow {
  readonly key: string;
}

export class ObjectStoreRegistry implements IRegistryDriver {
  /**
   * `entropy` draws the random parts of every token: a new row's incarnation id, and each write's own part. It
   * defaults to the platform's Web Crypto. Inject one only to make a test replayable: a seeded source in production
   * gives every process the same ids.
   */
  constructor(
    private readonly store: ObjectRegistryStore,
    private readonly prefix: string | undefined,
    private readonly now: () => number,
    private readonly entropy: Entropy = webCryptoEntropy,
  ) {}

  capabilities(): RegCaps {
    const conditionalDelete = this.removesRows();
    return entropyIsAvailable(this.entropy)
      ? { strongRead: true, conditionalDelete }
      : { strongRead: true, canWrite: false, conditionalDelete };
  }

  /** Whether a delete removes a row born with an incarnation id: the store has a delete, and vouches for it. */
  private removesRows(): boolean {
    return this.store.conditionalDelete === true && typeof this.store.delete === 'function';
  }

  /** The object each record `get` returned was read from, to fence a write made against it ({@link RegistryWriteOptions.held}). */
  private readonly observed = new WeakMap<RegistryRecord, ObservedRow>();

  async get(ref: SegmentRef): Promise<RegistryRecord | null> {
    const key = registryObjectKey(this.prefix, ref);
    const row = await this.readRow(key);
    if (row === null || row.env.deleted) return null;
    this.observed.set(row.env.record, { key, bytes: row.bytes, version: row.version });
    return row.env.record;
  }

  async create(
    ref: SegmentRef,
    record: NewRegistryRecord,
    options?: RegistryWriteOptions,
  ): Promise<{ token: Token }> {
    const checked = validateNewRegistryRecord(record);
    const key = registryObjectKey(this.prefix, ref);
    if (options?.held === null) {
      // The caller found no row: send the create-only write without reading. A row there now (or a tombstone, which a
      // create-only write cannot go over) fails it, and the read below says which.
      try {
        return await this.createOver(key, ref, checked, undefined);
      } catch (err) {
        if (!isWriteConflictError(err)) throw err;
      }
    }
    const current = await this.readRow(key);
    if (current !== null && !current.env.deleted) {
      throw new WriteConflictError(`registry row already exists for segment ${ref.segment}`);
    }
    return this.createOver(key, ref, checked, current ?? undefined);
  }

  /** Write a new incarnation of the row: over `tombstone` under its version, or create-only when there is none. */
  private async createOver(
    key: string,
    ref: SegmentRef,
    checked: NewRegistryRecord,
    tombstone: ReadRow | undefined,
  ): Promise<{ token: Token }> {
    // A new incarnation, whose counter continues across a tombstone, so with overwhelming probability a recreate never re-issues an old token.
    const token = newIncarnationToken(this.entropy, tombstone?.env.record);
    const env: RegistryEnvelope = {
      deleted: false,
      record: recordFromNew(ref, checked, this.now(), token),
    };
    // Create-only when truly absent; overwrite the tombstone under its version when recreating. Either way
    // a concurrent create loses the precondition and surfaces as a conflict.
    await this.putRow(key, env, tombstone ? { version: tombstone.version } : 'absent');
    return { token };
  }

  async compareAndSwap(
    ref: SegmentRef,
    expected: Token,
    patch: RegistryPatch,
    options?: RegistryWriteOptions,
  ): Promise<{ token: Token }> {
    const checked = validateRegistryPatch(patch);
    const key = registryObjectKey(this.prefix, ref);
    // The row the caller read, as this registry read it, when it is the row `expected` names; otherwise read it now.
    const current = this.observedRow(key, expected, options?.held) ?? (await this.readRow(key));
    if (current === null || current.env.deleted || current.env.record.token !== expected) {
      throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
    }
    const token = nextRegistryToken(current.env.record, this.entropy);
    const env: RegistryEnvelope = {
      deleted: false,
      record: applyRegistryPatch(current.env.record, checked, this.now(), token),
    };
    // The version we read fences a concurrent writer between that read and this write.
    await this.putRow(key, env, { version: current.version });
    return { token };
  }

  /**
   * The row a caller's `held` record was read as, decoded again from the bytes `get` saw so that nothing the caller did
   * to its copy reaches the write, or `undefined` when `held` is not a record this registry returned for this row under
   * the token the write expects. The version it carries is the store's fence, so a row that has moved on since fails
   * the write.
   */
  private observedRow(
    key: string,
    expected: Token,
    held: RegistryRecord | null | undefined,
  ): ReadRow | undefined {
    const seen = held ? this.observed.get(held) : undefined;
    if (seen === undefined || seen.key !== key || held?.token !== expected) return undefined;
    return this.decodeRow(key, seen);
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

  async delete(ref: SegmentRef, expected?: Token): Promise<void> {
    const key = registryObjectKey(this.prefix, ref);
    // A row born with an incarnation id is removed from the store, by a delete the store applies only while the
    // object is still the version read here: a later create draws a new incarnation, so nothing of this row is needed
    // to keep its tokens apart. Any other row is tombstoned (the counter advanced, the object kept), so a re-create
    // carries the counter on. Retry the read and the write on a cross-process race; it converges, then fails typed
    // rather than silently leaving the row live.
    for (let attempt = 0; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
      const current = await this.readRow(key);
      if (expected !== undefined) {
        // Fenced: the row must still carry the token the caller read. Re-checked on every attempt, so a row
        // that was swapped, or deleted and re-created, between two attempts is refused rather than tombstoned.
        if (current === null || current.env.deleted || current.env.record.token !== expected) {
          throw new WriteConflictError(`OCC token mismatch for registry row ${ref.segment}`);
        }
      } else if (current === null || current.env.deleted) {
        return; // idempotent — already gone
      }
      try {
        const remove = this.removesRows() ? this.store.delete : undefined;
        if (remove !== undefined && incarnationOf(current.env.record.token) !== undefined) {
          // The version read above is the row the caller's token names, so this removes that row and no later one.
          await remove.call(this.store, key, { version: current.version });
          return;
        }
        const token = nextRegistryToken(current.env.record, this.entropy);
        const env: RegistryEnvelope = {
          deleted: true,
          record: { ...current.env.record, token, updatedAt: this.now() },
        };
        await this.putRow(key, env, { version: current.version });
        return;
      } catch (err) {
        if (isWriteConflictError(err)) continue; // raced — re-read and try again
        throw err;
      }
    }
    throw new WriteConflictError(`registry delete: contention deleting "${ref.segment}" — retry`);
  }

  /**
   * Read + parse a registry object, returning its envelope and version fence, or null if absent.
   *
   * A store that pins a version to read consistently ({@link ObjectVersionRaced}) loses that pin whenever a
   * concurrent writer lands mid-read. Re-reading is the whole answer — the next read simply observes the
   * newer version — and it is bounded so a row under permanent write saturation fails typed instead of
   * spinning. Only a store that reads in two calls gets here; none of the shipped stores does.
   */
  private async readRow(objectKey: string): Promise<ReadRow | null> {
    const row = await this.readRaced(objectKey);
    return row === null ? null : this.decodeRow(objectKey, row);
  }

  /** Check and parse the bytes of a registry object. */
  private decodeRow(objectKey: string, row: ObjectRow): ReadRow {
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
    return { env, bytes: row.bytes, version: row.version };
  }

  /** {@link ObjectRegistryStore.read}, retrying the bounded number of times a mid-read overwrite allows. */
  private async readRaced(objectKey: string): Promise<ObjectRow | null> {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      try {
        return await this.store.read(objectKey);
      } catch (err) {
        if (!(err instanceof ObjectVersionRaced)) throw err;
      }
    }
    throw new TransientError(
      `registry read: ${this.store.label} object "${objectKey}" was overwritten on every one of ` +
        `${MAX_READ_ATTEMPTS} attempts — retry`,
    );
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
