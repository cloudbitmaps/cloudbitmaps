import {
  CloudRoaring,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  DEFAULT_PRICING,
  MemoryStorageDriver,
  CrbmStorageChunkSource,
  createBackend,
  writeCrbmGeneration,
  SafeBitmap,
  ValidationError,
  type PricingProfile,
  type StorageChunkSource,
  type Workload,
} from '@/index';
import { ObjectStoreRegistry } from '@/drivers/_shared/object-registry';
import { CountingObjectStore, counting } from '../helpers/counting';
import { seededStore } from '../helpers/loaded';

/**
 * The cost model of a loaded store. There is no per-id write term any more — data arrives only as a
 * generation, so the write side is `loads` (object PUTs) and the only crossover that exists is the read one.
 */

const GIB = 1024 ** 3;
const P = AWS_US_EAST_1_ONDEMAND;
const SECONDS_PER_MONTH = 730 * 3600; // 2,628,000 — the research's convention

describe('DEFAULT_PRICING', () => {
  // It survived the export curation on the argument that a caller clones and tweaks it for their own
  // region — and it was the one kept export with no test at all.
  //
  // The first version of this block mostly restated JavaScript: that an alias equals its target, that `??`
  // falls back, that a spread copies. Those cannot fail for the reason the block exists. Every number below
  // is HAND-MAINTAINED from published cloud pricing, and a stale or fat-fingered edit to any of them changes
  // every estimate this library produces while every other test stays green — so the profile is pinned
  // WHOLE. That is also the assertion that fails loudest when a price is deliberately updated, which is when
  // someone should be looking at it.
  it('is the exact published rate card, every field pinned', () => {
    // The identity matters as much as the values: `AWS_US_EAST_1_ONDEMAND` is `const P`, which the ~40
    // assertions in the rest of this file compute against. Re-point `DEFAULT_PRICING` at a fresh literal with
    // the same numbers and every other test here would still pass while the two silently diverged.
    expect(DEFAULT_PRICING).toBe(AWS_US_EAST_1_ONDEMAND);
    expect(DEFAULT_PRICING).toEqual({
      name: 'aws-us-east-1-ondemand',
      storage: { getPerMillion: 0.4, putPerMillion: 5.0, storagePerGiBMonth: 0.023 },
      redis: { monthlyUSD: 346 },
    });
  });

  it('is the profile `estimateCost` falls back to, and the fallback is not vacuous', () => {
    const input = { segments: [{ sizeBytes: 1.2e9 }], workload: { readsPerSec: 10 } };
    expect(estimateCost(input)).toEqual(estimateCost({ ...input, pricing: DEFAULT_PRICING }));
    // `??` would satisfy the line above against ANY profile, so prove the default actually reaches the
    // arithmetic: a profile with different rates must produce a different answer.
    const dearer: PricingProfile = {
      ...DEFAULT_PRICING,
      name: 'dearer',
      storage: { ...DEFAULT_PRICING.storage, getPerMillion: 40 },
    };
    expect(estimateCost({ ...input, pricing: dearer })).not.toEqual(estimateCost(input));
  });
});

/** All these ids live in chunk 0 (they are < 65,536), so the segment is exactly one serialized bitmap. */
const ONE_CHUNK_IDS = [1, 2, 3, 9, 77];
/** Bytes that one chunk holds — derived independently of the store, so it is a real cross-check. */
const ONE_CHUNK_BYTES = SafeBitmap.fromValues(ONE_CHUNK_IDS).serialize().length;

describe('estimateCost (planning)', () => {
  it('at-rest, low-QPS is win-big and dominated by storage', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1.2e9 }] }); // ~1.2 GB, no traffic
    expect(r.verdict).toBe('win-big');
    expect(r.assumptions.grounded).toBe(false); // sizes were supplied, not measured
    // storage = 1.2e9 / GiB * $0.023/GiB-mo
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((1.2e9 / GIB) * 0.023, 6);
    expect(r.monthlyUSD.total).toBeLessThan(P.redis.monthlyUSD * 0.1);
  });

  it('sustained read QPS past the crossover is the lose-zone', () => {
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

  it('read crossover matches the verified ~329 reads/sec (storage S3 GET, no cache)', () => {
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
  it('grounded storage cost matches a direct byte count of the real chunk payload', async () => {
    const { store } = seededStore({ s: ONE_CHUNK_IDS });
    const r = await store.segment('s').costReport();
    expect(r.assumptions.grounded).toBe(true); // measured, not supplied
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((ONE_CHUNK_BYTES / GIB) * 0.023, 9);
    expect(r.monthlyUSD.total).toBeCloseTo(r.monthlyUSD.byOp.storage, 9); // no workload → storage only
  });

  it('estimateCost and costReport agree when fed identical inputs', async () => {
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

  it('a segment with no Storage generation reports zero storage (grounded)', async () => {
    const { store } = seededStore();
    const r = await store.segment('empty').costReport();
    expect(r.assumptions.grounded).toBe(true);
    expect(r.monthlyUSD.byOp.storage).toBe(0);
  });

  it('a custom storage source without sizeOf() → grounded:false + a note, not a false $0', async () => {
    class NoSizeStorage implements StorageChunkSource {
      // Minimal impl — omitting the unused params still satisfies the interface.
      async getChunk(): Promise<Uint8Array | null> {
        return null;
      }
      async listChunkKeys(): Promise<number[]> {
        return [];
      }
    }
    const store = new CloudRoaring({ storage: new NoSizeStorage() });
    const r = await store.segment('x').costReport();
    expect(r.assumptions.grounded).toBe(false); // storage was NOT measured — don't claim a confident $0
    expect(r.monthlyUSD.byOp.storage).toBe(0);
    expect(r.assumptions.notes.some((n) => n.includes('sizeOf'))).toBe(true);
  });

  it('grounded size flows through CrbmStorageChunkSource from the .crbm index', async () => {
    const driver = new MemoryStorageDriver();
    const { size } = await writeCrbmGeneration(driver, { segment: 'g', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3, 400_000]) },
    ]);
    const store = new CloudRoaring({ storage: new CrbmStorageChunkSource(driver) });
    const r = await store.segment('g').costReport();
    expect(r.assumptions.grounded).toBe(true);
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((size / GIB) * 0.023, 9);
  });
});

describe('cost model — additional coverage (5b review)', () => {
  it('byOp partitions the total — every dollar is attributed to exactly one op', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 5e8 }],
      workload: {
        readsPerSec: 100,
        intersectsPerSec: 2,
        chunksPerIntersect: 3,
        loadsPerMonth: 50,
        hotSegments: 4,
      },
    });
    const { byOp, total } = r.monthlyUSD;
    expect(
      byOp.reads + byOp.intersects + byOp.storage + byOp.loads + byOp.pointerRefresh,
    ).toBeCloseTo(total, 9);
    // Every term is genuinely exercised, so the identity above is not passing on a bed of zeroes.
    for (const term of [
      byOp.reads,
      byOp.intersects,
      byOp.storage,
      byOp.loads,
      byOp.pointerRefresh,
    ]) {
      expect(term).toBeGreaterThan(0);
    }
  });

  it('read crossover scales with cache-hit rate; 100% hits → Infinity', () => {
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
      (P.redis.monthlyUSD - 1000 * 0.023) / (SECONDS_PER_MONTH * (P.storage.getPerMillion / 1e6)),
      6,
    );
  });

  it("the intersection path bills each operand's pointer and index, then the chunks (all GETs)", () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { intersectsPerSec: 10, chunksPerIntersect: 4 },
    });
    // 10/s × (4 chunks + 2 operands × a pointer and a tail read) × $0.40/M GET × 2.628e6 s/mo
    expect(r.monthlyUSD.byOp.intersects).toBeCloseTo(10 * (4 + 2 * 2) * (0.4 / 1e6) * 2_628_000, 6);
    expect(r.rationale).toMatch(/intersection/i);
    const threeWay = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { intersectsPerSec: 10, chunksPerIntersect: 4, operandsPerIntersect: 3 },
    });
    expect(threeWay.monthlyUSD.byOp.intersects).toBeCloseTo(
      10 * (4 + 2 * 3) * (0.4 / 1e6) * 2_628_000,
      6,
    );
    expect(r.assumptions.notes.some((n) => /priced cold/.test(n))).toBe(true);
  });

  it('count multiplies segment bytes (and count:0 contributes nothing)', () => {
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
      { operandsPerIntersect: -1 },
      { hotSegments: NaN },
      { genTtlMs: -1 },
      { genTtlMs: Infinity },
    ]) {
      expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], workload })).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a malformed pricing profile too (rates are a boundary input)', () => {
    const badGet: PricingProfile = { ...P, storage: { ...P.storage, getPerMillion: NaN } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], pricing: badGet })).toThrow(
      ValidationError,
    );
    // putPerMillion feeds the loads term, so it is a live rate — not decorative.
    const badPut: PricingProfile = { ...P, storage: { ...P.storage, putPerMillion: -1 } };
    expect(() => estimateCost({ segments: [{ sizeBytes: 1 }], pricing: badPut })).toThrow(
      ValidationError,
    );
    const badStorage: PricingProfile = {
      ...P,
      storage: { ...P.storage, storagePerGiBMonth: -0.01 },
    };
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
  const putUSD = P.storage.putPerMillion / 1e6;
  const getUSD = P.storage.getPerMillion / 1e6;
  /** What `store.load()` adds to the object's write: two listings and the pointer's PUT, and nine GETs. */
  const storeLoadUSD = 3 * putUSD + 9 * getUSD;

  it('is 0 and disclosed as not-modeled when loadsPerMonth is unset', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1e9 }] });
    expect(r.monthlyUSD.byOp.loads).toBe(0);
    expect(r.assumptions.notes.some((n) => /Loads are NOT modeled/.test(n))).toBe(true);
    expect(r.assumptions.notes.some((n) => /loadsPerMonth/.test(n))).toBe(true);
  });

  it("bills each load's object requests and what store.load() adds around them, once set", () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 1e9 }],
      workload: { loadsPerMonth: 1000 },
    });
    // requestsPerLoad defaults to 1: the object's single PUT.
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(1000 * (1 * putUSD + storeLoadUSD), 12);
    expect(r.monthlyUSD.total).toBeCloseTo(
      r.monthlyUSD.byOp.storage + 1000 * (putUSD + storeLoadUSD),
      12,
    );
    expect(r.assumptions.notes.some((n) => /Loads modeled/.test(n))).toBe(true);
    // $23.60 per million single-part loads at the default prices, as the docs say.
    expect(r.monthlyUSD.byOp.loads * 1000).toBeCloseTo(23.6, 9);
  });

  it('a multipart load bills its extra PUT-class requests (initiate + parts + complete)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1000, requestsPerLoad: 102 }, // a 100-part upload
    });
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(1000 * (102 * putUSD + storeLoadUSD), 12);
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(0.5286, 9); // still small money
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

// ---------------------------------------------------------------------------------------------------
// The pointer refresh. A long-lived reader trusts a segment's pointer for `cache.genTtlMs` (2 s by default) and
// then reads it again the next time it reads the segment — one GET per segment per TTL, for as long as the segment
// is read. For one segment that is $0.53 a month; for a thousand kept hot, more than the Redis-HA line itself. It
// defaults to not modeled, and is disclosed, like loads: the model cannot know how many segments stay hot.
// ---------------------------------------------------------------------------------------------------
describe('pointer refresh cost term', () => {
  const getUSD = P.storage.getPerMillion / 1e6;

  it('is 0 unless hotSegments is set, and says so when there are reads to refresh for', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }], workload: { readsPerSec: 1 } });
    expect(r.monthlyUSD.byOp.pointerRefresh).toBe(0);
    expect(r.assumptions.notes.some((n) => /pointer refresh is NOT modeled/.test(n))).toBe(true);
    // Nothing read, nothing to refresh: no note.
    const idle = estimateCost({ segments: [{ sizeBytes: 0 }] });
    expect(idle.assumptions.notes.some((n) => /pointer refresh/i.test(n))).toBe(false);
  });

  it('bills one GET per hot segment per genTtlMs, 2 s by default', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }], workload: { hotSegments: 1 } });
    // 2,628,000 s / 2 s = 1,314,000 GETs a month.
    expect(r.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(1_314_000 * getUSD, 12);
    expect(r.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(0.5256, 9);
    const thousand = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000 },
    });
    expect(thousand.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(525.6, 6);
    expect(thousand.verdict).toBe('lose-zone');
    expect(thousand.rationale).toMatch(/pointer refresh/);
    const minute = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, genTtlMs: 60_000 },
    });
    expect(minute.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(525.6 / 30, 6);
  });

  it('bills nothing for a pinned pointer (genTtlMs 0), which is read once and never again', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, genTtlMs: 0 },
    });
    expect(r.monthlyUSD.byOp.pointerRefresh).toBe(0);
    expect(r.assumptions.notes.some((n) => /pins it/.test(n))).toBe(true);
  });

  it('lowers the read crossover by what the refresh already spends', () => {
    const quiet = estimateCost({ segments: [{ sizeBytes: 0 }] });
    const hot = estimateCost({ segments: [{ sizeBytes: 0 }], workload: { hotSegments: 100 } });
    expect(hot.redisCrossover.readsPerSec).toBeCloseTo(
      (P.redis.monthlyUSD - 100 * 1_314_000 * getUSD) / (SECONDS_PER_MONTH * getUSD),
      6,
    );
    expect(hot.redisCrossover.readsPerSec).toBeLessThan(quiet.redisCrossover.readsPerSec);
  });
});

// ---------------------------------------------------------------------------------------------------
// What the model counts is what the engine does. Each figure the estimator adds — two GETs an operand for a cold
// intersect, what `store.load()` adds to a load, one pointer read per hot segment per TTL — is held here to the
// requests the real engine makes over the real single-bucket registry protocol. The estimator once priced a load
// as the object's PUT alone and an intersect as its chunks alone, and a real-cloud run is what showed it; a count
// taken here moves with the engine instead.
//
// The prices are chosen so a dollar figure decodes to request counts: a GET costs $1 and a PUT-class request
// $1,000, so `1000 × PUTs + GETs` has one reading while there are fewer than a thousand GETs.
// ---------------------------------------------------------------------------------------------------
describe('the estimator counts the requests the engine makes', () => {
  const COUNTING: PricingProfile = {
    name: 'one-dollar-get',
    storage: { getPerMillion: 1e6, putPerMillion: 1e9, storagePerGiBMonth: 0 },
    redis: { monthlyUSD: 1e15 },
  };
  /** One of each operation a month: per-second rates of one a month. */
  const ONCE = 1 / SECONDS_PER_MONTH;
  const decode = (usd: number): { put: number; get: number } => {
    const rounded = Math.round(usd);
    expect(Math.abs(usd - rounded)).toBeLessThan(1e-6);
    return { put: Math.floor(rounded / 1000), get: rounded % 1000 };
  };
  const price = (workload: Workload) =>
    estimateCost({ segments: [{ sizeBytes: 0 }], workload, pricing: COUNTING }).monthlyUSD.byOp;
  /** The storage driver's calls that are requests; `capabilities()` is a local query, and sends nothing. */
  const requestsIn = (calls: Record<string, number>): string[] =>
    Object.keys(calls)
      .filter((k) => k !== 'capabilities')
      .sort();

  /** A single-bucket store over counting drivers: every storage call by name, and every pointer read and write. */
  function countingStore(options: ConstructorParameters<typeof CloudRoaring>[0] | object = {}) {
    const calls: Record<string, number> = {};
    const pointer = new CountingObjectStore(0);
    const storage = counting(new MemoryStorageDriver(), calls);
    const registry = new ObjectStoreRegistry(pointer, undefined, () => 0);
    const open = (extra: object = {}) =>
      new CloudRoaring({ storage: createBackend({ storage, registry }), ...options, ...extra });
    const reset = () => {
      for (const k of Object.keys(calls)) delete calls[k];
      pointer.reads = 0;
      pointer.writes = 0;
    };
    return { calls, pointer, open, reset };
  }

  it('prices a cold intersect at the GETs the engine makes: 2 an operand, then its shared chunks', async () => {
    const { calls, pointer, open, reset } = countingStore();
    // Three chunks shared, and a chunk of each segment's own that chunk-skipping never reads.
    const shared = [1, 65_537, 131_073];
    const loader = open();
    await loader.load({ segment: 'a' }, [...shared, 5 * 65_536]);
    await loader.load({ segment: 'b' }, [...shared, 7 * 65_536]);

    reset();
    const cold = open(); // a fresh store: nothing cached, every pointer and index read from storage
    const ids: number[] = [];
    for await (const id of cold.segment('a').intersect([cold.segment('b')])) ids.push(id);
    expect(ids).toEqual(shared);

    // Every storage request the intersect made is a read the model knows about: nothing uncounted.
    expect(requestsIn(calls)).toEqual(['getRange', 'getTail']);
    expect(pointer.writes).toBe(0);
    const chunkReads = calls.getRange ?? 0;
    expect(chunkReads).toBe(2 * shared.length); // chunk-skipping: the shared chunks, from each operand
    const engineGets = pointer.reads + (calls.getTail ?? 0) + chunkReads;

    const model = decode(
      price({ intersectsPerSec: ONCE, chunksPerIntersect: chunkReads }).intersects,
    );
    expect(model).toEqual({ put: 0, get: engineGets });
    expect(engineGets).toBe(4 + 2 * shared.length); // 4 + 2k
  });

  it('prices a load at the requests store.load() makes once a segment has two generations behind it', async () => {
    const { calls, pointer, open, reset } = countingStore();
    const store = open();
    const billed = async (ids: number[]): Promise<{ put: number; get: number }> => {
      reset();
      const result = await store.load({ segment: 's' }, ids);
      expect(result.published).toBe(true);
      // On S3 the object, the listings and the pointer bill as PUT-class; every read is a GET; a delete is free.
      const known = ['delete', 'getRange', 'getTail', 'list', 'putImmutable'];
      expect(requestsIn(calls).filter((k) => !known.includes(k))).toEqual([]);
      return {
        put: (calls.putImmutable ?? 0) + (calls.list ?? 0) + pointer.writes,
        get: pointer.reads + (calls.getTail ?? 0) + (calls.getRange ?? 0),
      };
    };
    const first = await billed([1, 2, 3]);
    const second = await billed([1, 2, 3, 4]);
    const third = await billed([1, 2, 3, 4, 5]);

    // A single-part object write is one PUT-class request: requestsPerLoad 1.
    const model = decode(price({ loadsPerMonth: 1, requestsPerLoad: 1 }).loads);
    expect(model).toEqual(third);
    // The earlier loads make fewer requests, never more: the model is their upper bound.
    for (const earlier of [first, second]) {
      expect(earlier.put).toBe(model.put);
      expect(earlier.get).toBeLessThan(model.get);
    }
  });

  it('prices the refresh at one pointer read per hot segment per genTtlMs, and none when pinned', async () => {
    const readFor = async (genTtlMs: number | undefined, durationMs: number): Promise<number> => {
      const { pointer, open, reset } = countingStore();
      await open().load({ segment: 'hot' }, [1, 2, 3]);
      let now = 0;
      const clock = {
        now: (): number => now,
        sleep: (ms: number): Promise<void> => {
          now += Math.max(0, ms);
          return Promise.resolve();
        },
        yieldNow: (): Promise<void> => Promise.resolve(),
      };
      const reader = open({
        seams: { clock },
        ...(genTtlMs === undefined ? {} : { cache: { genTtlMs } }),
      });
      reset();
      // Read the segment every 100 ms: often enough that every TTL that lapses is followed by a read.
      for (now = 0; now < durationMs; now += 100) {
        expect(await reader.segment('hot').has(2)).toBe(true);
      }
      return pointer.reads;
    };

    const DURATION_MS = 60_000;
    // The first read opens the segment; each 2 s after it, the next read re-reads the pointer.
    const byDefault = await readFor(undefined, DURATION_MS);
    expect(byDefault).toBe(DURATION_MS / 2000);
    // The model's rate is the engine's: reads per ms × ms in a month.
    const modelPerMonth = price({ hotSegments: 1 }).pointerRefresh;
    expect(modelPerMonth).toBeCloseTo((byDefault / DURATION_MS) * SECONDS_PER_MONTH * 1000, 6);

    const minute = await readFor(10_000, DURATION_MS);
    expect(minute).toBe(DURATION_MS / 10_000);
    expect(price({ hotSegments: 1, genTtlMs: 10_000 }).pointerRefresh).toBeCloseTo(
      (minute / DURATION_MS) * SECONDS_PER_MONTH * 1000,
      6,
    );

    // Pinned: the one read that opened it, and never another; the model bills no refresh.
    expect(await readFor(0, DURATION_MS)).toBe(1);
    expect(price({ hotSegments: 1, genTtlMs: 0 }).pointerRefresh).toBe(0);
  });
});
