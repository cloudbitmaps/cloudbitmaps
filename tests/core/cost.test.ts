import {
  CloudRoaring,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  MemoryColdDriver,
  CrbmColdChunkSource,
  writeCrbmGeneration,
  SafeBitmap,
  ValidationError,
  type PricingProfile,
  type ColdChunkSource,
} from '@/index';
import { seededStore } from '../helpers/loaded';

/**
 * The cost model of a loaded store. There is no per-id write term any more — data arrives only as a
 * generation, so the write side is `loads` (object PUTs) and the only crossover that exists is the read one.
 */

const GIB = 1024 ** 3;
const P = AWS_US_EAST_1_ONDEMAND;
const SECONDS_PER_MONTH = 730 * 3600; // 2,628,000 — the research's convention

/** All these ids live in chunk 0 (they are < 65,536), so the segment is exactly one serialized bitmap. */
const ONE_CHUNK_IDS = [1, 2, 3, 9, 77];
/** Bytes that one chunk holds — derived independently of the store, so it is a real cross-check. */
const ONE_CHUNK_BYTES = SafeBitmap.fromValues(ONE_CHUNK_IDS).serialize().length;

describe('estimateCost (planning)', () => {
  it('at-rest, low-QPS is win-big and dominated by storage', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1.2e9 }] }); // ~1.2 GB, no traffic
    expect(r.verdict).toBe('win-big');
    expect(r.assumptions.grounded).toBe(false); // K6: sizes were supplied, not measured
    // storage = 1.2e9 / GiB * $0.023/GiB-mo
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((1.2e9 / GIB) * 0.023, 6);
    expect(r.monthlyUSD.total).toBeLessThan(P.redis.monthlyUSD * 0.1);
  });

  it('K4: sustained read QPS past the crossover is the lose-zone', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { readsPerSec: 1000 }, // well past the ~329/s crossover
    });
    expect(r.verdict).toBe('lose-zone');
    expect(r.monthlyUSD.total).toBeGreaterThan(P.redis.monthlyUSD);
    expect(r.rationale).toMatch(/read/i);
  });

  it('the three verdict bands sit exactly on the 10% / 100% thresholds', () => {
    // Storage-only reports, so the total is a pure function of the byte count we choose.
    const bytesFor = (usd: number): number => (usd / 0.023) * GIB;
    const atTenPercent = estimateCost({ segments: [{ sizeBytes: bytesFor(34.6) }] });
    expect(atTenPercent.verdict).toBe('win-big'); // `<=` 10% is still win-big
    const justOver = estimateCost({ segments: [{ sizeBytes: bytesFor(34.7) }] });
    expect(justOver.verdict).toBe('win');
    const atBaseline = estimateCost({ segments: [{ sizeBytes: bytesFor(346) }] });
    expect(atBaseline.verdict).toBe('lose-zone'); // `< redis` is a win; equal is not
  });

  it('read crossover matches the verified ~329 reads/sec (cold S3 GET, no cache)', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }] });
    // 346 / (2,628,000 s/mo × $0.40/M GET) = 329.147… reads/s
    expect(r.redisCrossover.readsPerSec).toBeGreaterThanOrEqual(329);
    expect(r.redisCrossover.readsPerSec).toBeLessThan(330);
  });

  it('derives rough bytes from cardinality when no sizeBytes given (2 B/value)', () => {
    const r = estimateCost({ segments: [{ cardinality: 1_000_000 }] });
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((2_000_000 / GIB) * 0.023, 6);
  });
});

describe('costReport (grounded)', () => {
  it('K1: grounded storage cost matches a direct byte count of the real chunk payload', async () => {
    const { store } = seededStore({ s: ONE_CHUNK_IDS });
    const r = await store.segment('s').costReport();
    expect(r.assumptions.grounded).toBe(true); // K6
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((ONE_CHUNK_BYTES / GIB) * 0.023, 9);
    expect(r.monthlyUSD.total).toBeCloseTo(r.monthlyUSD.byOp.storage, 9); // no workload → storage only
  });

  it('K2: estimateCost and costReport agree when fed identical inputs', async () => {
    const { store } = seededStore({ s: ONE_CHUNK_IDS });
    const workload = { readsPerSec: 50, cacheHitRate: 0.5, loadsPerMonth: 30 };

    const grounded = await store.segment('s').costReport({ workload });
    const planned = estimateCost({ segments: [{ sizeBytes: ONE_CHUNK_BYTES }], workload });

    expect(grounded.monthlyUSD).toEqual(planned.monthlyUSD);
    expect(grounded.redisCrossover).toEqual(planned.redisCrossover);
    expect(grounded.verdict).toBe(planned.verdict);
    // Only the provenance flag differs.
    expect(grounded.assumptions.grounded).toBe(true);
    expect(planned.assumptions.grounded).toBe(false);
  });

  it('a segment with no Cold generation reports zero storage (grounded)', async () => {
    const { store } = seededStore();
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
    const store = new CloudRoaring({ cold: new NoSizeCold() });
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
    const store = new CloudRoaring({ cold: new CrbmColdChunkSource(driver) });
    const r = await store.segment('g').costReport();
    expect(r.assumptions.grounded).toBe(true);
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((size / GIB) * 0.023, 9);
  });
});

describe('cost model — additional coverage (5b review)', () => {
  it('M6: byOp partitions the total — every dollar is attributed to exactly one op', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 5e8 }],
      workload: {
        readsPerSec: 100,
        intersectsPerSec: 2,
        chunksPerIntersect: 3,
        loadsPerMonth: 50,
      },
    });
    const { byOp, total } = r.monthlyUSD;
    expect(byOp.reads + byOp.intersects + byOp.storage + byOp.loads).toBeCloseTo(total, 9);
    // Every term is genuinely exercised, so the identity above is not passing on a bed of zeroes.
    for (const term of [byOp.reads, byOp.intersects, byOp.storage, byOp.loads]) {
      expect(term).toBeGreaterThan(0);
    }
  });

  it('M5: read crossover scales with cache-hit rate; 100% hits → Infinity', () => {
    const base = estimateCost({ segments: [{ sizeBytes: 0 }] }); // cacheHitRate 0
    const cached = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { cacheHitRate: 0.8 },
    });
    expect(cached.redisCrossover.readsPerSec).toBeCloseTo(base.redisCrossover.readsPerSec / 0.2, 0);
    const allHits = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { cacheHitRate: 1 },
    });
    expect(allHits.redisCrossover.readsPerSec).toBe(Infinity);
  });

  it('the crossover is net of fixed storage — a big at-rest footprint lowers it', () => {
    const empty = estimateCost({ segments: [{ sizeBytes: 0 }] });
    const heavy = estimateCost({ segments: [{ sizeBytes: 1000 * GIB }] }); // $23/mo of storage
    expect(heavy.redisCrossover.readsPerSec).toBeLessThan(empty.redisCrossover.readsPerSec);
    expect(heavy.redisCrossover.readsPerSec).toBeCloseTo(
      (P.redis.monthlyUSD - 1000 * 0.023) / (SECONDS_PER_MONTH * (P.cold.getPerMillion / 1e6)),
      6,
    );
  });

  it('L9: the intersection path bills cold fetches (chunks × GET)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
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
    expect(() => estimateCost({ segments: [{ cardinality: -1 }] })).toThrow(ValidationError);
    expect(() => estimateCost({ segments: [{ sizeBytes: 1, count: -2 }] })).toThrow(
      ValidationError,
    );
    for (const workload of [
      { intersectsPerSec: Infinity },
      { chunksPerIntersect: -1 },
      { loadsPerMonth: -1 },
      { requestsPerLoad: NaN },
      { cacheHitRate: -0.5 },
    ]) {
      expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], workload })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a malformed pricing profile too (rates are a boundary input)', () => {
    const badGet: PricingProfile = { ...P, cold: { ...P.cold, getPerMillion: NaN } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], pricing: badGet })).toThrow(
      ValidationError,
    );
    // putPerMillion feeds the loads term, so it is a live rate — not decorative.
    const badPut: PricingProfile = { ...P, cold: { ...P.cold, putPerMillion: -1 } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 1 }], pricing: badPut })).toThrow(
      ValidationError,
    );
    const badStorage: PricingProfile = { ...P, cold: { ...P.cold, storagePerGiBMonth: -0.01 } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 1 }], pricing: badStorage })).toThrow(
      ValidationError,
    );
    // A NaN baseline would make the verdict meaningless rather than merely wrong.
    const badRedis: PricingProfile = { ...P, redis: { monthlyUSD: NaN } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 1 }], pricing: badRedis })).toThrow(
      ValidationError,
    );
  });

  it('discloses what it does and does not model, and which rate card produced the numbers', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1024 }] });
    expect(r.assumptions.pricingName).toBe('aws-us-east-1-ondemand');
    expect(r.assumptions.notes.some((n) => /egress/i.test(n))).toBe(true);
    expect(r.assumptions.notes.some((n) => /workload rates/i.test(n))).toBe(true);
    const custom = estimateCost({
      segments: [{ sizeBytes: 1024 }],
      pricing: { ...P, name: 'my-gcs-committed' },
    });
    expect(custom.assumptions.pricingName).toBe('my-gcs-committed');
  });
});

// ---------------------------------------------------------------------------------------------------
// `loads` — the write side of a loaded store. Data enters only as a published generation, so the only
// write-shaped charge is the object PUT that a load issues. It defaults to 0 (unknowable from segment
// sizes alone) and the report DISCLOSES the omission, because a silent $0 write line on a store whose
// only write path is a load would read as "writes are free" rather than "writes were not modeled".
// ---------------------------------------------------------------------------------------------------
describe('loads cost term', () => {
  const putUSD = P.cold.putPerMillion / 1e6;

  it('is 0 and disclosed as not-modeled when loadsPerMonth is unset', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1e9 }] });
    expect(r.monthlyUSD.byOp.loads).toBe(0);
    expect(r.assumptions.notes.some((n) => /Loads are NOT modeled/.test(n))).toBe(true);
    expect(r.assumptions.notes.some((n) => /loadsPerMonth/.test(n))).toBe(true);
  });

  it('bills loadsPerMonth × requestsPerLoad × the PUT rate once set', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 1e9 }],
      workload: { loadsPerMonth: 1000 },
    });
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(1000 * 1 * putUSD, 12); // requestsPerLoad defaults to 1
    expect(r.monthlyUSD.total).toBeCloseTo(r.monthlyUSD.byOp.storage + 1000 * putUSD, 12);
    expect(r.assumptions.notes.some((n) => /Loads modeled/.test(n))).toBe(true);
  });

  it('a multipart load bills its extra PUT-class requests (initiate + parts + complete)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1000, requestsPerLoad: 102 }, // a 100-part upload
    });
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(1000 * 102 * putUSD, 12);
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(0.51, 6); // still small money, as the docs claim
  });

  it('loads never move the read crossover — the crossover is a read-rate question', () => {
    const quiet = estimateCost({ segments: [{ sizeBytes: 0 }] });
    const loading = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1_000_000 },
    });
    expect(loading.redisCrossover).toEqual(quiet.redisCrossover);
  });

  it('can dominate the verdict when a store is re-loaded pathologically often', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 1e6 }],
      workload: { loadsPerMonth: 100_000_000 }, // ~38 loads/sec — a load is not an update
    });
    expect(r.monthlyUSD.byOp.loads).toBeGreaterThan(r.monthlyUSD.byOp.storage);
    expect(r.verdict).toBe('lose-zone');
    expect(r.rationale).toMatch(/loads/i);
  });
});
