import { eraseIdFromSegment } from '@/core/erase-id';
import type { IColdDriver, SegmentRef } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { loadedStore } from '../helpers/loaded';

/**
 * A concurrent erasure collects with `keep: 0`, which takes every generation below its new pointer — `from`, and
 * the object the losing call just wrote. The documented answer to that race is `reason: 'superseded'`
 * ("the id is still there, re-run against the new generation"), which is what the fenced publish already
 * reports. The read half used to surface a bare `NotFoundError` instead, at three separate round trips.
 *
 * The pre-existing coverage of this interleaving passed only because its fixture was a **single chunk**: a
 * one-chunk rewrite never re-reads `from` after the interloper's sweep. Every case here spans three chunks
 * (`1`, `70_000`, `140_000` land in different chunks), which is what makes the long window reachable.
 */
const SEG: SegmentRef = { segment: 's' };
const THREE_CHUNKS = [1, 70_000, 140_000];

async function world() {
  const w = await loadedStore({}, { retry: false });
  return { ...w, deps: { cold: w.cold, registry: w.registry, codec: roaringCodec } };
}

/** Run `hook` once, immediately after the first chunk read — inside the rewrite's whole-segment stream. */
function afterFirstChunkRead(base: IColdDriver, hook: () => Promise<void>): IColdDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getTail: (k, m) => base.getTail(k, m),
    delete: (k) => base.delete(k),
    list: (ref) => base.list(ref),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    getRange: async (k, o, l) => {
      const res = await base.getRange(k, o, l);
      if (!fired) {
        fired = true;
        await hook();
      }
      return res;
    },
  };
}

/** Run `hook` once, before the reader is even opened — the shortest of the three windows. */
function beforeOpen(base: IColdDriver, hook: () => Promise<void>): IColdDriver {
  let fired = false;
  return {
    capabilities: () => base.capabilities(),
    getRange: (k, o, l) => base.getRange(k, o, l),
    delete: (k) => base.delete(k),
    list: (ref) => base.list(ref),
    putImmutable: (k, fn) => base.putImmutable(k, fn),
    getTail: async (k, m) => {
      if (!fired) {
        fired = true;
        await hook();
      }
      return base.getTail(k, m);
    },
  };
}

describe('an erasure whose generation is swept mid-flight reports superseded, not NotFoundError', () => {
  it('the generation vanishes between the pointer read and the reader open', async () => {
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);
    const cold = beforeOpen(w.cold, async () => {
      await eraseIdFromSegment(SEG, 1, w.deps); // publishes gen 1 and collects gen 0
    });

    const res = await eraseIdFromSegment(SEG, 70_000, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
    expect(res.collected).toEqual([]);
  });

  it('the generation vanishes part-way through the whole-segment rewrite', async () => {
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);
    const cold = afterFirstChunkRead(w.cold, async () => {
      await eraseIdFromSegment(SEG, 1, w.deps);
    });

    const res = await eraseIdFromSegment(SEG, 70_000, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
    expect(res.collected).toEqual([]);
  });

  it('the object this call wrote is swept before its own verify', async () => {
    // The interloper runs *after* our write and our pre-verify pointer check have both happened, and its
    // `keep: 0` takes our unpublished object along with `from` — so the verify reads an object we wrote
    // ourselves and finds it gone.
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);
    let armed = false;
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      getRange: (k, o, l) => w.cold.getRange(k, o, l),
      delete: (k) => w.cold.delete(k),
      list: (ref) => w.cold.list(ref),
      putImmutable: async (k, fn) => {
        const res = await w.cold.putImmutable(k, fn);
        armed = true; // our object is durable; the next tail read is the verify
        return res;
      },
      getTail: async (k, m) => {
        if (armed) {
          armed = false;
          await eraseIdFromSegment(SEG, 1, w.deps);
        }
        return w.cold.getTail(k, m);
      },
    };

    const res = await eraseIdFromSegment(SEG, 70_000, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
  });

  it('still THROWS when the pointer names an object that is simply absent', async () => {
    // Not a race: nothing superseded `from`, the object it names is gone for good. Reporting `superseded` here
    // would send the caller into a retry loop against a segment no re-run can fix.
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);
    await w.cold.delete({ ...SEG, generation: 0 });

    await expect(eraseIdFromSegment(SEG, 70_000, w.deps)).rejects.toThrow(/no such generation/);
  });

  it('a non-NotFound fault propagates EVEN WHEN the pointer has also moved', async () => {
    // The trap this test exists for: with the pointer moved, the catch would report `superseded` for *any*
    // error if it did not check the error's type first. So the fault has to land in a call that is already
    // racing an interloper — otherwise the pointer re-read rethrows on its own and the test passes without
    // the type gate ever mattering.
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);

    let reads = 0;
    const cold: IColdDriver = {
      capabilities: () => w.cold.capabilities(),
      getTail: (k, m) => w.cold.getTail(k, m),
      delete: (k) => w.cold.delete(k),
      list: (ref) => w.cold.list(ref),
      putImmutable: (k, fn) => w.cold.putImmutable(k, fn),
      getRange: async (k, o, l) => {
        reads++;
        if (reads === 1) {
          const res = await w.cold.getRange(k, o, l);
          await eraseIdFromSegment(SEG, 1, w.deps); // the pointer moves off `from`
          return res;
        }
        throw new Error('cold storage unavailable'); // …and then a fault that is NOT a missing generation
      },
    };

    await expect(eraseIdFromSegment(SEG, 70_000, { ...w.deps, cold })).rejects.toThrow(
      'cold storage unavailable',
    );
  });

  it('the single-chunk fixture that used to be the only coverage still reports superseded', async () => {
    const w = await world();
    await w.load(SEG, [1, 2, 3]);
    const cold = afterFirstChunkRead(w.cold, async () => {
      await eraseIdFromSegment(SEG, 1, w.deps);
    });

    const res = await eraseIdFromSegment(SEG, 2, { ...w.deps, cold });
    expect(res).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
  });

  it('a segment with no row at all is still `absent`, not superseded', async () => {
    const w = await world();
    const res = await eraseIdFromSegment(SEG, 1, w.deps);
    expect(res).toMatchObject({ erased: false, reason: 'absent' });
  });

  it('the reported answer is actionable: a re-run against the new generation erases the id', async () => {
    const w = await world();
    await w.load(SEG, THREE_CHUNKS);
    const cold = afterFirstChunkRead(w.cold, async () => {
      await eraseIdFromSegment(SEG, 1, w.deps);
    });

    const first = await eraseIdFromSegment(SEG, 70_000, { ...w.deps, cold });
    expect(first).toMatchObject({ erased: false, reason: 'superseded' });

    // Exactly what the contract tells the caller to do — and the id really is still there.
    const second = await eraseIdFromSegment(SEG, 70_000, w.deps);
    expect(second).toMatchObject({ erased: true });
    expect(await w.store.segment('s').has(70_000)).toBe(false);
  });
});
