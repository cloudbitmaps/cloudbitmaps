/**
 * Generation bookkeeping for the loaded store: which generation a writer should take next, and which
 * superseded generations may be collected.
 *
 * Storage generations are write-once, generation-keyed objects (`<segment>.<gen>.crbm`) behind one registry pointer
 * (`currentGen`). Every write path in the library — a load, an `*Into` materialisation, a subject-erasure rewrite —
 * writes a **new** object and then advances the pointer. Every load that finds a row fences its publish on the
 * row's token; a guarded load (the default, since the empty refusal reads the current generation) also fences on
 * the pointer it judged (`expectFrom`), and one that found no row fences on that absence instead. Only an unguarded
 * load (`allowEmpty: true` and no `guard.minRetained`) onto a segment with no row publishes bare forward-only. An
 * `*Into` materialisation is a load, and publishes the same way. The rewrite is fenced on its source generation and
 * the row's token (see invariant 1). That leaves the superseded object in the bucket, still billed, so something has
 * to collect it: {@link gcOrphanGenerations}. Pure orchestration over the driver ports — no I/O, time or randomness
 * of its own.
 */
import { ValidationError, WriteConflictError, isNotFoundError } from './errors';
import type { IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';

/** The two ports generation bookkeeping needs: the objects, and the pointer that says which one is current. */
export interface GenerationDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
}

/**
 * The generation number a writer should use for the segment's **next** object: one above the highest generation
 * the registry points at *or* that is present in Storage — whichever is higher. The erasure rewrite numbers this
 * way; a load numbers with {@link nextLoadGeneration}, which comes here only when its existence check finds the
 * number taken.
 *
 * Both are consulted because they can disagree. A load that wrote its object and crashed before publishing leaves
 * an object *above* `currentGen`; a writer that consulted only the pointer would pick that same number and hit the
 * write-once conflict on every retry. Skipping past it costs one `list` and keeps the retry trivial — the crashed
 * object is an orphan {@link gcOrphanGenerations} collects once the pointer moves on. Reusing such an object
 * instead of skipping it (verify-and-publish) is `load()`'s job, not a numbering helper's.
 *
 * A segment with no row and no objects starts at 0. An admin/write-path helper, never on the read path.
 */
export async function nextGeneration(ref: SegmentRef, deps: GenerationDeps): Promise<number> {
  return aboveEverything(ref, deps, await deps.registry.get(ref));
}

/** One above `record`'s pointer and above every generation listed in Storage, whichever is higher. */
async function aboveEverything(
  ref: SegmentRef,
  deps: GenerationDeps,
  record: RegistryRecord | null,
): Promise<number> {
  let highest = record?.currentGen ?? -1;
  for await (const key of deps.storage.list(ref)) {
    if (key.generation > highest) highest = key.generation;
  }
  return highest + 1;
}

/**
 * The generation number a load takes, from the row it has already read: `currentGen + 1` (0 with no row or no
 * pointer yet) when no object holds that number, which one existence check proves (a zero-byte `getTail`, one
 * metadata request on every shipped driver); otherwise one above the pointer and above everything listed, as
 * {@link nextGeneration} numbers. The check finding the number taken (a crashed load's orphan, the object of a
 * load still in flight, or the generations a rollback left above the pointer) and the check failing in any way
 * other than "not found" both take the listing, so the listing stays the authority whenever the check cannot
 * prove the number free.
 *
 * A load can therefore take a number **below** an object already in the bucket: an orphan at `currentGen + 2`
 * with `currentGen + 1` free is numbered under, not past. That is as safe as a listing's number. A load never
 * takes a number an object holds, and a put that races onto one fails write-once, so the load reports
 * `superseded`. The orphan above stays unpublished; the load whose check meets it numbers past it by the listing,
 * and collection takes it once a generation above it is current. Like a listing's, the number can be one whose
 * object was deleted (an erasure removes the generations above a rolled-back pointer that held the id), which is
 * why nothing identifies a generation by its number alone: the reader cache, the chunk cache and a pin all key on
 * the number and the row's token, and the token has moved on.
 */
export async function nextLoadGeneration(
  ref: SegmentRef,
  deps: GenerationDeps,
  row: RegistryRecord | null,
): Promise<number> {
  const generation = (row?.currentGen ?? -1) + 1;
  try {
    await deps.storage.getTail({ namespace: ref.namespace, segment: ref.segment, generation }, 0);
  } catch (err) {
    if (isNotFoundError(err)) return generation;
  }
  return aboveEverything(ref, deps, row);
}

/**
 * Garbage-collect superseded Storage generations for a segment: everything strictly below `currentGen`, keeping
 * the most recent `keep` of them as a grace window, so a read still fetching from a just-superseded
 * generation need not re-resolve mid-call (**invariant 4**). It is a window, not a lock: a read whose
 * generation is swept anyway re-resolves and retries once rather than failing (see `withFreshSnapshot`), so
 * `keep` trades storage for round trips. Generations ≥ `currentGen` are never touched. Returns the generations
 * deleted.
 *
 * **Except on a `destroyed` segment, where EVERY generation is garbage** and the grace window is meaningless.
 * A tombstoned segment resolves no generation for any reader, pinned or not — a pin cannot be taken on one, and
 * a pin taken while it was still active re-checks the status on every open — and nothing else in the library
 * would ever collect them, so without this those objects are billed forever.
 *
 * **Throws {@link WriteConflictError} when it cannot act on the row it read**: the row is gone when it is re-read,
 * after the listing or before a delete; on an active segment, the pointer has fallen below the cutoff before a
 * delete; on a `destroyed` segment, the row's token has changed. Not to be confused with the empty array it still
 * returns when there was genuinely nothing to collect (no row at all, or no pointer yet), which is why an empty
 * array is not a receipt. The row is read before the listing and acted on after it, so a name that was purged and
 * re-created in that window is a *different* segment wearing the same name, and its live object must not be
 * collected on the strength of the old row: on an active segment the lower of the two pointers is what keeps it
 * safe, and on a `destroyed` one the token. Refusing is safe — the objects are not going anywhere and the next
 * pass reads a consistent row — but it has to be **distinguishable** from "there was nothing to collect", which
 * an empty array is not: `eraseIdFromSegment` reads the returned list as the physical half of its erasure
 * receipt, and would otherwise report `erased: true` over bytes still in the bucket. Re-run it.
 *
 * That state is reachable in practice: a `dropSegment` whose Storage sweep threw part-way, or a load that was
 * already writing its object when the tombstone landed and finished the write afterwards. `dropSegment` re-sweeps
 * and reports whatever it could not reclaim in `generationsRemaining`, but a drop that was never re-run leaves a
 * residual, and this is what eventually collects it from the retention sweep.
 *
 * `keep: 0` is how a subject-erasure rewrite makes a bit **physically** gone on return: the generation that held
 * it is collected the moment the rewrite is current. A live read still fetching from it heals forward to the
 * rewrite, and a pin of it (`seg.pin()`) fails with `NotFoundError` for any chunk it has yet to read.
 */
export async function gcOrphanGenerations(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { keep?: number } = {},
): Promise<number[]> {
  const keep = options.keep ?? 1;
  // Refused, not clamped: `NaN` slices nothing off the end and would collect the whole grace window, and a
  // negative count that clamps to 0 collects it too, for a caller who wrote a typo.
  if (!Number.isInteger(keep) || keep < 0) {
    throw new ValidationError(`keep must be a non-negative integer; got ${String(keep)}`);
  }
  const record = await deps.registry.get(ref);
  if (record === null) return []; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  // A set, not an array: a listing that spans a purge-and-recreate can yield the same generation number
  // twice (the objects are re-created under the numbers just swept), and the grace window below keeps the
  // newest `keep` ENTRIES — so a duplicate would silently consume a keep slot and evict a live generation.
  const seen = new Set<number>();
  for await (const key of deps.storage.list(ref)) seen.add(key.generation);
  const gens = [...seen];
  // Everything above was read BEFORE the listing and is acted on after it, and the listing is paginated —
  // seconds wide on a real object store. So re-read the row and reconcile, because BOTH branches can otherwise
  // delete an object the live pointer names, which is the forbidden `missing-storage-generation` state.
  //
  // A purged row refuses outright, on either branch: purged-and-idle is indistinguishable from
  // purged-and-being-recreated, and the top of this function already declines to act without an authoritative
  // pointer.
  const after = await deps.registry.get(ref);
  if (after === null)
    throw new WriteConflictError(`registry row for segment ${ref.segment} was purged mid-pass`);

  // On a tombstone, require the *same* row. A token is never reused (ABA-safe), so an unchanged one proves the
  // segment was not purged and re-created underneath this pass — which matters here because this branch deletes
  // every object it enumerated, `currentGen` included, so a re-created segment would lose the generation its
  // new pointer names.
  if (record.status === 'destroyed' && after.token !== record.token) {
    throw new WriteConflictError(
      `segment ${ref.segment} changed incarnation while its generations were being listed`,
    );
  }

  // On the ordinary branch, take the LOWER of the two pointers. Within one incarnation the pointer only moves
  // forward, so a publish landing mid-listing leaves the cutoff exactly where it was and routine GC still
  // collects — refusing on any token change would make GC useless on a busy segment. But the pointer is only
  // monotonic *within* an incarnation: `nextGeneration` restarts at 0 once a row is purged and the bucket
  // emptied, so a name that was retired and re-created wears a LOWER `currentGen` than the one read before the
  // listing — and `rollbackSegment` lets an operator lower it deliberately — so `g < current` would then select
  // a live object. `Math.min` is what makes a
  // regressed pointer narrow the cutoff instead of widening it.
  const cutoff =
    current === null || after.currentGen === null ? null : Math.min(current, after.currentGen);

  /**
   * Re-prove that everything still queued for deletion is still collectable. Two different questions, because
   * the two branches delete under different licences:
   *
   *  - a **tombstone** deletes at and above `currentGen`, so it needs incarnation IDENTITY — the same row,
   *    by token;
   *  - the **ordinary** branch deletes strictly below `cutoff`, so it needs only that the live pointer has not
   *    fallen below `cutoff`. A forward publish moves it up and changes nothing, which is what keeps routine
   *    collection working on a busy segment. A purge-and-recreate or a `rollbackSegment` can move it down, which
   *    is why the pointer is re-proved before every delete (below).
   */
  const stillCollectable = async (): Promise<void> => {
    const still = await deps.registry.get(ref);
    if (still === null) {
      throw new WriteConflictError(`registry row for segment ${ref.segment} was purged mid-pass`);
    }
    const ok =
      record.status === 'destroyed'
        ? still.token === after.token
        : cutoff === null || (still.currentGen !== null && still.currentGen >= cutoff);
    if (!ok) {
      throw new WriteConflictError(
        `segment ${ref.segment} changed incarnation while its generations were being collected`,
      );
    }
  };

  const toDelete =
    record.status === 'destroyed'
      ? gens.sort((a, b) => a - b) // all of it: no reader can resolve a generation of a tombstoned segment
      : cutoff === null
        ? // No Storage pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
          // here is either a load about to publish or an orphan we cannot tell apart from it. Deleting would race
          // that publish into a dangling pointer. It is collected once a pointer exists.
          []
        : // Delete generations below the cutoff, except the newest `keep` of them (the grace window).
          gens
            .filter((g) => g < cutoff)
            .sort((a, b) => b - a) // newest-first
            .slice(keep);
  // The re-read above proves the segment was intact at ONE instant; the deletes below are one round trip each,
  // so the exposure is the whole loop, not that instant. The ordinary branch deletes newest-first, which puts a
  // restarted incarnation's generation 0 LAST — the worst ordering.
  //
  // Re-proved before EVERY delete, the first included. The re-read above does not cover the first: a rising
  // pointer only makes more things collectable, but `rollbackSegment` can move the pointer *down*, onto a
  // generation this pass has already queued, and a rollback landing between the re-read and the first delete
  // would leave the pass deleting the live generation before its second iteration noticed anything.
  //
  // Cost is one registry read per object actually deleted, on a path that is already one round trip per object
  // and is never on the read path.
  for (const generation of toDelete) {
    await stillCollectable();
    await deps.storage.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}
