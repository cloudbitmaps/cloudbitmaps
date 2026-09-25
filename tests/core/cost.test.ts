import {
  CloudRoaring,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  DEFAULT_PRICING,
  ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
  ONE_REDIS_HA_CLUSTER,
  MemoryStorageDriver,
  CrbmStorageChunkSource,
  createBackend,
  writeCrbmGeneration,
  SafeBitmap,
  ValidationError,
  type CostReport,
  type PricingProfile,
  type RedisSizing,
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
/** The default rates against one Redis-HA cluster, whatever the data size: the arithmetic of the verdict, alone. */
const FLAT: PricingProfile = { ...P, redis: ONE_REDIS_HA_CLUSTER };
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
      redis: { sizedToData: ELASTICACHE_REDIS_US_EAST_1_ONDEMAND },
    });
    expect(AWS_US_EAST_1_ONDEMAND.redis).toEqual({
      sizedToData: ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
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

// ---------------------------------------------------------------------------------------------------
// Redis sized to the data. The verdict used to compare every workload with one $346 cluster, which is the wrong
// size in both directions: 200 MB fits a node a tenth of its price, and 2 TB does not fit it at all. The default now
// prices the cheapest ElastiCache cluster that holds the stored bytes, from AWS's price list. The expected figures
// below are worked by hand from that price list, not by the code under test.
// ---------------------------------------------------------------------------------------------------
describe('Redis sized to the data', () => {
  const HOURS = 730;
  const MONTH = (nodes: number, hourlyUSD: number): number => nodes * hourlyUSD * HOURS;
  const GET_USD = P.storage.getPerMillion / 1e6;
  /** The point-read rate whose GETs cost `usd` a month, with no cache. */
  const readsFor = (usd: number): number => usd / (SECONDS_PER_MONTH * GET_USD);
  const report = (sizeBytes: number, pricing?: PricingProfile, workload?: Workload) =>
    estimateCost({
      segments: [{ sizeBytes }],
      ...(pricing ? { pricing } : {}),
      ...(workload ? { workload } : {}),
    });
  const baselineFor = (sizeBytes: number, pricing?: PricingProfile) =>
    report(sizeBytes, pricing).redisBaseline;
  /** The cluster a sized baseline priced. A fixed one has none, and that is a failure here. */
  const clusterOf = (b: CostReport['redisBaseline']) => {
    if (b.basis !== 'sized-to-data') throw new Error(`expected a sized baseline, got ${b.basis}`);
    return b.cluster;
  };
  /** The Redis note, which comes last so the notes a report already carried keep their places. */
  const redisNote = (r: CostReport): string => r.assumptions.notes.at(-1) ?? '';
  const catalogue = (
    nodeTypes: RedisSizing['nodeTypes'],
    over: Partial<RedisSizing> = {},
  ): PricingProfile => ({
    ...P,
    redis: {
      sizedToData: {
        source: 'test',
        replicasPerShard: 2,
        reservedMemoryFraction: 0.25,
        nodeTypes,
        ...over,
      },
    },
  });

  it('is the exact sourced catalogue, every row pinned', () => {
    // Hand-maintained from AWS's price list: a fat-fingered price moves every verdict while everything else passes.
    expect(ELASTICACHE_REDIS_US_EAST_1_ONDEMAND).toEqual({
      source: 'ElastiCache for Redis OSS, us-east-1 on-demand, AWS price list 20260914063714',
      replicasPerShard: 2,
      reservedMemoryFraction: 0.25,
      nodeTypes: [
        { name: 'cache.t4g.micro', memoryGiB: 0.5, hourlyUSD: 0.016, maxShards: 1 },
        { name: 'cache.t4g.small', memoryGiB: 1.37, hourlyUSD: 0.032, maxShards: 1 },
        { name: 'cache.t4g.medium', memoryGiB: 3.09, hourlyUSD: 0.065, maxShards: 1 },
        { name: 'cache.m6g.large', memoryGiB: 6.38, hourlyUSD: 0.149 },
        { name: 'cache.r6g.large', memoryGiB: 13.07, hourlyUSD: 0.206 },
        { name: 'cache.r6g.xlarge', memoryGiB: 26.32, hourlyUSD: 0.411 },
        { name: 'cache.r6g.2xlarge', memoryGiB: 52.82, hourlyUSD: 0.821 },
        { name: 'cache.r6g.4xlarge', memoryGiB: 105.81, hourlyUSD: 1.642 },
        { name: 'cache.r6g.8xlarge', memoryGiB: 209.55, hourlyUSD: 3.284 },
        { name: 'cache.r6g.12xlarge', memoryGiB: 317.77, hourlyUSD: 4.925 },
        { name: 'cache.r6g.16xlarge', memoryGiB: 419.09, hourlyUSD: 6.567 },
        { name: 'cache.r6gd.xlarge', memoryGiB: 26.32, ssdGiB: 99.33, hourlyUSD: 0.781 },
        { name: 'cache.r6gd.2xlarge', memoryGiB: 52.82, ssdGiB: 199.07, hourlyUSD: 1.56 },
        { name: 'cache.r6gd.4xlarge', memoryGiB: 105.81, ssdGiB: 398.14, hourlyUSD: 3.12 },
        { name: 'cache.r6gd.8xlarge', memoryGiB: 209.55, ssdGiB: 796.28, hourlyUSD: 6.24 },
        { name: 'cache.r6gd.12xlarge', memoryGiB: 317.77, ssdGiB: 1194.42, hourlyUSD: 9.358 },
        { name: 'cache.r6gd.16xlarge', memoryGiB: 419.09, ssdGiB: 1592.56, hourlyUSD: 12.477 },
      ],
    });
    // Frozen all the way down: a caller who mutates the shared default would move every other caller's verdicts.
    expect(Object.isFrozen(ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes[0])).toBe(true);
    expect(Object.isFrozen(AWS_US_EAST_1_ONDEMAND)).toBe(true);
    expect(Object.isFrozen(AWS_US_EAST_1_ONDEMAND.storage)).toBe(true);
    expect(Object.isFrozen(AWS_US_EAST_1_ONDEMAND.redis)).toBe(true);
    // This file is an ES module, so strict: the change throws rather than landing.
    expect(() => {
      (AWS_US_EAST_1_ONDEMAND as { redis: unknown }).redis = { monthlyUSD: 1 };
    }).toThrow(TypeError);
  });

  it('keeps the one-cluster anchor fixed at $346, which is not what the catalogue prices', () => {
    // 3 × cache.m7g.large at $0.158 an hour: the cluster behind the published crossover and the calibration.
    expect(ONE_REDIS_HA_CLUSTER).toEqual({ monthlyUSD: 346 });
    expect(Math.round(MONTH(3, 0.158))).toBe(346);
    // At 5 GB, which that cluster holds, the catalogue finds a cheaper one.
    expect(baselineFor(5e9).monthlyUSD).toBeLessThan(346);
  });

  it.each([
    // [label, bytes, node type, shards, nodes, hourly] — worked by hand: usable = memory × 0.75 (+ SSD).
    ['an empty store at the smallest cluster, not at none', 0, 'cache.t4g.micro', 1, 3, 0.016],
    ['200 MB on one burstable micro', 200e6, 'cache.t4g.micro', 1, 3, 0.016],
    // 1.2 GiB is more than a t4g.small leaves free (1.03 GiB), and a burstable node is priced as one shard.
    ['1.2 GiB on a t4g.medium', 1.2 * GIB, 'cache.t4g.medium', 1, 3, 0.065],
    // 4.66 GiB fits the 4.79 GiB an m6g.large leaves free.
    ['5 GB on an m6g.large', 5e9, 'cache.m6g.large', 1, 3, 0.149],
    // 18.63 GiB fits the 19.74 GiB of one r6g.xlarge; two shards of r6g.large would be $902.28, $2.19 more.
    ['20 GB on one r6g.xlarge shard', 20e9, 'cache.r6g.xlarge', 1, 3, 0.411],
    // 1,862.6 GiB fits one r6gd.16xlarge shard's 1,906.9 GiB of memory and SSD.
    ['2 TB on one data-tiering shard', 2e12, 'cache.r6gd.16xlarge', 1, 3, 12.477],
  ])('prices %s', (_label, bytes, nodeType, shards, nodes, hourly) => {
    const b = baselineFor(bytes);
    expect(clusterOf(b)).toEqual({ nodeType, shards, nodes, dataTiering: /r6gd/.test(nodeType) });
    expect(b.monthlyUSD).toBeCloseTo(MONTH(nodes, hourly), 9);
  });

  it('prices 2 TB all in memory at 95 shards of r6g.xlarge, when the catalogue has no data tiering', () => {
    const inMemory = catalogue(
      ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes.filter((n) => n.ssdGiB === undefined),
    );
    const b = baselineFor(2e12, inMemory);
    // 1,862.6 GiB over 19.74 GiB a shard is 94.4, so 95 shards and 285 nodes: $85,508.55, where eight shards of
    // r6g.12xlarge would be $86,286.00.
    expect(clusterOf(b)).toEqual({
      nodeType: 'cache.r6g.xlarge',
      shards: 95,
      nodes: 285,
      dataTiering: false,
    });
    expect(b.monthlyUSD).toBeCloseTo(MONTH(285, 0.411), 9);
    // Past a thousand, the words carry separators, as every page that quotes them does.
    // 50 TB all in memory is 587 shards of r6g.4xlarge: 46,566 GiB over the 79.36 GiB each leaves free.
    expect(redisNote(report(50e12, inMemory))).toContain(
      '587 shards, 1,761 cache.r6g.4xlarge nodes',
    );
  });

  it('is the cheapest in the catalogue that holds the data, and does hold it', () => {
    const { nodeTypes, reservedMemoryFraction, replicasPerShard } =
      ELASTICACHE_REDIS_US_EAST_1_ONDEMAND;
    const sizes = [
      0,
      1e6,
      3e8,
      1.1 * GIB,
      2.5 * GIB,
      4.7 * GIB,
      9 * GIB,
      40 * GIB,
      300 * GIB,
      5000 * GIB,
    ];
    for (const bytes of sizes) {
      const gib = bytes / GIB;
      const b = baselineFor(bytes);
      const cluster = clusterOf(b);
      const row = nodeTypes.find((n) => n.name === cluster.nodeType);
      if (row === undefined)
        throw new Error(`priced a node type not in the catalogue: ${cluster.nodeType}`);
      const usable = row.memoryGiB * (1 - reservedMemoryFraction) + (row.ssdGiB ?? 0);
      expect(cluster.shards * usable).toBeGreaterThanOrEqual(gib - 1e-9);
      expect(cluster.nodes).toBe(cluster.shards * (1 + replicasPerShard));
      expect(cluster.dataTiering).toBe(row.ssdGiB !== undefined);
      // Brute force: no row, at any shard count that holds the data, is cheaper.
      for (const n of nodeTypes) {
        const u = n.memoryGiB * (1 - reservedMemoryFraction) + (n.ssdGiB ?? 0);
        const need = Math.max(1, Math.ceil(gib / u));
        if (n.maxShards !== undefined && need > n.maxShards) continue;
        expect(MONTH(need * (1 + replicasPerShard), n.hourlyUSD)).toBeGreaterThanOrEqual(
          b.monthlyUSD - 1e-9,
        );
      }
    }
  });

  it('never prices more data at a cheaper Redis', () => {
    let last = 0;
    for (let bytes = 1e5; bytes < 1e13; bytes *= 1.37) {
      const usd = baselineFor(bytes).monthlyUSD;
      expect(usd).toBeGreaterThanOrEqual(last);
      last = usd;
    }
  });

  it('does not charge a shard to rounding when the data is an exact multiple of what a node holds', () => {
    // 0.6 GiB less a quarter is 0.45 GiB, and 2.25 GiB is five of those — which floating point divides to
    // 5.000000000000001, and a plain ceiling rounds to six.
    const pricing = catalogue([{ name: 'n', memoryGiB: 0.6, hourlyUSD: 1 }], {
      replicasPerShard: 0,
    });
    expect(clusterOf(baselineFor(2.25 * GIB, pricing))).toMatchObject({ shards: 5, nodes: 5 });
    // A byte more does need the sixth.
    expect(clusterOf(baselineFor(2.25 * GIB + 1, pricing))).toMatchObject({ shards: 6, nodes: 6 });
  });

  it('is what the verdict, the rationale and the crossover are measured against', () => {
    // The medium deployment of the sizing guide: 20 GB, one cold intersect a second, and the rest.
    const r = estimateCost({
      segments: [{ sizeBytes: 4_000_000, count: 5_000 }],
      workload: {
        intersectsPerSec: 1,
        chunksPerIntersect: 200,
        readsPerSec: 50,
        cacheHitRate: 0.8,
        loadsPerMonth: 150_000,
        hotSegments: 200,
        readerProcesses: 3,
      },
    });
    expect(r.redisBaseline.monthlyUSD).toBeCloseTo(MONTH(3, 0.411), 9);
    expect(r.verdict).toBe('win'); // $281 against $900, where one $346 cluster made it 81%
    expect(r.rationale).toContain(
      'under the $900.09/mo Redis that would hold 18.63 GiB (1 shard of 3 cache.r6g.xlarge nodes)',
    );
    // Where the two baselines disagree: 2 TB at rest is 12% of one cluster, but 0.16% of the Redis that holds it.
    expect(report(2e12).verdict).toBe('win-big');
    expect(report(2e12, FLAT).verdict).toBe('win');
    const fixedCosts = r.monthlyUSD.byOp.storage + r.monthlyUSD.byOp.pointerRefresh;
    expect(r.redisCrossover.readsPerSec).toBeCloseTo(
      (MONTH(3, 0.411) - fixedCosts) / (SECONDS_PER_MONTH * GET_USD * 0.2),
      6,
    );
  });

  it('draws the win / lose-zone line at the sized Redis, in both directions', () => {
    // 20 GB: its Redis is $900.09. $500 of reads is a win against it, and a lose-zone against one cluster.
    const mid = { readsPerSec: readsFor(500) };
    expect(report(20e9, undefined, mid).verdict).toBe('win');
    expect(report(20e9, FLAT, mid).verdict).toBe('lose-zone');
    // 200 MB: its Redis is $35.04. $100 of reads is a lose-zone against it, and a win against one cluster.
    const small = { readsPerSec: readsFor(100) };
    const r = report(200e6, undefined, small);
    expect(r.verdict).toBe('lose-zone');
    expect(r.rationale).toContain(
      'exceeds the $35.04/mo Redis that would hold 190.73 MiB (1 shard of 3 cache.t4g.micro nodes)',
    );
    expect(report(200e6, FLAT, small).verdict).toBe('win');
  });

  it('says what it priced, how, and which way the pricing leans', () => {
    const note = redisNote(report(20e9));
    for (const words of [
      'cheapest cluster in the catalogue that holds the 18.63 GiB stored',
      '1 shard of 3 cache.r6g.xlarge nodes',
      'each shard a primary and 2 replica(s)',
      '25% of memory reserved',
      '(ElastiCache for Redis OSS, us-east-1 on-demand, AWS price list 20260914063714)',
      // Two leanings, one each way: the bytes are a floor on Redis's memory, and the price a ceiling on its bill.
      'a floor on the memory Redis needs',
      'can cost less than the catalogue prices it',
    ]) {
      expect(note).toContain(words);
    }
    expect(note).not.toMatch(/data-tiering|cardinality|no bytes are counted/);
    const tiered = redisNote(report(2e12));
    expect(tiered).toContain('cache.r6gd.16xlarge is a data-tiering node');
    expect(tiered).toContain('regularly read up to 20% of their data');
  });

  it("describes a caller's own catalogue in its own terms", () => {
    const sizedToData: RedisSizing = {
      source: 'my rates',
      replicasPerShard: 1,
      reservedMemoryFraction: 0.1,
      nodeTypes: [
        { name: 'plain', memoryGiB: 1, ssdGiB: 0, hourlyUSD: 1 },
        { name: 'tiered', memoryGiB: 1, ssdGiB: 10, hourlyUSD: 5 },
      ],
    };
    const pricing: PricingProfile = { ...P, redis: { sizedToData } };
    const note = (gib: number, p = pricing): string => redisNote(report(gib * GIB, p));
    // 2 GiB: plain leaves 0.9 GiB a node, so 3 shards and 6 nodes at $4,380; tiered would be 2 nodes at $7,300.
    const two = note(2);
    expect(two).toContain('3 shards, 6 plain nodes');
    expect(two).toContain('a primary and 1 replica(s), 10% of memory reserved (my rates)');
    expect(two).not.toMatch(/data-tiering/); // ssdGiB: 0 is not a data-tiering node
    expect(clusterOf(report(2 * GIB, pricing).redisBaseline).dataTiering).toBe(false);
    // 20 GiB: plain needs 46 nodes ($33,580); tiered holds 10.9 GiB a node, so 2 shards and 4 nodes ($14,600).
    expect(note(20)).toContain('tiered is a data-tiering node');
    const single: PricingProfile = {
      ...P,
      redis: { sizedToData: { ...sizedToData, replicasPerShard: 0 } },
    };
    expect(note(0.5, single)).toContain('1 shard of 1 plain node,');
  });

  it('says a reserve in the precision it was given', () => {
    const pricing = catalogue([{ name: 'n', memoryGiB: 1, hourlyUSD: 1 }], {
      reservedMemoryFraction: 0.004,
    });
    expect(redisNote(report(1e6, pricing))).toContain('0.4% of memory reserved');
  });

  it('says when a size came from cardinality, which can overstate the Redis', () => {
    const fromCardinality = redisNote(estimateCost({ segments: [{ cardinality: 1_000_000 }] }));
    expect(fromCardinality).toContain('holds the 1.91 MiB stored');
    expect(fromCardinality).toContain('Some segment sizes came from cardinality, at 2 bytes an id');
    const measured = redisNote(estimateCost({ segments: [{ sizeBytes: 2e6 }] }));
    expect(measured).not.toContain('cardinality');
    // A spec counted zero times sizes nothing, so it cannot have overstated anything.
    const uncounted = redisNote(
      estimateCost({ segments: [{ sizeBytes: 2e6 }, { cardinality: 1e6, count: 0 }] }),
    );
    expect(uncounted).not.toContain('cardinality');
    // Nor can a cardinality of zero, which sizes nothing either.
    expect(redisNote(estimateCost({ segments: [{ cardinality: 0 }] }))).not.toContain(
      'cardinality',
    );
  });

  it('says when it had no bytes to size to, in the rationale as well as the note', () => {
    const none = report(0, undefined, { readsPerSec: readsFor(100) });
    expect(redisNote(none)).toContain(
      'as no bytes are counted, because nothing is stored or nothing was measured',
    );
    // Not "the Redis that would hold 0 bytes", as if that were a measurement.
    expect(none.rationale).toContain(
      'exceeds the $35.04/mo cheapest Redis cluster in the catalogue, as no bytes are counted',
    );
    expect(none.rationale).not.toContain('would hold');
    // Less than a byte rounds to none, and says so; a byte does not.
    expect(redisNote(report(0.4))).toContain('as no bytes are counted');
    expect(redisNote(report(1))).not.toContain('no bytes are counted');
    // A fixed baseline was not sized to anything, so it has nothing to say about the bytes.
    expect(redisNote(report(0, FLAT))).not.toContain('no bytes are counted');
  });

  it('says a size in the unit it fills, rounded before the unit is chosen', () => {
    expect(redisNote(report(1))).toContain('holds the 1 byte stored');
    expect(redisNote(report(20))).toContain('holds the 20 bytes stored');
    expect(redisNote(report(1023.6))).toContain('holds the 1.00 KiB stored');
    expect(redisNote(report(1_048_575))).toContain('holds the 1.00 MiB stored');
    expect(redisNote(report(2e12))).toContain('holds the 1.82 TiB stored');
  });

  it('keeps a fixed baseline as given, whatever the data size, in the words it always had', () => {
    for (const bytes of [0, 20e9, 2e12]) {
      expect(baselineFor(bytes, FLAT)).toStrictEqual({ basis: 'fixed', monthlyUSD: 346 });
    }
    expect(report(0, FLAT).rationale).toContain('≤10% of the $346/mo baseline');
    const own: PricingProfile = { ...P, redis: { monthlyUSD: 1000 } };
    const r = report(0, own, { readsPerSec: readsFor(500) });
    expect(r.redisBaseline).toStrictEqual({ basis: 'fixed', monthlyUSD: 1000 });
    expect(r.verdict).toBe('win'); // $500 against $1,000, where it is a lose-zone against $346
    expect(r.redisCrossover.readsPerSec).toBeCloseTo(readsFor(1000), 6);
    expect(r.rationale).toContain('under the $1000/mo baseline');
    expect(report(0, own, { readsPerSec: readsFor(1500) }).rationale).toContain(
      'exceeds the $1000/mo flat baseline',
    );
    expect(redisNote(r)).toBe('Redis priced at the fixed $1000/mo given, whatever the data size.');
  });

  it('prices a burstable node as one shard, and says so when nothing in the catalogue holds the data', () => {
    const burst = (maxShards?: number) =>
      catalogue([
        { name: 'burst', memoryGiB: 1.37, hourlyUSD: 0.032, ...(maxShards ? { maxShards } : {}) },
      ]);
    expect(() => baselineFor(2 * GIB, burst(1))).toThrow(/no node type .* holds 2\.00 GiB/);
    // A size too small for GiB is said in the unit it fills here too.
    const tiny = catalogue([{ name: 'tiny', memoryGiB: 1e-6, hourlyUSD: 1, maxShards: 1 }]);
    expect(() => baselineFor(1e6, tiny)).toThrow(/holds 976\.56 KiB within its maxShards/);
    expect(clusterOf(baselineFor(2 * GIB, burst()))).toEqual({
      nodeType: 'burst',
      shards: 2,
      nodes: 6,
      dataTiering: false,
    });
  });

  it('breaks a price tie on nodes whatever order the catalogue lists the rows in', () => {
    const one = { name: 'one-gib', memoryGiB: 1, hourlyUSD: 1 };
    const two = { name: 'two-gib', memoryGiB: 2, hourlyUSD: 2 };
    for (const nodeTypes of [
      [one, two],
      [two, one],
    ]) {
      for (const replicasPerShard of [0, 1]) {
        // Two shards of one-gib or one of two-gib: the same price, and fewer nodes wins it.
        const b = baselineFor(
          2 * GIB,
          catalogue(nodeTypes, { replicasPerShard, reservedMemoryFraction: 0 }),
        );
        expect(clusterOf(b)).toEqual({
          nodeType: 'two-gib',
          shards: 1,
          nodes: 1 + replicasPerShard,
          dataTiering: false,
        });
        expect(b.monthlyUSD).toBeCloseTo(MONTH(1 + replicasPerShard, 2), 9);
      }
    }
    // A tie reached by different roundings is still a tie: 0.1 × 3 is not 0.3 in floating point.
    const rounded = catalogue(
      [
        { name: 'thirds', memoryGiB: 1, hourlyUSD: 0.1 },
        { name: 'whole', memoryGiB: 3, hourlyUSD: 0.3 },
      ],
      { replicasPerShard: 0, reservedMemoryFraction: 0 },
    );
    expect(clusterOf(baselineFor(3 * GIB, rounded)).nodeType).toBe('whole');
    // A chain of near-ties is judged against the cheapest, not against whichever row led so far: A is the cheapest,
    // B is within a millionth of a dollar of it with fewer nodes, and C is just past the tolerance.
    const A = { name: 'A', memoryGiB: 1, hourlyUSD: 100 / (6 * HOURS) };
    const B = { name: 'B', memoryGiB: 2, hourlyUSD: 100.0000009 / (3 * HOURS) };
    const C = { name: 'C', memoryGiB: 6, hourlyUSD: 100.0000018 / HOURS };
    const orders = [
      [A, B, C],
      [A, C, B],
      [B, A, C],
      [B, C, A],
      [C, A, B],
      [C, B, A],
    ];
    for (const rows of orders) {
      const flat = catalogue(rows, { replicasPerShard: 0, reservedMemoryFraction: 0 });
      expect(clusterOf(baselineFor(6 * GIB, flat)).nodeType).toBe('B');
    }
    // An exact tie in price and nodes goes by name, so whether the answer tiers to SSD does not depend on the order.
    const plain = { name: 'plain', memoryGiB: 10, hourlyUSD: 1 };
    const tiered = { name: 'tiered', memoryGiB: 2, ssdGiB: 8, hourlyUSD: 1 };
    for (const rows of [
      [plain, tiered],
      [tiered, plain],
    ]) {
      const flat = catalogue(rows, { replicasPerShard: 0, reservedMemoryFraction: 0 });
      expect(clusterOf(baselineFor(5 * GIB, flat))).toMatchObject({
        nodeType: 'plain',
        dataTiering: false,
      });
    }
  });

  it('prices the catalogue it validated, reading each value once', () => {
    // A row whose price reads valid for validation and negative afterwards would price a cluster below zero.
    let reads = 0;
    const shifty = {
      name: 'shifty',
      memoryGiB: 10,
      get hourlyUSD() {
        reads += 1;
        return reads === 1 ? 1 : -5;
      },
    };
    const b = baselineFor(1e6, catalogue([shifty], { replicasPerShard: 0 }));
    expect(b.monthlyUSD).toBeCloseTo(MONTH(1, 1), 9);
    expect(reads).toBe(1);
  });

  it('reads a shape wherever its value comes from', () => {
    // A price reached through a getter, a prototype or a Proxy is given, and so is one beside an undefined sizedToData.
    const shapes = [
      new (class {
        get monthlyUSD() {
          return 346;
        }
      })(),
      Object.create(ONE_REDIS_HA_CLUSTER) as { monthlyUSD: number },
      new Proxy({}, { get: (_t, key) => (key === 'monthlyUSD' ? 346 : undefined) }),
      { monthlyUSD: 346, sizedToData: undefined },
    ];
    for (const redis of shapes) {
      const pricing = { ...P, redis } as unknown as PricingProfile;
      expect(baselineFor(5e9, pricing)).toStrictEqual({ basis: 'fixed', monthlyUSD: 346 });
    }
  });

  it('refuses a Redis given both ways, or neither, rather than silently dropping a figure', () => {
    // The idiom for "compare with my cluster" before sizing: spread the default's redis and set a price.
    const both = { ...P, redis: { ...P.redis, monthlyUSD: 500 } } as PricingProfile;
    expect(() => baselineFor(20e9, both)).toThrow(
      /exactly one of \{ monthlyUSD \} and \{ sizedToData \}, not both: spreading AWS_US_EAST_1_ONDEMAND\.redis keeps its sizedToData, so pass redis: \{ monthlyUSD \} alone/,
    );
    for (const redis of [{}, null, 346]) {
      const neither = { ...P, redis } as unknown as PricingProfile;
      expect(() => baselineFor(20e9, neither)).toThrow(ValidationError);
    }
    // A key set to undefined gives nothing, so a Redis made only of such keys is neither shape.
    for (const redis of [{ sizedToData: undefined }, { monthlyUSD: undefined }]) {
      const pricing = { ...P, redis } as unknown as PricingProfile;
      expect(() => baselineFor(1e6, pricing)).toThrow(
        /exactly one of \{ monthlyUSD \} and \{ sizedToData \}$/,
      );
    }
    // A price that is there but is not a number is refused as the price it claims to be.
    const nullPrice = { ...P, redis: { monthlyUSD: null } } as unknown as PricingProfile;
    expect(() => baselineFor(1e6, nullPrice)).toThrow(/monthlyUSD must be a finite number/);
  });

  it('refuses a catalogue it cannot price honestly, each bad row by name', () => {
    const base = ELASTICACHE_REDIS_US_EAST_1_ONDEMAND;
    const good = { name: 'good', memoryGiB: 1, hourlyUSD: 1 };
    const cases: Array<[unknown, RegExp]> = [
      [null, /sizedToData must be a RedisSizing/],
      [{ ...base, source: '' }, /source must say where the prices come from/],
      [{ ...base, source: undefined }, /source must say where the prices come from/],
      [{ ...base, nodeTypes: [] }, /nodeTypes must list at least one node type/],
      [{ ...base, nodeTypes: undefined }, /nodeTypes must list at least one node type/],
      [{ ...base, replicasPerShard: -1 }, /replicasPerShard must be an integer >= 0/],
      [{ ...base, replicasPerShard: 1.5 }, /replicasPerShard must be an integer >= 0/],
      [{ ...base, reservedMemoryFraction: 1 }, /reservedMemoryFraction must be below 1/],
      [{ ...base, reservedMemoryFraction: -0.1 }, /reservedMemoryFraction must be a finite/],
      [{ ...base, reservedMemoryFraction: NaN }, /reservedMemoryFraction must be a finite/],
      // A bad row beside a good one: refused for itself, not only when nothing is left to price.
      [{ ...base, nodeTypes: [good, { ...good, name: '' }] }, /every node type needs a name/],
      [{ ...base, nodeTypes: [good, { ...good, name: 7 }] }, /every node type needs a name/],
      [{ ...base, nodeTypes: [good, good] }, /\["good"\] is listed twice/],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', memoryGiB: 0 }] },
        /\["z"\]\.memoryGiB must be above 0/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', memoryGiB: Infinity }] },
        /\["z"\]\.memoryGiB must be a finite/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', ssdGiB: -1 }] },
        /\["z"\]\.ssdGiB must be a finite/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', hourlyUSD: NaN }] },
        /\["z"\]\.hourlyUSD must be a finite/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', maxShards: 0 }] },
        /\["z"\]\.maxShards must be an integer >= 1/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', maxShards: 1.5 }] },
        /\["z"\]\.maxShards must be an integer >= 1/,
      ],
      [
        { ...base, nodeTypes: [good, { ...good, name: 'z', maxShards: -1 }] },
        /\["z"\]\.maxShards must be an integer >= 1/,
      ],
    ];
    for (const [sizedToData, message] of cases) {
      const pricing = { ...P, redis: { sizedToData } } as unknown as PricingProfile;
      expect(() => baselineFor(1e6, pricing)).toThrow(ValidationError);
      expect(() => baselineFor(1e6, pricing)).toThrow(message);
    }
  });

  it('prices a grounded report against Redis sized to the segment it measured', async () => {
    const { store } = seededStore({ s: ONE_CHUNK_IDS });
    const r = await store.segment('s').costReport();
    expect(r.redisBaseline).toEqual(baselineFor(ONE_CHUNK_BYTES));
    expect(clusterOf(r.redisBaseline).nodeType).toBe('cache.t4g.micro');
  });
});

describe('estimateCost (planning)', () => {
  it('at-rest, low-QPS is win-big and dominated by storage', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 1.2e9 }] }); // ~1.2 GB, no traffic
    expect(r.verdict).toBe('win-big');
    expect(r.assumptions.grounded).toBe(false); // sizes were supplied, not measured
    // storage = 1.2e9 / GiB * $0.023/GiB-mo
    expect(r.monthlyUSD.byOp.storage).toBeCloseTo((1.2e9 / GIB) * 0.023, 6);
    expect(r.monthlyUSD.total).toBeLessThan(r.redisBaseline.monthlyUSD * 0.1);
  });

  it('sustained read QPS past the crossover is the lose-zone', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { readsPerSec: 1000 }, // well past the crossover
    });
    expect(r.verdict).toBe('lose-zone');
    expect(r.monthlyUSD.total).toBeGreaterThan(r.redisBaseline.monthlyUSD);
    expect(r.rationale).toMatch(/read/i);
  });

  it('the three verdict bands sit exactly on the 10% / 100% thresholds', () => {
    // Storage-only reports, so the total is a pure function of the byte count we choose.
    const bytesFor = (usd: number): number => (usd / 0.023) * GIB;
    // Against one cluster: sized to the data, the baseline would grow with the very bytes being varied.
    const flat = (usd: number) =>
      estimateCost({ segments: [{ sizeBytes: bytesFor(usd) }], pricing: FLAT });
    const atTenPercent = flat(34.6);
    expect(atTenPercent.verdict).toBe('win-big'); // `<=` 10% is still win-big
    const justOver = flat(34.7);
    expect(justOver.verdict).toBe('win');
    const atBaseline = flat(346);
    expect(atBaseline.verdict).toBe('lose-zone'); // `< redis` is a win; equal is not
  });

  it('read crossover matches the verified ~329 reads/sec against one cluster (storage S3 GET, no cache)', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }], pricing: FLAT });
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
    // Nor a confident Redis: sized to no bytes, it is the cheapest cluster there is, and the report says so.
    expect(r.assumptions.notes.at(-1)).toContain(
      'because nothing is stored or nothing was measured',
    );
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

  it('the crossover is net of fixed storage — against one cluster, a big at-rest footprint lowers it', () => {
    const empty = estimateCost({ segments: [{ sizeBytes: 0 }], pricing: FLAT });
    const heavy = estimateCost({ segments: [{ sizeBytes: 1000 * GIB }], pricing: FLAT }); // $23/mo of storage
    expect(heavy.redisCrossover.readsPerSec).toBeLessThan(empty.redisCrossover.readsPerSec);
    expect(heavy.redisCrossover.readsPerSec).toBeCloseTo(
      (ONE_REDIS_HA_CLUSTER.monthlyUSD - 1000 * 0.023) /
        (SECONDS_PER_MONTH * (P.storage.getPerMillion / 1e6)),
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
      { operandsPerIntersect: 0 }, // an intersection reads at least one segment
      { operandsPerIntersect: 0.5 },
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
// then reads it again the next time it reads the segment — at most one GET per segment per TTL, and only when a
// read comes. For one segment read around the clock that is $0.53 a month; for a thousand kept hot, more than the
// Redis-HA line itself. It defaults to not modeled, and is disclosed, like loads: the model cannot know how many
// segments stay hot, or in how many reader processes.
// ---------------------------------------------------------------------------------------------------
describe('pointer refresh cost term', () => {
  const getUSD = P.storage.getPerMillion / 1e6;

  it('is 0 unless hotSegments is set, and says so when there are reads to refresh for', () => {
    const r = estimateCost({ segments: [{ sizeBytes: 0 }], workload: { readsPerSec: 1 } });
    expect(r.monthlyUSD.byOp.pointerRefresh).toBe(0);
    expect(r.assumptions.notes.some((n) => /pointer refresh is NOT modeled/.test(n))).toBe(true);
    // Nothing read, nothing to refresh: no note. Intersections price their own pointer reads.
    for (const workload of [{}, { intersectsPerSec: 1 }]) {
      const quiet = estimateCost({ segments: [{ sizeBytes: 0 }], workload });
      expect(quiet.assumptions.notes.some((n) => /pointer refresh/i.test(n))).toBe(false);
    }
  });

  it('bills one GET per hot segment per genTtlMs, 2 s by default, when reads come that often', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1, readsPerSec: 10 },
    });
    // 2,628,000 s / 2 s = 1,314,000 GETs a month.
    expect(r.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(1_314_000 * getUSD, 12);
    expect(r.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(0.5256, 9);
    // Every read a cache hit, so the reads cost nothing and the refresh is what is left.
    const thousand = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, readsPerSec: 1000, cacheHitRate: 1 },
    });
    expect(thousand.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(525.6, 6);
    expect(thousand.verdict).toBe('lose-zone');
    expect(thousand.rationale).toMatch(/pointer refresh/);
    const minute = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, readsPerSec: 1000, genTtlMs: 60_000 },
    });
    expect(minute.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(525.6 / 30, 6);
    expect(minute.assumptions.notes).toContain(
      'Pointer refresh modeled: 1000 hot segment(s) in each of 1 reader process(es), each re-reading its pointer ' +
        'at most every 60000 ms, and at most once a point read.',
    );
  });

  it('multiplies by the reader processes, each of which refreshes on its own', () => {
    const one = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 100, readsPerSec: 10_000, cacheHitRate: 1 },
    });
    const fleet = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 100, readsPerSec: 10_000, cacheHitRate: 1, readerProcesses: 10 },
    });
    expect(fleet.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(
      10 * one.monthlyUSD.byOp.pointerRefresh,
      9,
    );
    expect(fleet.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(525.6, 6);
    // …and a fleet's reads are still the bound: ten processes cannot refresh more often than they read.
    const sparse = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 100, readsPerSec: 10, readerProcesses: 10 },
    });
    expect(sparse.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(10 * SECONDS_PER_MONTH * getUSD, 9);
    for (const readerProcesses of [0, 0.5, -1, NaN]) {
      expect(() =>
        estimateCost({
          segments: [{ sizeBytes: 0 }],
          workload: { hotSegments: 1, readerProcesses },
        }),
      ).toThrow(ValidationError);
    }
  });

  it('never bills more refreshes than there are point reads to make them', () => {
    // A thousand hot segments read once a second between them: each read after a lapsed TTL re-reads a pointer,
    // so the reads are the bound, not the segments.
    const sparse = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, readsPerSec: 1 },
    });
    expect(sparse.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(SECONDS_PER_MONTH * getUSD, 9);
    // No reads, no refresh — however many segments are called hot, and however short the TTL.
    const idle = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, genTtlMs: 0.001 },
    });
    expect(idle.monthlyUSD.byOp.pointerRefresh).toBe(0);
    expect(idle.verdict).toBe('win-big');
  });

  it('bills nothing for a pinned pointer (genTtlMs 0)', () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, readsPerSec: 1000, genTtlMs: 0 },
    });
    expect(r.monthlyUSD.byOp.pointerRefresh).toBe(0);
    expect(r.assumptions.notes).toContain(
      'Pointer refresh: none — genTtlMs 0 pins each pointer while the reader keeps the segment open.',
    );
  });

  it("warns when one reader's hot set is larger than a store keeps open by default", () => {
    const fits = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1024, readsPerSec: 10 },
    });
    expect(fits.assumptions.notes.some((n) => /keeps open by default/.test(n))).toBe(false);
    const spills = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1025, readsPerSec: 10 },
    });
    expect(spills.assumptions.notes.some((n) => /keeps open by default \(1024\)/.test(n))).toBe(
      true,
    );
    // Per reader: a fleet of processes that each keep 1,000 open fits, however large the fleet.
    const fleet = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 1000, readerProcesses: 20, readsPerSec: 10 },
    });
    expect(fleet.assumptions.notes.some((n) => /keeps open by default/.test(n))).toBe(false);
  });

  it('lowers the read crossover by what the refresh already spends', () => {
    const quiet = estimateCost({ segments: [{ sizeBytes: 0 }], pricing: FLAT });
    const hot = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { hotSegments: 100, readsPerSec: 100 },
      pricing: FLAT,
    });
    expect(hot.redisCrossover.readsPerSec).toBeCloseTo(
      (ONE_REDIS_HA_CLUSTER.monthlyUSD - 100 * 1_314_000 * getUSD) / (SECONDS_PER_MONTH * getUSD),
      6,
    );
    expect(hot.redisCrossover.readsPerSec).toBeLessThan(quiet.redisCrossover.readsPerSec);
  });
});

// ---------------------------------------------------------------------------------------------------
// GCS and Azure Blob read an object's metadata before its bytes, so a read that needs the size — a pointer read, a
// tail read — is two requests there. The driver tests pin those two requests against each SDK; this holds the
// model to them.
// ---------------------------------------------------------------------------------------------------
describe('requests per sized read', () => {
  const GCS_SHAPED: PricingProfile = { ...P, storage: { ...P.storage, requestsPerSizedRead: 2 } };
  const getUSD = P.storage.getPerMillion / 1e6;
  const putUSD = P.storage.putPerMillion / 1e6;

  it("doubles each operand's pointer and tail read, and leaves chunk reads alone", () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { intersectsPerSec: 1, chunksPerIntersect: 200 },
      pricing: GCS_SHAPED,
    });
    expect(r.monthlyUSD.byOp.intersects).toBeCloseTo(
      SECONDS_PER_MONTH * (200 + 2 * 2 * 2) * getUSD,
      6,
    );
    expect(r.assumptions.notes).toContain(
      'Intersections priced cold: 208 GETs each, 4 for each of 2 operand(s) plus 200 chunk read(s); ' +
        'cacheHitRate does not apply.',
    );
  });

  it("doubles a load's reads, and the refresh", () => {
    const r = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { loadsPerMonth: 1000, hotSegments: 1, readsPerSec: 10 },
      pricing: GCS_SHAPED,
    });
    expect(r.monthlyUSD.byOp.loads).toBeCloseTo(1000 * (4 * putUSD + 18 * getUSD), 12);
    expect(r.monthlyUSD.byOp.pointerRefresh).toBeCloseTo(2 * 1_314_000 * getUSD, 9);
  });

  it('is 1 by default, and refuses a malformed value', () => {
    const plain = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { intersectsPerSec: 1, chunksPerIntersect: 200 },
    });
    expect(plain.monthlyUSD.byOp.intersects).toBeCloseTo(SECONDS_PER_MONTH * 204 * getUSD, 6);
    for (const requestsPerSizedRead of [NaN, -1, Infinity]) {
      const pricing: PricingProfile = { ...P, storage: { ...P.storage, requestsPerSizedRead } };
      expect(() => estimateCost({ segments: [{ sizeBytes: 0 }], pricing })).toThrow(
        ValidationError,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// What the model counts is what the engine does. Each figure the estimator adds — two reads an operand for a cold
// intersect, what `store.load()` adds to a load, one pointer read per hot segment per TTL — is held here to the
// requests the real engine makes over the real single-bucket registry protocol, on S3's request shape (one request
// a read). The estimator once priced a load as the object's PUT alone and an intersect as its chunks alone, and a
// real-cloud run is what showed it; a count taken here moves with the engine instead.
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
  function countingStore() {
    const calls: Record<string, number> = {};
    const pointer = new CountingObjectStore(0);
    const storage = counting(new MemoryStorageDriver(), calls);
    const registry = new ObjectStoreRegistry(pointer, undefined, () => 0);
    const open = (extra: object = {}) =>
      new CloudRoaring({ storage: createBackend({ storage, registry }), ...extra });
    const reset = () => {
      for (const k of Object.keys(calls)) delete calls[k];
      pointer.reads = 0;
      pointer.writes = 0;
    };
    return { calls, pointer, open, reset };
  }

  /** A clock that moves only when told to. */
  function virtualClock() {
    const clock = {
      t: 0,
      now: (): number => clock.t,
      sleep: (ms: number): Promise<void> => {
        clock.t += Math.max(0, ms);
        return Promise.resolve();
      },
      yieldNow: (): Promise<void> => Promise.resolve(),
    };
    return clock;
  }

  it.each([
    ['two', ['a', 'b']],
    ['three', ['a', 'b', 'c']],
  ] as const)(
    'prices a cold %s-operand intersect at the GETs the engine makes: 2 an operand, then its shared chunks',
    async (_, names) => {
      const { calls, pointer, open, reset } = countingStore();
      // Three chunks every operand shares, and a chunk of each operand's own that chunk-skipping never reads.
      const shared = [1, 65_537, 131_073];
      const loader = open();
      for (const [i, name] of names.entries()) {
        await loader.load({ segment: name }, [...shared, (5 + i) * 65_536]);
      }

      reset();
      const cold = open(); // a fresh store: nothing cached, every pointer and index read from storage
      const [first, ...rest] = names.map((n) => cold.segment(n));
      const ids: number[] = [];
      for await (const id of first!.intersect(rest)) ids.push(id);
      expect(ids).toEqual(shared);

      // Every storage request the intersect made is a read the model knows about: nothing uncounted.
      expect(requestsIn(calls)).toEqual(['getRange', 'getTail']);
      expect(pointer.writes).toBe(0);
      const chunkReads = calls.getRange ?? 0;
      expect(chunkReads).toBe(names.length * shared.length); // chunk-skipping: the shared chunks, from each operand
      const engineGets = pointer.reads + (calls.getTail ?? 0) + chunkReads;

      const model = decode(
        price({
          intersectsPerSec: ONCE,
          chunksPerIntersect: chunkReads,
          operandsPerIntersect: names.length,
        }).intersects,
      );
      expect(model).toEqual({ put: 0, get: engineGets });
      expect(engineGets).toBe(2 * names.length + chunkReads);
    },
  );

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
    const fourth = await billed([1, 2, 3, 4, 5, 6]);

    // A single-part object write is one PUT-class request: requestsPerLoad 1.
    const model = decode(price({ loadsPerMonth: 1, requestsPerLoad: 1 }).loads);
    expect(model).toEqual(third);
    expect(fourth).toEqual(third); // the steady state: every load from the third on
    // The first two loads make two and one fewer reads, and the same PUT-class requests.
    expect(first).toEqual({ put: model.put, get: model.get - 2 });
    expect(second).toEqual({ put: model.put, get: model.get - 1 });
  });

  it('prices the refresh at one pointer read per hot segment per genTtlMs, and nothing else', async () => {
    const DURATION_MS = 60_000;
    /** Pointer reads and storage requests while one segment is read every `everyMs` for DURATION_MS. */
    const readFor = async (genTtlMs: number | undefined, everyMs: number) => {
      const { calls, pointer, open, reset } = countingStore();
      await open().load({ segment: 'hot' }, [1, 2, 3]);
      const clock = virtualClock();
      const reader = open({
        seams: { clock },
        ...(genTtlMs === undefined ? {} : { cache: { genTtlMs } }),
      });
      expect(await reader.segment('hot').has(2)).toBe(true); // opens it: a pointer read, a tail read
      reset();
      let reads = 0;
      for (clock.t = everyMs; clock.t <= DURATION_MS; clock.t += everyMs) {
        expect(await reader.segment('hot').has(2)).toBe(true);
        reads += 1;
      }
      // The refresh re-reads the pointer and nothing else: the index and the chunks stay cached.
      expect(requestsIn(calls)).toEqual([]);
      return { pointerReads: pointer.reads, reads };
    };
    /** The model's refresh over DURATION_MS, one hot segment, read `reads` times in it. */
    const modelled = (genTtlMs: number | undefined, reads: number): number =>
      (price({
        hotSegments: 1,
        readsPerSec: reads / (DURATION_MS / 1000),
        ...(genTtlMs === undefined ? {} : { genTtlMs }),
      }).pointerRefresh *
        DURATION_MS) /
      (SECONDS_PER_MONTH * 1000);

    // Read often enough that every lapsed TTL is followed by a read: the engine and the model agree exactly.
    const byDefault = await readFor(undefined, 100);
    expect(byDefault.pointerReads).toBe(DURATION_MS / 2000);
    expect(modelled(undefined, byDefault.reads)).toBeCloseTo(byDefault.pointerReads, 6);
    const tenSeconds = await readFor(10_000, 100);
    expect(tenSeconds.pointerReads).toBe(DURATION_MS / 10_000);
    expect(modelled(10_000, tenSeconds.reads)).toBeCloseTo(tenSeconds.pointerReads, 6);

    // At other cadences the model is an upper bound: never below what the engine makes.
    for (const everyMs of [1500, 2500, 3000, 7000]) {
      const run = await readFor(undefined, everyMs);
      expect(run.pointerReads).toBeLessThanOrEqual(run.reads);
      expect(modelled(undefined, run.reads)).toBeGreaterThanOrEqual(run.pointerReads - 1e-9);
    }

    // Pinned: no refresh at all, and the model bills none.
    expect((await readFor(0, 100)).pointerReads).toBe(0);
    expect(price({ hotSegments: 1, readsPerSec: 10, genTtlMs: 0 }).pointerRefresh).toBe(0);
  });

  it("prices a segment's grounded report at the store's own refresh", async () => {
    const { open } = countingStore();
    await open().load({ segment: 'hot' }, [1, 2, 3]);
    const workload = { hotSegments: 1, readsPerSec: 10 };
    const at = async (options: object, extra: Partial<Workload> = {}): Promise<number> =>
      (
        await open(options)
          .segment('hot')
          .costReport({ workload: { ...workload, ...extra }, pricing: COUNTING })
      ).monthlyUSD.byOp.pointerRefresh;
    const clock = virtualClock();
    // A store with a clock refreshes at its own TTL, 2 s by default.
    expect(await at({ seams: { clock } })).toBeCloseTo((SECONDS_PER_MONTH * 1000) / 2000, 3);
    expect(await at({ seams: { clock }, cache: { genTtlMs: 60_000 } })).toBeCloseTo(
      (SECONDS_PER_MONTH * 1000) / 60_000,
      3,
    );
    // Pinned, it never refreshes, and the report bills none.
    expect(await at({ seams: { clock }, cache: { genTtlMs: 0 } })).toBe(0);
    // A workload that states its own TTL wins.
    expect(
      await at({ seams: { clock }, cache: { genTtlMs: 60_000 } }, { genTtlMs: 2000 }),
    ).toBeCloseTo((SECONDS_PER_MONTH * 1000) / 2000, 3);
  });
});
