import { CloudRoaring, MemoryStorage } from '@/index';
import type { SegmentRef } from '@/index';
import { isNotFoundError } from '@/core/errors';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';

/**
 * An erasure rewrites the generation its row names, and it reads that object through the check every live open makes
 * (invariant 2): the object must be the one the row's summary names by its fingerprint. An object put under the number
 * from outside the library is refused, with `NotFoundError`, before anything is written, so the rewrite never publishes
 * its ids as a new generation that every read would then serve.
 */

const NS = 'ns';
const A: SegmentRef = { namespace: NS, segment: 'a' };
const HI = 65_536;
const PUBLISHED = [1, 2, HI + 3];
/** What the swapped object holds: the subject too, and an id no load ever wrote. */
const MARK = 999;
const SWAPPED = [2, MARK, HI + MARK];

async function world() {
  const backend = new MemoryStorage();
  const store = new CloudRoaring({ storage: backend, retry: false });
  await store.load(A, PUBLISHED);
  /** Replace generation 0's object under its unchanged row, as a restore or a hand edit of the bucket would. */
  const swap = async (ids: number[]): Promise<void> => {
    await backend.storage.delete({ ...A, generation: 0 });
    await bulkLoadCrbmGeneration(backend.storage, { ...A, generation: 0 }, ids);
  };
  /** The generations in the bucket, by listing it. */
  const objects = async (): Promise<number[]> => {
    const out: number[] = [];
    for await (const key of backend.storage.list(A)) out.push(key.generation);
    return out.sort((a, b) => a - b);
  };
  return { backend, store, swap, objects };
}

describe('an erasure reads the object its row names, and no other (invariant 2)', () => {
  it('over an object swapped under the row, it writes and publishes nothing, and the swap is never served', async () => {
    const w = await world();
    const before = (await w.backend.registry.get(A))!;
    await w.swap(SWAPPED);

    const result = await w.store.eraseSubject(2, { namespace: NS });
    const entry = result.erasedFrom.find((e) => e.segment === 'a');
    expect(entry?.erased).not.toBe(true);
    expect(entry?.note).toMatch(/another object than its registry row names/);

    const after = (await w.backend.registry.get(A))!;
    expect(after.currentGen).toBe(0);
    expect(after.token).toBe(before.token);
    expect(await w.objects()).toEqual([0]);

    // A fresh reader refuses the swapped object, as it did before the erasure: its ids are not served.
    const reader = new CloudRoaring({ storage: w.backend, retry: false });
    const read = reader.segment('a', { namespace: NS }).has(MARK);
    await expect(read).rejects.toSatisfy(isNotFoundError);
  });

  it('control: an intact object is erased as before', async () => {
    const w = await world();
    const result = await w.store.eraseSubject(2, { namespace: NS });
    expect(result.erasedFrom).toEqual([
      expect.objectContaining({ segment: 'a', erased: true, generation: 1 }),
    ]);
    const reader = new CloudRoaring({ storage: w.backend, retry: false });
    const seg = reader.segment('a', { namespace: NS });
    expect(await seg.has(2)).toBe(false);
    expect(await seg.has(1)).toBe(true);
  });
});
