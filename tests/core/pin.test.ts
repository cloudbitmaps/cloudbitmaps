import {
  CloudRoaring,
  InProcessKeystore,
  MemoryColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
  gcOrphanGenerations,
} from '@/index';
import { destroySegment } from '@/core/erasure';
import { UnsupportedError } from '@/core/errors';
import type { SegmentRef } from '@/index';

/**
 * A pin exists so a long job describes one instant. The first implementation made the snapshot a `Segment` over
 * a single-segment, generation-locked source, and an adversarial review reproduced five defects that all
 * descended from that one shape. Each has a case here.
 */
const REF: SegmentRef = { segment: 's' };
const OTHER: SegmentRef = { segment: 'other' };

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function world(opts: { keystore?: InProcessKeystore } = {}) {
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver();
  await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, [1, 2, 3], {
    registry,
    keystore: opts.keystore,
  });
  await bulkLoadCrbmGeneration(cold, { ...OTHER, generation: 0 }, [2, 3, 4], { registry });
  const store = new CloudRoaring({ cold, registry, keystore: opts.keystore });
  return { cold, registry, store };
}

describe('pin holds one segment at one generation', () => {
  it('a publish underneath does not move a pinned handle', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(3);

    await bulkLoadCrbmGeneration(w.cold, { ...REF, generation: 1 }, [1, 2, 3, 4, 5], {
      registry: w.registry,
    });

    expect(await snap.count()).toBe(3); // still the pinned instant
    expect(await collect(snap.iterate())).toEqual([1, 2, 3]);
    expect(await snap.has(5)).toBe(false);

    const fresh = new CloudRoaring({ cold: w.cold, registry: w.registry });
    expect(await fresh.segment('s').count()).toBe(5); // …while the world moved on
  });

  it('re-pinning observes the new generation', async () => {
    const w = await world();
    const first = await w.store.segment('s').pin();
    await bulkLoadCrbmGeneration(w.cold, { ...REF, generation: 1 }, [9], { registry: w.registry });
    const second = await w.store.segment('s').pin();

    expect(await first.count()).toBe(3);
    expect(await second.count()).toBe(1);
  });

  it('the combine verbs work on a pinned handle — pinned subject, live operands', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    const other = w.store.segment('other');

    expect(await collect(snap.intersect([other]))).toEqual([2, 3]);
    expect(await collect(snap.andNot([other]))).toEqual([1]);
    expect(await collect(snap.union([other]))).toEqual([1, 2, 3, 4]);
  });

  it('a pinned handle used as an OPERAND is read at its pin, not live', async () => {
    // The inverse of the case above, and the one that used to compose silently wrong.
    const w = await world();
    const snap = await w.store.segment('s').pin();
    await bulkLoadCrbmGeneration(w.cold, { ...REF, generation: 1 }, [1, 2, 3, 4], {
      registry: w.registry,
    });

    // `other` holds [2,3,4]. Pinned `s` is [1,2,3]; live `s` would be [1,2,3,4].
    expect(await collect(w.store.segment('other').intersect([snap]))).toEqual([2, 3]);
  });

  it('a pinned handle does NOT resurrect an id reported physically gone', async () => {
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.has(2)).toBe(true); // warm the pinned chunk

    const ledger = await w.store.eraseSubject(2, { allNamespaces: true });
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });

    // The pinned generation is physically gone, so the pin cannot serve it — and it must not answer from a
    // decoded chunk cached before the erasure either. Failing is the honest outcome: a pin does not heal
    // forward, because silently moving to another generation is what it exists to prevent.
    const answer = await snap.has(2).catch(() => 'threw');
    expect(answer).not.toBe(true);
    expect(await w.store.segment('s').has(2)).toBe(false);
  });

  it('a pin taken before a crypto-shred stops reading when the shred lands', async () => {
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    const w = await world({ keystore });
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(3);

    await destroySegment(REF, { registry: w.registry }, { confirmSegment: 's' });
    w.store.invalidate(REF); // the shred happened beside the store

    expect(await snap.count()).toBe(0);
    expect(await collect(snap.iterate())).toEqual([]);
  });

  it('the pinned reader is bounded by the same LRU — a pin costs a number, not an index', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    for (let i = 0; i < 12; i++) {
      await bulkLoadCrbmGeneration(cold, { segment: `s${i}`, generation: 0 }, [i], { registry });
    }
    // A ceiling far below the number of pins we are about to hold.
    const store = new CloudRoaring({ cold, registry, coldReaderCacheMax: 2 });
    const pins = [];
    for (let i = 0; i < 12; i++) pins.push(await store.segment(`s${i}`).pin());

    // Every pin still reads correctly after the LRU has evicted its reader many times over: the generation is
    // immutable, so re-opening at the same number reproduces the same bytes.
    for (let i = 0; i < 12; i++) expect(await pins[i]!.count()).toBe(1);
    for (let i = 0; i < 12; i++) expect(await pins[i]!.has(i)).toBe(true);
  });

  it('a transient fault does not poison a pin for its lifetime', async () => {
    // The memoized-rejection bug: `this.reader ??= open()` cached a REJECTED promise, so one fault made the pin
    // the single read path in the library with no resilience.
    const real = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, [1, 2, 3], { registry });

    let fail = false;
    const cold = {
      capabilities: () => real.capabilities(),
      getRange: (k: never, o: number, l: number) => real.getRange(k, o, l),
      delete: (k: never) => real.delete(k),
      list: (r: SegmentRef) => real.list(r),
      putImmutable: (k: never, fn: never) => real.putImmutable(k, fn),
      getTail: (k: never, m: number) =>
        fail ? Promise.reject(new Error('transient')) : real.getTail(k, m),
    } as unknown as MemoryColdDriver;

    const store = new CloudRoaring({ cold, registry, retry: false });
    const snap = await store.segment('s').pin();

    fail = true;
    await expect(snap.count()).rejects.toThrow('transient');
    fail = false;
    expect(await snap.count()).toBe(3); // recovered — the rejection was not memoized
  });

  it('a segment with no generation pins nothing and reads empty', async () => {
    const w = await world();
    const snap = await w.store.segment('never-loaded').pin();
    expect(await snap.count()).toBe(0);
    expect(await snap.has(1)).toBe(false);
    expect(await collect(snap.iterate())).toEqual([]);
  });

  it('a store that cannot pin says so, rather than pretending', async () => {
    const source = new MemoryColdChunkSource();
    const store = new CloudRoaring({ cold: source });
    await expect(store.segment('s').pin()).rejects.toThrow(UnsupportedError);
  });

  it('a pinned generation swept by GC fails rather than healing forward', async () => {
    // The documented cost of a pin: it is a hold, not a lease.
    const w = await world();
    const snap = await w.store.segment('s').pin();
    expect(await snap.count()).toBe(3);

    await bulkLoadCrbmGeneration(w.cold, { ...REF, generation: 1 }, [9], { registry: w.registry });
    await gcOrphanGenerations(REF, { cold: w.cold, registry: w.registry }, { keep: 0 });

    // It must NOT silently answer from generation 1 — that is the whole point of pinning.
    const answer = await snap.count().catch(() => 'threw');
    expect(answer).not.toBe(1);
  });
});
