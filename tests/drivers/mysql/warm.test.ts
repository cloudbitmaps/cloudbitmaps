import type { Pool } from 'mysql2/promise';
import {
  MysqlWarmDriver,
  mysqlWarmTableDDL,
  type MysqlWarmDriverOptions,
} from '@/drivers/mysql/warm';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';

// Construction + OCC-statement checks need no database (a fake Pool records/answers queries), so they run on
// the normal lane. Full behaviour (real cross-process OCC, listChunks, concurrency) is exercised in
// tests/integration/mysql.test.ts against a MySQL container — the same split the other datastore drivers use.

interface Call {
  sql: string;
  values: unknown[];
}
/** A mysql2 result: either selected rows, or a ResultSetHeader-shaped `{ affectedRows }`. */
type QResult = Record<string, unknown>[] | { affectedRows: number };

/** A fake mysql2 promise `Pool` recording every query and answering (or rejecting) via `handler`. mysql2's
 *  `query` resolves to the `[result, fields]` tuple the driver destructures. */
function fakePool(
  calls: Call[],
  handler: (sql: string, values: unknown[]) => QResult | Promise<QResult>,
): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return [await handler(sql, values), []];
    },
  } as unknown as Pool;
}

const rows = (r: Record<string, unknown>[] = []): QResult => r;
const affected = (affectedRows: number): QResult => ({ affectedRows });

const REF: ChunkRef = { segment: 's', chunkKey: 3 };
const driverWith = (
  calls: Call[],
  handler: (sql: string, values: unknown[]) => QResult | Promise<QResult>,
  opts: Partial<MysqlWarmDriverOptions> = {},
): MysqlWarmDriver => new MysqlWarmDriver({ pool: fakePool(calls, handler), ...opts });

describe('MysqlWarmDriver construction + DDL', () => {
  it('rejects an unsafe table name (identifier injection guard)', () => {
    const pool = fakePool([], () => rows());
    for (const table of ['foo; DROP TABLE x', 'a.b.c', 'foo`x', '']) {
      expect(() => new MysqlWarmDriver({ pool, table })).toThrow(ValidationError);
    }
    expect(() => new MysqlWarmDriver({ pool, table: 'app.warm' })).not.toThrow();
  });

  it('mysqlWarmTableDDL emits idempotent CREATE with the backtick-quoted table, columns, and utf8mb4_bin', () => {
    const ddl = mysqlWarmTableDDL('app.warm');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `app`.`warm`');
    expect(ddl).toContain('PRIMARY KEY (key_prefix, namespace, segment, chunk_key)');
    expect(ddl).toContain('payload    LONGBLOB');
    // The case-sensitive binary collation is correctness-critical (MySQL's default ci collation would make
    // segment='A' wrongly match a row keyed 'a') — assert it's pinned.
    expect(ddl).toContain('COLLATE=utf8mb4_bin');
    expect(() => mysqlWarmTableDDL('bad;name')).toThrow(ValidationError);
  });
});

describe('MysqlWarmDriver validation (before any query)', () => {
  it('rejects out-of-range chunk keys and bad names without touching the pool', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => rows());
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      await expect(d.get({ segment: 's', chunkKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(d.get({ segment: '../evil', chunkKey: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0); // never reached the pool
  });
});

describe('MysqlWarmDriver OCC statements (fake Pool, db-independent)', () => {
  it('get returns null on no row, and a decoded row otherwise', async () => {
    const dNull = driverWith([], () => rows([]));
    expect(await dNull.get(REF)).toBeNull();

    const calls: Call[] = [];
    const dRow = driverWith(calls, () => rows([{ token: 'tok-1', payload: Buffer.from([9, 8]) }]));
    const row = await dRow.get(REF);
    expect(row).not.toBeNull();
    expect(row!.token).toBe('tok-1');
    expect([...row!.bytes]).toEqual([9, 8]);
    expect(calls[0]?.sql).toContain('WHERE key_prefix = ? AND namespace = ? AND segment = ?');
    expect(calls[0]?.values).toEqual(['', '_default', 's', 3]);
  });

  it('create-if-absent → plain INSERT; a duplicate-key error ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => affected(1)); // inserted
    const { token } = await d.putConditional(REF, new Uint8Array([1, 2]), NO_ROW);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(calls[0]?.sql).toMatch(/^INSERT INTO/);
    expect(calls[0]?.values[4]).toBe(token); // token bound
    expect(calls[0]?.values[5]).toBeInstanceOf(Buffer); // payload bound as a LONGBLOB Buffer
    expect([...(calls[0]?.values[5] as Buffer)]).toEqual([1, 2]);

    // errno 1062 (ER_DUP_ENTRY) ⇒ the row already existed ⇒ a deterministic conflict, not a transient.
    const dupErrno = driverWith([], () =>
      Promise.reject(Object.assign(new Error('dup'), { errno: 1062 })),
    );
    await expect(dupErrno.putConditional(REF, new Uint8Array([1]), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    // ...also recognised by the string code.
    const dupCode = driverWith([], () =>
      Promise.reject(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })),
    );
    await expect(dupCode.putConditional(REF, new Uint8Array([1]), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('token-fenced update → UPDATE … AND token = ?; affectedRows !== 1 ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => affected(1));
    const { token } = await d.putConditional(REF, new Uint8Array([5]), 'old-token');
    expect(token).not.toBe('old-token'); // a fresh token is minted
    expect(calls[0]?.sql).toMatch(/UPDATE .* SET token = \?, payload = \?/s);
    expect(calls[0]?.sql).toContain('AND token = ?');
    expect(calls[0]?.values[0]).toBe(token); // new token bound first
    expect(calls[0]?.values[6]).toBe('old-token'); // fenced on the expected token last

    const stale = driverWith([], () => affected(0)); // token moved / row gone
    await expect(
      stale.putConditional(REF, new Uint8Array([5]), 'old-token'),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('fenced delete → DELETE … AND token; affectedRows !== 1 ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => affected(1));
    await d.deleteConditional(REF, 'tok');
    expect(calls[0]?.sql).toMatch(/^DELETE FROM/);
    expect(calls[0]?.sql).toContain('AND token = ?');
    expect(calls[0]?.values[4]).toBe('tok');

    const gone = driverWith([], () => affected(0));
    await expect(gone.deleteConditional(REF, 'tok')).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('mints a distinct random token per write', async () => {
    const d = driverWith([], () => affected(1));
    const a = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    const b = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    expect(a.token).not.toBe(b.token);
  });

  it('maps a transient MySQL fault to TransientError; passes a deterministic error through', async () => {
    // errno 1205 = ER_LOCK_WAIT_TIMEOUT (transient).
    const transient = driverWith([], () =>
      Promise.reject(Object.assign(new Error('lock'), { errno: 1205 })),
    );
    await expect(transient.get(REF)).rejects.toBeInstanceOf(TransientError);

    // errno 1064 = ER_PARSE_ERROR (deterministic — must surface, never blind-retried).
    const deterministic = driverWith([], () =>
      Promise.reject(Object.assign(new Error('syntax'), { errno: 1064 })),
    );
    await expect(deterministic.get(REF)).rejects.not.toBeInstanceOf(TransientError);
  });

  it('honors a keyPrefix as a bound value on the key columns', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => rows([]), { keyPrefix: 'tenant-x' });
    await d.get(REF);
    expect(calls[0]?.values[0]).toBe('tenant-x');
  });

  it('listChunks keyset-paginates across a page boundary (cursor advances, ascending, no dupes)', async () => {
    const dataset = [0, 1, 2, 3, 4].map((k) => ({
      chunk_key: k,
      token: `t${k}`,
      payload: Buffer.of(k),
    }));
    const calls: Call[] = [];
    const d = driverWith(
      calls,
      (_sql, values) => {
        const after = values[3] as number;
        const limit = values[4] as number;
        return dataset.filter((r) => r.chunk_key > after).slice(0, limit);
      },
      { listPageSize: 2 },
    );
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 1, 2, 3, 4]); // every row once, ascending, across 3 pages (2+2+1)
    expect(calls).toHaveLength(3);
    expect(calls[0]?.values[3]).toBe(-1); // first page starts after -1 (includes chunk 0)
    expect(calls[1]?.values[3]).toBe(1); // cursor advanced to the last key of page 1
    expect(calls[2]?.values[3]).toBe(3); // …and of page 2
  });

  it('rejects a non-positive / non-integer listPageSize (fail-fast)', () => {
    const pool = fakePool([], () => rows());
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MysqlWarmDriver({ pool, listPageSize: bad })).toThrow(ValidationError);
    }
  });
});
