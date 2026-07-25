/**
 * `MongoWarmDriver` — an {@link IWarmDriver} over MongoDB / DocumentDB (Phase 7).
 *
 * Uses the official `mongodb` driver, an **optional peer dependency** — only consumers of
 * `cloud-roaring/mongodb` install it. A `Db` is **injected** (dependency injection): the driver owns no
 * connection/credential logic, so it's thin and reuses the caller's client.
 *
 * Each chunk is one document keyed by a deterministic composite `_id` (`<prefix>|<ns>|<seg>|<chunkKey>`) with
 * an opaque OCC **token** (a random UUID per write) and the delta `payload` (BSON binary). Optimistic
 * concurrency is per-document and server-side:
 * - **create-if-absent** = `insertOne` with that `_id`; a duplicate-key error ⇒ {@link WriteConflictError}.
 * - **token-fenced update / delete** = `updateOne` / `deleteOne` filtered on `{ _id, token: expected }`; a 0
 *   matched/deleted count ⇒ {@link WriteConflictError}.
 *
 * Each op is a single-document atomic operation, so no transaction is needed. Tokens are not reused across
 * delete→recreate (ABA-safe, D3 — probabilistic random UUID, like the Postgres/Redis drivers). Reads are
 * strongly consistent when the `Db` targets the primary (majority/primary read preference), which the OCC
 * read-modify-write requires — see the `db` option note. Drivers may use `node:crypto`.
 */
import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef, IWarmDriver, NoRow, SegmentRef, Token, WarmRow } from '@/core/ports';
import { chunkDocId, normalizeKeyPrefix, segmentScope } from './keys';
import { isDuplicateKey, isTransient } from './mongodb-errors';

const DEFAULT_COLLECTION = 'cloud_roaring_warm';
const INDEX_NAME = 'cr_warm_scope_ck';
/** find() cursor batch — bounds resident docs on a very wide segment. */
const DEFAULT_BATCH = 500;
/**
 * Force **binary (byte-exact) comparison** on every op + the index, overriding any case-/diacritic-insensitive
 * *default* collation the collection may have been created with. Grammar-legal segment/namespace names differ
 * only by case (`"A"` vs `"a"`) are distinct stores; under a case-insensitive default collation an unpinned
 * `findOne({_id})` / `updateOne` / `deleteOne` would match the *wrong* document → cross-segment read/leak and
 * wrong-doc OCC updates. This is the Mongo analogue of the MySQL `utf8mb4_bin` requirement. Operation-level
 * collation is binary in the common (no-default-collation) case, so this is a no-op there and a fix otherwise.
 * NOTE: `insertOne` uniqueness is governed by the `_id` index's collation, which cannot be overridden per-op —
 * so a collection created with a case-insensitive **default** collation can still collapse `"a"`/`"A"` on
 * *insert* (a spurious create-if-absent conflict, not a data leak). The operator guide states the warm
 * collection must use the simple default collation; this pin closes the get/update/delete/list matching hole.
 */
const SIMPLE_COLLATION = { locale: 'simple' } as const;

/** One warm chunk document. */
interface WarmDoc {
  _id: string;
  kp: string;
  ns: string;
  seg: string;
  ck: number;
  token: string;
  payload: unknown; // written as a Node Buffer; read back as a BSON Binary (or Buffer if promoteBuffers)
}

export interface MongoWarmDriverOptions {
  /**
   * A `mongodb` `Db` (the driver calls `db.collection(...)`). The driver never connects/closes the client —
   * the caller owns its lifecycle. Reads must be strongly consistent for OCC (read-your-writes): use a
   * primary read preference (the default), not `secondary`/`secondaryPreferred`.
   */
  readonly db: Db;
  /** Warm collection name (default `cloud_roaring_warm`). */
  readonly collection?: string;
  /** Optional key-prefix component of the composite `_id` so several logical stores can share one collection. */
  readonly keyPrefix?: string;
  /** Advanced: `listChunks` cursor batch size (default 500). Tunes peak memory on wide segments. */
  readonly listPageSize?: number;
}

/**
 * Create the index `listChunks` needs — `{ kp, ns, seg, ck }` (scope filter + numeric ascending sort) —
 * idempotently. **Run this once at deploy time — it is effectively required, not merely an optimization:**
 * without it a `listChunks` over a segment whose dirty backlog exceeds MongoDB's 32 MB in-memory-sort ceiling
 * fails (server error 292, `QueryExceededMemoryLimitNoDiskUseAllowedException`) rather than merely running
 * slow. (create-if-absent needs no extra index — the composite `_id` is inherently unique.)
 */
export async function ensureMongoWarmIndexes(
  db: Db,
  collection: string = DEFAULT_COLLECTION,
): Promise<void> {
  await db
    .collection(collection)
    .createIndex(
      { kp: 1, ns: 1, seg: 1, ck: 1 },
      { name: INDEX_NAME, collation: SIMPLE_COLLATION },
    );
}

export class MongoWarmDriver implements IWarmDriver {
  private readonly col: Collection<WarmDoc>;
  private readonly keyPrefix: string;
  private readonly batch: number;

  constructor(options: MongoWarmDriverOptions) {
    this.keyPrefix = normalizeKeyPrefix(options.keyPrefix);
    const batch = options.listPageSize ?? DEFAULT_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new ValidationError(`listPageSize must be a positive safe integer; got ${batch}`);
    }
    this.batch = batch;
    this.col = options.db.collection<WarmDoc>(options.collection ?? DEFAULT_COLLECTION);
  }

  // Reads are strongly consistent when the Db targets the primary (see the `db` option), so the optional
  // `WarmReadOptions` hint would be a no-op — the structurally-optional param is simply omitted, as in the
  // LocalFs / Postgres / Redis drivers.
  async get(ref: ChunkRef): Promise<WarmRow | null> {
    const _id = chunkDocId(this.keyPrefix, ref); // validates ref
    let doc: WarmDoc | null;
    try {
      doc = await this.col.findOne({ _id }, { collation: SIMPLE_COLLATION });
    } catch (err) {
      throw this.mapError(err);
    }
    return doc === null ? null : this.rowFrom(doc, ref.chunkKey);
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    const _id = chunkDocId(this.keyPrefix, ref); // validates ref
    const token = randomUUID();
    const payload = Buffer.from(bytes); // copy: severs any caller-owned/reused input buffer; stored as Binary
    try {
      if (expected === NO_ROW) {
        const { kp, ns, seg } = segmentScope(this.keyPrefix, ref);
        await this.col.insertOne({ _id, kp, ns, seg, ck: ref.chunkKey, token, payload });
      } else {
        const res = await this.col.updateOne(
          { _id, token: expected },
          { $set: { token, payload } },
          { collation: SIMPLE_COLLATION },
        );
        if (res.matchedCount !== 1) {
          throw new WriteConflictError(`OCC conflict on chunk ${ref.chunkKey}`);
        }
      }
      return { token };
    } catch (err) {
      // A duplicate `_id` is the deterministic create-if-absent conflict — never a transient.
      if (isDuplicateKey(err)) {
        throw new WriteConflictError(`chunk ${ref.chunkKey} already exists (create-if-absent)`);
      }
      throw this.mapError(err); // WriteConflictError (from the update branch) passes straight through
    }
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    const _id = chunkDocId(this.keyPrefix, ref); // validates ref
    let deletedCount: number;
    try {
      deletedCount = (
        await this.col.deleteOne({ _id, token: expected }, { collation: SIMPLE_COLLATION })
      ).deletedCount;
    } catch (err) {
      throw this.mapError(err);
    }
    if (deletedCount !== 1) {
      throw new WriteConflictError(`fenced-delete conflict on chunk ${ref.chunkKey}`);
    }
  }

  async *listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
    const scope = segmentScope(this.keyPrefix, ref); // validates ref
    // The driver's cursor streams in `batchSize` batches, so peak memory is bounded on a wide segment; the
    // `{ kp, ns, seg, ck }` index (ensureMongoWarmIndexes) serves the filter + numeric ascending sort — and is
    // effectively required: without it a wide segment's sort spills past MongoDB's 32 MB in-memory-sort limit
    // and errors (292), not just runs slow.
    const cursor = this.col
      .find(scope, { collation: SIMPLE_COLLATION })
      .sort({ ck: 1 })
      .batchSize(this.batch);
    try {
      for await (const doc of cursor) {
        // Validate the yielded chunkKey (untrusted-data posture, like the sibling drivers) — a foreign/corrupt
        // doc matching the scope but lacking a numeric `ck` must not surface as `{ chunkKey: undefined }`.
        if (typeof doc.ck !== 'number') {
          throw new IntegrityError('warm doc is missing its numeric chunk key (ck)');
        }
        yield { chunkKey: doc.ck, ...this.rowFrom(doc, doc.ck) };
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Build a {@link WarmRow} from a doc; reject one missing/!typed fields (corrupt/foreign). */
  private rowFrom(doc: WarmDoc, chunkKey: number): WarmRow {
    if (typeof doc.token !== 'string' || doc.token === '') {
      throw new IntegrityError(`warm doc for chunk ${chunkKey} is missing its token`);
    }
    return { token: doc.token, bytes: decodePayload(doc.payload, chunkKey) };
  }

  /** Reclassify a transient Mongo fault as a retryable {@link TransientError}; else propagate unchanged. */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient MongoDB fault: ${(err as { message?: unknown } | null)?.message ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}

/**
 * Decode a stored payload to owned bytes, duck-typed so the driver needs no runtime `mongodb`/`bson` import
 * (kept `import type`, so `cloud-roaring/mongodb`'s built bundle has no runtime SDK dependency). A Node
 * `Buffer` is a `Uint8Array` (the `promoteBuffers` case); a BSON `Binary` exposes its bytes on `.buffer`.
 */
function decodePayload(p: unknown, chunkKey: number): Uint8Array {
  if (p instanceof Uint8Array) return new Uint8Array(p); // Buffer / Uint8Array — copy
  const inner = (p as { buffer?: unknown } | null)?.buffer; // BSON Binary → .buffer is a Buffer
  if (inner instanceof Uint8Array) return new Uint8Array(inner);
  throw new IntegrityError(`warm doc for chunk ${chunkKey} has no readable payload`);
}
