import { randomBytes } from 'node:crypto';
import { runConsistencyCheck } from '@/core/consistency';
import { openGenerationReader } from '@/core/crbm-open';
import { CrbmReader } from '@/core/crbm/reader';
import { NotFoundError, TransientError, ValidationError } from '@/core/errors';
import { loadSegment } from '@/core/load';
import type { GenKey, IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { sealSummary } from '@/core/summary';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring, MemoryStorage } from '@/index';
import { storeCodec } from '../helpers/store-codec';
import { counting } from '../helpers/counting';
import { testEntropy } from '../helpers/entropy';

/**
 * The consistency scan asks whether a segment's current object is there with one zero-length tail read (a HEAD on S3, a
 * metadata read on GCS, a properties read on Azure), and lists the segment's objects only when that read, or the open's
 * first read, fails, and asks nothing of it when the row's clear summary
 * makes the open that follows the answer. The load guard's size is the reader's `count()`, the same number as the sum
 * of its per-chunk cardinalities, without building the map. None of it changes what a load reports, or what a check reports,
 * except for a store that answers reads but refuses listings.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const seg = (i: number): SegmentRef => ({ namespace: 'ns', segment: `s${i}` });

function world(encrypted = false) {
  const keystore = new InProcessKeystore({ keys: { k: randomBytes(32) }, activeKeyId: 'k' });
  const backend = new MemoryStorage();
  const store = new CloudRoaring({
    storage: backend,
    retry: false,
    ...(encrypted ? { encryption: { keystore } } : {}),
  });
  const storageCalls: Record<string, number> = {};
  const registryCalls: Record<string, number> = {};
  return {
    keystore,
    backend,
    store,
    storageCalls,
    registryCalls,
    storage: counting<IStorageDriver>(backend.storage, storageCalls),
    registry: counting<IRegistryDriver>(backend.registry, registryCalls),
  };
}

async function loadSegments(w: ReturnType<typeof world>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await w.store.load(seg(i), [1, 2, 3, 70_000]);
}

/** `storage` with `getTail` answered by `answer` first: it returns `undefined` to let the real read through. */
function tailing(
  storage: IStorageDriver,
  answer: (key: GenKey, maxBytes: number) => Promise<never> | undefined,
): IStorageDriver {
  return new Proxy(storage, {
    get(t, p, rx) {
      const value: unknown = Reflect.get(t, p, rx);
      if (p !== 'getTail') return value;
      return (key: GenKey, maxBytes: number) =>
        answer(key, maxBytes) ?? (value as IStorageDriver['getTail']).call(t, key, maxBytes);
    },
  });
}

describe('checkConsistency request counts', () => {
  const N = 6;

  it('looks for each current object with one zero-length tail read, and lists nothing', async () => {
    const w = world();
    await loadSegments(w, N);
    const tails: number[] = [];
    const storage = tailing(w.storage, (_key, max) => {
      tails.push(max);
      return undefined;
    });
    const report = await runConsistencyCheck({ storage, registry: w.registry });
    expect(report).toEqual({ checked: N, inconsistent: [], errored: [] });
    expect(w.storageCalls.list ?? 0).toBe(0);
    expect(tails).toEqual(Array(N).fill(0));
    expect(w.registryCalls.list).toBe(1);
    expect(w.registryCalls.get).toBe(N);
  });

  it('with summaries and a clear summary on every row, the open is the only object request', async () => {
    const w = world();
    await loadSegments(w, N);
    const tails: number[] = [];
    const storage = tailing(w.storage, (_key, max) => {
      tails.push(max);
      return undefined;
    });
    const report = await runConsistencyCheck(
      { storage, registry: w.registry },
      { summaries: true },
    );
    expect(report).toEqual({ checked: N, inconsistent: [], errored: [], summariesUnchecked: 0 });
    expect(w.storageCalls.list ?? 0).toBe(0);
    expect(w.storageCalls.getTail).toBe(N);
    expect(tails.every((max) => max > 0)).toBe(true);
  });

  it('with summaries and rows that carry none, asks once per segment', async () => {
    const w = world();
    await loadSegments(w, N);
    for (let i = 0; i < N; i++) {
      const row = (await w.backend.registry.get(seg(i)))!;
      await w.backend.registry.compareAndSwap(seg(i), row.token, { summary: undefined });
    }
    const report = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry },
      { summaries: true },
    );
    expect(report).toEqual({ checked: N, inconsistent: [], errored: [], summariesUnchecked: 0 });
    expect(w.storageCalls.list ?? 0).toBe(0);
    expect(w.storageCalls.getTail).toBe(N);
  });

  it('with summaries and sealed rows, asks first and then opens; without the key, asks once', async () => {
    const w = world(true);
    await loadSegments(w, N);
    const sealed = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry, keystore: w.keystore },
      { summaries: true },
    );
    expect(sealed).toEqual({ checked: N, inconsistent: [], errored: [], summariesUnchecked: 0 });
    expect(w.storageCalls.list ?? 0).toBe(0);
    expect(w.storageCalls.getTail).toBe(2 * N);
    w.storageCalls.getTail = 0;
    const keyless = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry },
      { summaries: true },
    );
    expect(keyless).toEqual({ checked: N, inconsistent: [], errored: [], summariesUnchecked: N });
    expect(w.storageCalls.getTail).toBe(N);
  });

  it('asks nothing of a row with no generation, and nothing of a destroyed one', async () => {
    const w = world();
    await w.store.load(seg(0), [1]);
    await w.backend.registry.create(seg(1), { status: 'active', currentGen: null } as never, {});
    await w.store.load(seg(2), [1]);
    const row = (await w.backend.registry.get(seg(2)))!;
    await w.backend.registry.compareAndSwap(seg(2), row.token, { status: 'destroyed' });
    const report = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
    expect(report).toEqual({ checked: 3, inconsistent: [], errored: [] });
    expect(w.storageCalls.getTail).toBe(1);
    expect(w.storageCalls.list ?? 0).toBe(0);
  });
});

describe('a missing object is confirmed by the listing, only for the segments that look torn', () => {
  it('costs a listing for a torn segment and none for a healthy one', async () => {
    const w = world();
    await loadSegments(w, 3);
    await w.backend.storage.delete({ ...seg(1), generation: 0 });
    const report = await runConsistencyCheck({ storage: w.storage, registry: w.registry });
    expect(report.inconsistent.map((i) => i.segment)).toEqual(['s1']);
    expect(w.storageCalls.getTail).toBe(3);
    expect(w.storageCalls.list).toBe(1);
  });

  // S3 answers a HEAD of a missing object and of a missing bucket alike (a bare 404), so its zero-length tail read says
  // "no such object" where a listing raises the bucket's own error. The check reports what the listing says.
  it('is the listing that decides, so a tail read that cannot tell a missing bucket does not make every segment torn', async () => {
    const w = world();
    await loadSegments(w, 2);
    const storage = new Proxy(
      tailing(w.storage, (_key, max) =>
        max === 0 ? Promise.reject(new NotFoundError('no such generation')) : undefined,
      ),
      {
        get(t, p, rx) {
          const value: unknown = Reflect.get(t, p, rx);
          if (p !== 'list') return value;
          return (): AsyncIterable<GenKey> => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(
                  new ValidationError('the bucket does not exist: missing; check the bucket name'),
                ),
            }),
          });
        },
      },
    );
    const report = await runConsistencyCheck({ storage, registry: w.registry });
    expect(report.inconsistent).toEqual([]);
    expect(report.errored.map((e) => e.error)).toEqual([
      'the bucket does not exist: missing; check the bucket name',
      'the bucket does not exist: missing; check the bucket name',
    ]);
  });

  it('with the listing that finds the object, a segment is present although the tail read said it was not', async () => {
    const w = world();
    await loadSegments(w, 1);
    const storage = tailing(w.storage, (_key, max) =>
      max === 0 ? Promise.reject(new NotFoundError('stale')) : undefined,
    );
    const report = await runConsistencyCheck({ storage, registry: w.registry });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [] });
  });
});

describe('checkConsistency reports the same in every fault case', () => {
  const missing: GenKey = { ...SEG, generation: 0 };

  async function oneSegment(encrypted: boolean) {
    const w = world(encrypted);
    await w.store.load(SEG, [1, 2, 3]);
    return w;
  }

  const modes: Array<[string, boolean, boolean, boolean]> = [
    // name, summaries, encrypted, keystore handed to the check
    ['no summaries asked', false, false, false],
    ['clear summary', true, false, false],
    ['sealed summary with the key', true, true, true],
    ['sealed summary without the key', true, true, false],
  ];

  it.each(modes)(
    'a missing object is missing-storage-generation: %s',
    async (_name, summaries, enc, keyed) => {
      const w = await oneSegment(enc);
      await w.backend.storage.delete(missing);
      const report = await runConsistencyCheck(
        { storage: w.storage, registry: w.registry, ...(keyed ? { keystore: w.keystore } : {}) },
        { summaries },
      );
      expect(report.inconsistent).toEqual([
        { segment: 's', namespace: 'ns', currentGen: 0, issue: 'missing-storage-generation' },
      ]);
      expect(report.errored).toEqual([]);
      if (summaries) expect(report.summariesUnchecked).toBe(0);
    },
  );

  it.each(modes)(
    'a failing storage read is errored with its message, the scan goes on: %s',
    async (_name, summaries, enc, keyed) => {
      const w = await oneSegment(enc);
      await w.store.load({ namespace: 'ns', segment: 'other' }, [9]);
      const failing = (key: GenKey): boolean => key.segment === 's';
      const base = tailing(w.storage, (key) =>
        failing(key) ? Promise.reject(new TransientError('storage unavailable')) : undefined,
      );
      // A store that is down fails a listing as it fails a read.
      const storage = new Proxy(base, {
        get(t, p, rx) {
          const value: unknown = Reflect.get(t, p, rx);
          if (p !== 'list') return value;
          return (ref: SegmentRef) =>
            (async function* () {
              if (ref.segment === 's') throw new TransientError('storage unavailable');
              yield* (value as IStorageDriver['list']).call(t, ref);
            })();
        },
      });
      const report = await runConsistencyCheck(
        { storage, registry: w.registry, ...(keyed ? { keystore: w.keystore } : {}) },
        { summaries },
      );
      expect(report.inconsistent).toEqual([]);
      expect(report.errored).toEqual([
        { segment: 's', namespace: 'ns', error: 'storage unavailable' },
      ]);
      expect(report.checked).toBe(2);
    },
  );

  it("a zero-length read that fails is settled by the listing, whose own error is the segment's", async () => {
    const w = await oneSegment(false);
    const storage = tailing(w.storage, (_key, max) =>
      max === 0 ? Promise.reject(new Error('UnknownError')) : undefined,
    );
    expect(await runConsistencyCheck({ storage, registry: w.registry })).toEqual({
      checked: 1,
      inconsistent: [],
      errored: [],
    });
    const denied = new Proxy(storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'list') return value;
        return (): AsyncIterable<GenKey> => ({
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('AccessDenied')) }),
        });
      },
    });
    const report = await runConsistencyCheck({ storage: denied, registry: w.registry });
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'AccessDenied' }]);
  });

  it('a throttled tail read of the open is errored with its message', async () => {
    const w = await oneSegment(false);
    const storage = tailing(w.storage, (_key, max) =>
      max > 0 ? Promise.reject(new TransientError('slow down')) : undefined,
    );
    const report = await runConsistencyCheck(
      { storage, registry: w.registry },
      { summaries: true },
    );
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'slow down' }]);
  });

  it('a NotFoundError from the open while the listing still finds the object is an error of the segment, with the open message', async () => {
    const w = await oneSegment(false);
    const storage = tailing(w.storage, (_key, max) =>
      max > 0 ? Promise.reject(new NotFoundError('gone mid-open')) : undefined,
    );
    const report = await runConsistencyCheck(
      { storage, registry: w.registry },
      { summaries: true },
    );
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([{ segment: 's', namespace: 'ns', error: 'gone mid-open' }]);
  });

  /**
   * A 65,536-chunk segment, whose index is longer than the default 256 KiB tail, behind a storage that deletes the
   * object once the first non-empty tail read has answered. `tails` and `ranges` count the open's reads.
   */
  async function deletedAfterFirstTail(hint?: number) {
    const w = world();
    await w.store.load(
      SEG,
      Array.from({ length: 65_536 }, (_, i) => i * 65_536),
    );
    if (hint !== undefined) {
      const row = (await w.registry.get(SEG))!;
      await w.registry.compareAndSwap(SEG, row.token, {
        summary: { ...(row.summary as object), tailBytes: hint } as NonNullable<typeof row.summary>,
      });
    }
    const seen = { tails: 0, ranges: 0 };
    let first = true;
    const storage = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p === 'getRange') {
          return (...args: unknown[]) => {
            seen.ranges++;
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (p !== 'getTail') return value;
        return async (key: GenKey, max: number) => {
          const tail = await (value as IStorageDriver['getTail']).call(t, key, max);
          if (max > 0) seen.tails++;
          if (first && max > 0) {
            first = false;
            await w.backend.storage.delete(key);
          }
          return tail;
        };
      },
    });
    const report = await runConsistencyCheck(
      { storage, registry: w.registry },
      { summaries: true },
    );
    return { report, seen };
  }

  it('an object deleted after the open first read it is an error of the segment, not a torn one', async () => {
    // On a cleartext row whose summary covers the index the open reads once (the next test), so the fault is placed on
    // an open whose hint is too small: the default tail size, which still passes the summary's bounds and is used, and
    // which leaves the index to a second read. That second read is the one that meets the deleted object.
    const { report, seen } = await deletedAfterFirstTail(256 * 1024);
    // The premise: the open did read twice, a tail and then the index, before it met the deleted object.
    expect(seen).toEqual({ tails: 1, ranges: 1 });
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([
      { segment: 's', namespace: 'ns', error: 'no such generation: s.0' },
    ]);
  });

  it('an open sized by an honest summary reads the object once, so a deletion after that read is not met', async () => {
    // Fails on main, where the index is a second read and the deleted object is an error of the segment
    // (errored ['s']); passes with the tail read sized from the summary.
    const { report, seen } = await deletedAfterFirstTail();
    expect(report.inconsistent).toEqual([]);
    expect(report.errored).toEqual([]);
    expect(seen).toEqual({ tails: 1, ranges: 0 });
  });

  it('a store that answers reads but refuses listings reports each object that is there as present', async () => {
    const w = await oneSegment(false);
    const gone: SegmentRef = { namespace: 'ns', segment: 'gone' };
    await w.store.load(gone, [9]);
    await w.backend.storage.delete({ ...gone, generation: 0 });
    const storage = new Proxy(w.storage, {
      get(t, p, rx) {
        const value: unknown = Reflect.get(t, p, rx);
        if (p !== 'list') return value;
        return (): AsyncIterable<GenKey> => ({
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('AccessDenied')) }),
        });
      },
    });
    for (const summaries of [false, true]) {
      const report = await runConsistencyCheck({ storage, registry: w.registry }, { summaries });
      expect(report.inconsistent).toEqual([]);
      expect(report.errored).toEqual([{ segment: 'gone', namespace: 'ns', error: 'AccessDenied' }]);
    }
  });

  it('a row whose pointer moved after the listing is judged at the live pointer, with summaries too', async () => {
    const w = world();
    await w.store.load(SEG, [1]);
    await w.store.load(SEG, [1, 2]);
    await w.backend.storage.delete({ ...SEG, generation: 0 });
    const realList = w.backend.registry.list.bind(w.backend.registry);
    const registry: IRegistryDriver = new Proxy(w.registry, {
      get(t, p, rx) {
        if (p !== 'list') return Reflect.get(t, p, rx) as unknown;
        return async function* (ns?: string) {
          for await (const rec of realList(ns)) yield { ...rec, currentGen: 0 };
        };
      },
    });
    const report = await runConsistencyCheck({ storage: w.storage, registry }, { summaries: true });
    expect(report).toEqual({ checked: 1, inconsistent: [], errored: [], summariesUnchecked: 0 });
  });

  it('a pointer ahead of its object is missing even where the sealed summary is for it', async () => {
    const w = world(true);
    await w.store.load(SEG, [1, 2, 3]);
    const row = (await w.backend.registry.get(SEG))!;
    const aead = await w.keystore.openDek(row.wrappedDeks!);
    await w.backend.registry.compareAndSwap(SEG, row.token, {
      currentGen: 1,
      summary: sealSummary(aead, SEG, 1, 3, '4096:1', 300),
    });
    const report = await runConsistencyCheck(
      { storage: w.storage, registry: w.registry, keystore: w.keystore },
      { summaries: true },
    );
    expect(report.inconsistent.map((i) => [i.currentGen, i.issue])).toEqual([
      [1, 'missing-storage-generation'],
    ]);
  });
});

describe('the reader count is the sum of its per-chunk cardinalities', () => {
  const key = (ref: SegmentRef): GenKey => ({ ...ref, generation: 0 });
  const shapes: Array<[string, () => number[]]> = [
    ['one id', () => [7]],
    ['one chunk, full', () => Array.from({ length: 65_536 }, (_, i) => i)],
    ['three full chunks', () => Array.from({ length: 3 * 65_536 }, (_, i) => i)],
    ['one id in each of 65,536 chunks', () => Array.from({ length: 65_536 }, (_, i) => i * 65_536)],
    ['a few sparse chunks', () => [0, 1, 65_536, 200_000, 4_000_000, 4_000_001]],
  ];

  it.each(shapes)('%s', async (_name, ids) => {
    const w = world();
    const list = ids();
    await w.store.load(SEG, list);
    const reader = await openGenerationReader(w.backend.storage, key(SEG), undefined);
    const sum = [...reader.cardinalities().values()].reduce((a, b) => a + b, 0);
    expect(reader.count()).toBe(sum);
    expect(reader.count()).toBe(list.length);
    expect(reader.cardinalities().size).toBe(reader.chunkKeys().length);
  });

  it('an empty generation', async () => {
    const w = world();
    await w.store.load(SEG, [], { allowEmpty: true });
    const reader = await openGenerationReader(w.backend.storage, key(SEG), undefined);
    expect(reader.count()).toBe(0);
    expect(reader.cardinalities().size).toBe(0);
  });

  it('an encrypted generation, opened with its key', async () => {
    const w = world(true);
    const other: SegmentRef = { segment: 'e' };
    await w.store.load(other, [1, 2, 3, 100_000]);
    const row = (await w.backend.registry.get(other))!;
    const aead = await w.keystore.openDek(row.wrappedDeks!);
    const { aadFor } = await import('@/core/crypto');
    const reader = await openGenerationReader(w.backend.storage, key(other), {
      aead,
      aadFor: (scope) => aadFor(other, 0, scope),
    });
    expect(reader.count()).toBe(4);
    expect([...reader.cardinalities().values()].reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe('a load that needs the current size takes it from count()', () => {
  it('reads no per-chunk map, and the guard judges the same size, from a row with no summary', async () => {
    const memory = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const calls: Record<string, number> = {};
    const storage = counting<IStorageDriver>(memory, calls);
    const deps = { storage, registry, entropy: testEntropy, codec: storeCodec };
    for (const n of [3, 5]) {
      const r = await loadSegment(
        SEG,
        Array.from({ length: n }, (_, i) => i * 70_000),
        deps,
      );
      expect(r.published).toBe(true);
    }
    const row = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, row.token, { summary: undefined });
    for (const k of Object.keys(calls)) delete calls[k];
    const spy = vi.spyOn(CrbmReader.prototype, 'cardinalities');
    try {
      const refused = await loadSegment(SEG, [1], deps, { guard: { minRetained: 0.5 } });
      expect(refused).toMatchObject({
        published: false,
        reason: 'min-retained',
        cardinalityBefore: 5,
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // The same requests as before: the open's tail read, and no listing.
    expect(calls.getTail ?? 0).toBeGreaterThanOrEqual(1);
    expect(calls.list ?? 0).toBe(0);
  });

  it('a consistency check with summaries builds no per-chunk map either', async () => {
    const w = world();
    await loadSegments(w, 2);
    const spy = vi.spyOn(CrbmReader.prototype, 'cardinalities');
    try {
      await runConsistencyCheck({ storage: w.storage, registry: w.registry }, { summaries: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
