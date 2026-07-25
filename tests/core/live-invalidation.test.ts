import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CloudRoaring,
  CrbmColdChunkSource,
  LocalFsColdDriver,
  MemoryRegistryDriver,
  MemoryWarmDriver,
  bulkLoadCrbmGeneration,
  compactSegment,
} from '@/index';
import type { CompactionDeps, IRegistryDriver, SegmentRef } from '@/index';

/** Wrap a registry to count `get` calls — proves the TTL refresh coalesces instead of a per-reader herd. */
function countingRegistry(base: IRegistryDriver): {
  registry: IRegistryDriver;
  gets: () => number;
} {
  let gets = 0;
  const registry: IRegistryDriver = {
    capabilities: () => base.capabilities(),
    get: (ref) => {
      gets += 1;
      return base.get(ref);
    },
    create: (ref, rec) => base.create(ref, rec),
    compareAndSwap: (ref, expected, patch) => base.compareAndSwap(ref, expected, patch),
    list: (ns) => base.list(ns),
    delete: (ref) => base.delete(ref),
  };
  return { registry, gets: () => gets };
}

/**
 * Wrap a registry so a segment's FIRST `get` sees no record yet, then the real one — models a read that races
 * the segment's very first publish (the write path never creates a registry row, so a warm-only segment has
 * none until its first compaction/bulk-load publishes one). Proves `count`/`iterate` resolve `gen` after the
 * shape read (gap #4): resolving it first would read null here and undercount the freshly-published cold data.
 */
function firstGetNullRegistry(base: IRegistryDriver): IRegistryDriver {
  let served = false;
  return {
    capabilities: () => base.capabilities(),
    get: (ref) => {
      if (!served) {
        served = true;
        return Promise.resolve(null);
      }
      return base.get(ref);
    },
    create: (ref, rec) => base.create(ref, rec),
    compareAndSwap: (ref, expected, patch) => base.compareAndSwap(ref, expected, patch),
    list: (ns) => base.list(ns),
    delete: (ref) => base.delete(ref),
  };
}

/**
 * Live cross-generation invalidation (gap #4). A long-lived reader used to pin
 * `currentGen` for its whole lifetime, so after a separate daemon compacted a segment the reader would serve
 * the stale prior generation indefinitely — a folded add read FALSE, an erased id resurrected to TRUE. The fix:
 * the cold source re-resolves `currentGen` on a short TTL and the engine keys its HOT cache by generation, so a
 * reader converges to the new generation within the TTL (bounded, explicit staleness).
 */

const SEG: SegmentRef = { segment: 's' };
const OWNER = 'daemon-1';
const TTL = 1000;

function clockAt(start = 10_000): {
  now: () => number;
  sleep: () => Promise<void>;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, sleep: () => Promise.resolve(), advance: (ms) => (t += ms) };
}

let root: string;
let n = 0;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crbm-live-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeWorld() {
  const clock = clockAt();
  const cold = new LocalFsColdDriver(join(root, `d${n++}`));
  const warm = new MemoryWarmDriver();
  const registry = new MemoryRegistryDriver({ now: clock.now });
  const deps: CompactionDeps = { cold, warm, registry, clock };
  return { clock, cold, warm, registry, deps };
}

describe('live cross-generation invalidation (gap #4)', () => {
  it('does not permanently resurrect an erased id after compaction — converges within the TTL', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });

    // The long-lived Topology-B app server: raw cold driver + registry + clock + a short currentGen TTL.
    const store = new CloudRoaring({
      cold: w.cold,
      warm: w.warm,
      registry: w.registry,
      clock: w.clock,
      coldGenTtlMs: TTL,
      retry: false,
    });
    const seg = store.segment('s');
    // First read pins generation 0 and caches chunk 0 keyed by that generation.
    expect(await seg.has(2)).toBe(true);
    expect(await seg.has(1)).toBe(true);

    // A SEPARATE actor erases id 2 and force-compacts: the tombstone folds into a fresh gen 1 = {1,3}; the
    // Warm row is purged. (Distinct short-lived store over the same tiers — the daemon in Topology-B.)
    const eraser = new CloudRoaring({
      cold: w.cold,
      warm: w.warm,
      registry: w.registry,
      clock: w.clock,
      retry: false,
    });
    await eraser.segment('s').remove(2);
    expect(await compactSegment(SEG, w.deps, { owner: OWNER })).toMatchObject({
      compacted: true,
      toGen: 1,
    });

    // Within the TTL the long-lived reader still serves the pinned generation 0 — bounded, explicit staleness.
    expect(await seg.has(2)).toBe(true);

    // Once the TTL elapses, the next read re-resolves currentGen → gen 1 and the gen-keyed cache misses the
    // stale gen-0 chunk: the erased id is gone for good, and unaffected ids still read correctly.
    w.clock.advance(TTL + 1);
    expect(await seg.has(2)).toBe(false);
    expect(await seg.has(1)).toBe(true);
  });

  it('currentGeneration re-resolves to a newer generation only after the TTL elapses', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const source = new CrbmColdChunkSource(w.cold, {
      registry: w.registry,
      clock: w.clock,
      currentGenTtlMs: TTL,
    });

    expect(await source.currentGeneration(SEG)).toBe(0);

    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
      registry: w.registry,
    });
    expect(await source.currentGeneration(SEG)).toBe(0); // pinned within the TTL
    w.clock.advance(TTL + 1);
    expect(await source.currentGeneration(SEG)).toBe(1); // re-resolved after the TTL
  });

  it('pins the first generation for its lifetime when no clock is injected (pre-Phase-B behaviour)', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2], {
      registry: w.registry,
    });
    const source = new CrbmColdChunkSource(w.cold, { registry: w.registry }); // no clock ⇒ no refresh

    expect(await source.currentGeneration(SEG)).toBe(0);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3], {
      registry: w.registry,
    });
    w.clock.advance(TTL * 100);
    expect(await source.currentGeneration(SEG)).toBe(0); // never refreshes without a clock
  });

  it('coalesces a concurrent burst at the TTL boundary into ONE registry re-resolve (no thundering herd)', async () => {
    const w = makeWorld();
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2, 3], {
      registry: w.registry,
    });
    const { registry, gets } = countingRegistry(w.registry);
    const source = new CrbmColdChunkSource(w.cold, {
      registry,
      clock: w.clock,
      currentGenTtlMs: TTL,
    });

    expect(await source.currentGeneration(SEG)).toBe(0); // prime the snapshot (one resolve)
    const primed = gets();

    // Expire, then fire 8 concurrent reads (mirrors intersect's fan-out / concurrent has()). They must share
    // the one in-flight re-resolve — not issue one registry.get each (the boundary thundering-herd A1 flagged).
    w.clock.advance(TTL + 1);
    const burst = await Promise.all(Array.from({ length: 8 }, () => source.currentGeneration(SEG)));
    expect(burst).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(gets() - primed).toBe(1);
  });

  it('count()/iterate() do not undercount when a read races a segment first publish (gen after the shape read)', async () => {
    const w = makeWorld();
    // Chunk 0 lives in Cold gen 0 as {5,6}; a warm add of 7 makes it a dirty chunk (effective {5,6,7}).
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [5, 6], {
      registry: w.registry,
    });
    const writer = new CloudRoaring({
      cold: w.cold,
      warm: w.warm,
      registry: w.registry,
      clock: w.clock,
      retry: false,
    });
    await writer.segment('s').add(7);

    // A reader whose FIRST registry read sees no record yet (first-publish race), then the record. Resolving
    // `gen` before the shape read would read null and drop Cold {5,6} for the dirty chunk → count 1, iterate [7].
    const countStore = new CloudRoaring({
      cold: w.cold,
      warm: w.warm,
      registry: firstGetNullRegistry(w.registry),
      clock: w.clock,
      coldGenTtlMs: TTL,
      retry: false,
    });
    expect(await countStore.segment('s').count()).toBe(3);

    const iterStore = new CloudRoaring({
      cold: w.cold,
      warm: w.warm,
      registry: firstGetNullRegistry(w.registry),
      clock: w.clock,
      coldGenTtlMs: TTL,
      retry: false,
    });
    const ids: number[] = [];
    for await (const id of iterStore.segment('s').iterate()) ids.push(id);
    expect(ids).toEqual([5, 6, 7]);
  });

  it('pins for its lifetime without a registry (single-process/local; no cheap currentGen read)', async () => {
    const w = makeWorld();
    // No registry: the source resolves the max cold generation by list-scan and pins it (refresh needs a
    // registry). A registry-less setup is single-process local, not the separate-daemon Topology-B.
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 0 }, [1, 2]);
    const source = new CrbmColdChunkSource(w.cold, { clock: w.clock, currentGenTtlMs: TTL });

    expect(await source.currentGeneration(SEG)).toBe(0);
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 1 }, [1, 2, 3]);
    w.clock.advance(TTL + 1);
    expect(await source.currentGeneration(SEG)).toBe(0); // pinned (no registry to cheaply re-resolve)
  });
});
