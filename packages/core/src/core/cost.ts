/**
 * Cost model & estimator (Phase 5b) — pure, `core/`-safe (no I/O, time, or
 * SDK). Turns the verified economics into a first-class library API:
 *
 * - {@link estimateCost} — **planning** mode: pure what-if from segment sizes + a workload (sizing/sales).
 * - `segment.costReport()` (wired in `index.ts`) — **grounded** mode: the segment's real size from the
 *   `.crbm` index (free + exact, no payload reads) + a supplied workload for request rates. (Whole-store
 *   aggregation is a later phase.)
 *
 * Guiding split (08 decision #3): **formulas are the spec; rates are a pluggable {@link PricingProfile}.**
 * The report always emits a {@link CostReport.verdict} that includes the lose-zone — it never hides where an
 * always-on cache (Redis) wins.
 *
 * Model scope (kept deliberately simple, and stated in `assumptions.notes`): S3→same-region egress is free
 * and internet egress is not modeled; Warm delta storage is treated as negligible (it's tiny — only dirty
 * chunks); request cost is derived from the supplied workload rates (deriving it from live metrics counters
 * is a later refinement — the cost-completeness events are deferred).
 */
import { CHUNK_COUNT } from './bit-route';
import { ValidationError } from './errors';

/** Pluggable rate card. Rates differ by cloud/region/term and drift over time; the formulas don't. */
export interface PricingProfile {
  readonly name: string;
  readonly cold: {
    /** S3 GET (per **million** requests). A ranged GET bills as a full GET. */
    readonly getPerMillion: number;
    /** S3 PUT (per million). */
    readonly putPerMillion: number;
    readonly storagePerGiBMonth: number;
  };
  readonly warm: {
    /** DynamoDB read-request-units (per million). */
    readonly rruPerMillion: number;
    /** DynamoDB write-request-units (per million). **0 models a provisioned/flat tier** (no per-write charge). */
    readonly wruPerMillion: number;
    /** KiB billed per read unit (DynamoDB: 4). */
    readonly readUnitKiB: number;
    /** KiB billed per write unit (DynamoDB: 1 — the write cost driver). */
    readonly writeUnitKiB: number;
    readonly storagePerGiBMonth: number;
    /** Strongly-consistent reads bill 1 RRU/unit; eventually-consistent bill 0.5. */
    readonly stronglyConsistent: boolean;
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
  cold: { getPerMillion: 0.4, putPerMillion: 5.0, storagePerGiBMonth: 0.023 },
  warm: {
    rruPerMillion: 0.125,
    wruPerMillion: 0.625,
    readUnitKiB: 4,
    writeUnitKiB: 1,
    storagePerGiBMonth: 0.25,
    stronglyConsistent: true,
  },
  redis: { monthlyUSD: 346 }, // ElastiCache HA: 1 primary + 2 replicas (cache.m7g.large); ~$115 single-node
};

export const DEFAULT_PRICING: PricingProfile = AWS_US_EAST_1_ONDEMAND;

/** Which write path is live. `A` = Hot+Cold read-mostly (writes via bulk-load); `B` = live Warm writes. */
export type Topology = 'A' | 'B';

/** Sustained access pattern. All rates default to 0; unspecified ⇒ that op contributes nothing. */
export interface Workload {
  readonly readsPerSec?: number;
  readonly writesPerSec?: number;
  readonly intersectsPerSec?: number;
  /** HOT-cache hit rate in `[0, 1]` — hits are free; only misses cost. Default 0. */
  readonly cacheHitRate?: number;
  /** Avg serialized chunk/item size (KiB) — drives read/write units. Default 8 (a full roaring bitmap container). */
  readonly avgItemKiB?: number;
  /** Cold chunks fetched per intersection (the chunk-skipping survivors). Default 1. */
  readonly chunksPerIntersect?: number;
  /**
   * Compaction cycles per month across the modeled data (gap #10). Default **0** ⇒ compaction is not modeled
   * and the report *discloses* the omission (rather than silently under-reporting). Set it to fold in the
   * background job that usually dominates operational cost.
   */
  readonly compactionsPerMonth?: number;
  /**
   * Cold chunks re-read per compaction cycle — the whole generation (clean chunks are copied through, 1 GET
   * each). Default: derived from `coldBytes / avgItemKiB` (i.e. the whole modeled cold set is one generation —
   * exact for a single-segment/grounded report; for a multi-segment fleet set this to your *per-segment* chunk
   * count). This whole-generation re-read is the dominant compaction term.
   */
  readonly chunksPerCompaction?: number;
  /** Dirty Warm rows purged per compaction — the secondary RRU-read + WRU-delete term. Default 0. */
  readonly dirtyChunksPerCompaction?: number;
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
  readonly topology?: Topology;
  readonly pricing?: PricingProfile;
}

/**
 * A self-relative cost hint. See {@link CostReport.advisories}.
 *
 * `code` is the stable, machine-readable identity — branch on it rather than parsing `message`.
 */
export interface CostAdvisory {
  /**
   * `'batchable-writes'` — the modeled write count far exceeds the number of distinct Warm rows the data can
   * occupy, so each row is being rewritten many times over. If those ids ever arrive together, `addMany()`
   * collapses them to one write per chunk and bulk-load writes Cold directly.
   */
  readonly code: 'batchable-writes';
  /** Human-readable, safe to log or print. Carries the numbers that triggered it. */
  readonly message: string;
  /** The modeled cost of the term this advisory is about (USD/month). */
  readonly currentUSD: number;
  /**
   * A **floor**, not a promise: the same term if the writes were perfectly batched into one write per distinct
   * Warm row. Real batching lands between this and {@link CostAdvisory.currentUSD}, depending on how the ids
   * actually arrive — which the estimator cannot know.
   */
  readonly batchedFloorUSD: number;
}

export interface CostReport {
  readonly monthlyUSD: {
    readonly byTier: { readonly hot: number; readonly warm: number; readonly cold: number };
    readonly byOp: {
      readonly reads: number;
      readonly writes: number;
      readonly intersects: number;
      readonly storage: number;
      /** Background compaction (whole-generation re-read + PUT + Warm purge). 0 unless `compactionsPerMonth` is set. */
      readonly compaction: number;
    };
    readonly total: number;
  };
  /**
   * Sustained rate at which the pay-per-use model's cost passes the flat Redis baseline (per axis, the other
   * at 0), **evaluated at this report's `cacheHitRate` + `avgItemKiB`** — so a higher cache-hit rate raises
   * `readsPerSec` (cache hits are free). `Infinity` means that axis never crosses (e.g. a flat/provisioned
   * tier, or a 100% cache-hit rate). The published anchors (~26 writes/s, ~329 reads/s) are at `cacheHitRate: 0`.
   */
  readonly redisCrossover: { readonly writesPerSec: number; readonly readsPerSec: number };
  readonly verdict: 'win-big' | 'win' | 'lose-zone';
  readonly rationale: string;
  /**
   * Zero or more **self-relative** hints: places this workload is paying more than *this same library* would
   * charge for the same outcome. Distinct from {@link CostReport.verdict}, which only compares against the flat
   * Redis baseline — a workload can beat Redis by 40× and still be 100× more expensive than it needs to be, and
   * the verdict alone would call that `win-big` and say nothing.
   *
   * Empty is the normal case. Advisories never change the dollar figures; they are additive commentary, and each
   * carries a machine-readable {@link CostAdvisory.code} so consumers don't string-match.
   */
  readonly advisories: readonly CostAdvisory[];
  readonly assumptions: {
    readonly cacheHitRate: number;
    readonly pricingName: string;
    /** True when segment **sizes** were real (grounded `costReport`), false for a pure `estimateCost`. */
    readonly grounded: boolean;
    readonly topology: Topology;
    readonly notes: readonly string[];
  };
}

const SECONDS_PER_MONTH = 730 * 3600; // 2,628,000 — the research's convention
const GIB = 1024 ** 3;

/** Fail-fast at the boundary: reject non-finite / negative inputs rather than leak NaN into the report. */
function requireFiniteNonNeg(n: number, field: string): number {
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${field} must be a finite number >= 0; got ${n}`);
  }
  return n;
}

/** As above, but for divisors that must be strictly positive (a 0-KiB unit would divide to Infinity). */
function requireFinitePos(n: number, field: string): number {
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field} must be a finite number > 0; got ${n}`);
  }
  return n;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Rough bytes for a segment when only cardinality is known: 2 B/value (array-container upper bound, B6/B7). */
function sizingBytes(spec: SegmentSizing): number {
  if (spec.sizeBytes !== undefined) return requireFiniteNonNeg(spec.sizeBytes, 'segment.sizeBytes');
  if (spec.cardinality !== undefined) {
    return requireFiniteNonNeg(spec.cardinality, 'segment.cardinality') * 2;
  }
  return 0;
}

/**
 * Fire `batchable-writes` only once a Warm row is being rewritten at least this many times over the month.
 * Below it there is little to amortize — at a ratio of 1 you are already at one write per row.
 */
const BATCHABLE_WRITE_RATIO = 8;

/**
 * …and only when acting on it is worth real money. Without this the advisory nags about pennies on any
 * write-shaped workload, and an advisory that cries wolf is worse than no advisory at all.
 */
const BATCHABLE_MIN_SAVINGS_USD = 1;

/**
 * Derive the self-relative advisories. **Pure** — no I/O, clock, or randomness, so it stays inside the
 * deterministic core seam and is directly unit-testable.
 *
 * `maxWarmRows` must be a HARD upper bound on the distinct Warm rows the modeled data can occupy, never an
 * estimate. That direction matters: the trigger is `writes / maxWarmRows`, so *over*-stating the bound makes the
 * advisory quieter (a false negative — it misses a case it could have flagged) while *under*-stating it makes the
 * advisory fire on workloads that are already optimal (a false positive, which trains people to ignore it). The
 * bound is therefore taken from the id space itself — a 16-bit chunk key means at most {@link CHUNK_COUNT} rows
 * per segment — tightened by declared cardinality only, which cannot exceed the row count either. Byte-derived
 * cardinality is deliberately NOT used: `sizingBytes`'s 2 B/value convention understates a dense bitmap
 * container by ~16×, which would understate the bound and produce exactly the false positives above.
 */
function deriveAdvisories(input: {
  readonly writes: number;
  readonly writesUSD: number;
  readonly maxWarmRows: number;
  readonly warmWriteUSD: number;
}): readonly CostAdvisory[] {
  const { writes, writesUSD, maxWarmRows, warmWriteUSD } = input;
  const out: CostAdvisory[] = [];

  if (writes > 0 && writesUSD > 0 && maxWarmRows > 0) {
    const ratio = writes / maxWarmRows;
    const batchedFloorUSD = maxWarmRows * warmWriteUSD;
    const savings = writesUSD - batchedFloorUSD;
    if (ratio >= BATCHABLE_WRITE_RATIO && savings >= BATCHABLE_MIN_SAVINGS_USD) {
      out.push({
        code: 'batchable-writes',
        message:
          `${Math.round(writes).toLocaleString('en-US')} writes/mo against data occupying at most ` +
          `${maxWarmRows.toLocaleString('en-US')} Warm rows — each row rewritten ~${Math.round(ratio).toLocaleString('en-US')}× ` +
          `($${writesUSD.toFixed(2)}/mo). IF these ids ever arrive together, addMany() collapses them to one ` +
          `write per chunk and bulkLoadCrbmGeneration writes Cold directly, taking the write term toward ` +
          `$${batchedFloorUSD.toFixed(2)}/mo. If they genuinely arrive one at a time (real-time qualification), ` +
          `add() is the correct path and this is simply what it costs.`,
        currentUSD: writesUSD,
        batchedFloorUSD,
      });
    }
  }

  return out;
}

/** Core report builder shared by planning + grounded modes. `coldBytes` is total across all segments. */
function buildReport(input: {
  readonly coldBytes: number;
  readonly workload: Workload;
  readonly topology: Topology;
  readonly pricing: PricingProfile;
  readonly grounded: boolean;
  readonly extraNotes?: readonly string[];
  /** Hard upper bound on distinct Warm rows the modeled data can occupy. See {@link deriveAdvisories}. */
  readonly maxWarmRows: number;
}): CostReport {
  const { topology, pricing, grounded } = input;
  const { cold, warm, redis } = pricing;
  const S = SECONDS_PER_MONTH;

  // The pricing profile is a public, caller-supplied boundary input too — validate every rate that feeds
  // the report so a malformed profile fails fast rather than leaking NaN/Infinity dollars + a bogus verdict.
  requireFiniteNonNeg(cold.getPerMillion, 'pricing.cold.getPerMillion');
  requireFiniteNonNeg(cold.putPerMillion, 'pricing.cold.putPerMillion'); // now consumed by the compaction term
  requireFiniteNonNeg(cold.storagePerGiBMonth, 'pricing.cold.storagePerGiBMonth');
  requireFiniteNonNeg(warm.rruPerMillion, 'pricing.warm.rruPerMillion');
  requireFiniteNonNeg(warm.wruPerMillion, 'pricing.warm.wruPerMillion');
  requireFinitePos(warm.readUnitKiB, 'pricing.warm.readUnitKiB');
  requireFinitePos(warm.writeUnitKiB, 'pricing.warm.writeUnitKiB');
  requireFiniteNonNeg(redis.monthlyUSD, 'pricing.redis.monthlyUSD');

  const coldBytes = requireFiniteNonNeg(input.coldBytes, 'coldBytes');
  const cacheHitRate = clamp01(
    requireFiniteNonNeg(input.workload.cacheHitRate ?? 0, 'cacheHitRate'),
  );
  const readsPerSec = requireFiniteNonNeg(input.workload.readsPerSec ?? 0, 'readsPerSec');
  const writesPerSec = requireFiniteNonNeg(input.workload.writesPerSec ?? 0, 'writesPerSec');
  const intersectsPerSec = requireFiniteNonNeg(
    input.workload.intersectsPerSec ?? 0,
    'intersectsPerSec',
  );
  const avgItemKiB = requireFiniteNonNeg(input.workload.avgItemKiB ?? 8, 'avgItemKiB');
  const chunksPerIntersect = requireFiniteNonNeg(
    input.workload.chunksPerIntersect ?? 1,
    'chunksPerIntersect',
  );
  const compactionsPerMonth = requireFiniteNonNeg(
    input.workload.compactionsPerMonth ?? 0,
    'compactionsPerMonth',
  );
  const avgItemBytes = avgItemKiB * 1024;
  const derivedChunks = avgItemBytes > 0 ? Math.ceil(coldBytes / avgItemBytes) : 0;
  const chunksPerCompaction = requireFiniteNonNeg(
    input.workload.chunksPerCompaction ?? derivedChunks,
    'chunksPerCompaction',
  );
  const dirtyChunksPerCompaction = requireFiniteNonNeg(
    input.workload.dirtyChunksPerCompaction ?? 0,
    'dirtyChunksPerCompaction',
  );

  // Per-op unit costs (USD). `Math.max(1, ...)` enforces DynamoDB's ≥1-unit-per-request billing.
  const rruMult = warm.stronglyConsistent ? 1 : 0.5;
  const warmReadUSD =
    Math.max(1, Math.ceil(avgItemKiB / warm.readUnitKiB)) * rruMult * (warm.rruPerMillion / 1e6);
  const warmWriteUSD =
    Math.max(1, Math.ceil(avgItemKiB / warm.writeUnitKiB)) * (warm.wruPerMillion / 1e6);
  const coldGetUSD = cold.getPerMillion / 1e6; // same-region egress is free; internet egress not modeled

  // Monthly op volumes.
  const missFraction = 1 - cacheHitRate;
  const readMisses = readsPerSec * S * missFraction;
  const writes = writesPerSec * S;
  const intersects = intersectsPerSec * S;

  // Storage (monthly, exact when grounded). Warm delta storage is treated as negligible (only dirty chunks).
  const storageUSD = (coldBytes / GIB) * cold.storagePerGiBMonth;

  // Request costs by op. Topology-A reads hit Cold (S3 GET); Topology-B reads hit the Warm tier; Topology-A
  // has no per-op writes (writes arrive via bulk-load). Intersection fetches the surviving Cold chunks.
  const readsUSD = topology === 'A' ? readMisses * coldGetUSD : readMisses * warmReadUSD;
  const writesUSD = topology === 'B' ? writes * warmWriteUSD : 0;
  const intersectsUSD = intersects * chunksPerIntersect * coldGetUSD;

  // Compaction (gap #10): per cycle, re-read the whole generation (chunksPerCompaction Cold GETs — the
  // dominant term), write one new `.crbm` (a PUT), and purge the dirty Warm rows (an RRU read + a WRU delete).
  // Same-region GET/PUT egress is free; the GC delete of the superseded generation is free (not modeled).
  const putUSD = cold.putPerMillion / 1e6;
  const compactionColdUSD = compactionsPerMonth * (chunksPerCompaction * coldGetUSD + putUSD);
  const compactionWarmUSD =
    compactionsPerMonth * dirtyChunksPerCompaction * (warmReadUSD + warmWriteUSD);
  const compactionUSD = compactionColdUSD + compactionWarmUSD;

  const total = readsUSD + writesUSD + intersectsUSD + storageUSD + compactionUSD;

  const warmTierUSD = (topology === 'B' ? readsUSD + writesUSD : 0) + compactionWarmUSD;
  const coldTierUSD =
    storageUSD + (topology === 'A' ? readsUSD : 0) + intersectsUSD + compactionColdUSD;

  // Crossovers: sustained rate (other axis 0) where request cost alone passes (redis − fixed storage),
  // evaluated at this report's cache posture (misses) and item size (units).
  const headroom = Math.max(0, redis.monthlyUSD - storageUSD);
  const perReadUSD = topology === 'A' ? coldGetUSD : warmReadUSD;
  const writesCross =
    topology === 'B' && warmWriteUSD > 0 ? headroom / (S * warmWriteUSD) : Infinity;
  const readsCross =
    perReadUSD > 0 && missFraction > 0 ? headroom / (S * perReadUSD * missFraction) : Infinity;

  const verdict: CostReport['verdict'] =
    total <= redis.monthlyUSD * 0.1 ? 'win-big' : total < redis.monthlyUSD ? 'win' : 'lose-zone';

  const dominant = Math.max(readsUSD, writesUSD, intersectsUSD, storageUSD, compactionUSD);
  let driver = 'storage';
  if (dominant === writesUSD && writesUSD > 0)
    driver = 'warm writes (the per-1KiB WRU cost driver)';
  else if (dominant === readsUSD && readsUSD > 0)
    driver = topology === 'A' ? 'cold reads (S3 GETs)' : 'warm reads';
  else if (dominant === intersectsUSD && intersectsUSD > 0) driver = 'intersection cold fetches';
  else if (dominant === compactionUSD && compactionUSD > 0)
    driver = 'compaction (whole-generation re-read)';
  const rationale =
    verdict === 'lose-zone'
      ? `pay-per-use total $${total.toFixed(2)}/mo exceeds the $${redis.monthlyUSD}/mo flat baseline; dominated by ${driver}`
      : verdict === 'win-big'
        ? `$${total.toFixed(2)}/mo — ≤10% of the $${redis.monthlyUSD}/mo baseline; dominated by ${driver}`
        : `$${total.toFixed(2)}/mo, under the $${redis.monthlyUSD}/mo baseline; dominated by ${driver}`;

  const notes = [
    'S3→same-region egress treated as free; internet egress is not modeled.',
    'Warm delta storage treated as negligible (only dirty chunks).',
    'Request cost is from the supplied workload rates (live-metrics-derived request cost is a later phase).',
    compactionsPerMonth > 0
      ? `Compaction modeled: ${compactionsPerMonth}/mo × (${chunksPerCompaction} Cold GET + 1 PUT${dirtyChunksPerCompaction > 0 ? ` + ${dirtyChunksPerCompaction}-row Warm purge` : ''}); the whole-generation re-read dominates. GC delete of the superseded generation is free (not modeled).`
      : 'Compaction is NOT modeled — set workload.compactionsPerMonth (+ chunksPerCompaction) to include the whole-generation re-read that dominates operational cost.',
    ...(input.extraNotes ?? []),
  ];

  return {
    monthlyUSD: {
      byTier: { hot: 0, warm: warmTierUSD, cold: coldTierUSD },
      byOp: {
        reads: readsUSD,
        writes: writesUSD,
        intersects: intersectsUSD,
        storage: storageUSD,
        compaction: compactionUSD,
      },
      total,
    },
    redisCrossover: { writesPerSec: writesCross, readsPerSec: readsCross },
    verdict,
    rationale,
    // Topology-A has no per-op writes (they arrive via bulk-load), so `writesUSD` is 0 there and the advisory
    // cannot fire — correctly, since bulk-load is already the batched path.
    advisories: deriveAdvisories({
      writes,
      writesUSD,
      maxWarmRows: requireFiniteNonNeg(input.maxWarmRows, 'maxWarmRows'),
      warmWriteUSD,
    }),
    assumptions: { cacheHitRate, pricingName: pricing.name, grounded, topology, notes },
  };
}

/**
 * **Planning** cost estimate — pure, no instance or live data needed (sizing, sales, what-if). Segment sizes
 * are taken as given (or roughly derived from cardinality); use the grounded `segment.costReport()` for
 * exact, real sizes. See {@link CostReport}.
 */
export function estimateCost(input: EstimateInput): CostReport {
  const topology = input.topology ?? 'A';
  const pricing = input.pricing ?? DEFAULT_PRICING;
  const workload = input.workload ?? {};
  let coldBytes = 0;
  // Hard bound on distinct Warm rows: a 16-bit chunk key caps a segment at CHUNK_COUNT rows, and a segment can
  // never occupy more rows than it holds ids — so declared `cardinality` tightens it. `sizeBytes`-only specs get
  // the un-tightened cap rather than a byte-derived guess, which would understate it (see `deriveAdvisories`).
  let maxWarmRows = 0;
  for (const spec of input.segments) {
    const count = Math.floor(requireFiniteNonNeg(spec.count ?? 1, 'segment.count'));
    coldBytes += sizingBytes(spec) * count;
    const perSegment =
      spec.cardinality !== undefined
        ? Math.min(
            Math.floor(requireFiniteNonNeg(spec.cardinality, 'segment.cardinality')),
            CHUNK_COUNT,
          )
        : CHUNK_COUNT;
    maxWarmRows += perSegment * count;
  }
  return buildReport({ coldBytes, workload, topology, pricing, grounded: false, maxWarmRows });
}

/**
 * **Grounded** report from a real segment byte total (from the `.crbm` index) + a supplied workload. Used by
 * `Segment.costReport()` in `index.ts`. `grounded` defaults to true (the size is exact, not estimated); the
 * caller passes `grounded: false` + a note when the Cold source can't measure size.
 */
export function groundedReport(input: {
  readonly coldBytes: number;
  readonly grounded?: boolean;
  readonly workload?: Workload;
  readonly topology?: Topology;
  readonly pricing?: PricingProfile;
  readonly extraNotes?: readonly string[];
  /**
   * Hard upper bound on distinct Warm rows, for the advisories. Defaults to {@link CHUNK_COUNT} — this models
   * ONE segment, and a 16-bit chunk key caps a segment there. `SegmentSize` carries only `sizeBytes` today, so
   * an exact per-segment chunk count would need a driver-interface change; the id-space cap needs nothing and is
   * sound in the safe direction (it can only make the advisory quieter).
   */
  readonly maxWarmRows?: number;
}): CostReport {
  return buildReport({
    coldBytes: input.coldBytes,
    workload: input.workload ?? {},
    topology: input.topology ?? 'A',
    pricing: input.pricing ?? DEFAULT_PRICING,
    grounded: input.grounded ?? true,
    extraNotes: input.extraNotes,
    maxWarmRows: input.maxWarmRows ?? CHUNK_COUNT,
  });
}
