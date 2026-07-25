import {
  CloudRoaring,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  IntegrityError,
  type ColdChunkSource,
  type Segment,
} from '@/index';
import { SafeBitmap } from '@/roaring-codec';

function newStore(cold = new MemoryColdChunkSource()): {
  cold: MemoryColdChunkSource;
  cr: CloudRoaring;
} {
  return { cold, cr: new CloudRoaring({ warm: new MemoryWarmDriver(), cold }) };
}

async function members(seg: Segment): Promise<number[]> {
  const out: number[] = [];
  for await (const id of seg.iterate()) out.push(id);
  return out;
}

describe('SegmentEngine (via CloudRoaring)', () => {
  it('add / has / count / iterate basics', async () => {
    const { cr } = newStore();
    const s = cr.segment('users');
    await s.add(5);
    await s.add(100_000); // a different chunk
    await s.add(5); // idempotent
    expect(await s.has(5)).toBe(true);
    expect(await s.has(7)).toBe(false);
    expect(await s.count()).toBe(2);
    expect(await members(s)).toEqual([5, 100_000]);
  });

  it('addMany / removeMany across chunks', async () => {
    const { cr } = newStore();
    const s = cr.segment('users');
    await s.addMany([1, 2, 70_000, 70_001]);
    await s.removeMany([2, 70_000]);
    expect(await s.count()).toBe(2);
    expect(await members(s)).toEqual([1, 70_001]);
  });

  it('removes down to empty (C12)', async () => {
    const { cr } = newStore();
    const s = cr.segment('users');
    await s.add(42);
    await s.remove(42);
    expect(await s.has(42)).toBe(false);
    expect(await s.count()).toBe(0);
    expect(await members(s)).toEqual([]);
  });

  it('merges Cold ∪ adds \\ removes (V5)', async () => {
    const cold = new MemoryColdChunkSource();
    cold.seed({ segment: 'users', chunkKey: 0 }, SafeBitmap.fromValues([1, 2, 3]).serialize());
    const cr = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    const s = cr.segment('users');
    await s.add(9);
    await s.remove(2);
    expect(await s.count()).toBe(3);
    expect(await members(s)).toEqual([1, 3, 9]);
    expect(await s.has(2)).toBe(false);
    expect(await s.has(1)).toBe(true);
    expect(await s.has(9)).toBe(true);
  });

  it('re-add after remove restores membership', async () => {
    const { cr } = newStore();
    const s = cr.segment('users');
    await s.add(7);
    await s.remove(7);
    await s.add(7);
    expect(await s.has(7)).toBe(true);
    expect(await s.count()).toBe(1);
  });

  it('isolates namespaces', async () => {
    const cr = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
    });
    const a = cr.segment('seg', { namespace: 'acme' });
    const b = cr.segment('seg', { namespace: 'globex' });
    await a.add(1);
    expect(await a.has(1)).toBe(true);
    expect(await b.has(1)).toBe(false);
    expect(await b.count()).toBe(0);
  });

  it('rejects an out-of-range chunk key from a tier (IntegrityError)', async () => {
    const badCold: ColdChunkSource = {
      getChunk: () => Promise.resolve(null),
      listChunkKeys: () => Promise.resolve([70_000]), // > 0xffff
    };
    const s = new CloudRoaring({ warm: new MemoryWarmDriver(), cold: badCold }).segment('users');
    await expect(s.count()).rejects.toBeInstanceOf(IntegrityError);
  });
});
