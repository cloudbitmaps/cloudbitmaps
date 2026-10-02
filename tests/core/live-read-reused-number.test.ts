import { loadSegment } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { IntegrityError, TransientError } from '@/core/errors';
import { rollbackSegment } from '@/core/rollback';
import type { GenKey, IStorageDriver, SegmentRef } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { CrbmStorageChunkSource } from '@/core/crbm-storage-source';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { counting } from '../helpers/counting';

/**
 * A generation number can be taken again once its object is deleted: a load numbers `currentGen + 1` when no object
 * holds it, so a number freed by an interrupted collection pass, or by an erasure of the generations above a
 * rolled-back pointer, is written again with other content. A live reader that still holds the old object's index
 * (no timed refresh, or inside its TTL) then reads the new object's bytes at the old offsets. These pin that it
 * notices, by the object's footer, as a pin does, and re-resolves to the new object, rather than failing with an
 * `IntegrityError` that reads as corruption; and that a chunk that is corrupt in the object the reader opened still
 * fails.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

function world() {
  const storage = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  return { storage, registry, deps: { storage, registry, codec: roaringCodec } };
}

/** Generation `g`'s ids: some in chunk 0, more for each generation so the chunk offsets move, and one in chunk 1. */
const idsFor = (g: number): number[] => [...range(0, 10 * (g + 1)), 70_000 + g];

/** A clock that never moves, so a store with the default TTL keeps the snapshot it opened. */
const frozen = {
  now: (): number => 0,
  sleep: (): Promise<void> => Promise.resolve(),
  yieldNow: (): Promise<void> => Promise.resolve(),
};

const readers: Array<[string, object]> = [
  ['with no timed refresh (genTtlMs: 0)', { cache: { genTtlMs: 0 } }],
  ['inside its TTL', { seams: { clock: frozen } }],
];

describe.each(readers)(
  'a live reader %s, after its generation number is taken again',
  (_, opts) => {
    const open = (w: ReturnType<typeof world>) =>
      new CloudRoaring({
        storage: brandAsBackend({ storage: w.storage, registry: w.registry }),
        ...opts,
      }).segment('s', { namespace: 'ns' });

    it('heals when a collection pass stopped part-way and a rollback landed on a survivor', async () => {
      const w = world();
      for (let g = 0; g <= 3; g++) await loadSegment(SEG, idsFor(g), w.deps, { keep: 9 });
      const seg = open(w);
      expect(await seg.has(1)).toBe(true); // opens generation 3, reads chunk 0 only
      for (const g of [4, 5]) await loadSegment(SEG, idsFor(g), w.deps, { keep: 9 });
      // A newest-first pass deleted 3 and stopped; an operator rolls back onto 2; the next load takes 3 again.
      await w.storage.delete({ ...SEG, generation: 3 });
      await rollbackSegment(SEG, 2, w.deps);
      const r = await loadSegment(SEG, [...range(0, 3000), 80_000], w.deps, { keep: 9 });
      expect(r).toMatchObject({ generation: 3, published: true });
      expect(await seg.has(70_003)).toBe(false);
      expect(await seg.has(80_000)).toBe(true);
      expect(await seg.count()).toBe(3001);
    });

    it('heals when an erasure deleted the lower of two generations above a rolled-back pointer', async () => {
      const w = world();
      for (let g = 0; g <= 2; g++) {
        await loadSegment(SEG, g === 2 ? [...idsFor(g), 5000] : idsFor(g), w.deps, { keep: 9 });
      }
      const seg = open(w);
      expect(await seg.has(1)).toBe(true); // opens generation 2
      await loadSegment(SEG, idsFor(3), w.deps, { keep: 9 });
      await rollbackSegment(SEG, 1, w.deps);
      const erased = await eraseIdFromSegment(SEG, 5000, w.deps); // deletes 2, which held it; 3 stays
      expect(erased.erased).toBe(true);
      const r = await loadSegment(SEG, [...range(0, 3000), 80_000], w.deps, { keep: 9 });
      expect(r).toMatchObject({ generation: 2, published: true });
      expect(await seg.has(70_002)).toBe(false);
      expect(await seg.has(80_000)).toBe(true);
      expect(await seg.has(5000)).toBe(false);
    });

    it('heals when the erasure left nothing above the pointer, which a listing numbers the same way', async () => {
      const w = world();
      await loadSegment(SEG, idsFor(0), w.deps, { keep: 9 });
      await loadSegment(SEG, [...idsFor(1), 5000], w.deps, { keep: 9 });
      const seg = open(w);
      expect(await seg.has(1)).toBe(true); // opens generation 1
      await rollbackSegment(SEG, 0, w.deps);
      await eraseIdFromSegment(SEG, 5000, w.deps); // deletes 1
      const r = await loadSegment(SEG, [...range(0, 3000), 80_000], w.deps, { keep: 9 });
      expect(r).toMatchObject({ generation: 1, published: true });
      expect(await seg.has(70_001)).toBe(false);
      expect(await seg.has(80_000)).toBe(true);
    });
  },
);

describe('the heal, branch by branch', () => {
  const live = (storage: IStorageDriver, registry: MemoryRegistryDriver) =>
    new CloudRoaring({
      storage: brandAsBackend({ storage, registry }),
      cache: { genTtlMs: 0 },
    }).segment('s', { namespace: 'ns' });
  /** Generations 0 to 5 written; an interrupted pass took 3; a rollback onto 2; then `ids` loaded as the new 3. */
  async function reuse(w: ReturnType<typeof world>, gen: (g: number) => number[], ids: number[]) {
    for (const g of [4, 5]) await loadSegment(SEG, gen(g), w.deps, { keep: 9 });
    await w.storage.delete({ ...SEG, generation: 3 });
    await rollbackSegment(SEG, 2, w.deps);
    const r = await loadSegment(SEG, ids, w.deps, { keep: 9 });
    expect(r).toMatchObject({ generation: 3, published: true });
  }

  it('heals a read whose old offsets run past the end of a smaller new object (a range ValidationError)', async () => {
    const w = world();
    const big = (g: number): number[] => [
      ...range(0, 4000).map((i) => 2 * i + g),
      70_000 + g,
      140_000 + g,
    ];
    for (let g = 0; g <= 3; g++) await loadSegment(SEG, big(g), w.deps, { keep: 9 });
    const seg = live(w.storage, w.registry);
    expect(await seg.has(3)).toBe(true); // opens the big generation 3
    await reuse(w, big, [5, 80_000]);
    expect((await w.storage.getTail({ ...SEG, generation: 3 }, 0)).size).toBeLessThan(1000);
    expect(await seg.has(140_003)).toBe(false);
    expect(await seg.has(80_000)).toBe(true);
  });

  it('heals when the footer read finds the object gone: a publish collected it in between', async () => {
    const w = world();
    for (let g = 0; g <= 3; g++) await loadSegment(SEG, idsFor(g), w.deps, { keep: 9 });
    let arm = false;
    const racing = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getRange') return value;
        return async (key: GenKey, offset: number, length: number) => {
          const bytes = await w.storage.getRange(key, offset, length);
          if (arm && key.generation === 3) {
            arm = false;
            // Between the failing chunk read and its footer check: a publish whose `keep: 0` collects 3.
            await loadSegment(SEG, [...range(0, 500), 90_000], w.deps, { keep: 0 });
          }
          return bytes;
        };
      },
    }) as IStorageDriver;
    const seg = live(racing, w.registry);
    expect(await seg.has(1)).toBe(true);
    await reuse(w, idsFor, [...range(0, 3000), 80_000]);
    arm = true;
    expect(await seg.has(90_000)).toBe(true); // answered from the generation now current
    expect((await w.registry.get(SEG))!.currentGen).toBe(6);
  });

  it('does not swallow a transient fault in the footer read: the store retries it, and the retry heals', async () => {
    const w = world();
    for (let g = 0; g <= 3; g++) await loadSegment(SEG, idsFor(g), w.deps, { keep: 9 });
    let failTails = 0;
    let failed = 0;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) => {
          if (failTails > 0) {
            failTails -= 1;
            failed += 1;
            return Promise.reject(new TransientError('503 SlowDown'));
          }
          return w.storage.getTail(key, maxBytes);
        };
      },
    }) as IStorageDriver;
    const seg = live(flaky, w.registry);
    expect(await seg.has(1)).toBe(true);
    await reuse(w, idsFor, [...range(0, 3000), 80_000]);
    failTails = 1; // the footer check's read
    expect(await seg.has(80_000)).toBe(true);
    expect(failed).toBe(1);
  });

  it('a transient fault in the footer read reaches the caller as a TransientError when nothing retries it', async () => {
    const w = world();
    for (let g = 0; g <= 3; g++) await loadSegment(SEG, idsFor(g), w.deps, { keep: 9 });
    let failTails = 0;
    const flaky = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getTail') return value;
        return (key: GenKey, maxBytes: number) => {
          if (failTails > 0) return Promise.reject(new TransientError('503 SlowDown'));
          return w.storage.getTail(key, maxBytes);
        };
      },
    }) as IStorageDriver;
    const source = new CrbmStorageChunkSource(flaky, { registry: w.registry });
    const ref = { ...SEG, chunkKey: 1 };
    expect(await source.getChunk(ref)).not.toBeNull(); // opens generation 3, reads chunk 1
    await reuse(w, idsFor, [...range(0, 3000), 80_000]);
    // A fresh source over the old object would heal; this one still holds generation 3's old index.
    failTails = Infinity;
    await expect(source.getChunk({ ...SEG, chunkKey: 1 })).rejects.toBeInstanceOf(TransientError);
  });
});

describe('a live reader whose own object is corrupt', () => {
  it('still fails with IntegrityError: the footer says it is the object it opened', async () => {
    const w = world();
    await loadSegment(SEG, idsFor(0), w.deps);
    let flip = false;
    const corrupting = new Proxy(w.storage, {
      get(t, p, rx) {
        const value = Reflect.get(t, p, rx) as unknown;
        if (p !== 'getRange') return value;
        return async (key: GenKey, offset: number, length: number) => {
          const bytes = await w.storage.getRange(key, offset, length);
          if (!flip) return bytes;
          const out = bytes.slice();
          out[0] = (out[0] ?? 0) ^ 0xff; // a chunk payload's first byte, read from the object the reader opened
          return out;
        };
      },
    }) as IStorageDriver;
    const registryCalls: Record<string, number> = {};
    const seg = new CloudRoaring({
      storage: brandAsBackend({
        storage: corrupting,
        registry: counting(w.registry, registryCalls),
      }),
      cache: { genTtlMs: 0 },
    }).segment('s', { namespace: 'ns' });
    expect(await seg.has(1)).toBe(true);
    flip = true;
    delete registryCalls.get;
    await expect(seg.has(70_000)).rejects.toBeInstanceOf(IntegrityError);
    // The footer said it is the object the reader opened, so the read did not re-resolve the segment.
    expect(registryCalls.get).toBeUndefined();
  });
});
