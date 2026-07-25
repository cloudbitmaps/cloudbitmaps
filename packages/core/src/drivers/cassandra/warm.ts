/**
 * `CassandraWarmDriver` — an {@link IWarmDriver} over Cassandra / ScyllaDB (Phase 7).
 *
 * Uses the official `cassandra-driver`, an **optional peer dependency** — only consumers of
 * `cloud-roaring/cassandra` install it. A `Client` is **injected** (dependency injection): the driver owns no
 * connection/credential logic, so it's thin and reuses the caller's client.
 *
 * Each chunk is one row in a table partitioned by `(kp, ns, seg)` and clustered by `ck` — so all of a
 * segment's chunks share one partition and `listChunks` is a single partition read already ordered by
 * `ck` ascending. The opaque OCC **token** (a random UUID per write) lives in a `tok` column (`token` is a CQL
 * reserved word), and OCC is a **lightweight transaction** (LWT — Paxos-linearizable compare-and-set):
 * - **create-if-absent** = `INSERT … IF NOT EXISTS`; not applied ⇒ {@link WriteConflictError}.
 * - **token-fenced update / delete** = `UPDATE … / DELETE … IF tok = ?`; not applied (token moved or row
 *   absent) ⇒ {@link WriteConflictError}.
 *
 * The LWT's `IF` is evaluated under Paxos against the latest committed value, so the compare-and-set is
 * correct even if a prior `get` read a slightly stale value (a doomed write is simply not applied → retry).
 * **Reads observe the latest committed LWT value:** `get`/`listChunks` run at `LOCAL_SERIAL` by default (a
 * linearizable read that completes any in-flight Paxos round — the read-your-writes the OCC path needs on a
 * multi-node RF>1 cluster), downgrading to `LOCAL_ONE` only when the caller passes `{ consistent: false }`.
 * Tokens are not reused across delete→recreate (ABA-safe, D3 — probabilistic random UUID). Drivers may use
 * `node:crypto`.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'cassandra-driver';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type {
  ChunkRef,
  IWarmDriver,
  NoRow,
  SegmentRef,
  Token,
  WarmReadOptions,
  WarmRow,
} from '@/core/ports';
import { validateChunkRef, validateSegmentRef } from '@/core/validate';
import { namespacePart } from '../_shared/keys';
import { normalizeKeyPrefix, validateAndQuoteTable } from './keys';
import { isTransient } from './cassandra-errors';

const DEFAULT_TABLE = 'cloud_roaring_warm';
/** listChunks page size (CQL `fetchSize`) — the stream auto-pages, bounding resident rows on a wide segment. */
const DEFAULT_FETCH_SIZE = 500;
// `cassandra-driver` `types.consistencies` values — stable CQL binary-protocol constants, inlined so the built
// subpath keeps NO runtime `cassandra-driver` import (the SDK stays a pure type + optional peer, as with the
// other drivers). LOCAL_SERIAL = a linearizable read (observes the latest committed LWT value / read-your-
// writes); LOCAL_ONE = a fast, possibly-stale read used only when the caller opts into eventual consistency.
const CONSISTENCY_LOCAL_SERIAL = 9;
const CONSISTENCY_LOCAL_ONE = 10;

export interface CassandraWarmDriverOptions {
  /**
   * A connected `cassandra-driver` `Client`. The driver never connects/shuts it down — the caller owns it.
   * Notes: identifiers (keyspace/table) are **case-sensitive** here (quoted), so pass them exactly as stored
   * (lowercase unless created quoted). OCC reads use `LOCAL_SERIAL` — linearizable **within one datacenter**;
   * a **multi-DC** deployment that needs cross-DC linearizable OCC must run at `SERIAL` (configure it on the
   * client and note this driver defaults to the local variant). An LWT that times out is ambiguous: the retry
   * layer may re-issue it and surface a spurious `WriteConflictError` for a write that actually committed —
   * the caller's OCC re-read converges and no data is lost.
   */
  readonly client: Client;
  /** Keyspace holding the warm table (must already exist — replication is a deployment decision). */
  readonly keyspace: string;
  /** Warm table name (default `cloud_roaring_warm`). Must already exist (see `cassandraWarmTableDDL`). */
  readonly table?: string;
  /** Optional key-prefix column value so several logical stores can share one table (bound as data). */
  readonly keyPrefix?: string;
  /** Advanced: `listChunks` fetch (page) size (default 500). Tunes peak memory on wide segments. */
  readonly listPageSize?: number;
}

/** One raw warm row as selected (cassandra-driver decodes `blob`→Buffer, `int`→number, `text`→string).
 * NB: the token column is named `tok`, not `token` — `token` is a reserved word in CQL (`token()` function). */
interface RawRow {
  ck?: unknown;
  tok?: unknown;
  payload?: unknown;
}

/**
 * The idempotent CQL DDL for the warm table (identifier-validated + quoted). The driver does **not** create
 * schema at runtime (it stays thin); run this once at deploy time against an existing keyspace, e.g.
 * `await client.execute(cassandraWarmTableDDL('my_ks'))`.
 */
export function cassandraWarmTableDDL(keyspace: string, table: string = DEFAULT_TABLE): string {
  const t = validateAndQuoteTable(keyspace, table);
  return (
    `CREATE TABLE IF NOT EXISTS ${t} (\n` +
    // `tok`, not `token` — `token` is a reserved word in CQL.
    `  kp text,\n  ns text,\n  seg text,\n  ck int,\n  tok text,\n  payload blob,\n` +
    `  PRIMARY KEY ((kp, ns, seg), ck)\n` +
    `);`
  );
}

export class CassandraWarmDriver implements IWarmDriver {
  private readonly client: Client;
  private readonly table: string; // validated + quoted "keyspace"."table"
  private readonly keyPrefix: string;
  private readonly fetchSize: number;

  constructor(options: CassandraWarmDriverOptions) {
    this.client = options.client;
    this.table = validateAndQuoteTable(options.keyspace, options.table ?? DEFAULT_TABLE);
    this.keyPrefix = normalizeKeyPrefix(options.keyPrefix);
    const fetch = options.listPageSize ?? DEFAULT_FETCH_SIZE;
    if (!Number.isSafeInteger(fetch) || fetch < 1) {
      throw new ValidationError(`listPageSize must be a positive safe integer; got ${fetch}`);
    }
    this.fetchSize = fetch;
  }

  /** Read consistency: `LOCAL_SERIAL` (linearizable, read-your-writes) unless the caller opts into eventual. */
  private readConsistency(opts?: WarmReadOptions): number {
    return opts?.consistent === false ? CONSISTENCY_LOCAL_ONE : CONSISTENCY_LOCAL_SERIAL;
  }

  async get(ref: ChunkRef, opts?: WarmReadOptions): Promise<WarmRow | null> {
    validateChunkRef(ref);
    try {
      const res = await this.client.execute(
        `SELECT tok, payload FROM ${this.table} WHERE kp = ? AND ns = ? AND seg = ? AND ck = ?`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey],
        { prepare: true, consistency: this.readConsistency(opts) },
      );
      const row = res.rows[0] as RawRow | undefined;
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
    const payload = Buffer.from(bytes); // copy: severs any caller-owned/reused input buffer
    const ns = namespacePart(ref.namespace);
    let applied: boolean;
    try {
      const res =
        expected === NO_ROW
          ? await this.client.execute(
              `INSERT INTO ${this.table} (kp, ns, seg, ck, tok, payload) ` +
                `VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
              [this.keyPrefix, ns, ref.segment, ref.chunkKey, token, payload],
              { prepare: true },
            )
          : await this.client.execute(
              `UPDATE ${this.table} SET tok = ?, payload = ? ` +
                `WHERE kp = ? AND ns = ? AND seg = ? AND ck = ? IF tok = ?`,
              [token, payload, this.keyPrefix, ns, ref.segment, ref.chunkKey, expected],
              { prepare: true },
            );
      applied = res.wasApplied();
    } catch (err) {
      throw this.mapError(err);
    }
    if (!applied) {
      throw new WriteConflictError(
        expected === NO_ROW
          ? `chunk ${ref.chunkKey} already exists (create-if-absent)`
          : `OCC conflict on chunk ${ref.chunkKey}`,
      );
    }
    return { token };
  }

  async deleteConditional(ref: ChunkRef, expected: Token): Promise<void> {
    validateChunkRef(ref);
    let applied: boolean;
    try {
      const res = await this.client.execute(
        `DELETE FROM ${this.table} WHERE kp = ? AND ns = ? AND seg = ? AND ck = ? IF tok = ?`,
        [this.keyPrefix, namespacePart(ref.namespace), ref.segment, ref.chunkKey, expected],
        { prepare: true },
      );
      applied = res.wasApplied();
    } catch (err) {
      throw this.mapError(err);
    }
    if (!applied) {
      throw new WriteConflictError(`fenced-delete conflict on chunk ${ref.chunkKey}`);
    }
  }

  async *listChunks(
    ref: SegmentRef,
    opts?: WarmReadOptions,
  ): AsyncIterable<{ chunkKey: number } & WarmRow> {
    validateSegmentRef(ref);
    // A single-partition read, already ordered by the `ck` clustering key (ascending). `client.stream` is an
    // object-mode Readable that auto-pages at `fetchSize`, so peak memory is bounded on a wide segment.
    const stream = this.client.stream(
      `SELECT ck, tok, payload FROM ${this.table} WHERE kp = ? AND ns = ? AND seg = ?`,
      [this.keyPrefix, namespacePart(ref.namespace), ref.segment],
      { prepare: true, fetchSize: this.fetchSize, consistency: this.readConsistency(opts) },
    );
    try {
      // `client.stream` returns an object-mode Readable (async-iterable at runtime); its type defs expose only
      // the EventEmitter surface, so cast via `unknown`.
      for await (const raw of stream as unknown as AsyncIterable<RawRow>) {
        // Untrusted-data posture (like the sibling drivers): a corrupt row with a non-numeric `ck` must not
        // surface as `{ chunkKey: undefined }`.
        if (typeof raw.ck !== 'number') {
          throw new IntegrityError('warm row is missing its numeric chunk key (ck)');
        }
        yield { chunkKey: raw.ck, ...this.rowFrom(raw, raw.ck) };
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Build a {@link WarmRow} from a raw row; reject one missing/mistyped fields (corrupt/foreign). */
  private rowFrom(row: RawRow, chunkKey: number): WarmRow {
    if (typeof row.tok !== 'string' || row.tok === '') {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its token`);
    }
    if (!(row.payload instanceof Uint8Array)) {
      throw new IntegrityError(`warm row for chunk ${chunkKey} is missing its payload`);
    }
    return { token: row.tok, bytes: new Uint8Array(row.payload) };
  }

  /** Reclassify a transient Cassandra fault as a retryable {@link TransientError}; else propagate unchanged. */
  private mapError(err: unknown): unknown {
    if (isTransient(err)) {
      return new TransientError(
        `transient Cassandra fault: ${(err as { name?: unknown } | null)?.name ?? 'unknown'}`,
        { cause: err },
      );
    }
    return err;
  }
}
