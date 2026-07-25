import type { Db } from 'mongodb';
import { MongoWarmDriver, ensureMongoWarmIndexes } from '@/drivers/mongodb/warm';
import { IntegrityError, TransientError, ValidationError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type { ChunkRef } from '@/core/ports';

// Construction + op-dispatch checks need no MongoDB (a fake Db/collection records/answers), so they run on the
// normal lane. Full behaviour (real per-document OCC, cursor listChunks, concurrency) is exercised in
// tests/integration/mongodb.test.ts against a real MongoDB — the same split the other drivers use.

interface Call {
  op: string;
  args: unknown[];
}
interface FakeOpts {
  findOne?: Record<string, unknown> | null | (() => Promise<unknown>);
  insert?: () => Promise<void>;
  matchedCount?: number;
  deletedCount?: number;
  findDocs?: Record<string, unknown>[];
}

function fakeDb(calls: Call[], opts: FakeOpts = {}): Db {
  const col = {
    findOne: async (filter: unknown) => {
      calls.push({ op: 'findOne', args: [filter] });
      const f = opts.findOne;
      return typeof f === 'function' ? f() : (f ?? null);
    },
    insertOne: async (doc: unknown) => {
      calls.push({ op: 'insertOne', args: [doc] });
      if (opts.insert) await opts.insert();
      return { insertedId: (doc as { _id: string })._id };
    },
    updateOne: async (filter: unknown, update: unknown) => {
      calls.push({ op: 'updateOne', args: [filter, update] });
      return { matchedCount: opts.matchedCount ?? 1 };
    },
    deleteOne: async (filter: unknown) => {
      calls.push({ op: 'deleteOne', args: [filter] });
      return { deletedCount: opts.deletedCount ?? 1 };
    },
    createIndex: async (keys: unknown, indexOpts: unknown) => {
      calls.push({ op: 'createIndex', args: [keys, indexOpts] });
      return 'idx';
    },
    find: (filter: unknown) => {
      calls.push({ op: 'find', args: [filter] });
      let sortSpec: Record<string, number> | undefined;
      const cursor = {
        sort: (spec: Record<string, number>) => {
          sortSpec = spec;
          calls.push({ op: 'sort', args: [spec] });
          return cursor;
        },
        batchSize: () => cursor,
        // Honor the sort spec (not just replay insertion order) so a `_id`-vs-`ck` sort regression is caught.
        async *[Symbol.asyncIterator]() {
          const docs = [...(opts.findDocs ?? [])];
          if (sortSpec) {
            const [k, dir] = Object.entries(sortSpec)[0]!;
            docs.sort((a, b) => ((a[k] as number) - (b[k] as number)) * dir);
          }
          for (const d of docs) yield d;
        },
      };
      return cursor;
    },
  };
  return { collection: () => col } as unknown as Db;
}

const REF: ChunkRef = { segment: 's', chunkKey: 3 };
const doc = (over: Record<string, unknown> = {}) => ({
  _id: '|_default|s|3',
  token: 'tok-1',
  payload: Buffer.from([9, 8]),
  ...over,
});

describe('MongoWarmDriver construction + validation', () => {
  it('rejects a non-positive / non-integer listPageSize', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new MongoWarmDriver({ db: fakeDb([]), listPageSize: bad })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects out-of-range chunk keys / bad names before touching the collection', async () => {
    const calls: Call[] = [];
    const d = new MongoWarmDriver({ db: fakeDb(calls) });
    for (const bad of [70_000, -1, 1.5, Number.NaN]) {
      await expect(d.get({ segment: 's', chunkKey: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(d.get({ segment: '../x', chunkKey: 0 })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('MongoWarmDriver OCC dispatch (fake Db, mongo-independent)', () => {
  it('get returns null then a decoded row (payload from a Buffer OR a BSON Binary)', async () => {
    const dNull = new MongoWarmDriver({ db: fakeDb([], { findOne: null }) });
    expect(await dNull.get(REF)).toBeNull();

    const dBuf = new MongoWarmDriver({ db: fakeDb([], { findOne: doc() }) });
    expect([...(await dBuf.get(REF))!.bytes]).toEqual([9, 8]);

    // A BSON Binary exposes its bytes on `.buffer` — decoded without a runtime mongodb import.
    const dBin = new MongoWarmDriver({
      db: fakeDb([], { findOne: doc({ payload: { buffer: Buffer.from([1, 2, 3]) } }) }),
    });
    expect([...(await dBin.get(REF))!.bytes]).toEqual([1, 2, 3]);
  });

  it('create-if-absent → insertOne(deterministic _id); a duplicate key → WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = new MongoWarmDriver({ db: fakeDb(calls) });
    const { token } = await d.putConditional(REF, new Uint8Array([1, 2]), NO_ROW);
    expect(token.length).toBeGreaterThan(0);
    const inserted = calls[0]!.args[0] as Record<string, unknown>;
    expect(inserted._id).toBe('|_default|s|3');
    expect(inserted).toMatchObject({ kp: '', ns: '_default', seg: 's', ck: 3, token });
    expect(Buffer.isBuffer(inserted.payload)).toBe(true);

    const dup = new MongoWarmDriver({
      db: fakeDb([], {
        insert: () => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })),
      }),
    });
    await expect(dup.putConditional(REF, new Uint8Array([1]), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('token-fenced update → updateOne({_id,token}); matchedCount 0 → WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = new MongoWarmDriver({ db: fakeDb(calls, { matchedCount: 1 }) });
    const { token } = await d.putConditional(REF, new Uint8Array([5]), 'old-tok');
    expect(token).not.toBe('old-tok');
    expect(calls[0]!.args[0]).toEqual({ _id: '|_default|s|3', token: 'old-tok' });

    const stale = new MongoWarmDriver({ db: fakeDb([], { matchedCount: 0 }) });
    await expect(stale.putConditional(REF, new Uint8Array([5]), 'old-tok')).rejects.toBeInstanceOf(
      WriteConflictError,
    );
  });

  it('fenced delete → deleteOne({_id,token}); deletedCount 0 → WriteConflictError', async () => {
    const calls: Call[] = [];
    const d = new MongoWarmDriver({ db: fakeDb(calls, { deletedCount: 1 }) });
    await d.deleteConditional(REF, 'tok');
    expect(calls[0]!.args[0]).toEqual({ _id: '|_default|s|3', token: 'tok' });

    const gone = new MongoWarmDriver({ db: fakeDb([], { deletedCount: 0 }) });
    await expect(gone.deleteConditional(REF, 'tok')).rejects.toBeInstanceOf(WriteConflictError);
  });

  it('mints a distinct random token per write', async () => {
    const d = new MongoWarmDriver({ db: fakeDb([]) });
    const a = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    const b = await d.putConditional(REF, new Uint8Array([1]), NO_ROW);
    expect(a.token).not.toBe(b.token);
  });

  it('maps a transient Mongo fault to TransientError', async () => {
    const d = new MongoWarmDriver({
      db: fakeDb([], {
        findOne: () =>
          Promise.reject(Object.assign(new Error('net'), { name: 'MongoNetworkError' })),
      }),
    });
    await expect(d.get(REF)).rejects.toBeInstanceOf(TransientError);
  });

  it('listChunks scopes the query and sorts NUMERICALLY by ck (not by the _id string)', async () => {
    const calls: Call[] = [];
    // ck 9/10/100 with matching _ids, fed out of order. Numeric ck sort → [9,10,100]; an _id-STRING sort
    // would give [10,100,9] ("10"<"100"<"9"), so asserting [9,10,100] catches a regression to sort({_id:1}).
    const d = new MongoWarmDriver({
      db: fakeDb(calls, {
        findDocs: [
          { _id: '|_default|s|100', ck: 100, token: 't', payload: Buffer.from([1]) },
          { _id: '|_default|s|9', ck: 9, token: 't', payload: Buffer.from([1]) },
          { _id: '|_default|s|10', ck: 10, token: 't', payload: Buffer.from([1]) },
        ],
      }),
    });
    const seen: number[] = [];
    for await (const row of d.listChunks({ segment: 's' })) seen.push(row.chunkKey);
    expect(seen).toEqual([9, 10, 100]);
    expect(calls[0]).toEqual({ op: 'find', args: [{ kp: '', ns: '_default', seg: 's' }] });
    expect(calls.find((c) => c.op === 'sort')?.args[0]).toEqual({ ck: 1 }); // numeric sort key
  });

  it('listChunks rejects a scope-matching doc that lacks a numeric ck (untrusted-data posture)', async () => {
    const d = new MongoWarmDriver({
      db: fakeDb([], {
        findDocs: [{ _id: '|_default|s|x', ck: 'x', token: 't', payload: Buffer.from([1]) }],
      }),
    });
    await expect(async () => {
      for await (const _row of d.listChunks({ segment: 's' })) void _row;
    }).rejects.toBeInstanceOf(IntegrityError);
  });

  it('ensureMongoWarmIndexes creates the { kp, ns, seg, ck } listChunks index', async () => {
    const calls: Call[] = [];
    await ensureMongoWarmIndexes(fakeDb(calls), 'coll');
    const idx = calls.find((c) => c.op === 'createIndex');
    expect(idx?.args[0]).toEqual({ kp: 1, ns: 1, seg: 1, ck: 1 });
  });
});
