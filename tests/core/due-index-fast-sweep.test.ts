/**
 * The sweep's fast path: `scan: 'index'` reads only the due buckets instead of draining the fleet.
 *
 * The two properties that matter are **equivalence** (the fast path must retire exactly what the fleet path
 * retires, for anything the index knows about) and **cost** (it must not read the fleet — which is the entire
 * reason it exists, and the only thing a correctness test would not notice if it regressed).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CloudRoaring,
  DEFAULT_LOOKBACK_BUCKETS,
  MemoryColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  dueBucket,
  dueIndexRef,
  dueNamespace,
  type SegmentRef,
} from '@/index';

const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

function harness() {
  let t = T0;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const registry = new MemoryRegistryDriver({ now: clock.now });
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new MemoryColdDriver(),
    registry,
    clock,
  });
  return { store, registry, advance: (ms: number) => (t += ms) };
}

async function seed(store: CloudRoaring, segment: string, expiresAt?: number): Promise<SegmentRef> {
  const ref: SegmentRef = { namespace: 'active', segment };
  await store.segment(segment, { namespace: 'active' }).addMany([1, 2, 3]);
  if (expiresAt !== undefined) await store.setRetention(ref, { expiresAt });
  return ref;
}

describe('sweep — scan: index', () => {
  it('retires exactly what the fleet scan would', async () => {
    const { store } = harness();
    const soon = T0 + DAY;
    await seed(store, 'expires-soon', soon);
    await seed(store, 'expires-later', T0 + 90 * DAY);
    await seed(store, 'no-policy');

    const swept = await store.retireExpired({ scan: 'index', now: soon + 1 });

    expect(swept.retired).toBe(1);
    expect(swept.entries.map((e) => e.segment)).toEqual(['expires-soon']);
    expect(await store.segment('expires-soon', { namespace: 'active' }).count()).toBe(0);
    expect(await store.segment('expires-later', { namespace: 'active' }).count()).toBe(3);
    expect(await store.segment('no-policy', { namespace: 'active' }).count()).toBe(3);
  });

  it('does not read the fleet — the whole point, and invisible to a correctness test', async () => {
    const { store, registry } = harness();
    const soon = T0 + DAY;
    await seed(store, 'expires-soon', soon);
    for (let i = 0; i < 20; i++) await seed(store, `unrelated-${i}`); // fleet noise, no policies

    const listed: (string | undefined)[] = [];
    const realList = registry.list.bind(registry);
    vi.spyOn(registry, 'list').mockImplementation((namespace?: string) => {
      listed.push(namespace);
      return realList(namespace);
    });

    await store.retireExpired({ scan: 'index', now: soon + 1 });

    // Every list call is scoped to a due bucket. An unscoped list would be the fleet drain we are avoiding.
    expect(listed.every((ns) => ns?.startsWith('cbm.due.') === true)).toBe(true);
    expect(listed).toHaveLength(DEFAULT_LOOKBACK_BUCKETS + 1);
    vi.restoreAllMocks();
  });

  it('reads past buckets, so a sweep that did not run leaves nothing stranded', async () => {
    const { store } = harness();
    const threeDaysAgo = T0 - 3 * DAY;
    await seed(store, 'missed', threeDaysAgo + 1);

    // Nothing ran when it expired; the next cycle is days later and must still find it.
    const swept = await store.retireExpired({ scan: 'index', now: T0 });

    expect(swept.retired).toBe(1);
  });

  it('a bucket older than the lookback is left to the fleet repair pass', async () => {
    const { store } = harness();
    const longAgo = T0 - 30 * DAY;
    await seed(store, 'ancient', longAgo);

    expect((await store.retireExpired({ scan: 'index', now: T0 })).retired).toBe(0);
    // …and the backstop still catches it, which is why the omission is survivable.
    expect((await store.retireExpired({ scan: 'fleet', now: T0 })).retired).toBe(1);
  });

  it('a stale pointer costs a read and retires nothing', async () => {
    const { store, registry } = harness();
    const soon = T0 + DAY;
    const ref = await seed(store, 'reprieved', soon);
    await store.clearRetention(ref);
    await registry.create(dueIndexRef(dueBucket(soon), ref), { currentGen: null }); // interrupted reindex

    const swept = await store.retireExpired({ scan: 'index', now: soon + 1 });

    expect(swept.retired).toBe(0);
    expect(await store.segment('reprieved', { namespace: 'active' }).count()).toBe(3);
  });

  it('a segment reachable from two buckets is retired once, not twice', async () => {
    // `reindex` writes the new pointer before deleting the old, so an interruption leaves both. A phantom
    // second entry in the ledger would make an operator think two segments went away.
    const { store, registry } = harness();
    const soon = T0 + DAY;
    const ref = await seed(store, 'double-pointed', soon);
    await registry.create(dueIndexRef(dueBucket(soon) - 1, ref), { currentGen: null });

    const swept = await store.retireExpired({ scan: 'index', now: soon + 1 });

    expect(swept.retired).toBe(1);
    expect(swept.entries).toHaveLength(1);
  });

  it('forgets the pointer once a segment is retired, so buckets do not grow forever', async () => {
    const { store, registry } = harness();
    const soon = T0 + DAY;
    await seed(store, 'gone', soon);
    const bucket = dueNamespace(dueBucket(soon));

    await store.retireExpired({ scan: 'index', now: soon + 1 });

    const left: string[] = [];
    for await (const row of registry.list(bucket)) left.push(row.segment);
    expect(left).toEqual([]);
  });

  it('ignores a foreign row in a due bucket rather than acting on it', async () => {
    const { store, registry } = harness();
    const soon = T0 + DAY;
    await seed(store, 'real', soon);
    await registry.create(
      { namespace: dueNamespace(dueBucket(soon)), segment: 'not-a-pointer' },
      {
        currentGen: 0,
      },
    );

    const swept = await store.retireExpired({ scan: 'index', now: soon + 1 });

    expect(swept.retired).toBe(1);
    expect(swept.entries.map((e) => e.segment)).toEqual(['real']);
  });

  it('respects the namespace filter', async () => {
    const { store } = harness();
    const soon = T0 + DAY;
    await seed(store, 'in-scope', soon);
    await store.segment('elsewhere', { namespace: 'other' }).addMany([9]);
    await store.setRetention({ namespace: 'other', segment: 'elsewhere' }, { expiresAt: soon });

    const swept = await store.retireExpired({ scan: 'index', namespace: 'other', now: soon + 1 });

    expect(swept.entries.map((e) => e.segment)).toEqual(['elsewhere']);
  });

  it('an unindexed policy is invisible to the fast path and caught by the repair pass', async () => {
    // The documented boundary: `scan: 'index'` alone is not a complete retention strategy.
    const { store, registry } = harness();
    const soon = T0 + DAY;
    const ref = await seed(store, 'unpointed', soon);
    await registry.delete(dueIndexRef(dueBucket(soon), ref));

    expect((await store.retireExpired({ scan: 'index', now: soon + 1 })).retired).toBe(0);
    expect((await store.retireExpired({ scan: 'fleet', now: soon + 1 })).retired).toBe(1);
  });

  it('defaults to the fleet scan, so upgrading changes nothing', async () => {
    const { store, registry } = harness();
    const soon = T0 + DAY;
    const ref = await seed(store, 'unpointed', soon);
    await registry.delete(dueIndexRef(dueBucket(soon), ref)); // only the fleet scan can see this one

    expect((await store.retireExpired({ now: soon + 1 })).retired).toBe(1);
  });
});
