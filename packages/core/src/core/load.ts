/**
 * `loadSegment` — the loaded store's primary write path, as one call.
 *
 * A load is always the same four steps: take the next generation number, write one immutable object, move the
 * pointer, collect what the move superseded. Done by hand they are `nextGeneration` + `bulkLoadCrbmGeneration` +
 * `publishGeneration` + `gcOrphanGenerations`, and the step people leave out is the last one — so stores that
 * compose it themselves accumulate superseded generations they keep paying for. Composing it here is the point.
 *
 * The other reason it is one call is the **guard**. A load REPLACES a segment: whatever the stream contains is
 * what the segment contains afterwards. That makes an upstream query returning fewer rows than usual — or none —
 * a silent, successful-looking wipe, and nothing downstream can tell it from a legitimate shrink. The guard is
 * the place to say what a plausible result looks like, and it has to sit **between the write and the publish**,
 * because that is the only moment where the new content is known and the old one is still authoritative.
 *
 * Refusing therefore has to clean up after itself. The object is already durable at that point, and it sits
 * ABOVE `currentGen`, where generation collection deliberately never looks (it deletes strictly below the
 * pointer). Nothing else would ever reclaim it, so a refused load deletes its own object before returning.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import type { CodecInterface } from './codec';
import {
  bulkLoadCrbmGeneration,
  openGenerationReader,
  publishGeneration,
} from './crbm-cold-source';
import type { Clock } from './determinism';
import type { CrbmCrypto, IKeystore } from './crypto';
import { ValidationError } from './errors';
import { gcOrphanGenerations, nextGeneration } from './generation-gc';
import type { IColdDriver, IRegistryDriver, SegmentRef } from './ports';
import { validateSegmentRef } from './validate';

/** What {@link loadSegment} needs: the objects, the pointer, the codec, and key material if encrypted. */
export interface LoadDeps {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
  readonly codec?: CodecInterface;
  readonly keystore?: IKeystore;
  readonly requireEncryption?: boolean;
  readonly clock?: Clock;
  readonly crypto?: CrbmCrypto;
}

/**
 * What a plausible result looks like, so an implausible one is refused instead of published.
 *
 * Both bounds are compared against the **current** generation's cardinality, read from the `.crbm` index rather
 * than its payload — one object-header read, and only when a bound is actually set.
 */
export interface LoadGuard {
  /** Refuse a generation with fewer than this many ids. Use for "this segment is never legitimately tiny". */
  readonly minCardinality?: number;
  /**
   * Refuse a generation that drops more than this fraction of the current one — `0.5` refuses losing more than
   * half. A *growing* load is never refused by this bound, and neither is the first load of a segment, which has
   * nothing to shrink from.
   */
  readonly maxShrink?: number;
}

export interface LoadOptions {
  /**
   * Publish an empty generation over a non-empty one. Off by default: an empty result is far more often an
   * upstream failure than an intent, and the failure is indistinguishable from success once it lands.
   */
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  /** Generations to keep below the new pointer as a grace window (default 1) — see the `keep` sizing guidance. */
  readonly keep?: number;
  readonly audit?: IAuditSink;
}

/** Why a load did not become current. */
export type LoadRefusal =
  | 'empty'
  | 'min-cardinality'
  | 'max-shrink'
  /** Another writer published a higher generation first. The object was written, then removed. */
  | 'superseded';

export interface LoadResult {
  /** The generation written. Present even when refused — it is what was deleted again. */
  readonly generation: number;
  /** Whether this generation is now the segment's current one. */
  readonly published: boolean;
  /** Set only when `published` is false. */
  readonly reason?: LoadRefusal;
  readonly size: number;
  readonly sha256: string;
  readonly chunkCount: number;
  /** Distinct ids in the generation that was written, post-dedup. */
  readonly cardinality: number;
  /** The superseded generations collected after publishing. Empty when nothing was published. */
  readonly collected: readonly number[];
}

/** Cardinality of the segment's current generation, from the index. `null` when there is no current generation. */
async function currentCardinality(
  ref: SegmentRef,
  deps: LoadDeps,
  crypto: CrbmCrypto | undefined,
): Promise<number | null> {
  const record = await deps.registry.get(ref);
  if (record === null || record.currentGen === null || record.status === 'destroyed') return null;
  const reader = await openGenerationReader(
    deps.cold,
    { ...ref, generation: record.currentGen },
    crypto,
  );
  let total = 0;
  for (const n of reader.cardinalities().values()) total += n;
  return total;
}

/**
 * Replace a segment's contents with `ids`, as one immutable generation, and make it current.
 *
 * Returns what was written and whether it became current. A refusal is **not** an exception: `published: false`
 * with a `reason` is a normal outcome a caller branches on, in the same shape as a successful load, because the
 * interesting cases (a guard tripped, a racing writer won) are operational facts rather than faults.
 */
export async function loadSegment(
  ref: SegmentRef,
  ids: Iterable<number> | AsyncIterable<number>,
  deps: LoadDeps,
  options: LoadOptions = {},
): Promise<LoadResult> {
  validateSegmentRef(ref);
  const keep = options.keep ?? 1;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new ValidationError(`keep must be a non-negative integer; got ${String(keep)}`);
  }
  const guard = options.guard;
  if (guard?.minCardinality !== undefined) {
    const m = guard.minCardinality;
    if (!Number.isInteger(m) || m < 0) {
      throw new ValidationError(
        `guard.minCardinality must be a non-negative integer; got ${String(m)}`,
      );
    }
  }
  if (guard?.maxShrink !== undefined) {
    const s = guard.maxShrink;
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new ValidationError(`guard.maxShrink must be a fraction in 0..1; got ${String(s)}`);
    }
  }
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);

  // Read the "before" cardinality ONLY when a bound needs it. The empty guard needs to know whether the current
  // generation is non-empty; `maxShrink` needs its size. `minCardinality` compares against the new generation
  // alone, so it costs nothing extra. A load with no guard and `allowEmpty` pays for no extra read at all.
  const needsBefore = guard?.maxShrink !== undefined || options.allowEmpty !== true;
  const before = needsBefore ? await currentCardinality(ref, deps, deps.crypto) : null;

  const generation = await nextGeneration(ref, deps);
  const key = { namespace: ref.namespace, segment: ref.segment, generation };

  // `publish: false`, deliberately: the guard has to run while the old generation is still authoritative, so the
  // pointer moves below rather than here. The registry is still passed — it is where an existing encrypted
  // segment's DEK lives, and reusing that key is not optional — and the freshly minted one comes back on the
  // result so the deferred publish can store it.
  const written = await bulkLoadCrbmGeneration(deps.cold, key, ids, {
    registry: deps.registry,
    publish: false,
    keystore: deps.keystore,
    requireEncryption: deps.requireEncryption,
    codec: deps.codec,
    clock: deps.clock,
  });

  const refuse = async (reason: LoadRefusal): Promise<LoadResult> => {
    // The object is durable and sits above `currentGen`, where collection never looks. Nothing else would ever
    // reclaim it, so the refusal reclaims it here.
    await deps.cold.delete(key);
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      generation,
      reason,
      cardinality: written.cardinality,
    });
    return { ...written, generation, published: false, reason, collected: [] };
  };

  if (written.cardinality === 0 && options.allowEmpty !== true && (before ?? 0) > 0) {
    return refuse('empty');
  }
  if (guard?.minCardinality !== undefined && written.cardinality < guard.minCardinality) {
    return refuse('min-cardinality');
  }
  if (guard?.maxShrink !== undefined && before !== null && before > 0) {
    const floor = before * (1 - guard.maxShrink);
    if (written.cardinality < floor) return refuse('max-shrink');
  }

  const published = await publishGeneration(deps.registry, key, {
    wrappedDeks: written.wrappedDeks,
  });
  if (!published) return refuse('superseded');

  audit.onEvent({
    kind: 'segment.publish',
    segment: ref.segment,
    namespace: ref.namespace,
    generation,
  });

  const collected = await gcOrphanGenerations(ref, deps, { keep });
  return { ...written, generation, published: true, collected };
}
