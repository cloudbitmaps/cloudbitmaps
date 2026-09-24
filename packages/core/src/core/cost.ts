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
 * reader pays; the requests of a load (the object's write, and the listings and pointer reads and write
 * `store.load()` makes around it); and storage. Same-region egress is treated as free and internet egress is not
 * modeled; request cost is derived from the supplied workload rates (deriving it from live metrics counters is a
 * later refinement). There is no per-write term because the loaded store has no per-id write: data arrives as
 * generations, and a generation is a load.
 *
 * Every request count below is one the engine makes, and `tests/core/cost.test.ts` holds each to the engine by
 * counting what it sends: the model is only as honest as those counts, and they move when the engine does. They
 * are for a single-bucket store, where the pointer is an object beside the data, which is the topology that
 * ships. The estimator once priced a load as the object's PUT alone and an intersect as its chunk reads alone,
 * which a real-cloud run showed under-quoted a load by more than half and left out a pointer read and an index
 * read for every operand.
 *
 * The counts are S3's, and one reader process's. On GCS and Azure Blob a read that needs the object's size — a
 * pointer read, and a segment's tail read — is two requests, the metadata and then the bytes, which
 * {@link PricingProfile} carries as `requestsPerSizedRead`. A fleet of reader processes pays the pointer refresh
 * once per process, which {@link Workload.readerProcesses} carries. Where the model still quotes low is listed on
 * {@link Workload.hotSegments} and {@link Workload.chunksPerIntersect}.
 */
import { ValidationError } from './errors';
import { DEFAULT_CURRENT_GEN_TTL_MS, DEFAULT_MAX_OPEN_SEGMENTS } from './reader-defaults';

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
     * Requests one read costs when it needs the object's size first: a pointer read, and a segment's tail read.
     * Default **1**, S3's, whose suffix-range GET returns the size with the bytes. **2** on GCS and Azure Blob,
     * which read the metadata and then the bytes. A chunk read knows its range, and is one request everywhere.
     */
    readonly requestsPerSizedRead?: number;
  };
  /** The always-on baseline to compare against (e.g. an ElastiCache HA cluster). */
  readonly redis: { readonly monthlyUSD: number };
}

/**
 * Default profile — **AWS us-east-1, on-demand**, mid-2026, from the fact-checked
 * published pricing rather than copied from a blog post. Override it for your region, cloud, or committed term.
 */
export const AWS_US_EAST_1_ONDEMAND: PricingProfile = {
  name: 'aws-us-east-1-ondemand',
  storage: { getPerMillion: 0.4, putPerMillion: 5.0, storagePerGiBMonth: 0.023 },
  redis: { monthlyUSD: 346 }, // ElastiCache HA: 1 primary + 2 replicas (cache.m7g.large); ~$115 single-node
};

export const DEFAULT_PRICING: PricingProfile = AWS_US_EAST_1_ONDEMAND;

/** Sustained access pattern. All rates default to 0; unspecified ⇒ that op contributes nothing. */
export interface Workload {
  /**
   * Point reads (`has`) per second. Each cache miss is one object GET, once the segment's pointer and index are
   * read.
   */
  readonly readsPerSec?: number;
  readonly intersectsPerSec?: number;
  /** CACHE-cache hit rate in `[0, 1]` — hits are free; only misses cost. Default 0. */
  readonly cacheHitRate?: number;
  /**
   * Storage chunks one intersection fetches, summed over its operands: the chunk-skipping survivors. Default 1.
   * Two segments sharing `k` chunks fetch `2k`. The model adds each operand's pointer and index reads itself (see
   * {@link Workload.operandsPerIntersect}), so count chunks only. One more GET per operand whose index outgrows
   * the reader's tail read (256 KiB by default), which then reads the index whole, belongs here too, and so does a
   * pointer re-read by an intersect slow enough to outlive {@link Workload.genTtlMs}.
   */
  readonly chunksPerIntersect?: number;
  /**
   * Segments each intersection reads, `exclude` operands included; at least 1. Default 2. An intersection is priced
   * **cold**: before its chunks, each operand's pointer is read, then its index, in one read of the object's tail —
   * 2 GETs an operand, so a cold intersect of two segments sharing `k` chunks is `4 + 2k` GETs. `cacheHitRate`
   * does not apply to intersections, so a long-lived reader that answers a repeat from its cache pays less. Other
   * combines read their operands the same way and can be priced here too, with the chunks they fetch.
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
   * object sizes. The model adds what `store.load()` does around the write: two listings and the pointer's write,
   * PUT-class on S3, and nine GETs, the pointer read eight times and the current generation's index once. That is
   * a segment with two generations behind it; its first load makes two fewer GETs, and its second one fewer. On
   * S3 at the default prices a single-part `store.load()` is then about $23.60 per million. A segment whose index
   * outgrows the tail read makes one more GET, and a publish that loses a race to another writer reads the
   * pointer again.
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
   * default; `segment.costReport()` uses the store's. `0` pins each pointer for as long as the reader keeps the
   * segment open, which is then not refreshed.
   */
  readonly genTtlMs?: number;
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
    };
    readonly total: number;
  };
  /**
   * Sustained read rate at which the pay-per-use model's cost passes the flat Redis baseline, **evaluated at this
   * report's `cacheHitRate`** — so a higher cache-hit rate raises it (cache hits are free) — with the other
   * request axes at 0, and with what keeping the data readable costs taken out of the baseline first: storage, and
   * this report's pointer refresh. Loads, the write side, are left out of it. `Infinity` means it never crosses (a
   * 100% cache-hit rate). The published anchor (~329 reads/s) is at `cacheHitRate: 0` with no refresh modeled.
   */
  readonly redisCrossover: { readonly readsPerSec: number };
  readonly verdict: 'win-big' | 'win' | 'lose-zone';
  readonly rationale: string;
  readonly assumptions: {
    readonly cacheHitRate: number;
    readonly pricingName: string;
    /** True when segment **sizes** were real (grounded `costReport`), false for a pure `estimateCost`. */
    readonly grounded: boolean;
    readonly notes: readonly string[];
  };
}

const SECONDS_PER_MONTH = 730 * 3600; // 2,628,000 — the research's convention
const GIB = 1024 ** 3;

/**
 * A cold intersection's reads for each operand before its chunks: the pointer, then the index in one tail read.
 * Both need the object's size, so each costs `requestsPerSizedRead` requests.
 */
const SIZED_READS_PER_COLD_OPERAND = 2;

/**
 * What `store.load()` adds to its object's write, as the engine makes the requests on a segment with two
 * generations behind it: PUT-class, two listings (one to number the generation, one to collect after the publish)
 * and the pointer's write; reads, eight of the pointer and one of the current generation's index, each a sized
 * read. `tests/core/cost.test.ts` holds these to the engine, and counts a segment's first load at seven reads and
 * its second at eight.
 */
const STORE_LOAD_PUT_CLASS = 3;
const STORE_LOAD_SIZED_READS = 9;

/** Fail-fast at the boundary: reject non-finite / negative inputs rather than leak NaN into the report. */
function requireFiniteNonNeg(n: number, field: string): number {
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${field} must be a finite number >= 0; got ${n}`);
  }
  return n;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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
}): CostReport {
  const { pricing, grounded } = input;
  const { storage, redis } = pricing;
  const S = SECONDS_PER_MONTH;

  // The pricing profile is a public, caller-supplied boundary input too — validate every rate that feeds
  // the report so a malformed profile fails fast rather than leaking NaN/Infinity dollars + a bogus verdict.
  requireFiniteNonNeg(storage.getPerMillion, 'pricing.storage.getPerMillion');
  requireFiniteNonNeg(storage.putPerMillion, 'pricing.storage.putPerMillion');
  requireFiniteNonNeg(storage.storagePerGiBMonth, 'pricing.storage.storagePerGiBMonth');
  requireFiniteNonNeg(redis.monthlyUSD, 'pricing.redis.monthlyUSD');
  const sizedRead = requireFiniteNonNeg(
    storage.requestsPerSizedRead ?? 1,
    'pricing.storage.requestsPerSizedRead',
  );

  const storageBytes = requireFiniteNonNeg(input.storageBytes, 'storageBytes');
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

  // Per-request unit costs (USD). Same-region egress is free; internet egress not modeled.
  const storageGetUSD = storage.getPerMillion / 1e6;
  const putUSD = storage.putPerMillion / 1e6;

  // Monthly volumes.
  const missFraction = 1 - cacheHitRate;
  const readMisses = readsPerSec * S * missFraction;
  const intersects = intersectsPerSec * S;

  // A reader re-reads a pointer only when it reads the segment after the TTL has lapsed, so the refresh is at most
  // one per hot segment per TTL, and at most one per point read. A pinned pointer (`genTtlMs: 0`) is not refreshed.
  const refreshes =
    genTtlMs > 0
      ? Math.min((readerProcesses * hotSegments * S * 1000) / genTtlMs, readsPerSec * S)
      : 0;

  const storageUSD = (storageBytes / GIB) * storage.storagePerGiBMonth;
  const readsUSD = readMisses * storageGetUSD;
  const intersectGets =
    chunksPerIntersect + SIZED_READS_PER_COLD_OPERAND * operandsPerIntersect * sizedRead;
  const intersectsUSD = intersects * intersectGets * storageGetUSD;
  const loadGets = STORE_LOAD_SIZED_READS * sizedRead;
  const loadsUSD =
    loadsPerMonth * ((requestsPerLoad + STORE_LOAD_PUT_CLASS) * putUSD + loadGets * storageGetUSD);
  const refreshUSD = refreshes * sizedRead * storageGetUSD;
  const total = readsUSD + intersectsUSD + storageUSD + loadsUSD + refreshUSD;

  // Crossover: the sustained read rate (other axes 0) where request cost alone passes the baseline less the fixed
  // monthly costs (storage and the pointer refresh), evaluated at this report's cache posture (misses).
  const headroom = Math.max(0, redis.monthlyUSD - storageUSD - refreshUSD);
  const readsCross =
    storageGetUSD > 0 && missFraction > 0
      ? headroom / (S * storageGetUSD * missFraction)
      : Infinity;

  const verdict: CostReport['verdict'] =
    total <= redis.monthlyUSD * 0.1 ? 'win-big' : total < redis.monthlyUSD ? 'win' : 'lose-zone';

  const dominant = Math.max(readsUSD, intersectsUSD, storageUSD, loadsUSD, refreshUSD);
  let driver = 'storage';
  if (dominant === readsUSD && readsUSD > 0) driver = 'point reads (object GETs)';
  else if (dominant === intersectsUSD && intersectsUSD > 0) {
    driver = 'intersections (pointer, index and chunk GETs)';
  } else if (dominant === loadsUSD && loadsUSD > 0)
    driver = 'loads (object, listing and pointer requests)';
  else if (dominant === refreshUSD && refreshUSD > 0) driver = 'the pointer refresh (object GETs)';
  const rationale =
    verdict === 'lose-zone'
      ? `pay-per-use total $${total.toFixed(2)}/mo exceeds the $${redis.monthlyUSD}/mo flat baseline; dominated by ${driver}`
      : verdict === 'win-big'
        ? `$${total.toFixed(2)}/mo — ≤10% of the $${redis.monthlyUSD}/mo baseline; dominated by ${driver}`
        : `$${total.toFixed(2)}/mo, under the $${redis.monthlyUSD}/mo baseline; dominated by ${driver}`;

  const notes = [
    'Same-region egress treated as free; internet egress is not modeled.',
    'Request cost is from the supplied workload rates (live-metrics-derived request cost is a later phase).',
    loadsPerMonth > 0
      ? `Loads modeled: ${loadsPerMonth}/mo, each ${requestsPerLoad} PUT-class request(s) for the object plus ` +
        `${STORE_LOAD_PUT_CLASS} PUT-class and ${loadGets} GETs that store.load() adds (listings, pointer, index).`
      : 'Loads are NOT modeled — set workload.loadsPerMonth (+ requestsPerLoad for multipart) to include them.',
    ...(intersects > 0
      ? [
          `Intersections priced cold: ${intersectGets} GETs each, ` +
            `${SIZED_READS_PER_COLD_OPERAND * sizedRead} for each of ${operandsPerIntersect} operand(s) plus ` +
            `${chunksPerIntersect} chunk read(s); cacheHitRate does not apply.`,
        ]
      : []),
    hotSegments > 0
      ? genTtlMs > 0
        ? `Pointer refresh modeled: ${hotSegments} hot segment(s) in each of ${readerProcesses} reader ` +
          `process(es), each re-reading its pointer at most every ${genTtlMs} ms, and at most once a point read.`
        : 'Pointer refresh: none — genTtlMs 0 pins each pointer while the reader keeps the segment open.'
      : readsPerSec > 0
        ? 'The pointer refresh is NOT modeled — set workload.hotSegments to the segments each long-lived reader ' +
          'keeps reading, and workload.readerProcesses to how many readers there are.'
        : null,
    hotSegments > DEFAULT_MAX_OPEN_SEGMENTS
      ? `More hot segments in a reader than a store keeps open by default (${DEFAULT_MAX_OPEN_SEGMENTS}): a read of a segment ` +
        'the reader evicted opens it again, a pointer and a tail read, which this does not price. Raise ' +
        'cache.readerMax, and cache.readerMaxBytes, to keep them open.'
      : null,
    ...(input.extraNotes ?? []),
  ].filter((n): n is string => n !== null);

  return {
    monthlyUSD: {
      byOp: {
        reads: readsUSD,
        intersects: intersectsUSD,
        storage: storageUSD,
        loads: loadsUSD,
        pointerRefresh: refreshUSD,
      },
      total,
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
  const pricing = input.pricing ?? DEFAULT_PRICING;
  const workload = input.workload ?? {};
  let storageBytes = 0;
  for (const spec of input.segments) {
    const count = Math.floor(requireFiniteNonNeg(spec.count ?? 1, 'segment.count'));
    storageBytes += sizingBytes(spec) * count;
  }
  return buildReport({ storageBytes, workload, pricing, grounded: false });
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
    pricing: input.pricing ?? DEFAULT_PRICING,
    grounded: input.grounded ?? true,
    extraNotes: input.extraNotes,
  });
}
