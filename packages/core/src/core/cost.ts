/**
 * Cost model & estimator — pure, `core/`-safe (no I/O, time, or SDK). Turns the verified economics of the
 * loaded store into a first-class library API:
 *
 * - {@link estimateCost} — **planning** mode: pure what-if from segment sizes + a workload (sizing/sales).
 * - `segment.costReport()` (wired in the facade) — **grounded** mode: the segment's real size from the `.crbm`
 *   index (free + exact, no payload reads) + a supplied workload for request rates. (Whole-store aggregation is
 *   a later phase.)
 *
 * Guiding split: **formulas are the spec; rates are a pluggable {@link PricingProfile}.** The report always emits
 * a {@link CostReport.verdict} that includes the lose-zone — it never hides where an always-on cache (Redis)
 * wins.
 *
 * What the model covers, and states in `assumptions.notes`: object-store GETs for point reads, for
 * intersections (each operand's pointer and index as well as its chunks) and for the pointer refresh a long-lived
 * reader pays; the requests of the retention sweep (a retirement and a purge, each priced from the registry requests
 * it makes); the requests of a load (the object's write, and the pointer reads and write, the checks of the next
 * generation number and of the current generation's object, and the listing of every 16th generation that
 * `store.load()` makes around it); and storage. Same-region egress is
 * treated as free and internet egress is not modeled; request cost is derived from the supplied workload rates
 * (deriving it from live metrics counters is a later refinement). There is no per-write term because the loaded
 * store has no per-id write: data arrives as generations, and a generation is a load.
 *
 * Every request count below is one the engine makes, and `tests/core/cost.test.ts` holds each to the engine by
 * counting what it sends: the model is only as honest as those counts, and they move when the engine does. They
 * are for a single-bucket store, where the pointer is an object beside the data, which is the topology that
 * ships. A load is more than the object's PUT, and an intersect more than its chunk reads: pricing either as the
 * one alone under-quotes a load by more than half and leaves out a pointer read and an index read for every
 * operand.
 *
 * The counts are S3's (and GCS's), and one reader process's. A pointer read is one request on every backend, and
 * {@link PricingProfile} carries it as `requestsPerPointerRead`. A segment's tail read needs the object's size, and
 * on Azure Blob, which takes no suffix range, it is two requests, the properties and then the bytes, which
 * {@link PricingProfile} carries as `requestsPerSizedRead`. A fleet of reader processes pays the pointer refresh
 * once per process, which {@link Workload.readerProcesses} carries. Where the model still quotes low is listed on
 * {@link Workload.hotSegments} and {@link Workload.chunksPerIntersect}.
 */
import { ValidationError } from './errors';
import { LIST_COLLECTION_CADENCE } from './generation-gc';
import { DEFAULT_CURRENT_GEN_TTL_MS, DEFAULT_MAX_OPEN_SEGMENTS } from './reader-defaults';

/**
 * Freeze a constant and everything in it, so a caller that changes one — a `push` onto a catalogue's rows — cannot
 * change the default for every other caller in the process: the change throws in strict mode, as in every ES module,
 * and is ignored in a sloppy-mode script.
 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Pluggable rate card. Rates differ by cloud/region/term and drift over time; the formulas don't. */
export interface PricingProfile {
  readonly name: string;
  readonly storage: {
    /** Object GET (per **million** requests). A ranged GET bills as a full GET. */
    readonly getPerMillion: number;
    /** Object PUT (per million) — what a load pays, per request. */
    readonly putPerMillion: number;
    readonly storagePerGiBMonth: number;
    /**
     * Requests one pointer read costs: a read of a segment's registry row, whose version comes back with its bytes.
     * Default **1**, and 1 on S3, GCS and Azure Blob, each of which answers it with one GET. Charged for each operand
     * of an intersection, for the pointer reads a load makes, and for each pointer refresh. Set it when a
     * registry of your own takes more than one request to read a row.
     */
    readonly requestsPerPointerRead?: number;
    /**
     * Requests one tail read costs: the read of a segment's index from the end of its generation, which needs the
     * object's size. Default **1**, S3's, whose suffix-range GET returns the size with the bytes, and GCS's, the same.
     * **2** on Azure Blob, which takes no suffix range and reads the properties and then the bytes. Charged for each
     * operand of an intersection. A load reads no index of its own: a row that carries a summary of its current
     * generation gives the load the size it needs, and the checks it makes are one metadata request on every backend.
     * A chunk read knows its range, and is one request everywhere.
     */
    readonly requestsPerSizedRead?: number;
  };
  /**
   * The always-on Redis the verdict compares against: exactly one of the two. `sizedToData`, the default's, prices
   * the cheapest cluster that holds the report's stored bytes; `monthlyUSD` is one cluster you name, whatever the
   * data size. A profile carrying both is refused rather than read one way.
   */
  readonly redis:
    | { readonly monthlyUSD: number; readonly sizedToData?: never }
    | { readonly sizedToData: RedisSizing; readonly monthlyUSD?: never };
}

/** One node type a Redis cluster can be built from, as its cloud prices it. */
export interface RedisNodeType {
  readonly name: string;
  /** Memory, in GiB, as the cloud publishes it for the node type. */
  readonly memoryGiB: number;
  /**
   * SSD, in GiB, on a data-tiering node (ElastiCache's `r6gd`): keys stay in memory, and the values read least
   * recently move to the SSD. Counted in full beside the memory, as AWS counts a data-tiering node's capacity.
   */
  readonly ssdGiB?: number;
  /** Price per node-hour, in USD. */
  readonly hourlyUSD: number;
  /**
   * The most shards a cluster of this type is priced at. The default catalogue prices its burstable nodes as one
   * shard: a cluster sharded across them is not how data anyone queries is held. Default: no limit.
   */
  readonly maxShards?: number;
}

/**
 * Redis sized to hold the data: enough shards for the bytes, each a primary and its replicas, on whichever node
 * type in `nodeTypes` makes that cheapest. Prices within a millionth of a dollar of the cheapest are a tie, which
 * fewer nodes win, then the lower price, then the name, so the answer never depends on the order of the rows. The data is held at its stored,
 * compressed size, which is a floor on the memory Redis needs for it: a native Redis bitmap is sized by its highest
 * id, not by how many ids it holds, so sparse ids need more.
 */
export interface RedisSizing {
  /** Where the prices come from, and when; the report's notes quote it. */
  readonly source: string;
  readonly nodeTypes: readonly RedisNodeType[];
  /** Replicas per shard. AWS's best practice is 2; Multi-AZ needs at least 1. */
  readonly replicasPerShard: number;
  /** The share of each node's memory kept back from data: ElastiCache's `reserved-memory-percent`, 25% by default. */
  readonly reservedMemoryFraction: number;
}

/**
 * **ElastiCache for Redis OSS in us-east-1, on-demand**: node prices from AWS's public price list, version
 * 20260914063714 (published 2026-09-14, effective 2026-09-01,
 * https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/20260914063714/us-east-1/index.json), and the
 * memory AWS publishes for each node type. Every shard is a primary and two replicas, AWS's best practice, with
 * ElastiCache's default 25% of each node's memory reserved, and the burstable `t4g` nodes are priced as one shard.
 *
 * It lists only rows that are the cheapest fit for some size of data: the data-tiering `r6gd` rows above about
 * 30 GiB, and the larger in-memory `r6g` rows, `2xlarge` and up, when those are left out. The current `m7g` and `r7g` nodes are not here,
 * because an `m6g` or `r6g` with the same memory costs less. It is the cheapest cluster of THIS kind; Redis bought
 * another way costs less — one replica a shard a third less, ElastiCache for Valkey 20% less a node, reserved nodes
 * less again — so against those the saving the verdict reports is smaller. Pass their prices to compare with them.
 */
export const ELASTICACHE_REDIS_US_EAST_1_ONDEMAND: RedisSizing = deepFreeze({
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

/**
 * One ElastiCache HA cluster, a primary and two replicas of cache.m7g.large — the m7g family's smallest node —
 * at $0.158 an hour each: 3 × 730 h × $0.158 = $346.02, published to the dollar. The per-request crossovers on the
 * benchmarks page are drawn against this one cluster, whatever the data size; pass it as `pricing.redis` to compare
 * with it. It is not the cheapest cluster for any size of data: three cache.m6g.large hold the same memory for less.
 */
// The trailing comment below is parsed by scripts/site-figures.cjs, and the literal by bench/lib/calibration-figures.cjs.
export const ONE_REDIS_HA_CLUSTER = deepFreeze({ monthlyUSD: 346 }); // ElastiCache HA: 1 primary + 2 replicas (cache.m7g.large); ~$115 single-node

/**
 * Default profile — **AWS us-east-1, on-demand**, mid-2026, from the fact-checked published pricing rather than
 * copied from a blog post, with Redis sized to the data. Override it for your region, cloud, or committed term.
 */
export const AWS_US_EAST_1_ONDEMAND: PricingProfile = deepFreeze({
  name: 'aws-us-east-1-ondemand',
  storage: { getPerMillion: 0.4, putPerMillion: 5.0, storagePerGiBMonth: 0.023 },
  redis: { sizedToData: ELASTICACHE_REDIS_US_EAST_1_ONDEMAND },
});

/** Sustained access pattern. All rates default to 0; unspecified ⇒ that op contributes nothing. */
export interface Workload {
  /**
   * Point reads (`has`) per second. Each cache miss is one object GET, once the segment's pointer and index are
   * read.
   */
  readonly readsPerSec?: number;
  readonly intersectsPerSec?: number;
  /** Cache hit rate in `[0, 1]` — hits are free; only misses cost. Default 0. */
  readonly cacheHitRate?: number;
  /**
   * Range requests one intersection makes for its chunks, summed over its operands. Default 1. The engine reads each
   * operand's needed chunks (the chunk-skipping survivors) as coalesced ranges: chunks within 256 KiB of each other
   * are read in one request, up to 1 MiB, so this is the requests the chunks need, not the chunks. It follows the
   * bytes the needed chunks span in each object: two segments sharing 100 chunks that sit side by side make one request
   * of each, `2`; the same 100 spread over each object make as many as it takes to cover most of the object, a
   * request per MiB, and read most of its bytes. Count it by running the engine over a layout of your own, as
   * `bench/range-counts.cjs` does, or take it as one request per MiB the shared chunks span, per operand. (The field's
   * name is from when each chunk was a request of its own.) The model adds each operand's pointer and index reads itself (see
   * {@link Workload.operandsPerIntersect}), so count chunk requests only. One more GET per operand whose index
   * outgrows the reader's tail read (256 KiB by default), which then reads the index whole, belongs here too, and so
   * does a pointer re-read by an intersect slow enough to outlive {@link Workload.genTtlMs}.
   */
  readonly chunksPerIntersect?: number;
  /**
   * Segments each intersection reads, `exclude` operands included; at least 1. Default 2. An intersection is priced
   * **cold**: before its chunks, each operand's pointer is read, then its index, in one read of the object's tail —
   * 2 GETs an operand on S3 and GCS, so a cold intersect that makes `r` range requests of each of two segments is `4 + 2r` GETs there,
   * and 3 on Azure Blob, whose tail read is two requests (see {@link PricingProfile}). `cacheHitRate`
   * does not apply to intersections, so a long-lived reader that answers a repeat from its cache pays less. Other
   * combines read their operands the same way and can be priced here too, with the chunk requests they make.
   */
  readonly operandsPerIntersect?: number;
  /**
   * Generations published per month across the modeled data — the write side of a loaded store. Default **0**
   * ⇒ loads are not modeled and the report *discloses* the omission rather than silently under-reporting.
   */
  readonly loadsPerMonth?: number;
  /**
   * PUT-class requests one load's object write issues, each priced at the PUT rate. Default **1** (a single-object
   * PUT). A multipart write of `P` parts bills `P + 2` (initiate, the parts, complete) — set it when you know your
   * object sizes. The model adds what `store.load()` does around the write, at the default `keep` of 1: the pointer's
   * write, PUT-class on S3, and five GETs: the pointer read three times, one check that the next generation number is
   * free, and one that the current generation's object is there, which tells the collection that deletes by name it
   * may. The current generation's size comes from the row's summary of it, so the load reads no index. Collection
   * deletes the generation the window pushed out by name, so it lists only on every 16th generation, which adds a
   * PUT-class request and two pointer reads there and makes no check that the current generation is there, a
   * sixteenth of each on average. That is a segment with two
   * generations behind it, whose row carries a summary; its first two loads make fewer requests and collect nothing,
   * and the first load of a row written before rows carried a summary reads the current generation's index, one tail
   * read, in place of the check that its object is there. A publish that loses a race to another writer
   * reads the pointer again, and a load whose check finds the number taken (a crashed load's object, or the
   * generations a rollback left above the pointer) lists the segment's objects to number past them and to collect,
   * two PUT-class requests on S3 and two more pointer reads. So does every load that keeps two or more generations,
   * which lists to collect: one more PUT-class request and two more pointer reads than the model counts. The counts
   * are a cleartext segment's: an encrypted segment's load reads its row once more, after its ids and before it
   * unwraps the key, one more GET ($0.40 per million at the default prices) that the model leaves out, beside the
   * key-management calls it does not price either.
   */
  readonly requestsPerLoad?: number;
  /**
   * Segments each long-lived reader process keeps reading. A reader re-reads a segment's pointer when it reads the
   * segment after {@link Workload.genTtlMs} has passed, so each costs at most one GET per `genTtlMs` in each process
   * that reads it — 1,314,000 GETs a month at the default 2 s — and the whole term at most one GET per point read
   * (`readsPerSec`, across the fleet). Intersections are priced cold and pay their own pointer reads. Default **0**
   * ⇒ the refresh is not modeled, and the report *discloses* the omission when there are reads to refresh for.
   *
   * It assumes each hot segment stays open in the reader's cache (`cache.readerMax`, 1,024 segments by default,
   * and `cache.readerMaxBytes`, 64 MiB of parsed index). A read of a segment the cache evicted opens it again, a
   * pointer read and a tail read, which is not priced here, and neither is the re-open every reader makes after
   * each load, for the new generation's index. Size those caches to keep the hot set open; the report says so when
   * `hotSegments` is more than a store keeps open by default.
   */
  readonly hotSegments?: number;
  /**
   * Long-lived reader processes, each keeping its own {@link Workload.hotSegments} open and refreshing their
   * pointers on its own: ten processes reading the same hundred segments pay ten times one process's refresh.
   * At least 1. Default 1.
   */
  readonly readerProcesses?: number;
  /**
   * How long the reader trusts a pointer, in ms: the store's `cache.genTtlMs`. Default 2000, the store's own
   * default; `segment.costReport()` uses the store's. `0` turns the timed refresh off, and the model bills none: a
   * reader then re-reads a pointer only when its cache evicts the segment, a read finds its generation swept, or a
   * write invalidates it, none of which this term prices.
   */
  readonly genTtlMs?: number;
  /**
   * Segments the retention sweep (`retireExpired`) retires a month. Each costs 9 registry reads, 3 writes and a
   * delete with {@link Workload.conditionalDelete} on, and 8 reads and 3 writes with it off, priced at the GET and PUT
   * rates, a delete unbilled, as S3 leaves it. Default
   * **0**.
   */
  readonly retirementsPerMonth?: number;
  /**
   * Tombstones the sweep purges a month: at a steady state, as many as it retires a month, a `tombstoneGraceMs` later.
   * A purge costs 4 reads and 2 deletes with {@link Workload.conditionalDelete} on, and 3 reads and a write with it
   * off. Default **0**.
   */
  readonly purgesPerMonth?: number;
  /**
   * Whether the registry's deletes remove a row for good (`RegCaps.conditionalDelete`), which the shipped registries
   * do where the backend applies a delete precondition. Default **true**. `false` prices the sweep of a registry that
   * only tombstones: a purge rewrites the row instead of deleting it, and every later full sweep reads each tombstone
   * left (two reads per purged segment), which this term does not price.
   */
  readonly conditionalDelete?: boolean;
}

/** One (group of) segment(s) for planning. `count` = how many like this (default 1). */
export interface SegmentSizing {
  readonly sizeBytes?: number;
  readonly cardinality?: number;
  /** Number of segments with these characteristics. Default 1. */
  readonly count?: number;
}

export interface EstimateInput {
  readonly segments: readonly SegmentSizing[];
  readonly workload?: Workload;
  readonly pricing?: PricingProfile;
}

export interface CostReport {
  readonly monthlyUSD: {
    readonly byOp: {
      readonly reads: number;
      readonly intersects: number;
      readonly storage: number;
      /**
       * Loads: each its object's `requestsPerLoad` PUT-class requests plus what `store.load()` adds around them.
       * 0 unless `loadsPerMonth` is set.
       */
      readonly loads: number;
      /** The pointer refresh of {@link Workload.hotSegments}. 0 unless `hotSegments` is set. */
      readonly pointerRefresh: number;
      /**
       * The retention sweep's retirements and purges: each's registry reads at the GET rate and its writes at the PUT
       * rate. 0 unless `retirementsPerMonth` or `purgesPerMonth` is set.
       */
      readonly retention: number;
    };
    readonly total: number;
  };
  /**
   * The Redis the verdict compares against. Sized, the default, it is the cheapest cluster in
   * `pricing.redis.sizedToData` that holds this report's stored bytes; fixed, it is `pricing.redis.monthlyUSD` as
   * given.
   *
   * **It is not additive across reports.** Each report sizes Redis to its own bytes, so a per-segment report
   * (`segment.costReport()`) compares with a cluster holding that one segment alone, and the baselines of a store's
   * segments do not sum to the store's. To judge a store, price all its segments in one `estimateCost`. To alarm on
   * one, sum `monthlyUSD.total` over its segments and compare the sum with the Redis you would run for it: a
   * per-segment verdict against that whole price fires only when one segment alone costs more than all of it.
   */
  readonly redisBaseline:
    | { readonly basis: 'fixed'; readonly monthlyUSD: number }
    | {
        readonly basis: 'sized-to-data';
        readonly monthlyUSD: number;
        /** The node type, the shards, the nodes (every shard's primary and replicas), and whether they tier to SSD. */
        readonly cluster: {
          readonly nodeType: string;
          readonly shards: number;
          readonly nodes: number;
          readonly dataTiering: boolean;
        };
      };
  /**
   * Sustained read rate at which the pay-per-use model's cost passes {@link CostReport.redisBaseline}, **evaluated
   * at this report's `cacheHitRate`** — so a higher cache-hit rate raises it (cache hits are free) — with the other
   * request axes at 0, and with what keeping the data readable costs taken out of the baseline first: storage, and
   * this report's pointer refresh. Loads, the write side, are left out of it. `Infinity` means it never crosses (a
   * 100% cache-hit rate). The published anchor (~329 reads/s) is against {@link ONE_REDIS_HA_CLUSTER}, at
   * `cacheHitRate: 0` with no refresh modeled.
   */
  readonly redisCrossover: { readonly readsPerSec: number };
  readonly verdict: 'win-big' | 'win' | 'lose-zone';
  readonly rationale: string;
  readonly assumptions: {
    readonly cacheHitRate: number;
    readonly pricingName: string;
    /** True when segment **sizes** were real (grounded `costReport`), false for a pure `estimateCost`. */
    readonly grounded: boolean;
    /** What the model assumed and what it left out, in words. The last says how the Redis was priced. */
    readonly notes: readonly string[];
  };
}

const HOURS_PER_MONTH = 730; // AWS's own convention: 365 days × 24 hours ÷ 12 months
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600; // 2,628,000
const GIB = 1024 ** 3;

/**
 * What `store.load()` adds to its object's write, as the engine makes the requests on a segment with two
 * generations behind it, at the default `keep` of 1 with nothing above the pointer. Collection deletes the one
 * generation the window pushed out by name, so the pointer is read three times (the load's one read before its
 * publish, the compare-and-swap's read of the row's version, and the re-read before the delete) and nothing is
 * listed, except on every {@link LIST_COLLECTION_CADENCE}th generation, where collection lists instead: one more
 * PUT-class request and two more pointer reads (before and after the listing). Those two are averaged over the
 * cadence, so a count of `n` loads is exact for `n` consecutive generations of the cadence. PUT-class: the
 * pointer's write and the averaged listing. Pointer reads each cost `requestsPerPointerRead` requests. The load reads
 * no index: the row's summary of the current generation gives it the size the guard needs. It makes two checks, each
 * a single metadata request on every backend (S3's `HeadObject`, GCS's object metadata, Azure Blob's properties), so
 * `requestsPerSizedRead` applies to neither: that the next generation number is free, on every load, and that the
 * current generation's object is there, before the collection deletes by name the generation it pushed out of the
 * window, so on every load but the listing one. `tests/core/cost.test.ts` holds these to the engine over sixteen
 * consecutive loads. A load that keeps two or more generations, or whose check meets an object, lists on every load:
 * one more PUT-class request and two more pointer reads than these, and one check fewer.
 */
const STORE_LOAD_PUT_CLASS = 1 + 1 / LIST_COLLECTION_CADENCE;
const STORE_LOAD_POINTER_READS = 3 + 2 / LIST_COLLECTION_CADENCE;
const STORE_LOAD_EXISTENCE_CHECKS = 2 - 1 / LIST_COLLECTION_CADENCE;

/** The requests one segment's retirement or purge makes: reads (GET-class), writes (PUT-class) and deletes. */
interface SweepRequests {
  readonly reads: number;
  readonly writes: number;
  readonly deletes: number;
}

/**
 * What the retention sweep makes per segment, counted with a store that counts its requests
 * (`tests/core/retention-hard-purge.test.ts` holds each figure to the engine, and `tests/core/cost.test.ts` holds the
 * estimator to these). With the registry's `conditionalDelete` on, a retirement files a due-index pointer to the
 * tombstone and a purge removes the row and every pointer: a later sweep reads nothing of a purged segment. With it
 * off, a retirement files no pointer, a purge rewrites the row as a tombstone, and every later full sweep reads what
 * is left, two objects per purged segment.
 */
export const RETENTION_SWEEP_REQUESTS = deepFreeze({
  conditionalDelete: {
    retirement: { reads: 9, writes: 3, deletes: 1 },
    purge: { reads: 4, writes: 0, deletes: 2 },
  },
  tombstoning: {
    retirement: { reads: 8, writes: 3, deletes: 0 },
    purge: { reads: 3, writes: 1, deletes: 0 },
  },
}) satisfies Readonly<Record<string, Readonly<Record<string, SweepRequests>>>>;

/** A count of requests for a note: at most two decimals, none when it is whole. */
const shown = (n: number): string => String(Number(n.toFixed(2)));

/** Fail-fast at the boundary: reject non-finite / negative inputs rather than leak NaN into the report. */
function requireFiniteNonNeg(n: number | undefined, field: string): number {
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${field} must be a finite number >= 0; got ${n}`);
  }
  return n;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Two cluster prices closer than this are the same price. */
const TIE_USD = 1e-6;

interface SizedCluster {
  readonly nodeType: RedisNodeType;
  readonly shards: number;
  readonly nodes: number;
  readonly monthlyUSD: number;
}

/** The node's share of the data: its memory less the reserve, and all of a data-tiering node's SSD. */
function usableGiB(sizing: RedisSizing, nodeType: RedisNodeType): number {
  return nodeType.memoryGiB * (1 - sizing.reservedMemoryFraction) + (nodeType.ssdGiB ?? 0);
}

/** Fail-fast on a caller-supplied catalogue: a bad row would otherwise win on NaN, or never fit anything. */
function validateSizing(sizing: RedisSizing | undefined): asserts sizing is RedisSizing {
  const at = 'pricing.redis.sizedToData';
  if (sizing === null || typeof sizing !== 'object') {
    throw new ValidationError(`${at} must be a RedisSizing`);
  }
  if (typeof sizing.source !== 'string' || sizing.source === '') {
    throw new ValidationError(`${at}.source must say where the prices come from`);
  }
  if (!Array.isArray(sizing.nodeTypes) || sizing.nodeTypes.length === 0) {
    throw new ValidationError(`${at}.nodeTypes must list at least one node type`);
  }
  if (!Number.isInteger(sizing.replicasPerShard) || sizing.replicasPerShard < 0) {
    throw new ValidationError(
      `${at}.replicasPerShard must be an integer >= 0; got ${sizing.replicasPerShard}`,
    );
  }
  const reserved = requireFiniteNonNeg(
    sizing.reservedMemoryFraction,
    `${at}.reservedMemoryFraction`,
  );
  if (reserved >= 1) {
    throw new ValidationError(`${at}.reservedMemoryFraction must be below 1; got ${reserved}`);
  }
  const names = new Set<string>();
  for (const n of sizing.nodeTypes) {
    if (n === null || typeof n !== 'object' || typeof n.name !== 'string' || n.name === '') {
      throw new ValidationError(`${at}.nodeTypes: every node type needs a name`);
    }
    const row = `${at}.nodeTypes[${JSON.stringify(n.name)}]`;
    if (names.has(n.name)) throw new ValidationError(`${row} is listed twice`);
    names.add(n.name);
    if (!(requireFiniteNonNeg(n.memoryGiB, `${row}.memoryGiB`) > 0)) {
      throw new ValidationError(`${row}.memoryGiB must be above 0`);
    }
    requireFiniteNonNeg(n.ssdGiB ?? 0, `${row}.ssdGiB`);
    requireFiniteNonNeg(n.hourlyUSD, `${row}.hourlyUSD`);
    if (n.maxShards !== undefined && (!Number.isInteger(n.maxShards) || n.maxShards < 1)) {
      throw new ValidationError(`${row}.maxShards must be an integer >= 1; got ${n.maxShards}`);
    }
    // A memory so small that the reserve leaves nothing would size any data at infinite shards.
    if (!(usableGiB(sizing, n) > 0)) {
      throw new ValidationError(
        `${row} leaves no memory for data once ${reserved} of it is reserved`,
      );
    }
  }
}

/**
 * The cheapest cluster in `sizing` that holds `dataGiB`: for each node type, enough shards for the data in what each
 * node leaves free, every shard a primary and its replicas. See {@link RedisSizing} for how a tie is broken.
 */
function cheapestCluster(sizing: RedisSizing, dataGiB: number): SizedCluster {
  const fits: SizedCluster[] = [];
  for (const nodeType of sizing.nodeTypes) {
    const usable = usableGiB(sizing, nodeType);
    let shards = Math.max(1, Math.ceil(dataGiB / usable));
    // The division can round an exact multiple up by one: a shard fewer that still holds the data is the answer.
    if (shards > 1 && (shards - 1) * usable >= dataGiB) shards -= 1;
    if (nodeType.maxShards !== undefined && shards > nodeType.maxShards) continue;
    const nodes = shards * (1 + sizing.replicasPerShard);
    fits.push({
      nodeType,
      shards,
      nodes,
      monthlyUSD: nodes * nodeType.hourlyUSD * HOURS_PER_MONTH,
    });
  }
  const size = bytesWords(dataGiB * GIB);
  if (fits.length === 0) {
    throw new ValidationError(
      `no node type in pricing.redis.sizedToData.nodeTypes holds ${size} within its maxShards`,
    );
  }
  // Prices within TIE_USD of the cheapest are one price reached by different roundings. Chosen among them by a rule
  // that never looks at where a row sits in the list: fewer nodes, then the lower price, then the name.
  const cheapest = fits.reduce((m, c) => Math.min(m, c.monthlyUSD), Infinity);
  const [best] = fits
    .filter((c) => c.monthlyUSD <= cheapest + TIE_USD)
    .sort(
      (a, b) =>
        a.nodes - b.nodes ||
        a.monthlyUSD - b.monthlyUSD ||
        (a.nodeType.name < b.nodeType.name ? -1 : a.nodeType.name > b.nodeType.name ? 1 : 0),
    );
  if (best === undefined || !Number.isFinite(best.monthlyUSD)) {
    throw new ValidationError(
      `pricing.redis.sizedToData prices ${size} at no finite cost; check its node types`,
    );
  }
  return best;
}

/**
 * A plain copy of a caller's sizing, each value read once, so what is validated is what is priced: a getter or a
 * Proxy that answered differently the second time could otherwise price a row it never validated. Anything not
 * shaped like a sizing is passed through for {@link validateSizing} to refuse.
 */
function snapshotSizing(sizing: RedisSizing | undefined): RedisSizing | undefined {
  if (sizing === null || typeof sizing !== 'object') return sizing;
  const { source, nodeTypes, replicasPerShard, reservedMemoryFraction } = sizing;
  const row = (n: RedisNodeType): RedisNodeType => {
    if (n === null || typeof n !== 'object') return n;
    const { name, memoryGiB, ssdGiB, hourlyUSD, maxShards } = n;
    return {
      name,
      memoryGiB,
      hourlyUSD,
      ...(ssdGiB === undefined ? {} : { ssdGiB }),
      ...(maxShards === undefined ? {} : { maxShards }),
    };
  };
  return {
    source,
    replicasPerShard,
    reservedMemoryFraction,
    nodeTypes: Array.isArray(nodeTypes) ? Array.from(nodeTypes, row) : nodeTypes,
  };
}

/** What a report compares against: a fixed price, or the cluster sized to its bytes, and the sizing that chose it. */
interface Baseline {
  readonly monthlyUSD: number;
  readonly sized?: { readonly sizing: RedisSizing; readonly cluster: SizedCluster };
}

/** Read `pricing.redis`, which must be exactly one of the two shapes, and price it for `storedGiB`. */
function resolveBaseline(redis: PricingProfile['redis'], storedGiB: number): Baseline {
  if (redis === null || typeof redis !== 'object') {
    throw new ValidationError('pricing.redis must be { monthlyUSD } or { sizedToData }');
  }
  // A shape is given when its key has a value, however the value is reached: an inherited price, or one behind a
  // getter, is as given as an own property, and a key set to undefined gives nothing. Each is read once.
  const { monthlyUSD, sizedToData } = redis;
  const fixed = monthlyUSD !== undefined;
  const sized = sizedToData !== undefined;
  if (fixed === sized) {
    throw new ValidationError(
      'pricing.redis must be exactly one of { monthlyUSD } and { sizedToData }' +
        (fixed
          ? ', not both: spreading AWS_US_EAST_1_ONDEMAND.redis keeps its sizedToData, so pass redis: { monthlyUSD } alone'
          : ''),
    );
  }
  if (sized) {
    const sizing = snapshotSizing(sizedToData);
    validateSizing(sizing);
    const cluster = cheapestCluster(sizing, storedGiB);
    return { monthlyUSD: cluster.monthlyUSD, sized: { sizing, cluster } };
  }
  return { monthlyUSD: requireFiniteNonNeg(monthlyUSD, 'pricing.redis.monthlyUSD') };
}

/**
 * A byte count in the largest binary unit it fills — "18.63 GiB", "190.73 MiB", "20 bytes" — since a report on one
 * segment is usually far under a GiB, and "0.00 GiB" would read as nothing at all.
 */
function bytesWords(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  // Rounded before the unit is chosen, so 1,048,575 bytes reads "1.00 MiB", not "1024.00 KiB".
  const shown = (v: number, u: number): number => (u === 0 ? Math.round(v) : Number(v.toFixed(2)));
  while (unit < units.length - 1 && shown(value, unit) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  if (unit > 0) return `${value.toFixed(2)} ${units[unit]}`;
  const n = Math.round(value);
  return `${n} byte${n === 1 ? '' : 's'}`;
}

/** "1 shard of 3 cache.r6g.xlarge nodes", or "95 shards, 285 cache.r6g.xlarge nodes". */
function clusterWords(c: SizedCluster): string {
  const count = (n: number): string => n.toLocaleString('en-US');
  const nodes = `${count(c.nodes)} ${c.nodeType.name} node${c.nodes === 1 ? '' : 's'}`;
  return c.shards === 1 ? `1 shard of ${nodes}` : `${count(c.shards)} shards, ${nodes}`;
}

/** Rough bytes for a segment when only cardinality is known: 2 B/value (array-container upper bound). */
function sizingBytes(spec: SegmentSizing): number {
  if (spec.sizeBytes !== undefined) return requireFiniteNonNeg(spec.sizeBytes, 'segment.sizeBytes');
  if (spec.cardinality !== undefined) {
    return requireFiniteNonNeg(spec.cardinality, 'segment.cardinality') * 2;
  }
  return 0;
}

/** Core report builder shared by planning + grounded modes. `storageBytes` is total across all segments. */
function buildReport(input: {
  readonly storageBytes: number;
  readonly workload: Workload;
  readonly pricing: PricingProfile;
  readonly grounded: boolean;
  readonly extraNotes?: readonly string[];
  /** Some sizes were derived from cardinality, an upper bound: a Redis sized to them may be larger than needed. */
  readonly sizesFromCardinality?: boolean;
}): CostReport {
  const { pricing, grounded } = input;
  const { storage, redis } = pricing;
  const S = SECONDS_PER_MONTH;

  // The pricing profile is a public, caller-supplied boundary input too — validate every rate that feeds
  // the report so a malformed profile fails fast rather than leaking NaN/Infinity dollars + a bogus verdict.
  requireFiniteNonNeg(storage.getPerMillion, 'pricing.storage.getPerMillion');
  requireFiniteNonNeg(storage.putPerMillion, 'pricing.storage.putPerMillion');
  requireFiniteNonNeg(storage.storagePerGiBMonth, 'pricing.storage.storagePerGiBMonth');
  const pointerRead = requireFiniteNonNeg(
    storage.requestsPerPointerRead ?? 1,
    'pricing.storage.requestsPerPointerRead',
  );
  const sizedRead = requireFiniteNonNeg(
    storage.requestsPerSizedRead ?? 1,
    'pricing.storage.requestsPerSizedRead',
  );

  const storageBytes = requireFiniteNonNeg(input.storageBytes, 'storageBytes');
  const storedGiB = storageBytes / GIB;

  // The Redis to compare against: the cheapest cluster that holds the stored bytes, or the one cluster named.
  const baseline = resolveBaseline(redis, storedGiB);
  const baselineUSD = baseline.monthlyUSD;

  const cacheHitRate = clamp01(
    requireFiniteNonNeg(input.workload.cacheHitRate ?? 0, 'cacheHitRate'),
  );
  const readsPerSec = requireFiniteNonNeg(input.workload.readsPerSec ?? 0, 'readsPerSec');
  const intersectsPerSec = requireFiniteNonNeg(
    input.workload.intersectsPerSec ?? 0,
    'intersectsPerSec',
  );
  const chunksPerIntersect = requireFiniteNonNeg(
    input.workload.chunksPerIntersect ?? 1,
    'chunksPerIntersect',
  );
  const loadsPerMonth = requireFiniteNonNeg(input.workload.loadsPerMonth ?? 0, 'loadsPerMonth');
  const requestsPerLoad = requireFiniteNonNeg(
    input.workload.requestsPerLoad ?? 1,
    'requestsPerLoad',
  );
  const operandsPerIntersect = requireFiniteNonNeg(
    input.workload.operandsPerIntersect ?? 2,
    'operandsPerIntersect',
  );
  if (operandsPerIntersect < 1) {
    throw new ValidationError(
      `operandsPerIntersect must be at least 1, since an intersection reads its operands; got ${operandsPerIntersect}`,
    );
  }
  const hotSegments = requireFiniteNonNeg(input.workload.hotSegments ?? 0, 'hotSegments');
  const readerProcesses = requireFiniteNonNeg(
    input.workload.readerProcesses ?? 1,
    'readerProcesses',
  );
  if (readerProcesses < 1) {
    throw new ValidationError(`readerProcesses must be at least 1; got ${readerProcesses}`);
  }
  const genTtlMs = requireFiniteNonNeg(
    input.workload.genTtlMs ?? DEFAULT_CURRENT_GEN_TTL_MS,
    'genTtlMs',
  );
  const retirementsPerMonth = requireFiniteNonNeg(
    input.workload.retirementsPerMonth ?? 0,
    'retirementsPerMonth',
  );
  const purgesPerMonth = requireFiniteNonNeg(input.workload.purgesPerMonth ?? 0, 'purgesPerMonth');
  const conditionalDelete = input.workload.conditionalDelete ?? true;
  if (typeof conditionalDelete !== 'boolean') {
    throw new ValidationError(`conditionalDelete must be a boolean; got ${conditionalDelete}`);
  }

  // Per-request unit costs (USD). Same-region egress is free; internet egress not modeled.
  const storageGetUSD = storage.getPerMillion / 1e6;
  const putUSD = storage.putPerMillion / 1e6;

  // Monthly volumes.
  const missFraction = 1 - cacheHitRate;
  const readMisses = readsPerSec * S * missFraction;
  const intersects = intersectsPerSec * S;

  // A reader re-reads a pointer only when it reads the segment after the TTL has lapsed, so the refresh is at most
  // one per hot segment per TTL, and at most one per point read. With no timed refresh (`genTtlMs: 0`) it is none.
  const refreshes =
    genTtlMs > 0
      ? Math.min((readerProcesses * hotSegments * S * 1000) / genTtlMs, readsPerSec * S)
      : 0;

  const storageUSD = storedGiB * storage.storagePerGiBMonth;
  const readsUSD = readMisses * storageGetUSD;
  // A cold intersection reads each operand's pointer, then its index in one tail read, before its chunks.
  const getsPerColdOperand = pointerRead + sizedRead;
  const intersectGets = chunksPerIntersect + getsPerColdOperand * operandsPerIntersect;
  const intersectsUSD = intersects * intersectGets * storageGetUSD;
  const loadGets = STORE_LOAD_POINTER_READS * pointerRead + STORE_LOAD_EXISTENCE_CHECKS;
  const loadsUSD =
    loadsPerMonth * ((requestsPerLoad + STORE_LOAD_PUT_CLASS) * putUSD + loadGets * storageGetUSD);
  const refreshUSD = refreshes * pointerRead * storageGetUSD;
  const sweep = RETENTION_SWEEP_REQUESTS[conditionalDelete ? 'conditionalDelete' : 'tombstoning'];
  const retentionUSD =
    retirementsPerMonth *
      (sweep.retirement.reads * storageGetUSD + sweep.retirement.writes * putUSD) +
    purgesPerMonth * (sweep.purge.reads * storageGetUSD + sweep.purge.writes * putUSD);
  const total = readsUSD + intersectsUSD + storageUSD + loadsUSD + refreshUSD + retentionUSD;

  // Crossover: the sustained read rate (other axes 0) where request cost alone passes the baseline less the fixed
  // monthly costs (storage and the pointer refresh), evaluated at this report's cache posture (misses).
  const headroom = Math.max(0, baselineUSD - storageUSD - refreshUSD);
  const readsCross =
    storageGetUSD > 0 && missFraction > 0
      ? headroom / (S * storageGetUSD * missFraction)
      : Infinity;

  const verdict: CostReport['verdict'] =
    total <= baselineUSD * 0.1 ? 'win-big' : total < baselineUSD ? 'win' : 'lose-zone';

  const dominant = Math.max(
    readsUSD,
    intersectsUSD,
    storageUSD,
    loadsUSD,
    refreshUSD,
    retentionUSD,
  );
  let driver = 'storage';
  if (dominant === readsUSD && readsUSD > 0) driver = 'point reads (object GETs)';
  else if (dominant === intersectsUSD && intersectsUSD > 0) {
    driver = 'intersections (pointer, index and chunk GETs)';
  } else if (dominant === loadsUSD && loadsUSD > 0)
    driver = 'loads (object, listing and pointer requests)';
  else if (dominant === refreshUSD && refreshUSD > 0) driver = 'the pointer refresh (object GETs)';
  else if (dominant === retentionUSD && retentionUSD > 0)
    driver = 'the retention sweep (registry reads and writes)';
  // A fixed baseline keeps the words it always had — "flat baseline" in a lose-zone, "baseline" otherwise — and a
  // sized one says what it priced.
  const sized = baseline.sized;
  // No bytes counted — nothing stored, or a source that cannot measure — sizes Redis to nothing: the rationale says
  // so, rather than naming a cluster that "would hold 0 bytes" as if that were a measurement.
  const noBytes = Math.round(storageBytes) === 0;
  const redisWords =
    sized === undefined
      ? undefined
      : noBytes
        ? `$${baselineUSD.toFixed(2)}/mo cheapest Redis cluster in the catalogue, as no bytes are counted ` +
          `(${clusterWords(sized.cluster)})`
        : `$${baselineUSD.toFixed(2)}/mo Redis that would hold ${bytesWords(storageBytes)} ` +
          `(${clusterWords(sized.cluster)})`;
  const rationale =
    verdict === 'lose-zone'
      ? `pay-per-use total $${total.toFixed(2)}/mo exceeds the ${redisWords ?? `$${baselineUSD}/mo flat baseline`}; dominated by ${driver}`
      : verdict === 'win-big'
        ? `$${total.toFixed(2)}/mo — ≤10% of the ${redisWords ?? `$${baselineUSD}/mo baseline`}; dominated by ${driver}`
        : `$${total.toFixed(2)}/mo, under the ${redisWords ?? `$${baselineUSD}/mo baseline`}; dominated by ${driver}`;

  const dataTiering = sized !== undefined && (sized.cluster.nodeType.ssdGiB ?? 0) > 0;
  const redisNote =
    sized === undefined
      ? `Redis priced at the fixed $${baselineUSD}/mo given, whatever the data size.`
      : (noBytes
          ? 'Redis priced at the cheapest cluster in the catalogue, as no bytes are counted, because nothing ' +
            'is stored or nothing was measured'
          : `Redis priced at the cheapest cluster in the catalogue that holds the ${bytesWords(storageBytes)} stored`) +
        `: ${clusterWords(sized.cluster)}, each shard a primary and ${sized.sizing.replicasPerShard} ` +
        `replica(s), ${Number((sized.sizing.reservedMemoryFraction * 100).toFixed(1))}% of memory reserved ` +
        `(${sized.sizing.source}).` +
        (noBytes
          ? ' Pass pricing.redis: { monthlyUSD } to compare against a Redis of your own.'
          : ' Compressed bytes are a floor on the memory Redis needs: a native Redis bitmap is sized ' +
            'by its highest id, so sparse ids need more.') +
        ' Redis bought another way — fewer replicas, another engine, reserved nodes — can cost less than the ' +
        'catalogue prices it.' +
        (dataTiering
          ? ` ${sized.cluster.nodeType.name} is a data-tiering node, which keeps the values read least recently ` +
            'on its SSD. It is priced as if the data read often fits in its memory: AWS recommends data tiering ' +
            'for workloads that regularly read up to 20% of their data.'
          : '') +
        (input.sizesFromCardinality
          ? ' Some segment sizes came from cardinality, at 2 bytes an id, which is more than a dense bitmap ' +
            'needs, so this Redis may be larger than the data calls for: pass sizeBytes to size it to the ' +
            'compressed bytes.'
          : '');

  const notes = [
    'Same-region egress treated as free; internet egress is not modeled.',
    'Request cost is from the supplied workload rates (live-metrics-derived request cost is a later phase).',
    loadsPerMonth > 0
      ? `Loads modeled: ${loadsPerMonth}/mo, each ${requestsPerLoad} PUT-class request(s) for the object plus ` +
        `${shown(STORE_LOAD_PUT_CLASS)} PUT-class and ${shown(loadGets)} GETs that store.load() adds (the pointer, ` +
        'a check that the next generation number is free, a check that the current generation is there, and a listing every ' +
        `${LIST_COLLECTION_CADENCE}th load).`
      : 'Loads are NOT modeled — set workload.loadsPerMonth (+ requestsPerLoad for multipart) to include them.',
    ...(intersects > 0
      ? [
          `Intersections priced cold: ${intersectGets} GETs each, ` +
            `${getsPerColdOperand} for each of ${operandsPerIntersect} operand(s) plus ` +
            `${chunksPerIntersect} chunk range request(s); cacheHitRate does not apply.`,
        ]
      : []),
    hotSegments > 0
      ? genTtlMs > 0
        ? `Pointer refresh modeled: ${hotSegments} hot segment(s) in each of ${readerProcesses} reader ` +
          `process(es), each re-reading its pointer at most every ${genTtlMs} ms, and at most once a point read.`
        : 'Pointer refresh: none — genTtlMs 0 turns the timed refresh off. A reader still re-reads a pointer on an ' +
          'eviction, a swept generation or an invalidation, which this does not price.'
      : readsPerSec > 0
        ? 'The pointer refresh is NOT modeled — set workload.hotSegments to the segments each long-lived reader ' +
          'keeps reading, and workload.readerProcesses to how many readers there are.'
        : null,
    hotSegments > DEFAULT_MAX_OPEN_SEGMENTS
      ? `More hot segments in a reader than a store keeps open by default (${DEFAULT_MAX_OPEN_SEGMENTS}): a read of a segment ` +
        'the reader evicted opens it again, a pointer and a tail read, which this does not price. Raise ' +
        'cache.readerMax, and cache.readerMaxBytes, to keep them open.'
      : null,
    ...(retirementsPerMonth > 0 || purgesPerMonth > 0
      ? [
          `Retention sweep modeled: ${retirementsPerMonth}/mo retirements at ${sweep.retirement.reads} reads, ` +
            `${sweep.retirement.writes} writes and ${sweep.retirement.deletes} delete(s) each, ${purgesPerMonth}/mo ` +
            `purges at ${sweep.purge.reads} reads, ${sweep.purge.writes} writes and ${sweep.purge.deletes} ` +
            'delete(s) each; reads are priced at the GET rate and writes at the PUT rate, deletes at nothing, as S3 ' +
            'bills none' +
            (conditionalDelete
              ? '.'
              : '; a registry that only tombstones is read again, two reads per purged segment, by every later ' +
                'full sweep, which is not priced.'),
        ]
      : []),
    ...(input.extraNotes ?? []),
    // Last, so the notes a report already carried keep their places.
    redisNote,
  ].filter((n): n is string => n !== null);

  return {
    monthlyUSD: {
      byOp: {
        reads: readsUSD,
        intersects: intersectsUSD,
        storage: storageUSD,
        loads: loadsUSD,
        pointerRefresh: refreshUSD,
        retention: retentionUSD,
      },
      total,
    },
    redisBaseline:
      sized === undefined
        ? { basis: 'fixed', monthlyUSD: baselineUSD }
        : {
            basis: 'sized-to-data',
            monthlyUSD: baselineUSD,
            cluster: {
              nodeType: sized.cluster.nodeType.name,
              shards: sized.cluster.shards,
              nodes: sized.cluster.nodes,
              dataTiering,
            },
          },
    redisCrossover: { readsPerSec: readsCross },
    verdict,
    rationale,
    assumptions: { cacheHitRate, pricingName: pricing.name, grounded, notes },
  };
}

/**
 * **Planning** cost estimate — pure, no instance or live data needed (sizing, sales, what-if). Segment sizes
 * are taken as given (or roughly derived from cardinality); use the grounded `segment.costReport()` for
 * exact, real sizes. See {@link CostReport}.
 */
export function estimateCost(input: EstimateInput): CostReport {
  const pricing = input.pricing ?? AWS_US_EAST_1_ONDEMAND;
  const workload = input.workload ?? {};
  let storageBytes = 0;
  let sizesFromCardinality = false;
  for (const spec of input.segments) {
    const count = Math.floor(requireFiniteNonNeg(spec.count ?? 1, 'segment.count'));
    storageBytes += sizingBytes(spec) * count;
    if (
      spec.sizeBytes === undefined &&
      spec.cardinality !== undefined &&
      sizingBytes(spec) * count > 0
    ) {
      sizesFromCardinality = true;
    }
  }
  return buildReport({ storageBytes, workload, pricing, grounded: false, sizesFromCardinality });
}

/**
 * **Grounded** report from a real segment byte total (from the `.crbm` index) + a supplied workload. Used by
 * `Segment.costReport()` in the facade. `grounded` defaults to true (the size is exact, not estimated); the
 * caller passes `grounded: false` + a note when the Storage source can't measure size.
 */
export function groundedReport(input: {
  readonly storageBytes: number;
  readonly grounded?: boolean;
  readonly workload?: Workload;
  readonly pricing?: PricingProfile;
  readonly extraNotes?: readonly string[];
}): CostReport {
  return buildReport({
    storageBytes: input.storageBytes,
    workload: input.workload ?? {},
    pricing: input.pricing ?? AWS_US_EAST_1_ONDEMAND,
    grounded: input.grounded ?? true,
    extraNotes: input.extraNotes,
  });
}
