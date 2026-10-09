import { CloudRoaring, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import type { IStorageDriver } from '@/core/ports';
import { brandAsBackend } from '@/core/ports';
import { openGenerationReader } from '@/core/crbm-storage-source';
import { isNotFoundError } from '@/core/errors';
import { counting } from '../helpers/counting';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * A pin of the current generation shares the reader an earlier pin of the same version opened (invariant 2), and that
 * reader can have been opened by `pinAt`, which holds the object to the fingerprint its caller names and not to the row.
 * A live pin holds the memoised reader to the fingerprint the row's summary records before it takes it: a reader of
 * another object under the number is not shared, and the pin opens what is under the key as a live read does.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const PUBLISHED = [1, 2, HI + 3];
/** An id only the object put under the number from outside the library holds. */
const MARK = 999;

async function world() {
  const backend = new MemoryStorage();
  await new CloudRoaring({ storage: backend, retry: false }).load(A, PUBLISHED);
  const calls: Record<string, number> = {};
  const store = new CloudRoaring({
    storage: brandAsBackend({
      storage: counting<IStorageDriver>(backend.storage, calls),
      registry: backend.registry,
    }),
    retry: false,
  });
  /** Put `ids` under generation 0, under its unchanged row, and return the new object's fingerprint. */
  const swap = async (ids: number[]): Promise<string> => {
    await backend.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(backend.storage, { ...A, generation: 0 }, ids);
    return (await openGenerationReader(backend.storage, { ...A, generation: 0 }, undefined))
      .fingerprint;
  };
  return { backend, store, calls, swap, seg: () => store.segment('a', { namespace: NS }) };
}

describe("a live pin holds a memoised reader to the row's fingerprint (invariant 2)", () => {
  it('does not share a reader pinAt opened on another object than the row names', async () => {
    const w = await world();
    const stray = await w.swap([MARK, HI + MARK]);
    // pinAt holds the object to the fingerprint it is given, and memoises the reader under the live version.
    const byHand = await w.seg().pinAt({ generation: 0, fingerprint: stray });
    expect(await byHand.has(MARK)).toBe(true);

    // A live pin opens what is under the key against the row, which names another object: refused, as a read is.
    await expect(w.seg().pin()).rejects.toSatisfy(isNotFoundError);
  });

  it('control: a reader pinAt opened on the object the row names is shared, with no open of its own', async () => {
    const w = await world();
    const first = await new CloudRoaring({ storage: w.backend, retry: false })
      .segment('a', { namespace: NS })
      .pin();
    const at = first.pinnedAt!;
    const byHand = await w
      .seg()
      .pinAt({ generation: at.generation!, fingerprint: at.fingerprint! });
    expect(await byHand.has(1)).toBe(true);
    const tails = w.calls.getTail ?? 0;

    const live = await w.seg().pin();
    expect(live.pinnedAt).toMatchObject({ generation: 0, fingerprint: at.fingerprint });
    expect(await live.has(2)).toBe(true);
    expect(w.calls.getTail ?? 0).toBe(tails);
  });
});
