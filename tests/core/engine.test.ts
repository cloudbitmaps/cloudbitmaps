import { CloudRoaring, IntegrityError, type Clock, type ColdChunkSource } from '@/index';
import { collect, loadedStore, seedSegment, seededStore } from '../helpers/loaded';

/** A controllable clock, so the store's generation refresh (`coldGenTtlMs`) is driven by the test, not wall time. */
function fakeClock(): Clock & { advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

describe('SegmentEngine (via CloudRoaring) — reads over loaded segments', () => {
  it('has / count / iterate basics across chunks', async () => {
    const { store } = seededStore({ users: [5, 100_000] }); // 100_000 lives in a different chunk (key 1)
    const s = store.segment('users');
    expect(await s.has(5)).toBe(true);
    expect(await s.has(7)).toBe(false);
    expect(await s.has(100_000)).toBe(true);
    expect(await s.count()).toBe(2);
    expect(await collect(s.iterate())).toEqual([5, 100_000]);
  });

  it('a segment nothing has loaded reads as empty', async () => {
    const { store } = seededStore();
    const s = store.segment('nobody');
    expect(await s.has(1)).toBe(false);
    expect(await s.count()).toBe(0);
    expect(await collect(s.iterate())).toEqual([]);
  });

  it('a reload REPLACES the set — readers see the new generation, and only it', async () => {
    // There is no add/remove: the only way ids leave a segment is a generation that does not hold them. A
    // reader re-resolves the current generation after `coldGenTtlMs`, driven here by the injected clock.
    const clock = fakeClock();
    const { store, load, registry } = await loadedStore(
      { users: [1, 2, 70_000, 70_001] },
      { clock, coldGenTtlMs: 1 },
    );
    const s = store.segment('users');
    expect(await collect(s.iterate())).toEqual([1, 2, 70_000, 70_001]);

    await load('users', [1, 70_001, 200_000]); // generation 1: drops 2 and 70_000, adds 200_000
    expect((await registry.get({ segment: 'users' }))!.currentGen).toBe(1);
    clock.advance(1);
    expect(await s.count()).toBe(3);
    expect(await collect(s.iterate())).toEqual([1, 70_001, 200_000]);
    expect(await s.has(2)).toBe(false);
    expect(await s.has(70_000)).toBe(false);
    expect(await s.has(200_000)).toBe(true);
  });

  it('a reload to an empty generation reads as empty (the segment still exists)', async () => {
    const clock = fakeClock();
    const { store, load, registry } = await loadedStore(
      { users: [42] },
      { clock, coldGenTtlMs: 1 },
    );
    const s = store.segment('users');
    expect(await s.has(42)).toBe(true);

    await load('users', []);
    clock.advance(1);
    expect(await s.has(42)).toBe(false);
    expect(await s.count()).toBe(0);
    expect(await collect(s.iterate())).toEqual([]);
    expect((await registry.get({ segment: 'users' }))!.currentGen).toBe(1);
  });

  it('isolates namespaces', async () => {
    const { store, cold } = seededStore();
    seedSegment(cold, { namespace: 'acme', segment: 'seg' }, [1]);
    const a = store.segment('seg', { namespace: 'acme' });
    const b = store.segment('seg', { namespace: 'globex' });
    expect(await a.has(1)).toBe(true);
    expect(await b.has(1)).toBe(false);
    expect(await b.count()).toBe(0);
  });

  it('round-trips boundary ids through the full read path', async () => {
    const ids = [0, 0xffff, 0x1_0000, 0xffff_ffff];
    const { store } = seededStore({ s: ids });
    const s = store.segment('s');
    expect(await s.count()).toBe(4);
    expect(await collect(s.iterate())).toEqual(ids);
    expect(await s.has(0)).toBe(true);
    expect(await s.has(0xffff_ffff)).toBe(true);
  });

  it('rejects an out-of-range chunk key from a tier (IntegrityError)', async () => {
    const badCold: ColdChunkSource = {
      getChunk: () => Promise.resolve(null),
      listChunkKeys: () => Promise.resolve([70_000]), // > 0xffff
    };
    const s = new CloudRoaring({ cold: badCold }).segment('users');
    await expect(s.count()).rejects.toBeInstanceOf(IntegrityError);
  });
});
