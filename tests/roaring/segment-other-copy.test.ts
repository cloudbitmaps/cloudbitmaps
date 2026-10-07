import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';

/**
 * A segment of another copy of the package (a second install loads the module twice) is not an instance of this
 * copy's class. A combine takes it, as it always has: the operand check refuses what is not a segment, not what
 * another copy made.
 */
describe('a segment from another copy of the package', () => {
  it('is taken by a combine and an *Into call, as before', async () => {
    const other =
      (await import('../../packages/roaring/src/index.ts?another-copy')) as typeof import('@/index');
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
});
