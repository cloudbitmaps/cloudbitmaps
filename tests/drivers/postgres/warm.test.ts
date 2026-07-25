import type { Pool } from 'pg';
import {
  PostgresWarmDriver,
  postgresWarmTableDDL,
  type PostgresWarmDriverOptions,
} from '@/drivers/postgres/warm';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';

// Construction + OCC-statement checks need no database (a fake Pool records/answers queries), so they run on
// the normal lane. Full behaviour (real cross-process OCC, listChunks, concurrency) is exercised in
// tests/integration/postgres.test.ts against a Postgres container — the same split the cloud drivers use.

interface QResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
interface Call {
  text: string;
  values: unknown[];
}

/** A fake `pg.Pool` recording every query and answering via `handler`. */
function fakePool(
  calls: Call[],
  handler: (text: string, values: unknown[]) => QResult | Promise<QResult>,
): Pool {
  return {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return handler(text, values);
    },
  } as unknown as Pool;
}

const ok = (rows: Record<string, unknown>[] = [], rowCount = rows.length): QResult => ({
  rows,
  rowCount,
});
const REF: ChunkRef = { segment: 's', chunkKey: 3 };
const driverWith = (
  calls: Call[],
  handler: (t: string, v: unknown[]) => QResult | Promise<QResult>,
  opts: Partial<PostgresWarmDriverOptions> = {},
): PostgresWarmDriver => new PostgresWarmDriver({ pool: fakePool(calls, handler), ...opts });

describe('PostgresWarmDriver construction + DDL', () => {
  it('rejects an unsafe table name (identifier injection guard)', () => {
    const pool = fakePool([], () => ok());
    for (const table of ['foo; DROP TABLE x', 'a.b.c', 'foo"x', '']) {
      expect(() => new PostgresWarmDriver({ pool, table })).toThrow(ValidationError);
    }
    expect(() => new PostgresWarmDriver({ pool, table: 'app.warm' })).not.toThrow();
  });

  it('postgresWarmTableDDL emits idempotent CREATE with the quoted table + expected columns', () => {
    const ddl = postgresWarmTableDDL('app.warm');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "app"."warm"');
    expect(ddl).toContain('PRIMARY KEY (key_prefix, namespace, segment, chunk_key)');
    expect(ddl).toContain('payload    bytea');
    expect(() => postgresWarmTableDDL('bad;name')).toThrow(ValidationError);
  });
});

describe('PostgresWarmDriver validation (before any query)', () => {
  it('rejects out-of-range chunk keys and bad names without touching the pool', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => ok());
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      await expect(d.get({ segment: 's', chunkKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(d.get({ segment: '../evil', chunkKey: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0); // never reached the pool
  });
});

describe('PostgresWarmDriver OCC statements (fake Pool, db-independent)', () => {
  it('get returns null on no row, and a decoded row otherwise', async () => {
    const calls: Call[] = [];
    const dNull = driverWith(calls, () => ok([]));
    expect(await dNull.get(REF)).toBeNull();

    const dRow = driverWith([], () => ok([{ token: 'tok-1', payload: Buffer.from([9, 8]) }]));
    const row = await dRow.get(REF);
    expect(row).not.toBeNull();
    expect(row!.token).toBe('tok-1');
    expect([...row!.bytes]).toEqual([9, 8]);
    // SELECT filters on all four key columns.
    expect(calls[0]?.text).toContain('WHERE key_prefix = $1 AND namespace = $2 AND segment = $3');
    expect(calls[0]?.values).toEqual(['', '_default', 's', 3]);
  });

  it('create-if-absent → INSERT … ON CONFLICT DO NOTHING; 0 rows ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => ok([], 1)); // inserted
    const { token } = await d.putConditional(REF, new Uint8Array([1, 2]), NO_ROW);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(calls[0]?.text).toContain('ON CONFLICT');
    expect(calls[0]?.text).toContain('DO NOTHING');
    expect(calls[0]?.values[5]).toBeInstanceOf(Buffer); // payload bound as bytea Buffer
    expect([...(calls[0]?.values[5] as Buffer)]).toEqual([1, 2]);

    const dConflict = driverWith([], () => ok([], 0)); // row already existed
    await expect(dConflict.putConditional(REF, new Uint8Array([1]), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('token-fenced update → UPDATE … AND token = $7; 0 rows ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => ok([], 1));
    const { token } = await d.putConditional(REF, new Uint8Array([5]), 'old-token');
    expect(token).not.toBe('old-token'); // a fresh token is minted
    expect(calls[0]?.text).toMatch(/UPDATE .* SET token = \$5, payload = \$6/s);
    expect(calls[0]?.text).toContain('AND token = $7');
    expect(calls[0]?.values[6]).toBe('old-token');

    const stale = driverWith([], () => ok([], 0));
    await expect(
      stale.putConditional(REF, new Uint8Array([5]), 'old-token'),
    ).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('fenced delete → DELETE … AND token; 0 rows ⇒ WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => ok([], 1));
    await d.deleteConditional(REF, 'tok');
    expect(calls[0]?.text).toMatch(/^DELETE FROM/);
    expect(calls[0]?.text).toContain('AND token = $5');

    const gone = driverWith([], () => ok([], 0));
    await expect(gone.deleteConditional(REF, 'tok')).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('mints a distinct random token per write', async () => {
    const d = driverWith([], () => ok([], 1));
    const a = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    const b = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    expect(a.token).not.toBe(b.token);
  });

  it('maps a transient SQLSTATE to TransientError; passes a deterministic error through', async () => {
    const transient = driverWith([], () =>
      Promise.reject(Object.assign(new Error(), { code: '40001' })),
    );
    await expect(transient.get(REF)).rejects.toBeInstanceOf(TransientError);

    const deterministic = driverWith([], () =>
      Promise.reject(Object.assign(new Error('syntax'), { code: '42601' })),
    );
    await expect(deterministic.get(REF)).rejects.not.toBeInstanceOf(TransientError);
  });

  it('honors a keyPrefix as a bound value on the key columns', async () => {
    const calls: Call[] = [];
    const d = driverWith(calls, () => ok([]), { keyPrefix: 'tenant-x' });
    await d.get(REF);
    expect(calls[0]?.values[0]).toBe('tenant-x');
  });

  it('listChunks keyset-paginates across a page boundary (cursor advances, ascending, no dupes)', async () => {
    // A dataset wider than the page size forces the continuation loop — the headline behaviour. The handler
    // serves rows with chunk_key > $4 (the `after` cursor), ascending, capped at $5 (the page size).
    const dataset = [0, 1, 2, 3, 4].map((k) => ({
      chunk_key: k,
      token: `t${k}`,
      payload: Buffer.of(k),
    }));
    const calls: Call[] = [];
    const d = driverWith(
      calls,
      (_text, values) => {
        const after = values[3] as number;
        const limit = values[4] as number;
        const page = dataset.filter((r) => r.chunk_key > after).slice(0, limit);
        return ok(page);
      },
      { listPageSize: 2 },
    );
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 1, 2, 3, 4]); // every row once, ascending, across 3 pages (2+2+1)
    // 5 rows at page size 2 ⇒ pages of [0,1],[2,3],[4] then a terminating short page ⇒ 3 queries.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.values[3]).toBe(-1); // first page starts after -1 (includes chunk 0)
    expect(calls[1]?.values[3]).toBe(1); // cursor advanced to the last key of page 1
    expect(calls[2]?.values[3]).toBe(3); // …and of page 2
  });

  it('rejects a non-positive / non-integer listPageSize (fail-fast)', () => {
    const pool = fakePool([], () => ok());
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new PostgresWarmDriver({ pool, listPageSize: bad })).toThrow(ValidationError);
    }
  });
});
