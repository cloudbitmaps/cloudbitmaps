/**
 * `loadSegment` — the loaded store's primary write path, as one call.
 *
 * A load is always the same four steps: take the next generation number, write one immutable object, move the
 * pointer, collect what the move superseded. Inside the library each is its own internal function, and the
 * step a hand-composed load leaves out is the last one, so a store that composed it would accumulate superseded
 * generations it keeps paying for.
 * Composing it here, once, is the point.
 *
 * The other reason it is one call is the **guard**. A load REPLACES a segment: whatever the stream contains is
 * what the segment contains afterwards. That makes an upstream query returning fewer rows than usual — or none —
 * a silent, successful-looking wipe, and nothing downstream can tell it from a legitimate shrink. The guard is
 * the place to say what a plausible result looks like, and it has to sit **between the write and the publish**,
 * because that is the only moment where the new content is known and the old one is still authoritative.
 *
 * Refusing therefore has to clean up after itself. The object is already durable at that point, and it sits
 * ABOVE `currentGen`, where generation collection deliberately never looks (it deletes strictly below the
 * pointer), so a refused load deletes its own object before returning, while the segment's row is unchanged, gone
 * or `destroyed`. Once another write has changed the row, the object's number may name a re-created segment's live
 * object, so it stays, and collection takes it like any other generation once one above it is current.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { type CodecInterface, requireCodec } from './codec';
import {
  bulkLoadCrbmGeneration,
  holdsObject,
  openGenerationReader,
  publishGeneration,
} from './crbm-storage-source';
import type { Clock } from './determinism';
import { aadFor } from './crypto';
import type { CrbmCrypto, IKeystore } from './crypto';
import {
  KeyUnavailableError,
  ValidationError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
} from './errors';
import { gcOrphanGenerations, nextLoadGeneration } from './generation-gc';
import { type ReadRetry, retryRead } from './retry';
import type { IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef, Token } from './ports';
import { validateUserRef } from './validate';

/** What {@link loadSegment} needs: the objects, the pointer, the codec, and key material if encrypted. */
export interface LoadDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly codec?: CodecInterface;
  readonly keystore?: IKeystore;
  readonly requireEncryption?: boolean;
  readonly clock?: Clock;
  /**
   * The store's read retry, for the read the guard makes of the current generation: a transient fault there is run
   * again under it rather than failing the load. Absent, the read is made once. The write is never retried.
   */
  readonly readRetry?: ReadRetry;
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
   * Refuse a generation that retains less than this fraction of the current one — `0.5` means "at least half the
   * ids must survive". A *growing* load is never refused by this bound, and neither is the first load of a
   * segment, which has nothing to shrink from.
   *
   * Phrased as a floor rather than a ceiling on the loss so that `0` means the same thing here as it does on
   * `minCardinality` above: **no bound**. The inverse spelling (`maxShrink`) would make `0` mean "refuse any
   * shrink at all" — maximally strict — sitting in the same object literal as a field where `0` is maximally
   * permissive, which is where an inversion would eventually be written and not noticed.
   */
  readonly minRetained?: number;
}

export interface LoadOptions {
  /**
   * Publish an empty generation over a non-empty one. Off by default: an empty result is far more often an
   * upstream failure than an intent, and the failure is indistinguishable from success once it lands.
   */
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  /**
   * Generations to keep below the new pointer as a grace window (default 1). A non-negative integer: anything
   * else (negative, fractional, `NaN`, infinite) throws `ValidationError` before anything is written. Keep at
   * least one: a read that is
   * still fetching chunks from the just-superseded generation would otherwise have it deleted out from under it
   * and pay a re-resolve. A wider window costs storage, and it is what a pinned handle needs: a pin is never
   * re-resolved, so a chunk a pinned read has not fetched fails with `NotFoundError` once its generation is
   * collected. Keep at least one generation for every one that can be written above the pinned one while your
   * longest pinned job runs, on every writer that loads the segment — see "Generations and `keep`" in the loading
   * guide.
   */
  readonly keep?: number;
  readonly audit?: IAuditSink;
}

/** Why a load did not become current. */
export type LoadRefusal =
  | 'empty'
  | 'min-cardinality'
  | 'min-retained'
  /**
   * Another writer got there first. Either another load wrote the same generation number first, so the write-once
   * put refused this one and it wrote nothing (`size: 0`); or the segment's registry row changed while the load was
   * writing: another load published, a retention change, a rollback or an erasure wrote the row, or the row was
   * deleted. Once another write has changed the row, the object stays in the bucket, because its generation number
   * may by then name another incarnation's live object; once the row is `destroyed` (dropped or crypto-shredded),
   * the object is deleted, and once the row is gone, so is an object its footer proves this load's own.
   */
  | 'superseded';

export interface LoadResult {
  /**
   * The generation written. Present even when refused: a refusal deletes that object while the segment's row is
   * unchanged or `destroyed`, or gone once its footer proves it this load's own, and leaves it in the bucket once another write has changed the row. A load that lost its
   * generation number to another wrote nothing, and reports `size: 0`.
   */
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
  /**
   * What the segment held when the guard judged it — `null` when there was no current generation, or when no
   * bound needed it. Returned because an alert on `reason: 'min-retained'` is useless without it: "refused" is a
   * page, "refused: 4 → 1" is a diagnosis, and re-reading the segment to find out costs a round trip and races
   * whatever happens next.
   */
  readonly cardinalityBefore: number | null;
  /** The superseded generations collected after publishing. Empty when nothing was published. */
  readonly collected: readonly number[];
}

/**
 * Cardinality of the segment's current generation, read from the `.crbm` index rather than its payload.
 * `null` when there is no current generation to compare against.
 *
 * The crypto is derived **here** rather than taken from the caller, and that is not a convenience. AAD is bound
 * to a specific generation, so a `CrbmCrypto` passed in from outside would have to be pre-bound to whichever
 * generation turns out to be current — which only this function learns, by reading the row. A caller cannot
 * satisfy that seam even in principle, so offering it would be offering a parameter nobody can fill correctly.
 */
async function currentCardinality(
  ref: SegmentRef,
  deps: LoadDeps,
  record: RegistryRecord | null,
): Promise<number | null> {
  if (record === null || record.currentGen === null || record.status === 'destroyed') return null;
  const generation = record.currentGen;
  let crypto: CrbmCrypto | undefined;
  const wrapped = record.wrappedDeks;
  if (wrapped !== undefined && wrapped.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but load was given no keystore`,
      );
    }
    const aead = await deps.keystore.openDek(wrapped);
    crypto = { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
  }
  let reader;
  try {
    reader = await retryRead(
      () => openGenerationReader(deps.storage, { ...ref, generation }, crypto),
      deps.readRetry,
    );
  } catch (err) {
    // The row names a generation whose OBJECT is gone — the `missing-storage-generation` state a consistency
    // check reports, produced by a partial `dropSegment`, a bucket lifecycle rule, or a restore that brought
    // the registry back without the bucket.
    //
    // `null`, not a throw. The guard exists to protect ids that are still there, and these are already gone:
    // refusing to write would leave the segment unreadable AND unrepairable, which is the opposite of what a
    // guard is for. Writing over it is precisely the repair, and it is what this path did before the guard
    // reached it. A caller who wants to be told instead can run `checkConsistency()`, whose job that is.
    if (!isNotFoundError(err)) throw err;
    return null;
  }
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
  validateUserRef(ref);
  // Before any round trip: a core caller that forgot the codec learns it from this call's name, not the loader's.
  requireCodec(deps.codec, 'loadSegment');
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
  if (guard?.minRetained !== undefined) {
    const s = guard.minRetained;
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new ValidationError(`guard.minRetained must be a fraction in 0..1; got ${String(s)}`);
    }
  }
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);

  // One row read, and on a cleartext segment the only one before the publish: the guard's "before", the incarnation
  // this call is acting on, the pointer it derived its decision from, the number it takes next, the write's
  // destroyed check, and the publish's first attempt all come from it. Reusing it is sound because the publish is
  // fenced on this row (its token, the pointer the guard judged, or its absence), so a row that changes before then
  // makes the publish lose rather than land on the strength of a stale read. The write reads the row again after
  // the ids when this read found none, or found key material (see `bulkLoadCrbmGeneration`'s `row`).
  const row = await deps.registry.get(ref);
  const fromToken: Token | undefined = row?.token;
  const fromGeneration = row?.currentGen ?? undefined;

  // Read the "before" cardinality ONLY when a bound needs it. The empty guard needs to know whether the current
  // generation is non-empty; `minRetained` needs its size. `minCardinality` compares against the new generation
  // alone, so it costs nothing extra.
  const needsBefore = guard?.minRetained !== undefined || options.allowEmpty !== true;
  const before = needsBefore ? await currentCardinality(ref, deps, row) : null;

  const generation = await nextLoadGeneration(ref, deps, row);
  const key = { namespace: ref.namespace, segment: ref.segment, generation };

  // `publish: false`, deliberately: the guard has to run while the old generation is still authoritative, so the
  // pointer moves below rather than here. The registry is still passed — it is where an existing encrypted
  // segment's DEK lives, and reusing that key is not optional — and the freshly minted one comes back on the
  // result so the deferred publish can store it.
  let written;
  try {
    written = await bulkLoadCrbmGeneration(deps.storage, key, ids, {
      registry: deps.registry,
      publish: false,
      keystore: deps.keystore,
      requireEncryption: deps.requireEncryption,
      codec: deps.codec,
      clock: deps.clock,
      row,
    });
  } catch (err) {
    // Another loader took this generation number first — write-once refused the second put. That is a lost race,
    // and `LoadRefusal` documents a lost race as `'superseded'`; letting a `WriteConflictError` escape here would
    // make a caller who branches on `published` (as the doc-comment tells them to) miss the one outcome they were
    // told to expect. Nothing was written, so there is nothing to clean up; the refusal is still audited, as every
    // other one is, since a downstream reconciliation needs to know the replacement it asked for did not happen.
    if (!isWriteConflictError(err)) throw err;
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      generation,
      reason: 'superseded',
      cardinality: 0,
    });
    return {
      generation,
      published: false,
      reason: 'superseded',
      size: 0,
      sha256: '',
      chunkCount: 0,
      cardinality: 0,
      cardinalityBefore: before,
      collected: [],
    };
  }

  /**
   * Reclaim this load's object after a DEFINITE refusal: a guard that said no before any publish, or a publish that
   * answered `false` or threw a refusal of its own. Never after an ambiguous outcome (a lost response, a timeout):
   * a publish that may still land must not find its object gone.
   *
   * The object is durable and sits above `currentGen`, where collection never looks until a generation above it is
   * current, so the refusal reclaims it here, and deletes only what it can prove is its own. A generation number
   * identifies a generation within one incarnation of a row, and nothing more (invariant 1): once the row was
   * purged, the object under this load's key can be another writer's, because a re-created name's numbering restarts
   * and its loads take numbers a drop or a collection freed, this one included. Deleting that would put a row over a
   * missing generation, the forbidden `missing-storage-generation` state; leaving an orphan behind is strictly the
   * better failure.
   *
   * - The same row (an unchanged token): nothing was written since this load read it, so the number is its own.
   * - A `destroyed` row: no reader resolves any of its generations, so whatever is under the key is garbage.
   * - No row, or a row with key material when this load wrote cleartext (a cleartext object has no place in an
   *   encrypted segment's bucket, where a rollback could point at it and a shred would attest its bytes unreadable):
   *   the object under the key must be proved this load's by its fingerprint, from one read of its footer. One that
   *   is gone, is another object, or cannot be read is kept.
   */
  const reclaim = async (): Promise<void> => {
    const now = await deps.registry.get(ref);
    if (now !== null && (now.token === fromToken || now.status === 'destroyed')) {
      await deps.storage.delete(key);
      return;
    }
    const keyed = now !== null && now.wrappedDeks !== undefined && now.wrappedDeks.length > 0;
    if (
      (now === null || (keyed && !written.encrypted)) &&
      (await holdsObject(deps.storage, key, written.fingerprint))
    ) {
      await deps.storage.delete(key);
    }
  };

  const refuse = async (reason: LoadRefusal): Promise<LoadResult> => {
    await reclaim();
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      generation,
      reason,
      cardinality: written.cardinality,
    });
    // Constructed field by field, never spread from the write result. That result now carries `wrappedDeks` —
    // wrapped key material — and a spread would put it on a public, JSON-serialisable object that a load job
    // will reasonably `logger.info({ result })`. Declared shapes are not a filter at runtime.
    return {
      generation,
      published: false,
      reason,
      size: written.size,
      sha256: written.sha256,
      chunkCount: written.chunkCount,
      cardinality: written.cardinality,
      cardinalityBefore: before,
      collected: [],
    };
  };

  if (written.cardinality === 0 && options.allowEmpty !== true && (before ?? 0) > 0) {
    return refuse('empty');
  }
  if (guard?.minCardinality !== undefined && written.cardinality < guard.minCardinality) {
    return refuse('min-cardinality');
  }
  if (guard?.minRetained !== undefined && before !== null) {
    if (written.cardinality < before * guard.minRetained) return refuse('min-retained');
  }

  // Fence the publish on the row the guard judged.
  //
  // Forward-only is right for an UNGUARDED load: its ids come from upstream, so losing a race costs nothing that
  // the winner did not also bring. A guarded load is a different animal — it derived its decision from a
  // particular generation's cardinality, which makes it exactly the writer invariant 1 says must publish with
  // `expectFrom`. Without that, anything published between the "before" read and this publish voids the guard's
  // premise while the guard still reports success: reproduced, two loaders on a fresh segment let an EMPTY
  // generation land over a thousand ids, under default options, because `before` was read as "no row".
  //
  // `expectToken` goes on regardless. It is incarnation identity rather than a derivation fence, it costs
  // nothing legitimate — a token only changes when the row does — and it is what stops this call publishing
  // into a segment that merely reuses the name it started with.
  let published: boolean;
  try {
    published = await publishGeneration(deps.registry, key, {
      row,
      wrappedDeks: written.wrappedDeks,
      cleartext: !written.encrypted,
      ...(fromToken === undefined ? {} : { expectToken: fromToken }),
      ...(needsBefore && fromGeneration !== undefined ? { expectFrom: fromGeneration } : {}),
      // The third case, and the one the two fences above structurally cannot cover: the guard judged a segment
      // that had NO ROW. Both `expectFrom` and `expectToken` compare against a value read from a row, so with no
      // row both are omitted and the publish becomes a bare forward-only advance — which lands over anything
      // that appeared in between. `before` was `null`, so the empty and `minRetained` bounds had nothing to
      // judge and passed vacuously. Verified: an empty generation published over a thousand ids that a
      // concurrent writer had created meanwhile, reporting success. A guarded write therefore has to fence on
      // the ABSENCE it relied on, exactly as it fences on the pointer it relied on.
      ...(needsBefore && row === null ? { expectAbsent: true } : {}),
    });
  } catch (err) {
    // A refusal the publish states by throwing is as definite as a `false`: each of these is raised before that
    // attempt's compare-and-swap or create is sent, so nothing landed from it. `publishGeneration` raises three: a
    // `destroyed` row (no fence answered first, as for an unguarded load that found no row), new key material for a
    // segment that already has a generation, and a cleartext object for a row with key material. The registries raise
    // a `ValidationError` only from checks made before a write is sent (the ref, the record or patch, the row's size
    // cap), and never a `KeyUnavailableError`. Anything else, a transient fault above all, may still land, and keeps
    // the object.
    if (isValidationError(err) || err instanceof KeyUnavailableError) await reclaim();
    throw err;
  }
  if (!published) return refuse('superseded');

  audit.onEvent({
    kind: 'segment.publish',
    segment: ref.segment,
    namespace: ref.namespace,
    generation,
  });

  const collected = await gcOrphanGenerations(ref, deps, { keep });
  return {
    generation,
    published: true,
    size: written.size,
    sha256: written.sha256,
    chunkCount: written.chunkCount,
    cardinality: written.cardinality,
    cardinalityBefore: before,
    collected,
  };
}
