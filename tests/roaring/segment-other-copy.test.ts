import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';

/**
 * A segment of another copy of the package (a second install loads the module twice) is not an instance of this
 * copy's class. A combine takes it when it carries this copy's brand, as every copy of the same release does: the
 * operand check refuses what is not a segment, not what another copy with the same brand made.
 * An object that only has a lease check, or only the right shape, is not a segment.
 */
describe('a segment from another copy of the package', () => {
  it('is taken by a combine and an *Into call', async () => {
    // The query makes the module loader evaluate the source again: a second copy, as a second install would be.
    const specifier = '../../packages/roaring/src/index.ts?another-copy';
    const other = (await import(/* @vite-ignore */ specifier)) as typeof import('@/index');
    expect(other.CloudRoaring).not.toBe(CloudRoaring);
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    const otherStore = new other.CloudRoaring({ storage });
    await store.load({ segment: 'a' }, [1, 2, 3, 70_000]);
    await store.load({ segment: 'b' }, [2, 3, 70_000, 90_000]);
    const b = otherStore.segment('b') as unknown as ReturnType<CloudRoaring['segment']>;
    expect(b).not.toBeInstanceOf(Object.getPrototypeOf(store.segment('a')).constructor);
    const both: number[] = [];
    for await (const id of store.segment('a').intersect([b])) both.push(id);
    expect(both).toEqual([2, 3, 70_000]);
    await store.segment('a').intersectInto(store.segment('d'), [b]);
    const d: number[] = [];
    for await (const id of store.segment('d').iterate()) d.push(id);
    expect(d).toEqual([2, 3, 70_000]);
  });

  it('is not mimicked by an object with a leaseError method or a segment-shaped body', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    const hollow = { leaseError: () => undefined } as unknown as ReturnType<
      CloudRoaring['segment']
    >;
    const shaped = {
      ref: { segment: 'a' },
      leaseHold: undefined,
      leaseError: () => undefined,
    } as unknown as ReturnType<CloudRoaring['segment']>;
    for (const fake of [hollow, shaped]) {
      await expect(async () => {
        for await (const id of store.segment('a').intersect([fake])) void id;
      }).rejects.toThrow(ValidationError);
    }
  });

  const BRAND = Symbol.for('cloudbitmaps.roaring.segment/1');
  type Seg = ReturnType<CloudRoaring['segment']>;

  async function twoCopies() {
    const specifier = '../../packages/roaring/src/index.ts?another-copy';
    const other = (await import(/* @vite-ignore */ specifier)) as typeof import('@/index');
    const storage = new MemoryStorage();
    const store = new CloudRoaring({ storage });
    const otherStore = new other.CloudRoaring({ storage });
    await store.load({ segment: 'a' }, [1, 2, 3, 70_000]);
    await store.load({ segment: 'b' }, [2, 3, 70_000, 90_000]);
    await store.load({ segment: 'd' }, [9]);
    return { store, otherStore };
  }

  const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
    const out: number[] = [];
    for await (const id of it) out.push(id);
    return out;
  };

  it('is taken when it is pinned or leased', async () => {
    const { store, otherStore } = await twoCopies();
    const pinned = (await otherStore.segment('b').pin()) as unknown as Seg;
    const leased = (await otherStore
      .segment('b')
      .pin({ leaseUntil: Date.now() + 600_000 })) as unknown as Seg;
    for (const h of [pinned, leased]) {
      expect(await drain(store.segment('a').intersect([h]))).toEqual([2, 3, 70_000]);
    }
    await store.segment('a').intersectInto(store.segment('d'), [leased]);
    expect(await drain(store.segment('d').iterate())).toEqual([2, 3, 70_000]);
  });

  it('is refused when a Proxy hides its brand', async () => {
    const { store, otherStore } = await twoCopies();
    const hidden = new Proxy(otherStore.segment('b'), {
      get: (o, k) => (k === BRAND ? undefined : Reflect.get(o, k, o)),
    }) as unknown as Seg;
    await expect(drain(store.segment('a').intersect([hidden]))).rejects.toThrow(ValidationError);
  });

  it('is read only through the members the brand comment lists', async () => {
    const { store, otherStore } = await twoCopies();
    const reads = new Set<string>();
    const audit = <T extends object>(t: T): T =>
      new Proxy(t, {
        get(o, k) {
          reads.add(String(k));
          const v = Reflect.get(o, k, o);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(o) : v;
        },
      });
    const handles = [
      otherStore.segment('b'),
      await otherStore.segment('b').pin(),
      await otherStore.segment('b').pin({ leaseUntil: Date.now() + 600_000 }),
    ];
    const a = store.segment('a');
    for (const raw of handles) {
      const h = audit(raw) as unknown as Seg;
      await drain(a.intersect([h]));
      await drain(a.union([h]));
      await drain(a.andNot([h]));
      await drain(a.intersect([a], { exclude: [h] }));
      await a.intersectInto(store.segment('d'), [h]);
      await a.andNotInto(store.segment('d'), [h]);
      await a.unionInto(store.segment('d'), [h]);
    }
    await a.intersectInto(audit(otherStore.segment('d')) as unknown as Seg, [a]);
    expect([...reads].sort()).toEqual(
      [String(BRAND), 'ref', 'pinnedAt', 'leaseHold', 'key', 'leaseError'].sort(),
    );
  });
});
