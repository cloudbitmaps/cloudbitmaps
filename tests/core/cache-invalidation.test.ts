import {
  CloudRoaring,
  InProcessKeystore,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import { destroySegment } from '@/core/erasure';
import { setSegmentRetention } from '@/core/retention';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * A store keeps two layers of derived state: a resolved snapshot per segment (an open reader, plus the DEK it
 * unwrapped) and decoded chunks keyed by generation. Both exist to notice **a publish that advances
 * `currentGen`** — the TTL re-resolves, the new generation misses the cache.
 *
 * Neither notices an event that *destroys* what they were derived from. Every destructive verb went to the raw
 * drivers and told the caches nothing, so the process that performed an erasure kept answering from RAM — with
 * no backend read, which is what makes it unreachable by any storage-side control.
 */
const REF: SegmentRef = { namespace: 'ns', segment: 'seg' };
// 4242 is in chunk 0; 99_999 is in chunk 1 — a read of 99_999 must FETCH, so it cannot be served from a chunk
// warmed earlier. That is what separates "stale plaintext in a cache" from "still able to decrypt".
const IDS = [1, 2, 4242, 99_999];

async function collect(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('destructive verbs invalidate what this store derived from the segment', () => {
  it('the store that erases no longer serves the erased id', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });

    const store = new CloudRoaring({ cold, registry });
    expect(await store.segment('seg', { namespace: 'ns' }).has(4242)).toBe(true); // warms the snapshot + chunk 0

    const ledger = await store.eraseSubject(4242, { namespace: 'ns' });
    expect(ledger.erasedFrom[0]).toMatchObject({ erased: true });

    expect(await store.segment('seg', { namespace: 'ns' }).has(4242)).toBe(false);
    expect(await collect(store.segment('seg', { namespace: 'ns' }).iterate())).toEqual([
      1, 2, 99_999,
    ]);
  });

  it('a pinned store (coldGenTtlMs: 0) converges too — it never would on the TTL', async () => {
    // "Pin forever" is a documented setting. Without an explicit signal this window never closes at all.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });

    const store = new CloudRoaring({ cold, registry, coldGenTtlMs: 0 });
    expect(await store.segment('seg', { namespace: 'ns' }).has(4242)).toBe(true);
    await store.eraseSubject(4242, { namespace: 'ns' });
    expect(await store.segment('seg', { namespace: 'ns' }).has(4242)).toBe(false);
  });

  it('Art. 15 and Art. 17 agree after an erasure, on the same store', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });

    const store = new CloudRoaring({ cold, registry });
    expect((await store.subjectReport(4242, { namespace: 'ns' })).segments).toHaveLength(1);

    await store.eraseSubject(4242, { namespace: 'ns' });
    expect((await store.subjectReport(4242, { namespace: 'ns' })).segments).toEqual([]);
  });

  it('the export (Art. 20) no longer carries the erased id', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });

    const store = new CloudRoaring({ cold, registry });
    await store.segment('seg', { namespace: 'ns' }).has(4242); // warm it
    await store.eraseSubject(4242, { namespace: 'ns' });

    const seen: number[] = [];
    for await (const v of store.segment('seg', { namespace: 'ns' }).iterate()) seen.push(v);
    expect(seen).not.toContain(4242);
  });

  it('`store.invalidate` closes a crypto-shred performed beside the store', async () => {
    // `destroySegment` is a free function over raw drivers, so the store cannot see it. Before the signal
    // existed, the retained reader kept DECRYPTING — including chunk 1, which it had never fetched.
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const keystore = new InProcessKeystore({
      keys: { k1: new Uint8Array(32).fill(7) },
      activeKeyId: 'k1',
    });
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry, keystore });

    const store = new CloudRoaring({
      cold,
      registry,
      keystore,
      coldGenTtlMs: 0,
    });
    expect(await store.segment('seg', { namespace: 'ns' }).has(4242)).toBe(true); // warms chunk 0 only

    const res = await destroySegment(REF, { registry }, { confirmSegment: 'seg' });
    expect(res).toMatchObject({ destroyed: true, cryptoShredded: true });

    store.invalidate(REF);

    expect(await collect(store.segment('seg', { namespace: 'ns' }).iterate())).toEqual([]);
    expect(await store.segment('seg', { namespace: 'ns' }).has(99_999)).toBe(false);
  });

  it('a retirement invalidates the segments it retired', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const PAST = Date.parse('2020-01-01T00:00:00Z');
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });

    const store = new CloudRoaring({ cold, registry, coldGenTtlMs: 0 });
    expect(await store.segment('seg', { namespace: 'ns' }).count()).toBe(4);

    await store.retireExpired({ now: PAST + 1 });
    expect(await store.segment('seg', { namespace: 'ns' }).count()).toBe(0);
  });

  it('`dryRun` invalidates nothing, because it changes nothing', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const PAST = Date.parse('2020-01-01T00:00:00Z');
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });
    await setSegmentRetention(REF, { registry }, { expiresAt: PAST });

    const store = new CloudRoaring({ cold, registry, coldGenTtlMs: 0 });
    expect(await store.segment('seg', { namespace: 'ns' }).count()).toBe(4);
    await store.retireExpired({ now: PAST + 1, dryRun: true });
    expect(await store.segment('seg', { namespace: 'ns' }).count()).toBe(4);
  });

  it('invalidating one segment does not disturb another', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const other: SegmentRef = { namespace: 'ns', segment: 'other' };
    await bulkLoadCrbmGeneration(cold, { ...REF, generation: 0 }, IDS, { registry });
    await bulkLoadCrbmGeneration(cold, { ...other, generation: 0 }, [5, 6], { registry });

    const store = new CloudRoaring({ cold, registry, coldGenTtlMs: 0 });
    expect(await store.segment('seg', { namespace: 'ns' }).count()).toBe(4);
    expect(await store.segment('other', { namespace: 'ns' }).count()).toBe(2);

    store.invalidate(REF);
    expect(await store.segment('other', { namespace: 'ns' }).count()).toBe(2);
  });

  it('the decoded chunks really go — the next read re-fetches', async () => {
    // Asserted directly rather than through an outcome. For the verbs above, dropping the *snapshot* is
    // already enough: a destroyed or retired row resolves to no generation, and an erasure moves to a new one
    // whose cache key misses anyway. The decoded-chunk drop earns its place in the case where the segment
    // still resolves to the SAME generation number under a different lineage — a retired name re-created,
    // where `nextGeneration` restarts at 0 and the key `(segment, chunk, 0)` collides. Nothing here can
    // exercise that until the reader compares lineage too, so pin the mechanism itself: after `invalidate`,
    // the cache must be cold.
    const real = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    await bulkLoadCrbmGeneration(real, { ...REF, generation: 0 }, IDS, { registry });

    let fetches = 0;
    const cold: IColdDriver = {
      capabilities: () => real.capabilities(),
      getTail: (k, m) => real.getTail(k, m),
      delete: (k) => real.delete(k),
      list: (r) => real.list(r),
      putImmutable: (k, fn) => real.putImmutable(k, fn),
      getRange: (k, o, l) => {
        fetches += 1;
        return real.getRange(k, o, l);
      },
    };

    const store = new CloudRoaring({ cold, registry, coldGenTtlMs: 0 });
    await store.segment('seg', { namespace: 'ns' }).has(4242);
    const warmed = fetches;
    expect(warmed).toBeGreaterThan(0);

    await store.segment('seg', { namespace: 'ns' }).has(4242); // served from the decoded chunk
    expect(fetches).toBe(warmed);

    store.invalidate(REF);

    await store.segment('seg', { namespace: 'ns' }).has(4242); // cache is cold: it must go back to storage
    expect(fetches).toBeGreaterThan(warmed);
  });

  it('invalidating a segment this store never read is a no-op, not an error', async () => {
    const cold = new MemoryColdDriver();
    const registry = new MemoryRegistryDriver();
    const store = new CloudRoaring({ cold, registry });
    expect(() => store.invalidate({ namespace: 'ns', segment: 'never-seen' })).not.toThrow();
  });
});
