import { eraseIdFromSegment } from '@/core/erase-id';
import { NotFoundError } from '@/core/errors';
import type { IStorageDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { loadedStore } from '../helpers/loaded';

/**
 * The rewrite phase translates a `NotFoundError` by re-reading the row: the pointer still at `from` means the
 * object is genuinely absent (thrown), a pointer that moved means a concurrent writer got there first
 * (`'superseded'`). That translation lives in a `catch`, so it only covers what is **awaited inside** the `try`.
 * When the id is not in the current generation the phase hands off to the sweep of the other generations, and a
 * `NotFoundError` from that sweep has to reach the same `catch` rather than bypass it.
 */
const SEG: SegmentRef = { segment: 's' };

describe('an erasure that sweeps the other generations translates a NotFoundError like the rest of the phase', () => {
  it('reports superseded when the pointer moved while the sweep found an object gone', async () => {
    const w = await loadedStore({}, { retry: false });
    await w.load(SEG, [5, 6, 7]); // gen 0 holds the id
    await w.load(SEG, [6, 7]); // gen 1 is current and does not: a retained superseded holder remains below it
    let fired = false;
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      putImmutable: (k, fn) => w.storage.putImmutable(k, fn),
      list: (ref) => w.storage.list(ref),
      delete: async (k, o) => {
        if (!fired) {
          fired = true;
          await w.load(SEG, [6, 7, 8]); // another writer publishes generation 2 mid-sweep
          throw new NotFoundError('object already gone');
        }
        return w.storage.delete(k, o);
      },
    };

    const res = await eraseIdFromSegment(SEG, 5, {
      storage,
      registry: w.registry,
      codec: roaringCodec,
    });

    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 1 });
  });

  it('still throws when the pointer has not moved: the object is genuinely absent', async () => {
    const w = await loadedStore({}, { retry: false });
    await w.load(SEG, [5, 6, 7]);
    await w.load(SEG, [6, 7]);
    const storage: IStorageDriver = {
      capabilities: () => w.storage.capabilities(),
      getRange: (k, o, l) => w.storage.getRange(k, o, l),
      getTail: (k, m) => w.storage.getTail(k, m),
      putImmutable: (k, fn) => w.storage.putImmutable(k, fn),
      list: (ref) => w.storage.list(ref),
      delete: () => Promise.reject(new NotFoundError('object already gone')),
    };

    await expect(
      eraseIdFromSegment(SEG, 5, { storage, registry: w.registry, codec: roaringCodec }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
