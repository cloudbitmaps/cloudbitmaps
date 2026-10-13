import { openGenerationReader, sameObjectUnder } from '@/core/crbm-open';
import { DISCARD_ATTEMPTS, eraseIdFromSegment, type EraseIdResult } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import { loadSegment, type LoadResult } from '@/core/load';
import { brandAsBackend } from '@/core/ports';
import { setSegmentRetention } from '@/core/retention';
import { MemoryRegistryDriver, MemoryStorageDriver } from '@/drivers/memory';
import { CloudRoaring } from '@/index';
import type { GenKey, IRegistryDriver, IStorageDriver, RegistryPatch } from '@/index';
import type { Clock, SegmentRef } from '@/index';
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
 * refuses its publish of 2 and its discard reaches `stallAt`, every call on `clk`. Returns the erasure's run, its gate,
 * what it sent, and the stores.
 */
async function refusedRewrite(stallAt: Stall, clk: Clock = clock) {
  const storage = new MemoryStorageDriver();
  const registry: IRegistryDriver = new MemoryRegistryDriver();
  const deps = { storage, registry, codec: roaringCodec, clock: clk };
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
      // The load publishes unless the discard's renewal landed before its publish: once that renewal lands first, the
      // load's publish is fenced on a row the renewal retired.
      expect(l2.published).toBe(l2Publish === 'at once' || stallAt === 'before its delete');
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
    expect((await registry.get(REF))?.currentGen).toBe(1);
    expect(await reads(storage, registry)).toEqual([5, 6]);
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

/** A write of the row's leases alone: one lease, on the generation the pointer names. */
const leaseOf = () => ({
  leases: [{ holder: '0123456789abcdef', generation: 1, until: clock.now() + 60_000 }],
});

describe("a refused rewrite's discard whose footer read does not find its rewrite", () => {
  it.each(['another object', 'no object'])(
    'the footer read meets %s under its number: it keeps, with no renewal and no delete',
    async (kind) => {
      const { e1, atDiscard, sent, storage, registry, deps } =
        await refusedRewrite('before its footer read');
      expect(await eraseIdFromSegment(REF, Y, deps)).toMatchObject({ erased: true });
      expect(await generations(storage)).not.toContain(2);
      const l2At = gate();
      let l2: Promise<LoadResult> | undefined;
      if (kind === 'another object') {
        // A load of other ids takes 2 afresh and holds its publish.
        const l2Registry = Object.create(registry) as IRegistryDriver;
        l2Registry.compareAndSwap = async (ref, expected, patch, options) => {
          if (publishes(patch, 2)) {
            l2At.reach();
            await l2At.opened;
          }
          return registry.compareAndSwap(ref, expected, patch, options);
        };
        l2 = loadSegment(REF, [7, 8], { ...deps, registry: l2Registry });
        await l2At.reached;
      }
      atDiscard.open();
      expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
      expect(sent).toEqual({ renewals: 0, deletes: 0 });
      if (l2 !== undefined) {
        expect(await generations(storage)).toContain(2);
        l2At.open();
        expect(await l2).toMatchObject({ generation: 2, published: true });
        expect(await reads(storage, registry)).toEqual([7, 8]);
      } else {
        expect(await generations(storage)).not.toContain(2);
      }
    },
  );
});

describe("a refused rewrite's discard and the writes it waits out", () => {
  it(`a write of leases alone costs no attempt: after it and ${DISCARD_ATTEMPTS - 1} other lost renewals, the next lands and deletes`, async () => {
    const { e1, atDiscard, sent, storage, registry } =
      await refusedRewrite('after its footer read');
    let expiry = clock.now() + 86_400_000;
    let n = 0;
    const swap = registry.compareAndSwap.bind(registry);
    registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (publishes(patch, 1)) {
        n += 1;
        if (n === 1) await swap(REF, (await registry.get(REF))!.token, leaseOf());
        else if (n <= DISCARD_ATTEMPTS) {
          expiry += 1;
          await setSegmentRetention(REF, { registry }, { expiresAt: expiry });
        }
      }
      return swap(ref, expected, patch, options);
    };
    atDiscard.open();

    expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
    expect(sent).toEqual({ renewals: DISCARD_ATTEMPTS + 1, deletes: 1 });
    expect(await generations(storage)).not.toContain(2);
    expect(await reads(storage, registry)).toEqual([5, 6]);
  });

  it('after waiting out a write of leases alone, it decides on the row it reads after the wait', async () => {
    // The wait itself lets a retention write land: the row the discard renews must be the one read after the wait.
    // What the next wait on the clock does before it returns.
    const duringWait: (() => Promise<unknown>)[] = [];
    const clk: Clock = {
      now: clock.now,
      sleep: async () => {
        await duringWait.shift()?.();
      },
    };
    const { e1, atDiscard, sent, storage, registry } = await refusedRewrite(
      'after its footer read',
      clk,
    );
    await registry.compareAndSwap(REF, (await registry.get(REF))!.token, leaseOf());
    duringWait.push(() =>
      setSegmentRetention(REF, { registry }, { expiresAt: clock.now() + 86_400_000 }),
    );
    atDiscard.open();

    expect(await e1).toMatchObject({ erased: false, reason: 'superseded' });
    expect(sent).toEqual({ renewals: 2, deletes: 1 });
    expect(await generations(storage)).not.toContain(2);
  });

  it('renewals that get no answer share one bound of 3 resends, across the waits between them', async () => {
    const { e1, atDiscard, storage, registry } = await refusedRewrite('after its footer read');
    let n = 0;
    const swap = registry.compareAndSwap.bind(registry);
    registry.compareAndSwap = async (ref, expected, patch, options) => {
      if (publishes(patch, 1)) {
        n += 1;
        if (n === 3) await swap(REF, (await registry.get(REF))!.token, leaseOf());
        else throw new TransientError('no answer, not landed');
      }
      return swap(ref, expected, patch, options);
    };
    atDiscard.open();

    // Sends 1 and 2 get no answer; send 3, the second resend, loses to a lease write, waited out; send 4 gets no answer,
    // and after send 5, the third resend, gets none either, the bound is spent.
    await expect(e1).rejects.toBeInstanceOf(TransientError);
    expect(n).toBe(5);
    expect(await generations(storage)).toContain(2);
  });
});

describe("an erasure's renewal of the row before it deletes a holder", () => {
  it('a write of leases alone between the renewal and the delete does not stop the erasure', async () => {
    const storage = new MemoryStorageDriver();
    const registry = new MemoryRegistryDriver();
    const deps = { storage, registry, codec: roaringCodec };
    await loadSegment(REF, [1, 2, 3], deps);
    // A load writes generation 1, which holds 9, above the pointer, and holds its publish.
    const atPublish = gate();
    let held = false;
    const gated = Object.create(registry) as MemoryRegistryDriver;
    gated.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      if (!held && 'currentGen' in patch) {
        held = true;
        atPublish.reach();
        await atPublish.opened;
      }
      return registry.compareAndSwap(ref, expected, patch);
    };
    const load = loadSegment(REF, [1, 2, 3, 9], { ...deps, registry: gated });
    await atPublish.reached;
    // A lease write lands right after the erasure's renewal of the row, before its delete of the holder.
    const swap = registry.compareAndSwap.bind(registry);
    const eraser = Object.create(registry) as MemoryRegistryDriver;
    eraser.compareAndSwap = async (ref: SegmentRef, expected: string, patch) => {
      const written = await swap(ref, expected, patch);
      if ('currentGen' in patch && patch.currentGen === 0) {
        await swap(ref, written.token, {
          leases: [{ holder: '00000000000000aa', generation: 0, until: 1e15 }],
        });
      }
      return written;
    };
    const erased = await eraseIdFromSegment(REF, 9, { ...deps, registry: eraser });
    atPublish.open();
    await load;
    expect(erased).toMatchObject({ erased: true });
  });
});

describe('refused rewrites of several erasures racing one that won', () => {
  /**
   * The winner erases Z while each loser erases an id of its own, all from generation 0. The losers read generation 0
   * before the winner publishes, then number one after another above the winner's object once it has returned, so each
   * rewrite sits above the winner's pointer and still holds Z, which the winner reported erased. Every loser's discard
   * renews the row at once with the others, so each renewal but one loses to another loser's.
   */
  it.each([DISCARD_ATTEMPTS + 1, DISCARD_ATTEMPTS + 4])(
    '%i losers: each deletes its rewrite, so nothing in the bucket holds the id the winner erased',
    async (losers) => {
      const Z = 99;
      const ids = Array.from({ length: losers }, (_, i) => 1_000 + i);
      const storage = new MemoryStorageDriver();
      const registry: IRegistryDriver = new MemoryRegistryDriver();
      const deps = { storage, registry, codec: roaringCodec, clock };
      await loadSegment(REF, [1, 2, Z, ...ids], deps); // generation 0, one chunk

      // The winner writes generation 1 and holds its publish.
      const winnerAtPublish = gate();
      const winnerRegistry = Object.create(registry) as IRegistryDriver;
      winnerRegistry.compareAndSwap = async (ref, expected, patch, options) => {
        if (publishes(patch, 1)) {
          winnerAtPublish.reach();
          await winnerAtPublish.opened;
        }
        return registry.compareAndSwap(ref, expected, patch, options);
      };
      const winner = eraseIdFromSegment(REF, Z, { ...deps, registry: winnerRegistry });
      await winnerAtPublish.reached;

      // Each loser reads generation 0, then waits at the listing that numbers its rewrite; its discard's first renewal
      // waits for every loser's.
      const allRenewing = gate();
      let renewing = 0;
      const runs = ids.map((id) => {
        const atNumbering = gate();
        const written = gate();
        let listed = false;
        let renewed = false;
        const loserStorage = Object.create(storage) as IStorageDriver;
        loserStorage.putImmutable = async (key, write) => {
          const out = await storage.putImmutable(key, write);
          written.reach();
          return out;
        };
        loserStorage.list = (ref) => {
          if (listed) return storage.list(ref);
          listed = true;
          return (async function* () {
            atNumbering.reach();
            await atNumbering.opened;
            yield* storage.list(ref);
          })();
        };
        const loserRegistry = Object.create(registry) as IRegistryDriver;
        loserRegistry.compareAndSwap = async (ref, expected, patch, options) => {
          if (!renewed && publishes(patch, 1)) {
            renewed = true;
            renewing += 1;
            if (renewing === losers) allRenewing.open();
            await allRenewing.opened;
          }
          return registry.compareAndSwap(ref, expected, patch, options);
        };
        const run = eraseIdFromSegment(REF, id, {
          ...deps,
          storage: loserStorage,
          registry: loserRegistry,
        });
        return { run, atNumbering, written };
      });
      for (const { atNumbering } of runs) await atNumbering.reached;

      winnerAtPublish.open();
      expect(await winner).toMatchObject({ erased: true, generation: 1 });

      // The losers number 2, 3, ... in turn, each above every object in the bucket.
      for (const { atNumbering, written } of runs) {
        atNumbering.open();
        await written.reached;
      }
      for (const { run } of runs) {
        expect(await run).toMatchObject({ erased: false, reason: 'superseded', fromGeneration: 0 });
      }

      expect(await generations(storage)).toEqual([1]);
      expect(await eraseIdFromSegment(REF, Z, deps)).toMatchObject({
        erased: false,
        reason: 'not-member',
      });
    },
  );
});
