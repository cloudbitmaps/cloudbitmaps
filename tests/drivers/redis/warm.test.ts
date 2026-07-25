import type { Redis } from 'ioredis';
import { RedisWarmDriver } from '@/drivers/redis/warm';
import { TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';

// Construction + OCC-dispatch checks need no Redis (a fake client records/answers), so they run on the normal
// lane. Full behaviour (atomic Lua CAS, listChunks, concurrency) is exercised in tests/integration/redis.test.ts
// against a real Redis — the same split the other drivers use.

interface Rec {
  put: unknown[][];
  del: unknown[][];
}
type PutRet = number | (() => Promise<number>);

/** A fake ioredis client: crWarmPut/crWarmDel are pre-installed (so the driver skips defineCommand). */
function fakeClient(
  rec: Rec,
  opts: {
    put?: PutRet;
    del?: PutRet;
    hget?: Record<string, Buffer> | (() => Promise<Record<string, Buffer>>);
    zrange?: string[];
    pipelineExec?: [Error | null, unknown][];
  } = {},
): Redis {
  const pipelineCalls: string[] = [];
  const pipeline = {
    hgetallBuffer(key: string) {
      pipelineCalls.push(key);
      return pipeline;
    },
    exec: async () => opts.pipelineExec ?? [],
  };
  return {
    defineCommand: () => undefined,
    crWarmPut: async (...args: unknown[]) => {
      rec.put.push(args);
      return typeof opts.put === 'function' ? opts.put() : (opts.put ?? 1);
    },
    crWarmDel: async (...args: unknown[]) => {
      rec.del.push(args);
      return typeof opts.del === 'function' ? opts.del() : (opts.del ?? 1);
    },
    hgetallBuffer: async () => (typeof opts.hget === 'function' ? opts.hget() : (opts.hget ?? {})),
    zrange: async () => opts.zrange ?? [],
    pipeline: () => pipeline,
  } as unknown as Redis;
}

const REF: ChunkRef = { segment: 's', chunkKey: 3 };
const rec = (): Rec => ({ put: [], del: [] });

describe('RedisWarmDriver construction + validation', () => {
  it('rejects a non-positive / non-integer listPageSize', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new RedisWarmDriver({ client: fakeClient(rec()), listPageSize: bad })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects out-of-range chunk keys / bad names before touching the client', async () => {
    const r = rec();
    const d = new RedisWarmDriver({ client: fakeClient(r) });
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      await expect(d.get({ segment: 's', chunkKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(d.get({ segment: '../x', chunkKey: 0 })).rejects.toBeInstanceOf(ValidationError);
    expect(r.put).toHaveLength(0);
  });
});

describe('RedisWarmDriver OCC dispatch (fake client, Redis-independent)', () => {
  it('get returns null on an absent hash, a decoded row otherwise', async () => {
    const dNull = new RedisWarmDriver({ client: fakeClient(rec(), { hget: {} }) });
    expect(await dNull.get(REF)).toBeNull();

    const dRow = new RedisWarmDriver({
      client: fakeClient(rec(), { hget: { t: Buffer.from('tok-1'), b: Buffer.from([9, 8]) } }),
    });
    const row = await dRow.get(REF);
    expect(row!.token).toBe('tok-1');
    expect([...row!.bytes]).toEqual([9, 8]);
  });

  it('create-if-absent dispatches crWarmPut(mode=create) and maps 0 → WriteConflictError', async () => {
    const r = rec();
    const d = new RedisWarmDriver({ client: fakeClient(r, { put: 1 }) });
    const { token } = await d.putConditional(REF, new Uint8Array([1, 2]), NO_ROW);
    expect(token.length).toBeGreaterThan(0);
    const [hashKey, indexKey, mode, expected, tok, member, payload] = r.put[0]!;
    expect(mode).toBe('create');
    expect(expected).toBe('');
    expect(tok).toBe(token);
    expect(member).toBe('3');
    expect(hashKey).toBe('{|_default|s}c:3');
    expect(indexKey).toBe('{|_default|s}idx');
    expect(payload).toBeInstanceOf(Buffer);
    expect([...(payload as Buffer)]).toEqual([1, 2]);

    const conflict = new RedisWarmDriver({ client: fakeClient(rec(), { put: 0 }) });
    await expect(conflict.putConditional(REF, new Uint8Array([1]), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('token-fenced update dispatches crWarmPut(mode=update, expected) and maps 0 → WriteConflictError', async () => {
    const r = rec();
    const d = new RedisWarmDriver({ client: fakeClient(r, { put: 1 }) });
    const { token } = await d.putConditional(REF, new Uint8Array([5]), 'old-tok');
    expect(token).not.toBe('old-tok');
    expect(r.put[0]![2]).toBe('update');
    expect(r.put[0]![3]).toBe('old-tok');

    const stale = new RedisWarmDriver({ client: fakeClient(rec(), { put: 0 }) });
    await expect(stale.putConditional(REF, new Uint8Array([5]), 'old-tok')).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('fenced delete dispatches crWarmDel and maps 0 → WriteConflictError', async () => {
    const r = rec();
    const d = new RedisWarmDriver({ client: fakeClient(r, { del: 1 }) });
    await d.deleteConditional(REF, 'tok');
    expect(r.del[0]).toEqual(['{|_default|s}c:3', '{|_default|s}idx', 'tok', '3']);

    const gone = new RedisWarmDriver({ client: fakeClient(rec(), { del: 0 }) });
    await expect(gone.deleteConditional(REF, 'tok')).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('mints a distinct random token per write', async () => {
    const d = new RedisWarmDriver({ client: fakeClient(rec(), { put: 1 }) });
    const a = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    const b = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    expect(a.token).not.toBe(b.token);
  });

  it('maps a transient Redis fault to TransientError', async () => {
    const d = new RedisWarmDriver({
      client: fakeClient(rec(), { hget: () => Promise.reject(new Error('Connection is closed.')) }),
    });
    await expect(d.get(REF)).rejects.toBeInstanceOf(TransientError);
  });

  it('listChunks reads the sorted-set index ascending and skips a member whose hash vanished', async () => {
    const d = new RedisWarmDriver({
      client: fakeClient(rec(), {
        zrange: ['0', '2', '9'],
        // chunk 2's hash raced a delete → empty {} → skipped; 0 and 9 are live.
        pipelineExec: [
          [null, { t: Buffer.from('t0'), b: Buffer.from([0]) }],
          [null, {}],
          [null, { t: Buffer.from('t9'), b: Buffer.from([9]) }],
        ],
      }),
    });
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([0, 9]);
  });
});
