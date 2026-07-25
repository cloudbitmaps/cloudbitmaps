import {
  CrbmColdChunkSource,
  MemoryColdDriver,
  MemoryRegistryDriver,
  bulkLoadCrbmGeneration,
} from '@/index';
import type { IColdDriver } from '@/index';

/**
 * Bounded cold-reader cache (gap #1). `CrbmColdChunkSource` used to hold an
 * unbounded `Map` of opened readers (each carrying a fully-parsed `.crbm` index), so a long-running server's
 * footprint grew with every distinct segment ever read → OOM at 100K+ segments. The cache is now a `BoundedLru`
 * capped by `maxOpenSegments`: past the ceiling the least-recently-used segment's reader is evicted, and the
 * next read of it re-opens (one cheap tail GET, since generations are immutable).
 */

/** Wrap a cold driver to count reader opens — `CrbmReader.open` issues exactly one `getTail` per open. */
function countingCold(base: IColdDriver): { cold: IColdDriver; opens: () => number } {
  let opens = 0;
  const cold: IColdDriver = {
    capabilities: () => base.capabilities(),
    putImmutable: (k, w) => base.putImmutable(k, w),
    getRange: (k, o, l) => base.getRange(k, o, l),
    getTail: (k, m) => {
      opens += 1;
      return base.getTail(k, m);
    },
    delete: (k) => base.delete(k),
    list: (r) => base.list(r),
  };
  return { cold, opens: () => opens };
}

async function seed(
  cold: IColdDriver,
  registry: MemoryRegistryDriver,
  segments: string[],
): Promise<void> {
  for (const segment of segments) {
    await bulkLoadCrbmGeneration(cold, { segment, generation: 0 }, [1, 2], { registry });
  }
}

const SEGS = ['s0', 's1', 's2'];

describe('CrbmColdChunkSource — bounded reader cache (gap #1)', () => {
  it('evicts the LRU segment past maxOpenSegments and re-opens it on the next read', async () => {
    const registry = new MemoryRegistryDriver({ now: () => 0 });
    const { cold, opens } = countingCold(new MemoryColdDriver());
    await seed(cold, registry, SEGS); // bulk-load writes (putImmutable) — no reader opens yet
    expect(opens()).toBe(0);

    const source = new CrbmColdChunkSource(cold, { registry, maxOpenSegments: 2 });
    // Read each segment once: 3 opens, but the ceiling is 2 → s0 (LRU) is evicted, cache holds {s1, s2}.
    for (const segment of SEGS) await source.listChunkKeys({ segment });
    expect(opens()).toBe(3);

    // s0 was evicted → this read re-opens it (4th open), proving the bound is enforced.
    await source.listChunkKeys({ segment: 's0' });
    expect(opens()).toBe(4);

    // s2 is still cached → no new open.
    await source.listChunkKeys({ segment: 's2' });
    expect(opens()).toBe(4);
  });

  it('bounds the resident reader set across a large fleet — memory cannot accumulate with fleet size (gap #1 at scale)', async () => {
    // The memory gate for the bounded-memory pillar (gap #1 → gap #12), enforced STRUCTURALLY (deterministic,
    // no flaky RSS sampling): read a fleet FAR larger than the cache cap TWICE. Pass 1 opens each once (N opens).
    // With the cap ≪ N, every segment is evicted before we loop back, so pass 2 re-opens all N (2N total). An
    // unbounded cache (the pre-Phase-C regression) would keep all N readers resident → pass 2 is 0 re-opens
    // (total N) → this assertion fails. That's the catch: reader memory is bounded by the cap, not the fleet.
    const N = 200;
    const CAP = 20;
    const registry = new MemoryRegistryDriver({ now: () => 0 });
    const { cold, opens } = countingCold(new MemoryColdDriver());
    const fleet = Array.from({ length: N }, (_, i) => `seg${i}`);
    for (const segment of fleet) {
      await bulkLoadCrbmGeneration(cold, { segment, generation: 0 }, [1, 2], { registry });
    }
    const source = new CrbmColdChunkSource(cold, { registry, maxOpenSegments: CAP });

    for (const segment of fleet) await source.listChunkKeys({ segment }); // pass 1: first touch of each
    expect(opens()).toBe(N);
    for (const segment of fleet) await source.listChunkKeys({ segment }); // pass 2: all evicted → all re-open
    expect(opens()).toBe(2 * N); // unbounded cache ⇒ N (0 re-opens); bounded ⇒ 2N
  });

  it('keeps all readers cached when maxOpenSegments covers the working set (no eviction, no re-open)', async () => {
    const registry = new MemoryRegistryDriver({ now: () => 0 });
    const { cold, opens } = countingCold(new MemoryColdDriver());
    await seed(cold, registry, SEGS);

    const source = new CrbmColdChunkSource(cold, { registry, maxOpenSegments: 10 });
    for (const segment of SEGS) await source.listChunkKeys({ segment });
    expect(opens()).toBe(3);

    // Re-reading any segment is a cache hit — the reader (and its index) is still resident.
    await source.listChunkKeys({ segment: 's0' });
    expect(opens()).toBe(3);
  });
});

describe('CrbmColdChunkSource — byte-bounded reader cache (gap #1, second half)', () => {
  // Each seeded segment carries [1,2] → one chunk → one parsed index entry (160 B retained, the reader's
  // RETAINED_BYTES_PER_INDEX_ENTRY). The COUNT bound (`maxOpenSegments`) is set generously so the BYTE bound
  // (`maxOpenIndexBytes`) is the one doing the work: this is what a count-only cache missed (1024 wide indices
  // at several MB each could pin ~GBs, blowing a small heap, while the count was nominally "in bounds"). Two
  // index entries = 320 B.
  it('evicts the LRU reader when the parsed-index byte budget binds before the count budget', async () => {
    const registry = new MemoryRegistryDriver({ now: () => 0 });
    const { cold, opens } = countingCold(new MemoryColdDriver());
    await seed(cold, registry, SEGS);

    // count cap 100 (never binds); byte cap 320 B holds exactly two 160 B indices.
    const source = new CrbmColdChunkSource(cold, {
      registry,
      maxOpenSegments: 100,
      maxOpenIndexBytes: 320,
    });
    await source.listChunkKeys({ segment: 's0' });
    await source.listChunkKeys({ segment: 's1' }); // total 320 B ≤ 320 — both resident
    expect(opens()).toBe(2);

    // s2 pushes the total to 480 B > 320 → the LRU (s0) is evicted on byte pressure alone.
    await source.listChunkKeys({ segment: 's2' });
    expect(opens()).toBe(3);
    await source.listChunkKeys({ segment: 's0' }); // evicted → re-opens (proves the byte bound fired)
    expect(opens()).toBe(4);
    await source.listChunkKeys({ segment: 's2' }); // still resident → no new open
    expect(opens()).toBe(4);
  });

  it('bounds resident index bytes across a large fleet — memory cannot accumulate with fleet size', async () => {
    // The byte-bound analogue of the count-bound scale gate: read a fleet whose aggregate index footprint far
    // exceeds the byte budget, TWICE. With the budget ≪ fleet footprint, every segment is byte-evicted before
    // we loop back, so pass 2 re-opens all N (2N total). A byte-unbounded cache keeps them resident ⇒ N.
    const N = 200;
    const CAP_BYTES = 20 * 160; // ~20 indices resident (160 B each)
    const registry = new MemoryRegistryDriver({ now: () => 0 });
    const { cold, opens } = countingCold(new MemoryColdDriver());
    const fleet = Array.from({ length: N }, (_, i) => `seg${i}`);
    for (const segment of fleet) {
      await bulkLoadCrbmGeneration(cold, { segment, generation: 0 }, [1, 2], { registry });
    }
    const source = new CrbmColdChunkSource(cold, {
      registry,
      maxOpenSegments: 100_000, // count never binds; bytes do
      maxOpenIndexBytes: CAP_BYTES,
    });

    for (const segment of fleet) await source.listChunkKeys({ segment });
    expect(opens()).toBe(N);
    for (const segment of fleet) await source.listChunkKeys({ segment });
    expect(opens()).toBe(2 * N); // byte-unbounded ⇒ N (0 re-opens); byte-bounded ⇒ 2N
  });
});
