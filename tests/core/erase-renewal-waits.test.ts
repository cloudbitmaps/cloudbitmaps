import { eraseIdFromSegment } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import type { Clock } from '@/core/determinism';
import type { SegmentRef } from '@/core/ports';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { unansweredRegistry } from '../helpers/unanswered-registry';

const REF: SegmentRef = { segment: 's' };
const X = 9;

async function run(extra: (clock: Clock) => object) {
  const storage = new MemoryStorageDriver();
  const base = new MemoryRegistryDriver();
  await base.create(REF, { currentGen: null });
  await bulkLoadCrbmGeneration(storage, { ...REF, generation: 0 }, [1, X], {
    registry: base,
    publish: false,
  });
  const registry = unansweredRegistry(base, ['throw', 'throw', 'throw', 'throw']);
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => 1_700_000_000_000,
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  };
  await expect(
    eraseIdFromSegment(REF, X, { storage, registry, codec: roaringCodec, clock, ...extra(clock) }),
  ).rejects.toBeInstanceOf(TransientError);
  return sleeps;
}

describe("the waits between an erasure's resends of an unanswered renewal", () => {
  it('with no rng, each wait is exactly its bound', async () => {
    expect(await run(() => ({}))).toEqual([500, 1000, 2000]);
  });
  it("with only the store's read-retry rng, that rng spreads the waits", async () => {
    expect(
      await run(() => ({ readRetry: { clock: undefined, rng: { next: () => 0.5 } } })),
    ).toEqual([250, 500, 1000]);
  });
});
