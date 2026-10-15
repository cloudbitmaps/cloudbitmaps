import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage, ValidationError } from '@/index';

/**
 * A segment of another copy of the package (a second install loads the module twice) is not an instance of this
 * copy's class. A store belongs to one copy, so another copy's segment always comes from another store and is
 * refused, over a shared backend or a separate one, before any request. Its versioned brand only gives the refusal a
 * precise message; an object that merely has the brand's shape or a lease check is not a segment.
 */
type Seg = ReturnType<CloudRoaring['segment']>;
const BRAND = Symbol.for('cloudbitmaps.roaring.segment/1');
const COPY_MESSAGE =
  /another installed copy of @cloudbitmaps\/roaring, so it belongs to another store; install one copy and combine segments of one store$/;

const drain = async (it: AsyncIterable<number>): Promise<number[]> => {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
};

async function twoCopies(shared: boolean) {
  // The query makes the module loader evaluate the source again: a second copy, as a second install would be.
  const specifier = '../../packages/roaring/src/index.ts?another-copy';
  const other = (await import(/* @vite-ignore */ specifier)) as typeof import('@/index');
  expect(other.CloudRoaring).not.toBe(CloudRoaring);
  const storage = new MemoryStorage();
  const store = new CloudRoaring({ storage });
  const otherStore = new other.CloudRoaring({
    storage: shared ? storage : new other.MemoryStorage(),
  });
  await store.load({ segment: 'a' }, [1, 2, 3, 70_000]);
  await store.load({ segment: 'd' }, [9]);
  await otherStore.load({ segment: 'b' }, [2, 3, 70_000, 90_000]);
  await otherStore.load({ segment: 'd' }, [8]);
  return { store, otherStore };
}

const generationsOf = async (s: { generations: CloudRoaring['generations'] }, name: string) =>
  (await s.generations({ segment: name })).map((g) => g.generation);

describe.each([
  ['a shared storage', true],
  ['a separate storage', false],
])('a segment from another copy of the package, over %s', (_label, shared) => {
  it('is refused by every combine, *Into and materializeMany, publishing nothing', async () => {
    const { store, otherStore } = await twoCopies(shared);
    const before = await generationsOf(store, 'd');
    const beforeOther = await generationsOf(otherStore, 'd');
    const a = store.segment('a');
    const d = store.segment('d');
    const raw = otherStore.segment('b') as unknown as Seg;
    const pinned = (await otherStore.segment('b').pin()) as unknown as Seg;
    const leased = (await otherStore
      .segment('b')
      .pin({ leaseUntil: Date.now() + 600_000 })) as unknown as Seg;
    for (const h of [raw, pinned, leased]) {
      expect(h).not.toBeInstanceOf(Object.getPrototypeOf(a).constructor);
      await expect(drain(a.intersect([h]))).rejects.toThrow(COPY_MESSAGE);
      await expect(drain(a.union([h]))).rejects.toThrow(COPY_MESSAGE);
      await expect(drain(a.andNot([h]))).rejects.toThrow(COPY_MESSAGE);
      await expect(drain(a.intersect([a], { exclude: [h] }))).rejects.toThrow(
        /an exclude comes from another installed copy/,
      );
      await expect(a.intersectInto(d, [h])).rejects.toThrow(COPY_MESSAGE);
      await expect(a.unionInto(d, [h])).rejects.toThrow(COPY_MESSAGE);
      await expect(a.andNotInto(d, [h])).rejects.toThrow(COPY_MESSAGE);
      await expect(a.intersectInto(h, [a])).rejects.toThrow(
        /the destination comes from another installed copy/,
      );
      await expect(
        store.materializeMany({
          operands: { p: h },
          outputs: [{ dest: d, expr: 'p' }],
          keep: 1,
        }),
      ).rejects.toThrow(COPY_MESSAGE);
      await expect(
        store.materializeMany({
          operands: { p: a },
          outputs: [{ dest: h, expr: 'p' }],
          keep: 1,
        }),
      ).rejects.toThrow(/the destination comes from another installed copy/);
      await expect(drain(a.intersect([h])).catch((e: Error) => e)).resolves.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(await generationsOf(store, 'd')).toEqual(before);
    expect(await generationsOf(otherStore, 'd')).toEqual(beforeOther);
    await (leased as unknown as { release(): Promise<void> }).release();
  });

  it('is refused when a Proxy hides its brand, as not a segment', async () => {
    const { store, otherStore } = await twoCopies(shared);
    const hidden = new Proxy(otherStore.segment('b'), {
      get: (o, k) => (k === BRAND ? undefined : Reflect.get(o, k, o)),
    }) as unknown as Seg;
    await expect(drain(store.segment('a').intersect([hidden]))).rejects.toThrow(ValidationError);
  });
});

describe('a segment-shaped object is not a segment of another copy', () => {
  it('is not mimicked by an object with a leaseError method or a segment-shaped body', async () => {
    const store = new CloudRoaring({ storage: new MemoryStorage() });
    await store.load({ segment: 'a' }, [1, 2, 3]);
    const hollow = { leaseError: () => undefined } as unknown as Seg;
    const shaped = {
      ref: { segment: 'a' },
      leaseHold: undefined,
      leaseError: () => undefined,
    } as unknown as Seg;
    for (const fake of [hollow, shaped]) {
      await expect(drain(store.segment('a').intersect([fake]))).rejects.toThrow(
        /must be a segment from this store's segment\(\)/,
      );
    }
  });
});
