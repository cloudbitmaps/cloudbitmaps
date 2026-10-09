import fc from 'fast-check';
import {
  openGenerationReader,
  publishGeneration,
  writeCrbmGeneration,
} from '@/core/crbm-storage-source';
import { eraseIdFromSegment } from '@/core/erase-id';
import { joinId } from '@/core/bit-route';
import type { GenKey, IStorageDriver } from '@/core/ports';
import { TransientError } from '@/index';
import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';

// When the id is not in the current generation, the erasure looks through the other generations for the newest
// holder, a few at a time. The answer must be what a one-at-a-time scan, newest first, gives for every layout:
// the newest holder, the first fault in newest-first order and no fault past a holder.

const SEG = { segment: 's' };
const ID = joinId(0, 1);
const HOLDS_BOUND = 4;

interface Layout {
  /** Which generations 0..n-1 hold the id. */
  readonly holds: readonly boolean[];
  /** The pointer: the generation the row names (generations above it were never published). */
  readonly from: number;
  readonly delays: readonly number[];
  /** Which generations fault when read (never the pointer's own). */
  readonly fails?: readonly boolean[];
}

interface Probe {
  readonly storage: IStorageDriver;
  readonly registry: MemoryRegistryDriver;
  readonly stats: { active: Set<number>; peak: number; opened: number[] };
}

async function build(
  layout: Layout,
  opts: { fail?: (generation: number) => Error | undefined } = {},
): Promise<Probe> {
  const inner = new MemoryStorageDriver();
  const registry = new MemoryRegistryDriver();
  for (let g = 0; g < layout.holds.length; g++) {
    const key = { ...SEG, generation: g };
    await writeCrbmGeneration(inner, key, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues(layout.holds[g] ? [1, 2] : [2]) },
    ]);
    if (g <= layout.from) await publishGeneration(registry, key);
  }
  const stats = { active: new Set<number>(), peak: 0, opened: [] as number[] };
  const visit = async <T>(key: GenKey, op: () => Promise<T>): Promise<T> => {
    stats.opened.push(key.generation);
    stats.active.add(key.generation);
    stats.peak = Math.max(stats.peak, stats.active.size);
    try {
      await new Promise((r) => setTimeout(r, layout.delays[key.generation] ?? 1));
      const err = opts.fail?.(key.generation);
      if (err !== undefined) throw err;
      return await op();
    } finally {
      stats.active.delete(key.generation);
    }
  };
  const storage: IStorageDriver = {
    capabilities: () => inner.capabilities(),
    getRange: (key, offset, length) => visit(key, () => inner.getRange(key, offset, length)),
    getTail: (key, max) => visit(key, () => inner.getTail(key, max)),
    putImmutable: (key, fn) => inner.putImmutable(key, fn),
    list: (ref) => inner.list(ref),
    delete: (key, o) => inner.delete(key, o),
  };
  return { storage, registry, stats };
}

const erase = (p: Probe) =>
  eraseIdFromSegment(SEG, ID, { storage: p.storage, registry: p.registry, codec: roaringCodec });

/** What is left in the bucket that still holds the id, read straight off the objects. */
async function holdersLeft(p: Probe): Promise<number[]> {
  const left: number[] = [];
  for await (const key of p.storage.list(SEG)) {
    const reader = await openGenerationReader(p.storage, key, undefined);
    const bytes = await reader.getChunk(0);
    if (bytes !== null && roaringCodec.safeDeserialize(bytes, 1 << 20).has(1)) {
      left.push(key.generation);
    }
  }
  return left;
}

const layoutArb = fc.integer({ min: 1, max: 9 }).chain((n) =>
  fc.record({
    holds: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    from: fc.integer({ min: 0, max: n - 1 }),
    delays: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: n, maxLength: n }),
    fails: fc.array(
      fc.integer({ min: 0, max: 5 }).map((x) => x === 0),
      {
        minLength: n,
        maxLength: n,
      },
    ),
  }),
);

/**
 * The one-at-a-time scan the parallel one must equal: every generation above the pointer newest first (all of them,
 * since each holder there must be found), then, only if none held, the ones below newest first up to the first
 * holder. A fault surfaces where the walk reaches it. Returns the generation that holds the newest copy, `'none'`
 * when nothing holds the id, or the faulting generation.
 */
function serialOracle(layout: Layout): { newest: number | 'none' } | { fault: number } {
  const n = layout.holds.length;
  const above = Array.from({ length: n }, (_, g) => n - 1 - g).filter((g) => g > layout.from);
  const below = Array.from({ length: n }, (_, g) => n - 1 - g).filter((g) => g < layout.from);
  const holdersAbove: number[] = [];
  for (const g of above) {
    if (layout.fails?.[g]) return { fault: g };
    if (layout.holds[g]) holdersAbove.push(g);
  }
  if (holdersAbove.length > 0) return { newest: holdersAbove[0]! };
  for (const g of below) {
    if (layout.fails?.[g]) return { fault: g };
    if (layout.holds[g]) return { newest: g };
  }
  return { newest: 'none' };
}

describe('the erasure scan for the generations holding the id', () => {
  it('equals the serial scan for every layout, faults included, and leaves no holder behind', async () => {
    await fc.assert(
      fc.asyncProperty(layoutArb, async (raw) => {
        const layout: Layout = {
          ...raw,
          holds: raw.holds.map((h, g) => (g === raw.from ? false : h)),
          fails: raw.fails.map((f, g) => (g === raw.from ? false : f)),
        };
        const p = await build(layout, {
          fail: (g) => (layout.fails?.[g] ? new Error(`boom ${g}`) : undefined),
        });
        const expected = serialOracle(layout);
        if ('fault' in expected) {
          await expect(erase(p)).rejects.toThrow(`boom ${expected.fault}`);
          return;
        }
        const res = await erase(p);
        if (expected.newest === 'none') {
          expect(res).toMatchObject({ erased: false, reason: 'not-member' });
        } else {
          expect(res).toMatchObject({ erased: true, fromGeneration: expected.newest });
        }
        expect(await holdersLeft(p)).toEqual([]);
      }),
      { numRuns: 120 },
    );
  }, 60_000);

  it.each([
    { generations: 40, holder: 38 },
    { generations: 60, holder: 58 },
    { generations: 40, holder: 30 },
  ])(
    'stops reading past the first holder: $generations generations, newest holder $holder',
    async ({ generations, holder }) => {
      const from = generations - 1;
      const layout: Layout = {
        holds: Array.from({ length: generations }, (_, g) => g <= holder),
        from,
        delays: Array(generations).fill(2),
      };
      const p = await build(layout);
      const res = await erase(p);
      expect(res).toMatchObject({ erased: true, fromGeneration: holder });
      // Newest first below the pointer, the holder is this far in; only reads already in flight may land past it.
      const index = from - 1 - holder;
      const below = new Set(p.stats.opened.filter((g) => g < from));
      expect(below.size).toBeLessThanOrEqual(index + HOLDS_BOUND);
    },
  );

  it('throws the first fault in newest-first order when a holder sits above the pointer', async () => {
    const layout: Layout = {
      holds: [false, false, true, true, true, true],
      from: 1,
      delays: [1, 1, 1, 9, 1, 1],
    };
    // Generations 5, 4, 3 and 2 are all read, since every holder above the pointer must be found; 4 faults first in
    // newest-first order even though 3 faults too and answers later.
    const p = await build(layout, {
      fail: (g) => (g === 4 || g === 3 ? new Error(`boom ${g}`) : undefined),
    });
    await expect(erase(p)).rejects.toThrow('boom 4');
  });

  it('reads several generations at once, never above the bound', async () => {
    const layout: Layout = {
      holds: [true, true, true, true, true, true, true, true, false],
      from: 8,
      delays: Array(9).fill(5),
    };
    const p = await build(layout);
    const res = await erase(p);
    expect(res).toMatchObject({ erased: true, fromGeneration: 7 });
    expect(p.stats.peak).toBeGreaterThan(1);
    expect(p.stats.peak).toBeLessThanOrEqual(HOLDS_BOUND);
  });

  it('throws the fault of the newest generation read, as the serial scan would', async () => {
    const layout: Layout = {
      holds: [true, true, true, false],
      from: 3,
      delays: [1, 1, 1, 1],
    };
    // Generation 2 is the first below the pointer, so a fault there is the one that surfaces, not generation 0's.
    const p = await build(layout, {
      fail: (g) => (g === 2 ? new Error('boom 2') : g === 0 ? new Error('boom 0') : undefined),
    });
    await expect(erase(p)).rejects.toThrow('boom 2');
  });

  it('ignores a fault in a generation older than the first holder found', async () => {
    const layout: Layout = {
      holds: [true, false, true, false],
      from: 3,
      delays: [1, 1, 1, 1],
    };
    // Generation 2 holds the id, so the scan stops there: generation 0 is never looked at, and its fault never matters.
    const p = await build(layout, {
      fail: (g) => (g === 0 ? new TransientError('throttled') : undefined),
    });
    const res = await erase(p);
    expect(res).toMatchObject({ erased: true, fromGeneration: 2 });
  });
});
