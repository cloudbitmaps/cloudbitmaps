/**
 * `MysqlWarmDriver` — an {@link IWarmDriver} over MySQL / MariaDB (Phase 7).
 *
 * "No DynamoDB — use the MySQL you already run." Uses the official `mysql2` (its promise API), an **optional
 * peer dependency** — only consumers of `cloud-roaring/mysql` install it. A `mysql2` `Pool` is **injected**
 * (dependency injection): the driver owns no connection/credential logic, so it's thin, reuses the caller's
 * pool, and is testable against a MySQL container.
 *
 * Each chunk is one row in a single table (`PRIMARY KEY (key_prefix, namespace, segment, chunk_key)`), with an
 * opaque OCC **token** (a random UUID minted per write) and the delta `payload` (LONGBLOB). Optimistic
 * concurrency is real, cross-process, and server-side:
 * - **create-if-absent** = a plain `INSERT`; a pre-existing row raises `ER_DUP_ENTRY` (errno 1062) ⇒
 *   {@link WriteConflictError}.
 * - **token-fenced update / delete** = `UPDATE … / DELETE … WHERE … AND token = ?`; `affectedRows !== 1` ⇒
 *   the stored token moved (or the row is gone) ⇒ {@link WriteConflictError}.
 *
 * **Why `affectedRows` is reliable here despite MySQL counting *changed* (not matched) rows by default:** the
 * new token is a fresh random UUID on every write, so a matched fenced `UPDATE` **always** changes the `token`
 * column ⇒ `affectedRows === 1` on a match and `0` on a miss, regardless of the connection's
 * `CLIENT_FOUND_ROWS` flag. (The driver never sets a value equal to what's stored, so the "unchanged row ⇒ 0
 * affected" MySQL quirk cannot mask a real match.)
 *
 * **Collation matters for correctness:** the table is `utf8mb4_bin`, so `key_prefix` / `namespace` / `segment`
 * / `token` compare **byte-exact and case-sensitive**. MySQL's *default* collation (`utf8mb4_0900_ai_ci`) is
 * case- and accent-**insensitive**, which would make `segment = 'A'` wrongly match a row keyed `'a'` — a
 * correctness hole. {@link mysqlWarmTableDDL} pins `utf8mb4_bin` to close it; a caller supplying their own
 * table must do the same.
 *
 * Tokens are not reused across delete→recreate (ABA-safe, D3): a delete removes the row and a recreate mints a
 * fresh random UUID, so a token from before the delete won't match. (Probabilistic — a random 122-bit UUIDv4,
 * collision odds negligible — vs the DynamoDB driver's structural monotonic counter; the hard-delete model
 * can't offer the latter, and conformance D3 pins the behavior. Reads are strongly
 * consistent (single primary), so the optional `WarmReadOptions` consistency hint is a no-op, like the
 * in-memory / LocalFs / Postgres drivers. Drivers may use `node:crypto`; only `core/` is determinism-bound.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
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
import { isDuplicateKey, isTransient } from './mysql-errors';

const DEFAULT_TABLE = 'cloud_roaring_warm';
/** Default listChunks keyset-pagination batch — bounds peak memory to ~this many rows regardless of width. */
const DEFAULT_LIST_BATCH = 1000;

export interface MysqlWarmDriverOptions {
  /**
   * A constructed `mysql2` promise `Pool` (or a pool-compatible client exposing `query`). The driver never
   * opens/closes connections — the caller owns the pool's lifecycle. It **must target the primary**: reads are
   * treated as strongly consistent (the OCC read-modify-write needs read-your-writes), so a pool pointed at a
   * read replica could serve stale rows and silently break OCC.
   */
  readonly pool: Pool;
  /** Warm table name — identifier or `db.table` (default `cloud_roaring_warm`). Must already exist. */
  readonly table?: string;
  /** Optional key-prefix column value so several logical stores can share one table (bound as data). */
  readonly keyPrefix?: string;
  /** Advanced: `listChunks` keyset-pagination page size (default 1000). Tunes peak memory on wide segments. */
  readonly listPageSize?: number;
}

/** One raw warm row as selected. */
interface RawRow extends RowDataPacket {
  chunk_key?: number;
  token?: unknown;
  payload?: unknown;
}

/**
 * The idempotent DDL for the warm table (identifier-validated + backtick-quoted). The driver does **not**
 * create schema (it stays thin + needs no DDL privileges at runtime); run this once at deploy time, e.g.
 * `await pool.query(mysqlWarmTableDDL())`. The `utf8mb4_bin` collation is **required for correctness** (see the
 * class doc): it makes the key columns compare byte-exact and case-sensitive, unlike MySQL's default ci
 * collation. Column lengths keep the composite primary key within InnoDB's 3072-byte index limit under utf8mb4.
 */
export function mysqlWarmTableDDL(table: string = DEFAULT_TABLE): string {
  const t = validateAndQuoteTable(table);
  return (
    `CREATE TABLE IF NOT EXISTS ${t} (\n` +
    `  key_prefix VARCHAR(191) NOT NULL,\n` +
    `  namespace  VARCHAR(256) NOT NULL,\n` +
    `  segment    VARCHAR(256) NOT NULL,\n` +
    `  chunk_key  INT          NOT NULL,\n` +
    `  token      CHAR(36)     NOT NULL,\n` +
    `  payload    LONGBLOB     NOT NULL,\n` +
    `  PRIMARY KEY (key_prefix, namespace, segment, chunk_key)\n` +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`
  );
}

export class MysqlWarmDriver implements IWarmDriver {
  private readonly pool: Pool;
  private readonly table: string; // validated + backtick-quoted for interpolation
  private readonly keyPrefix: string;
  private readonly listBatch: number;

  constructor(options: MysqlWarmDriverOptions) {
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
  // no-op — the structurally-optional param is simply omitted (still satisfies IWarmDriver), as in LocalFs/pg.
  async get(ref: ChunkRef): Promise<WarmRow | null> {
    validateChunkRef(ref);
    try {
      const [rows] = await this.pool.query<RawRow[]>(
        `SELECT token, payload FROM ${this.table} ` +
          `WHERE key_prefix = ? AND namespace = ? AND segment = ? AND chunk_key = ?`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey],
      );
      const row = rows[0];
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
    // Copy the payload into a Buffer for the LONGBLOB binding — severs any caller-owned/reused input buffer.
    const payload = Buffer.from(bytes);
    const ns = namespacePart(ref.namespace);
    try {
      if (expected === NO_ROW) {
        // create-if-absent: a plain INSERT. A pre-existing PK raises ER_DUP_ENTRY (1062), caught below as a
        // deterministic conflict — never an INSERT IGNORE (which would also swallow unrelated errors).
        await this.pool.query<ResultSetHeader>(
          `INSERT INTO ${this.table} (key_prefix, namespace, segment, chunk_key, token, payload) ` +
            `VALUES (?, ?, ?, ?, ?, ?)`,
          [this.keyPrefix, ns, ref.segment, ref.chunkKey, token, payload],
        );
      } else {
        const [res] = await this.pool.query<ResultSetHeader>(
          `UPDATE ${this.table} SET token = ?, payload = ? ` +
            `WHERE key_prefix = ? AND namespace = ? AND segment = ? AND chunk_key = ? AND token = ?`,
          [token, payload, this.keyPrefix, ns, ref.segment, ref.chunkKey, expected],
        );
        // The fresh token always changes the row, so affectedRows reflects the MATCH: 1 = fenced write applied,
        // anything else = the stored token moved or the row is gone (a conflict), never a silent false-success.
        if (res.affectedRows !== 1) {
          throw new WriteConflictError(`OCC conflict on chunk ${ref.chunkKey}`);
        }
      }
      return { token };
    } catch (err) {
      if (isWriteConflictError(err)) throw err; // our own deterministic conflict — never a transient
      if (expected === NO_ROW && isDuplicateKey(err)) {
        throw new WriteConflictError(`chunk ${ref.chunkKey} already exists (create-if-absent)`);
      }
      throw this.mapError(err);
    }
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    validateChunkRef(ref);
    try {
      const [res] = await this.pool.query<ResultSetHeader>(
        `DELETE FROM ${this.table} ` +
          `WHERE key_prefix = ? AND namespace = ? AND segment = ? AND chunk_key = ? AND token = ?`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey, expected],
      );
      if (res.affectedRows !== 1) {
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
    // regardless of how wide the segment is. (It does NOT resume across a transient fault — the retry decorator
    // re-enumerates a streaming method from the start and buffers, see drivers/retry/retrying-drivers.ts.)
    let after = -1;
    for (;;) {
      let rows: RawRow[];
      try {
        const [res] = await this.pool.query<RawRow[]>(
          `SELECT chunk_key, token, payload FROM ${this.table} ` +
            `WHERE key_prefix = ? AND namespace = ? AND segment = ? AND chunk_key > ? ` +
            `ORDER BY chunk_key ASC LIMIT ?`,
          [this.keyPrefix, ns, ref.segment, after, this.listBatch],
        );
        rows = res;
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
   * Reclassify a transient MySQL fault (lock-wait/deadlock, connection lost, too-many-connections, dropped
   * socket) as a retryable {@link TransientError}; everything else propagates unchanged. Applied at every
   * query site so callers + the retry decorator only ever see typed errors. A deterministic OCC/duplicate-key
   * conflict is signalled by the driver itself — never reclassified here.
   */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient MySQL fault: ${(err as { code?: unknown } | null)?.code ?? (err as { errno?: unknown } | null)?.errno ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}
