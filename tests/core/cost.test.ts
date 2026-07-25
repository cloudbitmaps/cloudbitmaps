import {
  CloudRoaring,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  MemoryColdDriver,
  CrbmColdChunkSource,
  writeCrbmGeneration,
  SafeBitmap,
  ValidationError,
  type PricingProfile,
  type ColdChunkSource,
} from '@/index';

const GIB = 1024 ** 3;

function seededStore(bytes: Uint8Array): { store: CloudRoaring; sizeBytes: number } {
  const cold = new MemoryColdChunkSource();
  cold.seed({ segment: 's', chunkKey: 0 }, bytes);
  const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
  return { store, sizeBytes: bytes.length };
}

describe('estimateCost (planning)', () => {
  it('at-rest, low-QPS is win-big and dominated by storage', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1.2e9 }] }); // ~1.2 GB, no traffic
    expect(r.verdict).toBe('win-big');
    expect(r.assumptions.grounded).toBe(false); // K6: sizes were supplied, not measured
    // storage = 1.2e9 / GiB * $0.023/GiB-mo
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((1.2e9 / GIB) * 0.023, 6);
    expect(r.monthlyUSD.total).toBeLessThan(AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD * 0.1);
  });

  it('K4: small data + high write QPS is the lose-zone', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { writesPerSec: 100 }, // well past the ~26/s crossover
    });
    expect(r.verdict).toBe('lose-zone');
    expect(r.monthlyUSD.total).toBeGreaterThan(AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD);
    expect(r.rationale).toMatch(/write/i);
  });

  it('write crossover matches the verified ~26 writes/sec (8 KiB items, Topology-B)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { avgItemKiB: 8 },
    });
    expect(r.redisCrossover.writesPerSec).toBeGreaterThan(25);
    expect(r.redisCrossover.writesPerSec).toBeLessThan(27);
  });

  it('read crossover matches the verified ~329 reads/sec (Topology-A, cold S3 GET)', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'A' });
    expect(r.redisCrossover.readsPerSec).toBeGreaterThan(320);
    expect(r.redisCrossover.readsPerSec).toBeLessThan(340);
  });

  it('K5: a provisioned Warm profile (flat, wruPerMillion=0) removes the write crossover', () => {
    const provisioned: PricingProfile = {
      ...AWS_US_EAST_1_ONDEMAND,
      warm: { ...AWS_US_EAST_1_ONDEMAND.warm, wruPerMillion: 0 },
    };
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      pricing: provisioned,
      workload: { writesPerSec: 1000 },
    });
    expect(r.redisCrossover.writesPerSec).toBe(Infinity);
    expect(r.monthlyUSD.byOp.writes).toBe(0); // no per-write charge under a flat tier
  });

  it('derives rough bytes from cardinality when no sizeBytes given (2 B/value)', () => {
    const r = estimateCost({ segments: [{ cardinality: 1_000_000 }] });
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((2_000_000 / GIB) * 0.023, 6);
  });
});

describe('costReport (grounded)', () => {
  it('K1: grounded storage cost matches a direct byte count of the real .crbm size', async () => {
    const { store, sizeBytes } = seededStore(SafeBitmap.fromValues([1, 2, 3, 500_000]).serialize());
    const r = await store.segment('s').costReport();
    expect(r.assumptions.grounded).toBe(true); // K6
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((sizeBytes / GIB) * 0.023, 9);
    expect(r.monthlyUSD.total).toBeCloseTo(r.monthlyUSD.byOp.storage, 9); // no workload → storage only
  });

  it('K2: estimateCost and costReport agree when fed identical inputs', async () => {
    const bytes = SafeBitmap.fromValues([1, 2, 3, 9, 77, 100_000]).serialize();
    const { store, sizeBytes } = seededStore(bytes);
    const workload = { readsPerSec: 50, writesPerSec: 3, cacheHitRate: 0.5 };

    const grounded = await store.segment('s').costReport({ topology: 'B', workload });
    const planned = estimateCost({ segments: [{ sizeBytes }], topology: 'B', workload });

    expect(grounded.monthlyUSD).toEqual(planned.monthlyUSD);
    expect(grounded.redisCrossover).toEqual(planned.redisCrossover);
    expect(grounded.verdict).toBe(planned.verdict);
    // Only the provenance flag differs.
    expect(grounded.assumptions.grounded).toBe(true);
    expect(planned.assumptions.grounded).toBe(false);
  });

  it('a segment with no Cold generation reports zero storage (grounded)', async () => {
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
    });
    const r = await store.segment('empty').costReport();
    expect(r.assumptions.grounded).toBe(true);
    expect(r.monthlyUSD.byOp.storage).toBe(0);
  });

  it('a custom cold source without sizeOf() → grounded:false + a note, not a false $0', async () => {
    class NoSizeCold implements ColdChunkSource {
      // Minimal impl — omitting the unused params still satisfies the interface.
      async getChunk(): Promise<Uint8Array | null> {
        return null;
      }
      async listChunkKeys(): Promise<number[]> {
        return [];
      }
    }
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold: new NoSizeCold() });
    const r = await store.segment('x').costReport();
    expect(r.assumptions.grounded).toBe(false); // storage was NOT measured — don't claim a confident $0
    expect(r.monthlyUSD.byOp.storage).toBe(0);
    expect(r.assumptions.notes.some((n) => n.includes('sizeOf'))).toBe(true);
  });

  it('L7: grounded size flows through CrbmColdChunkSource from the .crbm index', async () => {
    const driver = new MemoryColdDriver();
    const { size } = await writeCrbmGeneration(driver, { segment: 'g', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3, 400_000]) },
    ]);
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(driver),
    });
    const r = await store.segment('g').costReport();
    expect(r.assumptions.grounded).toBe(true);
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((size / GIB) * 0.023, 9);
  });
});

describe('cost model — additional coverage (5b review)', () => {
  it('M4: Topology A charges $0 for writes and bills reads to cold; B bills warm', () => {
    const workload = { readsPerSec: 100, writesPerSec: 10 };
    const a = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'A', workload });
    const b = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'B', workload });
    expect(a.monthlyUSD.byOp.writes).toBe(0); // A has no per-op writes (bulk-load path)
    expect(b.monthlyUSD.byOp.writes).toBeGreaterThan(0);
    // A reads bill S3 GET (4e-7); B reads bill warm RRU (2.5e-7) → A read cost > B read cost.
    expect(a.monthlyUSD.byOp.reads).toBeGreaterThan(b.monthlyUSD.byOp.reads);
  });

  it('M6: byTier sums to total, and byOp partitions into the right tiers per topology', () => {
    for (const topology of ['A', 'B'] as const) {
      const r = estimateCost({
        segments: [{ sizeBytes: 5e8 }],
        topology,
        workload: {
          readsPerSec: 100,
          writesPerSec: 10,
          intersectsPerSec: 2,
          chunksPerIntersect: 3,
        },
      });
      const { byTier, byOp, total } = r.monthlyUSD;
      // byTier sum === total catches tier misallocation (byTier is built separately from byOp — not an identity).
      expect(byTier.hot + byTier.warm + byTier.cold).toBeCloseTo(total, 9);
      expect(byTier.hot).toBe(0);
      if (topology === 'A') {
        // A: reads are cold S3 GETs and there are no per-op writes → everything but writes is cold.
        expect(byOp.writes).toBe(0);
        expect(byTier.warm).toBe(0);
        expect(byTier.cold).toBeCloseTo(byOp.storage + byOp.reads + byOp.intersects, 9);
      } else {
        // B: reads + writes are warm; storage + intersects are cold.
        expect(byTier.warm).toBeCloseTo(byOp.reads + byOp.writes, 9);
        expect(byTier.cold).toBeCloseTo(byOp.storage + byOp.intersects, 9);
      }
    }
  });

  it('M5: read crossover scales with cache-hit rate; 100% hits → Infinity', () => {
    const base = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'B' }); // cacheHitRate 0
    const cached = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { cacheHitRate: 0.8 },
    });
    expect(cached.redisCrossover.readsPerSec).toBeCloseTo(base.redisCrossover.readsPerSec / 0.2, 0);
    const allHits = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { cacheHitRate: 1 },
    });
    expect(allHits.redisCrossover.readsPerSec).toBe(Infinity);
  });

  it('L8: eventually-consistent reads halve warm read cost (double the read crossover)', () => {
    const ec: PricingProfile = {
      ...AWS_US_EAST_1_ONDEMAND,
      warm: { ...AWS_US_EAST_1_ONDEMAND.warm, stronglyConsistent: false },
    };
    const sc = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'B' });
    const eventually = estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'B', pricing: ec });
    expect(eventually.redisCrossover.readsPerSec).toBeCloseTo(sc.redisCrossover.readsPerSec * 2, 0);
  });

  it('L9: the intersection path bills cold fetches (chunks × GET)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'A',
      workload: { intersectsPerSec: 10, chunksPerIntersect: 4 },
    });
    // 10/s × 4 chunks × $0.40/M GET × 2.628e6 s/mo
    expect(r.monthlyUSD.byOp.intersects).toBeCloseTo(10 * 4 * (0.4 / 1e6) * 2_628_000, 6);
    expect(r.rationale).toMatch(/intersection/i);
  });

  it('L10: count multiplies segment bytes (and count:0 contributes nothing)', () => {
    const one = estimateCost({ segments: [{ sizeBytes: 1e8 }] });
    const three = estimateCost({ segments: [{ sizeBytes: 1e8, count: 3 }] });
    expect(three.monthlyUSD.byOp.storage).toBeCloseTo(one.monthlyUSD.byOp.storage * 3, 9);
    const none = estimateCost({ segments: [{ sizeBytes: 1e8, count: 0 }] });
    expect(none.monthlyUSD.byOp.storage).toBe(0);
  });

  it('rejects non-finite / negative inputs (fail-fast, no NaN report)', () => {
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 0 }], workload: { readsPerSec: NaN } }),
    ).toThrow(ValidationError);
    expect(() => estimateCost({ segments: [{ sizeBytes: -1 }] })).toThrow(ValidationError);
  });

  it('rejects a malformed pricing profile too (rates are a boundary input)', () => {
    const badRate: PricingProfile = {
      ...AWS_US_EAST_1_ONDEMAND,
      cold: { ...AWS_US_EAST_1_ONDEMAND.cold, getPerMillion: NaN },
    };
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 0 }], topology: 'A', pricing: badRate }),
    ).toThrow(ValidationError);
    // A zero-KiB read unit would divide to Infinity — must be rejected, not silently produce Infinity $.
    const zeroUnit: PricingProfile = {
      ...AWS_US_EAST_1_ONDEMAND,
      warm: { ...AWS_US_EAST_1_ONDEMAND.warm, readUnitKiB: 0 },
    };
    expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], pricing: zeroUnit })).toThrow(
      ValidationError,
    );
  });
});

describe('compaction cost term (gap #10)', () => {
  const P = AWS_US_EAST_1_ONDEMAND;

  it('defaults to 0 and discloses the omission when compaction is not modeled', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1e9 }] });
    expect(r.monthlyUSD.byOp.compaction).toBe(0);
    expect(r.assumptions.notes.some((n) => /Compaction is NOT modeled/.test(n))).toBe(true);
  });

  it('adds the whole-generation re-read + PUT when compactionsPerMonth is set', () => {
    const coldBytes = 8 * 1024 * 100; // 100 chunks at the default 8 KiB avg ⇒ chunksPerCompaction derives to 100
    const r = estimateCost({
      segments: [{ sizeBytes: coldBytes }],
      workload: { compactionsPerMonth: 10 },
    });
    const coldGetUSD = P.cold.getPerMillion / 1e6;
    const putUSD = P.cold.putPerMillion / 1e6;
    const expected = 10 * (100 * coldGetUSD + putUSD);
    expect(r.monthlyUSD.byOp.compaction).toBeCloseTo(expected, 9);
    expect(r.monthlyUSD.total).toBeCloseTo(r.monthlyUSD.byOp.storage + expected, 9); // no other traffic
    expect(r.monthlyUSD.byTier.cold).toBeCloseTo(r.monthlyUSD.byOp.storage + expected, 9);
    expect(r.assumptions.notes.some((n) => /Compaction modeled/.test(n))).toBe(true);
  });

  it('includes the Warm-purge term and can dominate the verdict', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 8 * 1024 * 100_000 }], // 100k chunks
      workload: { compactionsPerMonth: 1000, dirtyChunksPerCompaction: 10 },
    });
    expect(r.monthlyUSD.byOp.compaction).toBeGreaterThan(r.monthlyUSD.byOp.storage);
    expect(r.rationale).toMatch(/compaction/);
  });

  it('rejects a negative compaction workload input', () => {
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 1 }], workload: { compactionsPerMonth: -1 } }),
    ).toThrow(ValidationError);
    expect(() =>
      estimateCost({ segments: [{ sizeBytes: 1 }], workload: { chunksPerCompaction: -5 } }),
    ).toThrow(ValidationError);
  });

  it('validates pricing.cold.putPerMillion (now consumed by the compaction term)', () => {
    const bad: PricingProfile = { ...P, cold: { ...P.cold, putPerMillion: -1 } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 1 }], pricing: bad })).toThrow(
      ValidationError,
    );
  });

  it('routes the Warm-purge term to byTier.warm, isolated from the cold re-read', () => {
    const coldBytes = 8 * 1024 * 10; // 10 chunks at the default 8 KiB avg
    const r = estimateCost({
      segments: [{ sizeBytes: coldBytes }],
      topology: 'B',
      workload: { compactionsPerMonth: 100, dirtyChunksPerCompaction: 5 },
    });
    const coldGetUSD = P.cold.getPerMillion / 1e6;
    const putUSD = P.cold.putPerMillion / 1e6;
    const rruMult = P.warm.stronglyConsistent ? 1 : 0.5;
    const warmReadUSD =
      Math.max(1, Math.ceil(8 / P.warm.readUnitKiB)) * rruMult * (P.warm.rruPerMillion / 1e6);
    const warmWriteUSD =
      Math.max(1, Math.ceil(8 / P.warm.writeUnitKiB)) * (P.warm.wruPerMillion / 1e6);
    const coldPart = 100 * (10 * coldGetUSD + putUSD);
    const warmPart = 100 * 5 * (warmReadUSD + warmWriteUSD);
    expect(warmPart).toBeGreaterThan(0); // sanity: the isolated term is non-trivial
    expect(r.monthlyUSD.byOp.compaction).toBeCloseTo(coldPart + warmPart, 9);
    // Topology B with no read/write traffic ⇒ the warm tier is EXACTLY the purge part; the re-read + PUT are cold.
    expect(r.monthlyUSD.byTier.warm).toBeCloseTo(warmPart, 9);
    expect(r.monthlyUSD.byTier.cold).toBeCloseTo(r.monthlyUSD.byOp.storage + coldPart, 9);
  });
});

// ---------------------------------------------------------------------------------------------------
// `advisories` — the SELF-relative check (Phase 9). `verdict` only ever compares against the flat Redis
// baseline, so a workload can beat Redis by 40x and still be ~100x more expensive than this same library
// would charge for the same outcome — and the verdict alone calls that `win-big` and says nothing. That
// blind spot is what this exists to close, so the tests below pin BOTH directions: it must fire on the
// pathological shape, and it must stay silent everywhere else (an advisory that cries wolf gets ignored,
// which is strictly worse than not having one).
// ---------------------------------------------------------------------------------------------------
describe('cost advisories (self-relative, not vs Redis)', () => {
  const P = AWS_US_EAST_1_ONDEMAND;
  const CHUNKS = 65_536; // 16-bit chunk key
  const MONTH = 730 * 3600;

  /** A 10M-id segment written one id at a time — the shape the docs call the trap. */
  const loopy = () =>
    estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'B',
      workload: { writesPerSec: 10_000_000 / MONTH },
    });

  it('fires `batchable-writes` on the id-at-a-time shape', () => {
    const r = loopy();
    const a = r.advisories.find((x) => x.code === 'batchable-writes');
    expect(a).toBeDefined();
    expect(a?.currentUSD).toBeGreaterThan(a?.batchedFloorUSD as number);
    expect(a?.message).toMatch(/addMany/);
  });

  // The whole point. Without this assertion the feature could regress to "verdict says win-big, silence".
  it('fires even when the verdict is `win-big` — the blind spot it closes', () => {
    // 1M writes/mo ⇒ ~$5/mo, comfortably ≤10% of the $346 Redis line ⇒ `win-big` … while still rewriting each
    // Warm row ~15x. Exactly the case where the Redis-relative verdict says "great" and means nothing.
    const r = estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'B',
      workload: { writesPerSec: 1_000_000 / MONTH },
    });
    expect(r.verdict).toBe('win-big');
    expect(r.monthlyUSD.total).toBeLessThan(P.redis.monthlyUSD * 0.1);
    expect(r.advisories.map((a) => a.code)).toContain('batchable-writes');
  });

  it('the floor is a floor: one write per Warm row at the modeled item size', () => {
    const r = loopy();
    const a = r.advisories.find((x) => x.code === 'batchable-writes');
    const warmWriteUSD =
      Math.max(1, Math.ceil(8 / P.warm.writeUnitKiB)) * (P.warm.wruPerMillion / 1e6);
    // cardinality 10M > CHUNK_COUNT, so the bound saturates at the id-space cap.
    expect(a?.batchedFloorUSD).toBeCloseTo(CHUNKS * warmWriteUSD, 9);
  });

  it('stays silent when writes already sit at ~one per Warm row', () => {
    const r = estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'B',
      workload: { writesPerSec: CHUNKS / MONTH }, // ratio 1 — nothing to amortize
    });
    expect(r.advisories).toEqual([]);
  });

  it('stays silent on Topology A — bulk-load IS the batched path, and there are no per-op writes', () => {
    const r = estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'A',
      workload: { writesPerSec: 10_000_000 / MONTH },
    });
    expect(r.monthlyUSD.byOp.writes).toBe(0);
    expect(r.advisories).toEqual([]);
  });

  it('stays silent with no write traffic at all', () => {
    const r = estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'B',
      workload: { readsPerSec: 500 },
    });
    expect(r.advisories).toEqual([]);
  });

  // Guards BATCHABLE_MIN_SAVINGS_USD: a high ratio on a tiny bill is not worth interrupting anyone for.
  it('stays silent when the ratio is high but the money is pennies', () => {
    const r = estimateCost({
      segments: [{ cardinality: 100 }], // bound = 100 rows
      topology: 'B',
      workload: { writesPerSec: 100_000 / MONTH }, // ratio 1,000x — but ~$0.08/mo
    });
    expect(r.monthlyUSD.byOp.writes).toBeLessThan(1);
    expect(r.advisories).toEqual([]);
  });

  // The bound must be an UPPER bound on Warm rows. Understating it invents false positives on workloads that
  // are already optimal; a small segment can only occupy `cardinality` rows, never CHUNK_COUNT.
  it('tightens the bound by declared cardinality rather than always assuming the full id space', () => {
    const small = estimateCost({
      segments: [{ cardinality: 1_000 }],
      topology: 'B',
      workload: { writesPerSec: 1_000_000 / MONTH },
    });
    const a = small.advisories.find((x) => x.code === 'batchable-writes');
    expect(a?.message).toMatch(/1,000 Warm rows/);
  });

  it('scales the bound across a fleet (per-segment rows x count)', () => {
    const r = estimateCost({
      segments: [{ cardinality: 1_000, count: 10 }],
      topology: 'B',
      workload: { writesPerSec: 10_000_000 / MONTH },
    });
    const a = r.advisories.find((x) => x.code === 'batchable-writes');
    expect(a?.message).toMatch(/10,000 Warm rows/); // 1,000 x 10
  });

  it('is empty (not undefined) on an unremarkable report, so consumers can iterate unconditionally', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1024 }] });
    expect(Array.isArray(r.advisories)).toBe(true);
    expect(r.advisories).toEqual([]);
  });

  it('never changes the dollar figures it comments on', () => {
    const withAdv = loopy();
    const same = estimateCost({
      segments: [{ cardinality: 10_000_000 }],
      topology: 'B',
      workload: { writesPerSec: 10_000_000 / MONTH },
    });
    expect(withAdv.monthlyUSD).toEqual(same.monthlyUSD);
    expect(withAdv.advisories.length).toBeGreaterThan(0);
  });
});
