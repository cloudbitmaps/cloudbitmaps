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
 * What the model covers, and states in `assumptions.notes`: object-store GETs for reads and intersections,
 * object-store PUTs for loads, and storage. Same-region egress is treated as free and internet egress is not
 * modeled; request cost is derived from the supplied workload rates (deriving it from live metrics counters is a
 * later refinement). There is no per-write term because the loaded store has no per-id write: data arrives as
 * generations, and a generation is a load.
 */
import { ValidationError } from './errors';

/** Pluggable rate card. Rates differ by cloud/region/term and drift over time; the formulas don't. */
export interface PricingProfile {
  readonly name: string;
  readonly cold: {
    /** Object GET (per **million** requests). A ranged GET bills as a full GET. */
    readonly getPerMillion: number;
    /** Object PUT (per million) — what a load pays, per request. */
    readonly putPerMillion: number;
    readonly storagePerGiBMonth: number;
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
  redis: { monthlyUSD: 346 }, // ElastiCache HA: 1 primary + 2 replicas (cache.m7g.large); ~$115 single-node
};

export const DEFAULT_PRICING: PricingProfile = AWS_US_EAST_1_ONDEMAND;

/** Sustained access pattern. All rates default to 0; unspecified ⇒ that op contributes nothing. */
export interface Workload {
  /** Point reads (`has`) per second. Each cache miss is one object GET. */
  readonly readsPerSec?: number;
  readonly intersectsPerSec?: number;
  /** HOT-cache hit rate in `[0, 1]` — hits are free; only misses cost. Default 0. */
  readonly cacheHitRate?: number;
  /** Cold chunks fetched per intersection (the chunk-skipping survivors). Default 1. */
  readonly chunksPerIntersect?: number;
  /**
   * Generations published per month across the modeled data — the write side of a loaded store. Default **0**
   * ⇒ loads are not modeled and the report *discloses* the omission rather than silently under-reporting.
   */
  readonly loadsPerMonth?: number;
  /**
   * PUT-class requests one load issues. Default **1** (a single-object PUT). A multipart load of `P` parts bills
   * `P + 2` (initiate, the parts, complete) — set it when you know your object sizes. Still small money: at
   * $5/million, a thousand 100-part loads a month is $0.51.
   */
  readonly requestsPerLoad?: number;
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
      /** Loads (object PUTs). 0 unless `loadsPerMonth` is set. */
      readonly loads: number;
    };
    readonly total: number;
  };
  /**
   * Sustained read rate at which the pay-per-use model's cost passes the flat Redis baseline (with every other
   * axis at 0), **evaluated at this report's `cacheHitRate`** — so a higher cache-hit rate raises it (cache hits
   * are free). `Infinity` means it never crosses (a 100% cache-hit rate). The published anchor (~329 reads/s) is
   * at `cacheHitRate: 0`.
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

/** Core report builder shared by planning + grounded modes. `coldBytes` is total across all segments. */
function buildReport(input: {
  readonly coldBytes: number;
  readonly workload: Workload;
  readonly pricing: PricingProfile;
  readonly grounded: boolean;
  readonly extraNotes?: readonly string[];
}): CostReport {
  const { pricing, grounded } = input;
  const { cold, redis } = pricing;
  const S = SECONDS_PER_MONTH;

  // The pricing profile is a public, caller-supplied boundary input too — validate every rate that feeds
  // the report so a malformed profile fails fast rather than leaking NaN/Infinity dollars + a bogus verdict.
  requireFiniteNonNeg(cold.getPerMillion, 'pricing.cold.getPerMillion');
  requireFiniteNonNeg(cold.putPerMillion, 'pricing.cold.putPerMillion');
  requireFiniteNonNeg(cold.storagePerGiBMonth, 'pricing.cold.storagePerGiBMonth');
  requireFiniteNonNeg(redis.monthlyUSD, 'pricing.redis.monthlyUSD');

  const coldBytes = requireFiniteNonNeg(input.coldBytes, 'coldBytes');
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

  // Per-request unit costs (USD). Same-region egress is free; internet egress not modeled.
  const coldGetUSD = cold.getPerMillion / 1e6;
  const putUSD = cold.putPerMillion / 1e6;

  // Monthly volumes.
  const missFraction = 1 - cacheHitRate;
  const readMisses = readsPerSec * S * missFraction;
  const intersects = intersectsPerSec * S;

  const storageUSD = (coldBytes / GIB) * cold.storagePerGiBMonth;
  const readsUSD = readMisses * coldGetUSD;
  const intersectsUSD = intersects * chunksPerIntersect * coldGetUSD;
  const loadsUSD = loadsPerMonth * requestsPerLoad * putUSD;
  const total = readsUSD + intersectsUSD + storageUSD + loadsUSD;

  // Crossover: the sustained read rate (other axes 0) where request cost alone passes (redis − fixed storage),
  // evaluated at this report's cache posture (misses).
  const headroom = Math.max(0, redis.monthlyUSD - storageUSD);
  const readsCross =
    coldGetUSD > 0 && missFraction > 0 ? headroom / (S * coldGetUSD * missFraction) : Infinity;

  const verdict: CostReport['verdict'] =
    total <= redis.monthlyUSD * 0.1 ? 'win-big' : total < redis.monthlyUSD ? 'win' : 'lose-zone';

  const dominant = Math.max(readsUSD, intersectsUSD, storageUSD, loadsUSD);
  let driver = 'storage';
  if (dominant === readsUSD && readsUSD > 0) driver = 'point reads (object GETs)';
  else if (dominant === intersectsUSD && intersectsUSD > 0) driver = 'intersection chunk fetches';
  else if (dominant === loadsUSD && loadsUSD > 0) driver = 'loads (object PUTs)';
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
      ? `Loads modeled: ${loadsPerMonth}/mo × ${requestsPerLoad} PUT-class request(s) each.`
      : 'Loads are NOT modeled — set workload.loadsPerMonth (+ requestsPerLoad for multipart) to include them.',
    ...(input.extraNotes ?? []),
  ];

  return {
    monthlyUSD: {
      byOp: { reads: readsUSD, intersects: intersectsUSD, storage: storageUSD, loads: loadsUSD },
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
  let coldBytes = 0;
  for (const spec of input.segments) {
    const count = Math.floor(requireFiniteNonNeg(spec.count ?? 1, 'segment.count'));
    coldBytes += sizingBytes(spec) * count;
  }
  return buildReport({ coldBytes, workload, pricing, grounded: false });
}

/**
 * **Grounded** report from a real segment byte total (from the `.crbm` index) + a supplied workload. Used by
 * `Segment.costReport()` in the facade. `grounded` defaults to true (the size is exact, not estimated); the
 * caller passes `grounded: false` + a note when the Cold source can't measure size.
 */
export function groundedReport(input: {
  readonly coldBytes: number;
  readonly grounded?: boolean;
  readonly workload?: Workload;
  readonly pricing?: PricingProfile;
  readonly extraNotes?: readonly string[];
}): CostReport {
  return buildReport({
    coldBytes: input.coldBytes,
    workload: input.workload ?? {},
    pricing: input.pricing ?? DEFAULT_PRICING,
    grounded: input.grounded ?? true,
    extraNotes: input.extraNotes,
  });
}
