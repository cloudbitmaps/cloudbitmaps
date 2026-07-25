import fc from 'fast-check';
import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import { splitId } from '@/core/bit-route';

// IDs spanning ~5 chunks so multi-chunk routing + merge are exercised.
const ID = fc.integer({ min: 0, max: 300_000 });

const op = fc.oneof(
  fc.record({ t: fc.constant('add' as const), id: ID }),
  fc.record({ t: fc.constant('remove' as const), id: ID }),
  fc.record({ t: fc.constant('addMany' as const), ids: fc.array(ID, { maxLength: 20 }) }),
  fc.record({ t: fc.constant('removeMany' as const), ids: fc.array(ID, { maxLength: 20 }) }),
);

/** Seed Cold from a set of ids (grouped into per-chunk roaring bytes). */
function seedCold(cold: MemoryColdChunkSource, segment: string, ids: number[]): void {
  const byChunk = new Map<number, number[]>();
  for (const id of ids) {
    const { chunkKey, remainder } = splitId(id);
    const rems = byChunk.get(chunkKey) ?? [];
    rems.push(remainder);
    byChunk.set(chunkKey, rems);
  }
  for (const [chunkKey, rems] of byChunk) {
    cold.seed({ segment, chunkKey }, SafeBitmap.fromValues(rems).serialize());
  }
}

describe('engine vs Set oracle (I2, V4, V5)', () => {
  it('matches a Set across random op sequences, with seeded Cold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(ID, { maxLength: 50 }),
        fc.array(op, { maxLength: 80 }),
        async (coldIds, ops) => {
          const warm = new MemoryWarmDriver();
          const cold = new MemoryColdChunkSource();
          seedCold(cold, 's', coldIds);
          const seg = new CloudRoaring({ warm, cold }).segment('s');
          const oracle = new Set<number>(coldIds);

          for (const o of ops) {
            if (o.t === 'add') {
              await seg.add(o.id);
              oracle.add(o.id);
            } else if (o.t === 'remove') {
              await seg.remove(o.id);
              oracle.delete(o.id);
            } else if (o.t === 'addMany') {
              await seg.addMany(o.ids);
              for (const id of o.ids) oracle.add(id);
            } else {
              await seg.removeMany(o.ids);
              for (const id of o.ids) oracle.delete(id);
            }
          }

          expect(await seg.count()).toBe(oracle.size);

          const got: number[] = [];
          for await (const id of seg.iterate()) got.push(id);
          expect(got).toEqual([...oracle].sort((a, b) => a - b));

          // has() is two-sided: true for members, false for non-members.
          for (const id of [...oracle].slice(0, 5)) {
            expect(await seg.has(id)).toBe(true);
          }
          for (const id of [7, 99_999, 200_001, 300_000]) {
            expect(await seg.has(id)).toBe(oracle.has(id));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
