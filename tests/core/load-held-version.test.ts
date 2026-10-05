import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSegment, type LoadOptions } from '@/core/load';
import { eraseIdFromSegment } from '@/core/erase-id';
import { TransientError } from '@/core/errors';
import type { IRegistryDriver, IStorageDriver, SegmentRef } from '@/core/ports';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { InProcessKeystore } from '@/drivers/crypto';
import { MemoryStorageDriver } from '@/drivers/memory';
import { roaringCodec } from '@/roaring-codec';
import { bulkLoadCrbmGeneration } from '../helpers/bulk-load';
import { CountingObjectStore, counting } from '../helpers/counting';

/**
 * A load, an `*Into` and an erasure's rewrite publish onto a row they already read, and say so to the registry
 * (`held`), which then sends its conditional write without reading the row again. These count what that costs at the
 * store the registry is over, the way a request is billed, beside the same load through a registry that ignores the
 * hint; and hold the fence: a row that changed since the read still makes the publish lose, and a write that got no
 * answer is settled by reading the row, with nothing deleted until it is.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };

const ticking = (): (() => number) => {
  let t = 1_000;
  return () => (t += 1);
};

/** A registry over `registry`'s store that does not take the hint: what a driver that ignores `held` does. */
function ignoringHeld(registry: IRegistryDriver): IRegistryDriver {
  return new Proxy(registry, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== 'create' && prop !== 'compareAndSwap') {
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (...args: unknown[]) => {
        const method = value as (...a: unknown[]) => unknown;
        return method.apply(target, prop === 'create' ? args.slice(0, 2) : args.slice(0, 3));
      };
    },
  });
}

function world() {
  const storage = new MemoryStorageDriver();
  const store = new CountingObjectStore(0, { conditionalDelete: true });
  const registry = new ObjectStoreRegistry(store, 'p', ticking());
  // Another process over the same store.
  const other = new ObjectStoreRegistry(store, 'p', ticking());
  const keystore = new InProcessKeystore({ keys: { A: randomBytes(32) }, activeKeyId: 'A' });
  const waits: number[] = [];
  const clock = {
    now: () => 0,
    sleep: async (ms: number): Promise<void> => void waits.push(ms),
    yieldNow: async (): Promise<void> => {},
  };
  const deletes: Record<string, number> = {};
  const counted = counting<IStorageDriver>(storage, deletes);
  const through = (r: IRegistryDriver, encrypted = false) => ({
    storage: counted,
    registry: r,
    codec: roaringCodec,
    clock,
    ...(encrypted ? { keystore } : {}),
  });
  return {
    storage,
    store,
    registry,
    other,
    waits,
    deletes: () => deletes.delete ?? 0,
    through,
    /** Three loads: the segment is at generation 2 and its row carries what a steady one does. */
    seed: async (encrypted = false) => {
      for (const ids of [[1], [1, 2], [1, 2, 3]]) {
        await loadSegment(SEG, ids, through(registry, encrypted), { keep: 9 });
      }
    },
    /** The registry requests `run` makes at the store. */
    measure: async (run: () => Promise<unknown>) => {
      const reads = store.reads;
      const writes = store.writes;
      await run();
      return { reads: store.reads - reads, writes: store.writes - writes };
    },
  };
}

interface Shape {
  name: string;
  encrypted: boolean;
  existing: boolean;
  options: LoadOptions;
  /** The registry requests at the store: with the hint, and through a registry that ignores it. */
  with: { reads: number; writes: number };
  without: { reads: number; writes: number };
}

const SHAPES: Shape[] = [
  {
    name: 'a new cleartext segment, guarded',
    encrypted: false,
    existing: false,
    options: {},
    with: { reads: 2, writes: 1 },
    without: { reads: 3, writes: 1 },
  },
  {
    name: 'a new encrypted segment',
    encrypted: true,
    existing: false,
    options: {},
    with: { reads: 2, writes: 1 },
    without: { reads: 3, writes: 1 },
  },
  {
    name: 'an existing cleartext segment, guarded',
    encrypted: false,
    existing: true,
    options: { keep: 9 },
    with: { reads: 1, writes: 1 },
    without: { reads: 2, writes: 1 },
  },
  {
    name: 'an existing cleartext segment, allowEmpty',
    encrypted: false,
    existing: true,
    options: { keep: 9, allowEmpty: true },
    with: { reads: 1, writes: 1 },
    without: { reads: 2, writes: 1 },
  },
  {
    // The seed kept every generation, so the row names 0 and 1, and a `keep` of 1 takes both: one read of the row each.
    name: 'an existing cleartext segment that collects the generations its publish pushed out',
    encrypted: false,
    existing: true,
    options: { keep: 1 },
    with: { reads: 3, writes: 1 },
    without: { reads: 4, writes: 1 },
  },
  {
    name: 'an existing encrypted segment',
    encrypted: true,
    existing: true,
    options: { keep: 9 },
    with: { reads: 2, writes: 1 },
    without: { reads: 3, writes: 1 },
  },
];

describe('a load that holds its row makes one registry read fewer', () => {
  it.each(SHAPES)('$name', async (shape) => {
    const run = async (hinted: boolean) => {
      const w = world();
      if (shape.existing) await w.seed(shape.encrypted);
      const registry = hinted ? w.registry : ignoringHeld(w.registry);
      let result: Awaited<ReturnType<typeof loadSegment>> | undefined;
      const counts = await w.measure(async () => {
        result = await loadSegment(
          SEG,
          [1, 2, 3, 4],
          w.through(registry, shape.encrypted),
          shape.options,
        );
      });
      expect(result).toMatchObject({ published: true });
      return counts;
    };
    expect(await run(true)).toEqual(shape.with);
    expect(await run(false)).toEqual(shape.without);
  });

  it('a generation written straight to a segment, as an *Into does, makes one registry read fewer', async () => {
    const run = async (hinted: boolean) => {
      const w = world();
      await w.seed();
      const registry = hinted ? w.registry : ignoringHeld(w.registry);
      let published: boolean | undefined;
      const counts = await w.measure(async () => {
        const r = await bulkLoadCrbmGeneration(w.storage, { ...SEG, generation: 3 }, [1, 2, 3, 4], {
          registry,
          clock: w.through(registry).clock,
        });
        published = r.becameCurrent;
      });
      expect(published).toBe(true);
      return counts;
    };
    const hinted = await run(true);
    const plain = await run(false);
    expect(plain.reads - hinted.reads).toBe(1);
    expect(hinted.writes).toBe(plain.writes);
  });

  it("an erasure's rewrite makes one registry read fewer", async () => {
    const run = async (hinted: boolean) => {
      const w = world();
      await w.seed();
      const registry = hinted ? w.registry : ignoringHeld(w.registry);
      let erased: unknown;
      const counts = await w.measure(async () => {
        erased = await eraseIdFromSegment(SEG, 2, w.through(registry));
      });
      expect(erased).toMatchObject({ erased: true, fromGeneration: 2, generation: 3 });
      return counts;
    };
    const hinted = await run(true);
    const plain = await run(false);
    expect(plain.reads - hinted.reads).toBe(1);
    expect(hinted.writes).toBe(plain.writes);
  });
});

/** `ids`, with `meanwhile` run after the first one: after the load read its row, before it writes and publishes. */
async function* streaming(ids: number[], meanwhile: () => Promise<void>): AsyncIterable<number> {
  const [head, ...rest] = ids;
  if (head !== undefined) yield head;
  await meanwhile();
  yield* rest;
}

describe('the store still fences a publish made on a held row', () => {
  it('a row another process advanced after the read: the publish reaches the store, loses, and reports superseded', async () => {
    const w = world();
    await w.seed();
    let writes = 0;
    await w.measure(async () => {
      const result = await loadSegment(
        SEG,
        streaming([1, 2, 3, 4], async () => {
          const row = (await w.other.get(SEG))!;
          await w.other.compareAndSwap(SEG, row.token, { currentGen: row.currentGen! + 5 });
          writes = w.store.writes;
        }),
        w.through(w.registry),
        { keep: 9 },
      );
      expect(result).toMatchObject({ published: false, reason: 'superseded' });
    });
    // One write was sent after the other process's, and the store refused it.
    expect(w.store.writes - writes).toBe(1);
    expect((await w.registry.get(SEG))!.currentGen).toBe(7);
  });

  it('a row another process created after a load found none: the create-only write loses, and reports superseded', async () => {
    const w = world();
    const result = await loadSegment(
      SEG,
      streaming([1, 2, 3], async () => {
        await w.other.create(SEG, { currentGen: 4 });
      }),
      w.through(w.registry),
      {},
    );
    expect(result).toMatchObject({ published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))!.currentGen).toBe(4);
  });

  it('an erasure whose row moved on after it read it is superseded, and not published', async () => {
    const w = world();
    await w.seed();
    const result = await eraseIdFromSegment(
      SEG,
      2,
      w.through(
        new Proxy(w.registry, {
          get(t, p) {
            const value = Reflect.get(t, p, t) as unknown;
            if (p !== 'get')
              return typeof value === 'function' ? (value as () => unknown).bind(t) : value;
            let moved = false;
            return async (ref: SegmentRef) => {
              const row = await t.get(ref);
              if (!moved && row !== null && row.currentGen === 2) {
                moved = true;
                // After the read the rewrite publishes against: another writer changes the row.
                setTimeout(() => undefined, 0);
                await w.other.compareAndSwap(SEG, row.token, { currentGen: 2, keyId: undefined });
              }
              return row;
            };
          },
        }),
      ),
    );
    expect(result).toMatchObject({ erased: false, reason: 'superseded' });
  });
});

describe('a write that got no answer is settled by reading the row, and nothing is deleted before it is', () => {
  /** Make the next write apply, or not, and then fail without an answer. */
  function unanswered(w: ReturnType<typeof world>, landed: boolean, times = 1) {
    const write = w.store.write.bind(w.store);
    let left = times;
    w.store.write = async (key, body, expect) => {
      if (left === 0) return write(key, body, expect);
      left -= 1;
      if (landed) await write(key, body, expect);
      else w.store.writes += 1; // sent, and never answered
      throw new TransientError('503 SlowDown');
    };
  }

  it('a compare-and-swap that landed and lost its response is settled by one read, and is not sent again', async () => {
    const control = world();
    await control.seed();
    const base = await control.measure(() =>
      loadSegment(SEG, [1, 2, 3, 4], control.through(control.registry), { keep: 9 }),
    );

    const w = world();
    await w.seed();
    unanswered(w, true);
    let result: Awaited<ReturnType<typeof loadSegment>> | undefined;
    const counts = await w.measure(async () => {
      result = await loadSegment(SEG, [1, 2, 3, 4], w.through(w.registry), { keep: 9 });
    });
    expect(result).toMatchObject({ published: true, generation: 3 });
    expect(counts.writes).toBe(1); // the write was not sent again: the read showed it had landed
    expect(counts.reads - base.reads).toBe(1); // and that read is the one that settled it
    expect(w.deletes()).toBe(0);
  });

  it('one that did not land is sent again, and the held row is not what that resend rests on', async () => {
    const control = world();
    await control.seed();
    const base = await control.measure(() =>
      loadSegment(SEG, [1, 2, 3, 4], control.through(control.registry), { keep: 9 }),
    );

    const w = world();
    await w.seed();
    unanswered(w, false);
    let result: Awaited<ReturnType<typeof loadSegment>> | undefined;
    const counts = await w.measure(async () => {
      result = await loadSegment(SEG, [1, 2, 3, 4], w.through(w.registry), { keep: 9 });
    });
    expect(result).toMatchObject({ published: true, generation: 3 });
    expect(w.waits).toEqual([500]);
    expect(counts.writes).toBe(2);
    // The settle read, and the resend's own read of the row: it is sent without a held row, since the one it
    // would carry is from before the write that may still land.
    expect(counts.reads - base.reads).toBe(2);
    expect(w.deletes()).toBe(0);
  });

  it('a write that never gets an answer throws the registry fault and deletes nothing', async () => {
    const w = world();
    await w.seed();
    unanswered(w, false, 99);
    const err = await loadSegment(SEG, [1, 2, 3, 4], w.through(w.registry), { keep: 9 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransientError);
    expect(w.deletes()).toBe(0);
    expect((await w.registry.get(SEG))!.currentGen).toBe(2);
    const kept: number[] = [];
    for await (const k of w.storage.list(SEG)) kept.push(k.generation);
    expect(kept.sort()).toEqual([0, 1, 2, 3]);
  });

  it('a write that got no answer, over a row another process then moved past it, is not taken for a publish', async () => {
    const w = world();
    await w.seed();
    const write = w.store.write.bind(w.store);
    let armed = true;
    w.store.write = async (key, body, expect) => {
      if (!armed) return write(key, body, expect);
      armed = false;
      // The write is answered with a fault and did not land, and another writer takes the row before the read.
      const row = (await w.other.get(SEG))!;
      await w.other.compareAndSwap(SEG, row.token, { currentGen: 9 });
      throw new TransientError('503 SlowDown');
    };
    const result = await loadSegment(SEG, [1, 2, 3, 4], w.through(w.registry), { keep: 9 });
    expect(result).toMatchObject({ published: false, reason: 'superseded' });
    expect((await w.registry.get(SEG))!.currentGen).toBe(9);
  });
});
