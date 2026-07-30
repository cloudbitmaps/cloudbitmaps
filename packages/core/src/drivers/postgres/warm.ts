/**
 * `PostgresWarmDriver` — an {@link IWarmDriver} over PostgreSQL (Phase 7).
 *
 * "No DynamoDB — use the Postgres you already run." Uses the official `pg` (node-postgres), an **optional
 * peer dependency** — only consumers of `cloud-roaring/postgres` install it. A `pg.Pool` is **injected**
 * (dependency injection): the driver owns no connection/credential logic, so it's thin, reuses the caller's
 * pool, and is testable against a Postgres container.
 *
 * Each chunk is one row in a single table (`PRIMARY KEY (key_prefix, namespace, segment, chunk_key)`), with
 * an opaque OCC **token** (a random UUID minted per write) and the delta `payload` (bytea). Optimistic
 * concurrency is real, cross-process, and server-side:
 * - **create-if-absent** = `INSERT … ON CONFLICT DO NOTHING`; 0 rows affected ⇒ the row already exists ⇒
 *   {@link WriteConflictError}.
 * - **token-fenced update / delete** = `UPDATE … / DELETE … WHERE … AND token = :expected`; 0 rows affected
 *   ⇒ the stored token moved (or the row is gone) ⇒ {@link WriteConflictError}.
 *
 * Tokens are not reused across delete→recreate (ABA-safe, D3): a delete removes the row and a recreate mints
 * a fresh random UUID, so a token from before the delete won't match. (This is a *probabilistic* guarantee —
 * a random 122-bit UUIDv4, collision odds negligible — vs the DynamoDB driver's *structural* monotonic-counter
 * guarantee; the hard-delete/no-tombstone model can't offer the latter, and conformance D3 pins the behavior.)
 * Reads are strongly consistent (single primary), so the optional `WarmReadOptions` consistency hint is a
 * no-op, like the in-memory / LocalFs drivers. Drivers may use `node:crypto`; only `core/` is determinism-bound.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  IntegrityError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isWriteConflictError,
} from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef, IWarmDriver, NoRow, SegmentRef, Token, WarmRow } from '@/core/ports';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';
import { namespacePart } from '../_shared/keys';
import { normalizeKeyPrefix, validateAndQuoteTable } from './keys';
import { isTransient } from './postgres-errors';

const DEFAULT_TABLE = 'cloud_roaring_warm';
/** Default listChunks keyset-pagination batch — bounds peak memory to ~this many rows regardless of width. */
const DEFAULT_LIST_BATCH = 1000;

export interface PostgresWarmDriverOptions {
  /**
   * A constructed `pg.Pool` (or a pool-compatible client). The driver never opens/closes connections — the
   * caller owns the pool's lifecycle. It **must target the primary**: reads are treated as strongly
   * consistent (the OCC read-modify-write needs read-your-writes), so a pool pointed at a read replica /
   * hot standby could serve stale rows and silently break OCC.
   */
  readonly pool: Pool;
  /** Warm table name — identifier or `schema.table` (default `cloud_roaring_warm`). Must already exist. */
  readonly table?: string;
  /** Optional key-prefix column value so several logical stores can share one table (bound as data). */
  readonly keyPrefix?: string;
  /** Advanced: `listChunks` keyset-pagination page size (default 1000). Tunes peak memory on wide segments. */
  readonly listPageSize?: number;
}

/** One raw warm row as selected. */
interface RawRow {
  chunk_key?: number;
  token?: unknown;
  payload?: unknown;
}

/**
 * The idempotent DDL for the warm table (identifier-validated + quoted). The driver does **not** create
 * schema (it stays thin + needs no DDL privileges at runtime); run this once at deploy time, e.g.
 * `await pool.query(postgresWarmTableDDL())`.
 */
export function postgresWarmTableDDL(table: string = DEFAULT_TABLE): string {
  const t = validateAndQuoteTable(table);
  return (
    `CREATE TABLE IF NOT EXISTS ${t} (\n` +
    `  key_prefix text    NOT NULL,\n` +
    `  namespace  text    NOT NULL,\n` +
    `  segment    text    NOT NULL,\n` +
    `  chunk_key  integer NOT NULL,\n` +
    `  token      text    NOT NULL,\n` +
    `  payload    bytea   NOT NULL,\n` +
    `  PRIMARY KEY (key_prefix, namespace, segment, chunk_key)\n` +
    `);`
  );
}

export class PostgresWarmDriver implements IWarmDriver {
  private readonly pool: Pool;
  private readonly table: string; // validated + quoted for interpolation
  private readonly keyPrefix: string;
  private readonly listBatch: number;

  constructor(options: PostgresWarmDriverOptions) {
    this.pool = options.pool;
    this.table = validateAndQuoteTable(options.table ?? DEFAULT_TABLE);
    this.keyPrefix = normalizeKeyPrefix(options.keyPrefix);
    const batch = options.listPageSize ?? DEFAULT_LIST_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new ValidationError(`listPageSize must be a positive safe integer; got ${batch}`);
    }
    this.listBatch = batch;
  }

  // Reads are always strongly consistent (single primary), so the optional `WarmReadOptions` hint would be a
  // no-op — the structurally-optional param is simply omitted (still satisfies IWarmDriver), as in LocalFs.
  async get(ref: ChunkRef): Promise<WarmRow | null> {
    validateChunkRef(ref);
    try {
      const res = await this.pool.query<RawRow>(
        `SELECT token, payload FROM ${this.table} ` +
          `WHERE key_prefix = $1 AND namespace = $2 AND segment = $3 AND chunk_key = $4`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey],
      );
      const row = res.rows[0];
      return row === undefined ? null : this.rowFrom(row, ref.chunkKey);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async putConditional(
    ref: ChunkRef,
    bytes: Uint8Array,
    expected: Token | NoRow,
  ): Promise<{ token: Token }> {
    validateChunkRef(ref);
    const token = randomUUID();
    // Copy the payload into a Buffer for `bytea` binding — severs any caller-owned/reused input buffer.
    const payload = Buffer.from(bytes);
    const ns = namespacePart(ref.namespace);
    try {
      if (expected === NO_ROW) {
        const res = await this.pool.query(
          `INSERT INTO ${this.table} (key_prefix, namespace, segment, chunk_key, token, payload) ` +
            `VALUES ($1, $2, $3, $4, $5, $6) ` +
            `ON CONFLICT (key_prefix, namespace, segment, chunk_key) DO NOTHING`,
          [this.keyPrefix, ns, ref.segment, ref.chunkKey, token, payload],
        );
        // A single-row PK write affects exactly 1 row on success; anything else (0 = conflict, or a `null`
        // rowCount) is NOT a confirmed insert — treat as a conflict, never a silent false-success.
        if (res.rowCount !== 1) {
          throw new WriteConflictError(`chunk ${ref.chunkKey} already exists (create-if-absent)`);
        }
      } else {
        const res = await this.pool.query(
          `UPDATE ${this.table} SET token = $5, payload = $6 ` +
            `WHERE key_prefix = $1 AND namespace = $2 AND segment = $3 AND chunk_key = $4 ` +
            `AND token = $7`,
          [this.keyPrefix, ns, ref.segment, ref.chunkKey, token, payload, expected],
        );
        if (res.rowCount !== 1)
          throw new WriteConflictError(`OCC conflict on chunk ${ref.chunkKey}`);
      }
      return { token };
    } catch (err) {
      if (isWriteConflictError(err)) throw err; // our own deterministic conflict — never a transient
      throw this.mapError(err);
    }
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    validateChunkRef(ref);
    try {
      const res = await this.pool.query(
        `DELETE FROM ${this.table} ` +
          `WHERE key_prefix = $1 AND namespace = $2 AND segment = $3 AND chunk_key = $4 AND token = $5`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey, expected],
      );
      if (res.rowCount !== 1) {
        throw new WriteConflictError(`fenced-delete conflict on chunk ${ref.chunkKey}`);
      }
    } catch (err) {
      if (isWriteConflictError(err)) throw err;
      throw this.mapError(err);
    }
  }

  async *listChunks(ref: SegmentRef): AsyncIterable<{ chunkKey: number } & WarmRow> {
    validateSegmentRef(ref);
    const ns = namespacePart(ref.namespace);
    // Keyset pagination on chunk_key (ascending) bounds peak memory to one page WITHIN a single enumeration,
    // regardless of how wide the segment is. It does NOT resume across a transient fault, and nothing above it
    // makes that good: the retry decorator retries `listChunks` only until the first row arrives and then
    // streams live, deliberately NOT buffering, so a fault mid-enumeration reaches the caller. (This comment
    // used to say the decorator "re-enumerates from the start and buffers" — true of the cold/registry `list`
    // wrappers, never of this one. See drivers/retry/retrying-drivers.ts.)
    let after = -1;
    for (;;) {
      let rows: RawRow[];
      try {
        const res = await this.pool.query<RawRow>(
          `SELECT chunk_key, token, payload FROM ${this.table} ` +
            `WHERE key_prefix = $1 AND namespace = $2 AND segment = $3 AND chunk_key > $4 ` +
            `ORDER BY chunk_key ASC LIMIT $5`,
          [this.keyPrefix, ns, ref.segment, after, this.listBatch],
        );
        rows = res.rows;
      } catch (err) {
        throw this.mapError(err);
      }
      for (const row of rows) {
        const chunkKey = row.chunk_key;
        if (typeof chunkKey !== 'number') {
          throw new IntegrityError('warm row is missing its chunk_key');
        }
        yield { chunkKey, ...this.rowFrom(row, chunkKey) };
        after = chunkKey;
      }
      if (rows.length < this.listBatch) return;
    }
  }

  /**
   * Build a {@link WarmRow} from a raw row. `token` must be a non-empty string and `payload` a Buffer — a
   * missing/typo'd column means a corrupt or foreign row, which we reject (untrusted-data posture) rather
   * than paper over. The returned bytes are a fresh copy (driver-owned, read-only per the contract).
   */
  private rowFrom(row: RawRow, chunkKey: number): WarmRow {
    if (typeof row.token !== 'string' || row.token === '') {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its token`);
    }
    if (!(row.payload instanceof Uint8Array)) {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its payload`);
    }
    return { token: row.token, bytes: new Uint8Array(row.payload) };
  }

  /**
   * Reclassify a transient Postgres fault (serialization/deadlock, connection, resource, dropped socket) as
   * a retryable {@link TransientError}; everything else propagates unchanged. Applied at every query site so
   * callers + the retry decorator only ever see typed errors. A deterministic OCC conflict is signalled by
   * the driver itself (0 rows affected) — never reclassified here.
   */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient Postgres fault: ${(err as { code?: unknown } | null)?.code ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}
