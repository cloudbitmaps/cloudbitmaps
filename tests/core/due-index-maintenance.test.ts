/**
 * Keeping the due index in step with the policies it points at.
 *
 * The index is a fast path and the segment's own row is the truth, so the tests here are less about "is the
 * pointer there" and more about **what happens when it isn't** — because that is the whole argument for it
 * being safe to add a second index at all.
 */
import { describe, expect, it } from 'vitest';
import { type SegmentRef } from '@/index';
import { drainRegistry } from '@/core/registry-scan';
import { dueBucket, dueIndexRef, dueNamespace } from '@/core/due-index';
import { loadedStore } from '../helpers/loaded';
import type { IRegistryDriver } from '@/core/ports';

const DAY = 86_400_000;
const T0 = 1_754_000_000_000;
const SEG: SegmentRef = { namespace: 'active', segment: 'd-2026-08-05' };

async function harness() {
  let t = T0;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const w = await loadedStore(
    {},
    {
      seams: { clock },
    },
  );
  return { ...w, clock, advance: (ms: number) => (t += ms) };
}

/** Every pointer currently in one bucket. */
async function pointersIn(registry: IRegistryDriver, bucket: number): Promise<string[]> {
  const rows = await drainRegistry(registry, {
    namespace: dueNamespace(bucket),
    maxScanSegments: 1000,
    op: 'test',
  });
  return rows.map((r) => r.segment).sort();
}

describe('due index — maintained by the policy write path', () => {
  it('setRetention writes the pointer for the expiry day', async () => {
    const { store, registry } = await harness();
    const expiresAt = T0 + 30 * DAY;

    const res = await store.setRetention(SEG, { expiresAt });

    expect(res.indexed).toBe(true);
    expect(await pointersIn(registry, dueBucket(expiresAt))).toEqual(['6.actived-2026-08-05']);
    // …and the pointer decodes back to the segment it points at.
    expect(dueIndexRef(dueBucket(expiresAt), SEG).segment).toBe('6.actived-2026-08-05');
  });

  it('moving an expiry moves the pointer — the old bucket is left clean', async () => {
    const { store, registry } = await harness();
    const first = T0 + 10 * DAY;
    const second = T0 + 40 * DAY;

    await store.setRetention(SEG, { expiresAt: first });
    await store.setRetention(SEG, { expiresAt: second });

    expect(await pointersIn(registry, dueBucket(first))).toEqual([]);
    expect(await pointersIn(registry, dueBucket(second))).toHaveLength(1);
  });

  it('two writes inside the same day do not duplicate the pointer', async () => {
    const { store, registry } = await harness();
    const bucket = dueBucket(T0 + 10 * DAY);

    await store.setRetention(SEG, { expiresAt: T0 + 10 * DAY });
    const second = await store.setRetention(SEG, { expiresAt: T0 + 10 * DAY + 60_000 }); // same day

    expect(await pointersIn(registry, bucket)).toHaveLength(1);
    // The pointer already existing must report `indexed: true` — it IS indexed. Reporting false there would
    // make the common case (a policy rewritten the same day) look like a degradation and train an operator to
    // ignore the signal.
    expect(second.indexed).toBe(true);
  });

  it('clearRetention removes the pointer', async () => {
    const { store, registry } = await harness();
    const expiresAt = T0 + 10 * DAY;
    await store.setRetention(SEG, { expiresAt });

    expect(await store.clearRetention(SEG)).toBe(true);

    expect(await pointersIn(registry, dueBucket(expiresAt))).toEqual([]);
  });

  it('pointers are invisible to every unscoped fleet enumeration', async () => {
    // An enumeration that saw them would count the pointers as segments, and the retention sweep's own `scanned`
    // count would include every pointer. A reserved family has to be declared in ONE place.
    const { store, registry, load } = await harness();
    await load(SEG, [1, 2, 3]);
    await store.setRetention(SEG, { expiresAt: T0 + 10 * DAY });

    const fleet = await drainRegistry(registry, { maxScanSegments: 1000, op: 'test' });

    expect(fleet.map((r) => r.segment)).toEqual([SEG.segment]);
  });
});

describe('due index — the drift directions that make it safe', () => {
  it('a pointer left behind cannot retire anything — the live row is re-read', async () => {
    const { store, registry, load } = await harness();
    const expiresAt = T0 + 10 * DAY;
    await load(SEG, [1, 2, 3]);
    await store.setRetention(SEG, { expiresAt });

    // Simulate the pointer surviving a policy change it should not have: clear the policy, then put the
    // pointer back by hand. This is the state an interrupted `reindex` leaves behind.
    await store.clearRetention(SEG);
    await registry.create(dueIndexRef(dueBucket(expiresAt), SEG), { currentGen: null });

    const swept = await store.retireExpired({ now: expiresAt + 1 });

    expect(swept.retired).toBe(0); // the row has no policy any more, so nothing is eligible
    expect(await store.segment(SEG.segment, { namespace: SEG.namespace }).count()).toBe(3);
  });

  it('a missing pointer cannot lose data — the full scan still finds the policy', async () => {
    const { store, registry, load } = await harness();
    const expiresAt = T0 + 10 * DAY;
    await load(SEG, [1, 2, 3]);
    await store.setRetention(SEG, { expiresAt });

    // Delete the pointer, leaving the policy in place — the state of a segment whose pointer write failed.
    await registry.delete(dueIndexRef(dueBucket(expiresAt), SEG));
    expect(await pointersIn(registry, dueBucket(expiresAt))).toEqual([]);

    const swept = await store.retireExpired({ now: expiresAt + 1 });

    expect(swept.retired).toBe(1); // the repair path is the backstop, and it is the default scan
    expect(await store.segment(SEG.segment, { namespace: SEG.namespace }).count()).toBe(0);
  });

  it('an unindexable ref still gets its policy, and reports that it was not indexed', async () => {
    const { store, registry } = await harness();
    // Encodes to more than the 256-character name limit, so there is no single row name that can hold it.
    const huge: SegmentRef = { namespace: 'n'.repeat(200), segment: 's'.repeat(200) };
    const expiresAt = T0 + 10 * DAY;

    const res = await store.setRetention(huge, { expiresAt });

    expect(res.indexed).toBe(false); // a degradation, not an error
    expect(res.expiresAt).toBe(expiresAt); // …and the policy is committed regardless
    expect(await pointersIn(registry, dueBucket(expiresAt))).toEqual([]);
    // The repair scan still sees it, which is the whole point of `indexed: false` being survivable.
    const swept = await store.retireExpired({ now: expiresAt + 1 });
    expect(swept.retired).toBe(1);
  });

  it('a pointer write failure does not fail the policy write', async () => {
    const { store, registry } = await harness();
    const original = registry.create.bind(registry);
    let failIndexWrites = false;
    registry.create = async (ref, record) => {
      if (failIndexWrites && ref.namespace?.startsWith('cbm.due.') === true) {
        throw new Error('registry unavailable');
      }
      return original(ref, record);
    };

    failIndexWrites = true;
    const res = await store.setRetention(SEG, { expiresAt: T0 + 10 * DAY });

    expect(res.indexed).toBe(false);
    expect(res.expiresAt).toBe(T0 + 10 * DAY); // committed — the index is not on the critical path
    expect((await registry.get(SEG))?.retention).toEqual({ expiresAt: T0 + 10 * DAY });
  });
});

describe('due index — an index scan holds a bounded number of stray pointers', () => {
  it('pointers to segments that are gone, past maxScanSegments, are left for a later scan', async () => {
    const { store, registry, advance } = await harness();
    const expiresAt = T0 + DAY;
    const refs = Array.from({ length: 5 }, (_, i) => ({
      namespace: 'active',
      segment: `gone-${i}`,
    }));
    for (const ref of refs) {
      await store.setRetention(ref, { expiresAt });
      await registry.delete(ref); // the row goes, the pointer stays: a stray
    }
    expect(await pointersIn(registry, dueBucket(expiresAt))).toHaveLength(5);
    advance(2 * DAY);
    const res = await store.retireExpired({ scan: 'index', maxScanSegments: 2 });
    expect(res.retired).toBe(0);
    // At most two held, and forgotten, this call; the other three wait for the next.
    expect(await pointersIn(registry, dueBucket(expiresAt))).toHaveLength(3);
    await store.retireExpired({ scan: 'index', maxScanSegments: 2 });
    await store.retireExpired({ scan: 'index', maxScanSegments: 2 });
    expect(await pointersIn(registry, dueBucket(expiresAt))).toHaveLength(0);
  });

  it('a live expired segment behind more strays than the bound is still retired', async () => {
    const { store, registry, advance } = await harness();
    const expiresAt = T0 + DAY;
    // Pointers are read in name order, so the strays come first.
    for (let i = 0; i < 3; i++) {
      const ref = { namespace: 'active', segment: `a-gone-${i}` };
      await store.setRetention(ref, { expiresAt });
      await registry.delete(ref);
    }
    const live = { namespace: 'active', segment: 'z-live' };
    await store.setRetention(live, { expiresAt });
    advance(2 * DAY);
    const res = await store.retireExpired({ scan: 'index', maxScanSegments: 2 });
    expect(res).toMatchObject({ retired: 1, eligible: 1 });
  });
});
