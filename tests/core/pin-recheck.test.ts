import { describe, expect, it } from 'vitest';
import { CloudRoaring, InProcessKeystore, MemoryStorage, TransientError } from '@/index';
import type { Clock, Segment, SegmentRef } from '@/index';
import { brandAsBackend } from '@/core/ports';
import type { GenKey, IRegistryDriver, IStorageDriver, RegistryRecord } from '@/core/ports';
import { destroySegment, dropSegment } from '@/core/erasure';
import { eraseIdFromSegment } from '@/core/erase-id';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { PinnedStorageChunkSource } from '@/core/pinned-storage-source';
import { segmentKey } from '@/core/keys';
import { LeaseExpiredError, NotFoundError } from '@/core/errors';
import { REFRESH_RETRY_MS } from '@/core/reader-defaults';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { storeCodec } from '../helpers/store-codec';
import { testEntropy } from '../helpers/entropy';

/**
 * A pinned handle re-reads its segment's registry row at most every `cache.genTtlMs` and fails once the segment is
 * destroyed, gone or another incarnation, or its generation erased or replaced, whether or not its reader still holds
 * the chunks. Two stores share one backend: the first pins and reads, the second (here: the bare drivers) destroys.
 */
const TTL = 2_000;
const S: SegmentRef = { segment: 's' };
const O: SegmentRef = { segment: 'o' };
const IDS = [1, 2, 3, 70_000];

function manualClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

interface Options {
  readonly ttl?: number;
  readonly keystore?: InProcessKeystore;
  readonly noRegistryClock?: boolean;
}

async function world(options: Options = {}) {
  const backend = new MemoryStorage();
  const { storage, registry } = backend;
  const sent = { rows: 0, tails: 0 };
  const state = {
    fail: undefined as Error | undefined,
    tamper: (row: RegistryRecord): RegistryRecord => row,
  };
  const counted = new Proxy(registry, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'get') return typeof value === 'function' ? value.bind(t) : value;
      return async (ref: SegmentRef) => {
        sent.rows += 1;
        if (state.fail !== undefined) throw state.fail;
        const row = await t.get(ref);
        return row === null ? null : state.tamper(row);
      };
    },
  }) as IRegistryDriver;
  const readStorage: IStorageDriver = {
    capabilities: () => storage.capabilities(),
    getRange: (key: GenKey, offset: number, length: number) =>
      storage.getRange(key, offset, length),
    getTail: (key: GenKey, maxBytes: number) => {
      sent.tails += 1;
      return storage.getTail(key, maxBytes);
    },
    putImmutable: (key, write) => storage.putImmutable(key, write),
    list: (r) => storage.list(r),
    delete: (key, deleteOptions) => storage.delete(key, deleteOptions),
  };
  const put = (ref: SegmentRef, ids: number[], generation = 0) =>
    bulkLoadCrbmGeneration(storage, { ...ref, generation }, ids, {
      registry,
      keystore: options.keystore,
    });
  await put(S, IDS);
  await put(O, [2, 3, 4]);
  const clock = manualClock();
  const ttl = options.ttl ?? TTL;
  const open = (): CloudRoaring =>
    new CloudRoaring({
      storage: brandAsBackend({ storage: readStorage, registry: counted }),
      cache: { genTtlMs: ttl },
      ...(options.noRegistryClock ? {} : { seams: { clock } }),
      ...(options.keystore ? { encryption: { keystore: options.keystore } } : {}),
    });
  const deps = {
    storage,
    registry,
    keystore: options.keystore,
    entropy: testEntropy,
    codec: storeCodec,
  };
  const reset = (): void => {
    sent.rows = 0;
    sent.tails = 0;
  };
  return { storage, registry, clock, open, store: open(), sent, state, reset, put, deps };
}
type World = Awaited<ReturnType<typeof world>>;

const keystore = (): InProcessKeystore =>
  new InProcessKeystore({ keys: { k1: new Uint8Array(32).fill(7) }, activeKeyId: 'k1' });

/** Every read a pinned handle answers, each as a call that must throw once the pin is over. */
function reads(snap: Segment, other: Segment): Record<string, () => Promise<unknown>> {
  return {
    has: () => snap.has(2),
    count: () => snap.count(),
    iterate: () => collect(snap.iterate()),
    intersect: () => collect(snap.intersect([other])),
    'intersect, pin as exclude': () => collect(other.andNot([snap])),
    'intersect, pin as operand': () => collect(other.intersect([snap])),
    stat: () => snap.stat(),
    batches: async () => {
      for await (const b of snap.iterate().batches()) void b;
    },
    everyNth: () => collect(snap.everyNth(2)),
    union: () => collect(snap.union([other])),
  };
}

const ENDS: Record<string, (w: World) => Promise<void>> = {
  'cleartext destroy': async (w) => {
    await destroySegment(S, w.deps, { confirmSegment: 's', allowCleartext: true });
  },
  drop: async (w) => {
    await dropSegment(S, w.deps, { confirmSegment: 's' });
  },
  'purge of the row': async (w) => {
    await w.registry.delete(S);
  },
};

describe('a pinned handle in another store fails once its segment is destroyed', () => {
  for (const [end, run] of Object.entries(ENDS)) {
    for (const [verb] of Object.entries(reads(undefined as never, undefined as never))) {
      it(`${end}: ${verb} fails within genTtlMs, on a warm reader and chunk cache, and not before`, async () => {
        const w = await world();
        const snap = await w.store.segment('s').pin();
        const other = w.store.segment('o');
        // Warm: every chunk is in the reader and the chunk cache.
        for (const read of Object.values(reads(snap, other))) await read();
        await run(w);
        w.clock.advance(TTL - 1);
        // Inside the bound the pin still answers: the bound is stated, not zero.
        await reads(snap, other)[verb]!();
        w.clock.advance(1);
        await expect(reads(snap, other)[verb]!()).rejects.toBeInstanceOf(NotFoundError);
      });
    }
  }

  it('a crypto-shred: a warm pin in another store fails once the interval lapses, and its key is dropped', async () => {
    const ks = keystore();
    const w = await world({ keystore: ks });
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(4);
    expect(await snap.has(2)).toBe(true);
    const res = await destroySegment(S, w.deps, { confirmSegment: 's' });
    expect(res).toMatchObject({ cryptoShredded: true });
    expect(await snap.has(2)).toBe(true); // not yet due
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(snap.count()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another store's erasure of the pinned generation ends the pin", async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.has(2)).toBe(true);
    const res = await eraseIdFromSegment(S, 2, w.deps);
    expect(res).toMatchObject({ erased: true });
    expect(await snap.has(2)).toBe(true); // inside the bound
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(snap.count()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a pinned stream in progress stops at its next chunk once the interval has lapsed', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const id of snap.iterate()) {
          seen.push(id);
          if (seen.length === 1) {
            await destroySegment(S, w.deps, { confirmSegment: 's', allowCleartext: true });
            w.clock.advance(TTL);
          }
        }
      })(),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(seen.length).toBeLessThan(IDS.length);
  });

  it('a leased pin fails like any other, and a lapsed lease throws LeaseExpiredError first', async () => {
    const w = await world();
    const until = 3_600_000;
    const snap = await w.store.segment('s').pin({ leaseUntil: until });
    expect(await snap.has(2)).toBe(true);
    await destroySegment(S, w.deps, { confirmSegment: 's', allowCleartext: true });
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
    w.clock.advance(until);
    await expect(snap.has(2)).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  it('a name purged and created again: the old pin fails although its objects are still in the bucket', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.has(2)).toBe(true);
    await w.registry.delete(S);
    await w.put(S, [9], 5); // a new incarnation of the name; the old generation 0 object is still in the bucket
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a ledger that names the pinned generation with another checksum fails the pin as replaced', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.has(2)).toBe(true);
    w.state.tamper = (row) => ({
      ...row,
      knownGens: row.knownGens?.map((e) => ({ ...e, footerCrc: e.footerCrc ^ 1 })),
      summary: undefined,
    });
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toThrow(/no longer the object this handle pinned/);
    // The verdict is kept: later reads fail with no request.
    w.reset();
    await expect(snap.count()).rejects.toBeInstanceOf(NotFoundError);
    expect(w.sent).toEqual({ rows: 0, tails: 0 });
  });

  it('store.invalidate after a restore forgets the verdict', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.has(2)).toBe(true);
    w.state.tamper = (row) => ({
      ...row,
      knownGens: row.knownGens?.map((e) => ({ ...e, footerCrc: e.footerCrc ^ 1 })),
      summary: undefined,
    });
    w.clock.advance(TTL);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
    w.state.tamper = (row) => row; // the object is restored
    w.store.invalidate(S);
    expect(await snap.has(2)).toBe(true);
  });
});

describe('what a pinned handle costs', () => {
  it('one row read per interval serves every read, pin, handle and combine of the segment', async () => {
    const w = await world();
    const a = await w.store.segment('s').pin();
    const b = await w.store.segment('s').pin();
    const o = await w.store.segment('o').pin();
    await a.count();
    w.reset();
    for (let i = 0; i < 5; i++) {
      await a.has(2);
      await b.has(2);
      await collect(a.intersect([b]));
      await o.count();
    }
    expect(w.sent.rows).toBe(0); // inside the interval: nothing
    w.clock.advance(TTL);
    for (let i = 0; i < 5; i++) {
      await a.has(2);
      await b.has(2);
      await collect(a.intersect([b]));
    }
    expect(w.sent.rows).toBe(1);
    w.clock.advance(TTL);
    await Promise.all([a.has(2), b.has(2), a.count(), b.count()]);
    expect(w.sent.rows).toBe(2);
  });

  it('an idle pin makes no request, and its first read after the idle period is checked first', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    await snap.count();
    w.reset();
    w.clock.advance(100 * TTL);
    expect(w.sent.rows).toBe(0);
    await snap.has(2);
    expect(w.sent.rows).toBe(1);
  });

  it('a pin that a load has moved past, still in the ledger, answers with a row read and no footer read', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(4);
    await w.put(S, [9, 10], 1);
    w.clock.advance(TTL);
    w.reset();
    expect(await snap.count()).toBe(4);
    expect(w.sent).toEqual({ rows: 1, tails: 0 });
  });

  it('a pin whose generation has left the ledger but whose object stays answers, with one footer read per interval', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(4);
    w.state.tamper = (row) => ({ ...row, knownGens: undefined });
    for (let round = 0; round < 2; round++) {
      w.clock.advance(TTL);
      w.reset();
      expect(await snap.has(2)).toBe(true);
      expect(w.sent).toEqual({ rows: 1, tails: 1 });
    }
  });

  it('leases, a load and a rollback leave the pin answering, the row read being the only request', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    await snap.count();
    await w.put(S, [9], 1);
    await w.store.segment('s').pin({ leaseUntil: 3_000_000 });
    w.clock.advance(TTL);
    w.reset();
    expect(await snap.count()).toBe(4);
    expect(w.sent).toEqual({ rows: 1, tails: 0 });
  });

  it('with genTtlMs 0, or no clock, no row is read for a pin, and nothing bounds it', async () => {
    for (const options of [{ ttl: 0 }, { noRegistryClock: true }]) {
      const w = await world(options);
      const snap = await w.store.segment('s').pin();
      await snap.count();
      await destroySegment(S, w.deps, { confirmSegment: 's', allowCleartext: true });
      w.clock.advance(100 * TTL);
      w.reset();
      expect(await snap.has(2)).toBe(true);
      expect(w.sent.rows).toBe(0);
    }
  });
});

describe('a registry fault during a recheck', () => {
  it('a transient fault keeps serving and asks again after the retry interval', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    await snap.count();
    await destroySegment(S, w.deps, { confirmSegment: 's', allowCleartext: true });
    w.clock.advance(TTL);
    w.state.fail = new TransientError('throttled');
    w.reset();
    expect(await snap.has(2)).toBe(true);
    expect(w.sent.rows).toBe(1);
    w.clock.advance(REFRESH_RETRY_MS - 1);
    expect(await snap.has(2)).toBe(true);
    expect(w.sent.rows).toBe(1);
    w.state.fail = undefined;
    w.clock.advance(1);
    await expect(snap.has(2)).rejects.toBeInstanceOf(NotFoundError);
    expect(w.sent.rows).toBe(2);
  });

  it('any other fault fails the read with it, is not remembered, and the next read asks again', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    await snap.count();
    w.clock.advance(TTL);
    const denied = new Error('access denied');
    w.state.fail = denied;
    await expect(snap.has(2)).rejects.toBe(denied);
    w.state.fail = undefined;
    expect(await snap.has(2)).toBe(true);
  });
});

describe('a pin that has ended', () => {
  it('drops its reader, and the key the reader unwrapped', async () => {
    const w = await world({ keystore: keystore() });
    const source = new CrbmStorageChunkSource(w.storage, {
      registry: w.registry,
      keystore: keystore(),
      clock: w.clock,
      currentGenTtlMs: TTL,
    });
    const at = await source.pinGeneration(S);
    const pinned = new PinnedStorageChunkSource(source, new Map([[segmentKey(S), at!]]));
    const snapshots = (source as unknown as { snapshots: { size: number } }).snapshots;
    expect(await pinned.getChunk({ ...S, chunkKey: 0 })).not.toBeNull();
    expect(snapshots.size).toBe(1); // control: the pin's reader is held
    await destroySegment(S, w.deps, { confirmSegment: 's' });
    w.clock.advance(TTL);
    await expect(pinned.getChunk({ ...S, chunkKey: 0 })).rejects.toBeInstanceOf(NotFoundError);
    expect(snapshots.size).toBe(0);
  });
});
