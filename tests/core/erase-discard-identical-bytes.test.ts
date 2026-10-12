import { openGenerationReader, sameObjectUnder } from '@/core/crbm-open';
import { DISCARD_ATTEMPTS, eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import type { GenKey, IRegistryDriver, IStorageDriver, RegistryPatch } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { collect } from '../helpers/loaded';
import { REF, X, clock, gate, generations } from '../helpers/retaken-number-race';

/**
 * A refused rewrite discards its own object above the winner's pointer, after one read of its footer matches the
 * rewrite's fingerprint. A footer names an object by its bytes, and a cleartext load of the ids the rewrite holds
 * writes those very bytes, so once another erasure has deleted the rewrite's object a load can take the number again
 * with an object the footer read cannot tell from the rewrite's:
 *
 *   first load       writes 1 ([5, 6]), holds its publish ─────────▶ publishes 1 │
 *   erasure (of X)   reads 0, writes 2 = [1, 2, Y], refused by that publish; its discard reads the row ── stalls ──▶
 *   erasure (of Y)   finds 2 above the pointer, renews the row, deletes 2 │
 *   second load      [1, 2, Y] reads the row, takes 2 afresh, writes the rewrite's bytes ──▶ publishes 2
 *
 * Were the refused erasure to delete what its footer read matched, the row would name generation 2 with no object under
 * it, and every read of the segment would fail, with nothing reporting it. The discard renews the row it read before
 * deleting, so a publish fenced on a row read before that renewal is refused, and a renewal that loses makes it decide
 * again. Gated promises hold each order, and the clock never waits, so a run is the same every time.
 */

/** The second id: the rewrite of generation 0 still holds it, and the first load's generation does not. */
const Y = 77;
const GEN2: GenKey = { ...REF, generation: 2 };

const publishes = (patch: RegistryPatch, generation: number): boolean =>
  'currentGen' in patch && patch.currentGen === generation;

/** Where the refused erasure's discard stalls: before its footer read, once that answered, or before its delete. */
type Stall = 'before its footer read' | 'after its footer read' | 'before its delete';
/** When the second load's publish lands: as soon as it is sent, or once the refused erasure has returned. */
type L2Publish = 'at once' | 'after the erasure returns';

/** What the refused erasure sent: its renewals of the row (writes naming pointer 1), and deletes of generation 2. */
interface Sent {
  renewals: number;
  deletes: number;
}

/**
 * Generation 0 holds X and Y, the first load holds its publish of 1, and the erasure of X runs until that publish
 * refuses its publish of 2 and its discard reaches `stallAt`. Returns the erasure's run, its gate, what it sent, and
 * the stores.
 */
async function refusedRewrite(stallAt: Stall) {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, clock };
  await loadSegment(REF, [1, 2, X, Y], deps); // generation 0

  const l1AtPublish = gate();
  const l1Registry = Object.create(registry) as IRegistryDriver;
  l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
    if (publishes(patch, 1)) {
      l1AtPublish.reach();
      await l1AtPublish.opened;
    }
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  const l1 = loadSegment(REF, [5, 6], { ...deps, registry: l1Registry });
  await l1AtPublish.reached;

  // The first load publishes as the erasure's publish of 2 is sent, which refuses the erasure's.
  let refused = false;
  const sent: Sent = { renewals: 0, deletes: 0 };
  const e1Registry = Object.create(registry) as IRegistryDriver;
  e1Registry.compareAndSwap = async (ref, expected, patch, options) => {
    if (!refused && publishes(patch, 2)) {
      l1AtPublish.open();
      expect(await l1).toMatchObject({ generation: 1, published: true });
      refused = true;
    }
    if (refused && publishes(patch, 1)) sent.renewals += 1;
    return registry.compareAndSwap(ref, expected, patch, options);
  };

  // Every write goes to the one driver, so each stored object gets its own version from its counter.
  const atDiscard = gate();
  let stalled = false;
  const stall = async (at: Stall, key: GenKey): Promise<void> => {
    if (!refused || stalled || at !== stallAt || key.generation !== 2) return;
    stalled = true;
    atDiscard.reach();
    await atDiscard.opened;
  };
  const e1Storage = Object.create(storage) as IStorageDriver;
  e1Storage.putImmutable = (key, write) => storage.putImmutable(key, write);
  e1Storage.getRange = (key, offset, length) => storage.getRange(key, offset, length);
  e1Storage.getTail = async (key, maxBytes) => {
    await stall('before its footer read', key);
    const tail = await storage.getTail(key, maxBytes);
    await stall('after its footer read', key);
    return tail;
  };
  e1Storage.delete = async (key, options) => {
    await stall('before its delete', key);
    if (refused && key.generation === 2) sent.deletes += 1;
    return storage.delete(key, options);
  };

  const e1 = eraseIdFromSegment(REF, X, { ...deps, storage: e1Storage, registry: e1Registry });
  await atDiscard.reached;
  return { e1, atDiscard, sent, storage, registry, deps };
}

/** The race in the header: the discard stalls at `stallAt`, and the second load publishes as `l2Publish` says. */
async function race(stallAt: Stall, l2Publish: L2Publish) {
  const { e1, atDiscard, sent, storage, registry, deps } = await refusedRewrite(stallAt);
  const rewrite = (await openGenerationReader(storage, GEN2, undefined)).fingerprint;

  // The other erasure erases an id the rewrite holds and the first load's generation does not: generation 2 is a
  // holder above the pointer, and it goes.
  expect(await eraseIdFromSegment(REF, Y, deps)).toMatchObject({ erased: true });
  expect(await generations(storage)).not.toContain(2);

  // The second load takes 2 afresh and writes the rewrite's very bytes.
  const l2AtPublish = gate();
  const l2Registry = Object.create(registry) as IRegistryDriver;
  l2Registry.compareAndSwap = async (ref, expected, patch, options) => {
    if (l2Publish === 'after the erasure returns' && publishes(patch, 2)) {
      l2AtPublish.reach();
      await l2AtPublish.opened;
    }
    return registry.compareAndSwap(ref, expected, patch, options);
  };
  const l2Run = loadSegment(REF, [1, 2, Y], { ...deps, registry: l2Registry });
  let first: EraseIdResult;
  let l2: LoadResult;
  if (l2Publish === 'after the erasure returns') {
    await l2AtPublish.reached;
    // A control that must hold: the footer read cannot tell the load's object from the rewrite's.
    expect(await sameObjectUnder(storage, GEN2, rewrite)).toBe(true);
    atDiscard.open();
    first = await e1;
    l2AtPublish.open();
    l2 = await l2Run;
  } else {
    l2 = await l2Run;
    expect(l2).toMatchObject({ generation: 2, published: true });
    expect(await sameObjectUnder(storage, GEN2, rewrite)).toBe(true);
    atDiscard.open();
    first = await e1;
  }
  return { first, l2, sent, storage, registry };
}

/** What the segment reads, through a store over the same drivers. */
async function reads(storage: IStorageDriver, registry: IRegistryDriver): Promise<number[]> {
  const store = new CloudRoaring({ storage: brandAsBackend({ storage, registry }), retry: false });
  return collect(store.segment(REF.segment).iterate());
}

describe("a refused rewrite's discard and a load that takes its number again with the same bytes", () => {
  it.each<[Stall, L2Publish]>([
    ['before its footer read', 'at once'],
    ['before its footer read', 'after the erasure returns'],
    ['after its footer read', 'at once'],
    ['after its footer read', 'after the erasure returns'],
    ['before its delete', 'at once'],
    ['before its delete', 'after the erasure returns'],
  ])(
    'the discard stalled %s, the load publishing %s: the pointer keeps its object',
    async (stallAt, l2Publish) => {
      const { first, l2, storage, registry } = await race(stallAt, l2Publish);

      expect(first).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
      // The row names a generation whose object is in the bucket, and the segment reads it: the load's when it
      // published, the first load's when the discard's renewal refused it.
      const row = await registry.get(REF);
      expect(row?.currentGen).toBe(l2.published ? 2 : 1);
      expect(await generations(storage)).toContain(row?.currentGen);
      expect(await reads(storage, registry)).toEqual(l2.published ? [1, 2, Y] : [5, 6]);
      if (!l2.published) expect(l2).toMatchObject({ generation: 2, reason: 'superseded' });
    },
  );
});

describe("a refused rewrite's discard whose renewal of the row loses", () => {
  it('to the load that published its number: it reads that row, keeps the object and deletes nothing', async () => {
    const { first, l2, sent, storage, registry } = await race('after its footer read', 'at once');

    expect(first).toMatchObject({ erased: false, reason: 'superseded' });
    expect(l2).toMatchObject({ generation: 2, published: true });
    expect(sent).toEqual({ renewals: 1, deletes: 0 });
    expect((await registry.get(REF))?.currentGen).toBe(2);
    expect(await reads(storage, registry)).toEqual([1, 2, Y]);
  });

  it("to another erasure's renewal: it decides again, and deletes the object only once its own renewal lands, which refuses the load", async () => {
    const { first, l2, sent, storage, registry } = await race(
      'after its footer read',
      'after the erasure returns',
    );

    expect(first).toMatchObject({ erased: false, reason: 'superseded' });
    // The second renewal landed, so the object under 2 went, and the load that wrote it was refused.
    expect(sent).toEqual({ renewals: 2, deletes: 1 });
    expect(l2).toMatchObject({ generation: 2, published: false, reason: 'superseded' });
    expect(await generations(storage)).not.toContain(2);
    expect((await registry.get(REF))?.currentGen).toBe(1);
    expect(await reads(storage, registry)).toEqual([5, 6]);
  });

  it(`to another write each time: it keeps its object after ${DISCARD_ATTEMPTS} renewals`, async () => {
    const { e1, atDiscard, sent, storage, registry } =
      await refusedRewrite('after its footer read');
    // Before each renewal of the row, a retention write lands: not a write of leases alone, so each one loses.
    let expiry = clock.now() + 86_400_000;
    const swap = registry.compareAndSwap.bind(registry);
    registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (publishes(patch, 1)) {
        expiry += 1;
        await setSegmentRetention(REF, { registry }, { expiresAt: expiry });
      }
      return swap(ref, expected, patch, options);
    };
    atDiscard.open();

    expect(await e1).toMatchObject({ erased: false, reason: 'superseded', generation: 2 });
    expect(sent).toEqual({ renewals: DISCARD_ATTEMPTS, deletes: 0 });
    expect(await generations(storage)).toContain(2);
    expect((await registry.get(REF))?.currentGen).toBe(1);
    expect(await reads(storage, registry)).toEqual([5, 6]);
  });

  it('to a write of leases alone: it waits that out, decides again, and deletes its object', async () => {
    const { e1, atDiscard, sent, storage, registry } =
      await refusedRewrite('after its footer read');
    const row = await registry.get(REF);
    await registry.compareAndSwap(REF, row!.token, {
      leases: [{ holder: '0123456789abcdef', generation: 1, until: clock.now() + 60_000 }],
    });
    atDiscard.open();

    expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
    expect(sent).toEqual({ renewals: 2, deletes: 1 });
    expect(await generations(storage)).not.toContain(2);
    expect(await reads(storage, registry)).toEqual([5, 6]);
  });

  it('with no answer, having landed: it reads the row, decides again, and deletes once a renewal is answered', async () => {
    const { e1, atDiscard, sent, storage, registry } =
      await refusedRewrite('after its footer read');
    const real = registry.compareAndSwap.bind(registry);
    let dropped = false;
    registry.compareAndSwap = async (ref, expected, patch, options) => {
      const written = await real(ref, expected, patch, options);
      if (!dropped && publishes(patch, 1)) {
        dropped = true;
        throw new TransientError('the renewal landed and its answer was lost');
      }
      return written;
    };
    atDiscard.open();

    expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
    expect(sent).toEqual({ renewals: 2, deletes: 1 });
    expect(await generations(storage)).not.toContain(2);
  });

  it('with no answer, having not landed, and no clock to wait on: it throws and deletes nothing', async () => {
    const storage = new MemoryStorageDriver();
    const registry: IRegistryDriver = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec, clock };
    await loadSegment(REF, [1, 2, X], deps);
    const l1AtPublish = gate();
    const l1Registry = Object.create(registry) as IRegistryDriver;
    l1Registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (publishes(patch, 1)) {
        l1AtPublish.reach();
        await l1AtPublish.opened;
      }
      return registry.compareAndSwap(ref, expected, patch, options);
    };
    const l1 = loadSegment(REF, [5, 6], { ...deps, registry: l1Registry });
    await l1AtPublish.reached;
    let refused = false;
    let renewals = 0;
    const e1Registry = Object.create(registry) as IRegistryDriver;
    e1Registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (!refused && publishes(patch, 2)) {
        l1AtPublish.open();
        await l1;
        refused = true;
      }
      if (refused && publishes(patch, 1)) {
        renewals += 1;
        throw new TransientError('the renewal got no answer');
      }
      return registry.compareAndSwap(ref, expected, patch, options);
    };

    // No `sleep`: a write that got no answer over a row still as it was is not sent again.
    await expect(
      eraseIdFromSegment(REF, X, { ...deps, registry: e1Registry, clock: {} }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(renewals).toBe(1);
    expect(await generations(storage)).toContain(2);
    expect((await registry.get(REF))?.currentGen).toBe(1);
  });
});
