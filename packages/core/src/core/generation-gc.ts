/**
 * Generation bookkeeping for the loaded store: which generation a writer should take next, and which
 * superseded generations may be collected.
 *
 * Cold generations are write-once, generation-keyed objects (`<segment>.<gen>.crbm`) behind one registry pointer
 * (`currentGen`). Every write path in the library — a bulk load, an `*Into` materialisation, a subject-erasure
 * rewrite — writes a **new** object and then advances the pointer, forward-only for a load and fenced on its
 * source generation for the rewrite (see invariant 1). That leaves the superseded object
 * in the bucket, still billed, so something has to collect it: {@link gcOrphanGenerations}. Pure orchestration
 * over the driver ports — no I/O, time or randomness of its own.
 */
import { WriteConflictError } from './errors';
import type { IColdDriver, IRegistryDriver, SegmentRef } from './ports';

/** The two ports generation bookkeeping needs: the objects, and the pointer that says which one is current. */
export interface GenerationDeps {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
}

/**
 * The generation number a writer should use for the segment's **next** object: one above the highest generation
 * the registry points at *or* that is present in Cold — whichever is higher.
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
  const record = await deps.registry.get(ref);
  let highest = record?.currentGen ?? -1;
  for await (const key of deps.cold.list(ref)) {
    if (key.generation > highest) highest = key.generation;
  }
  return highest + 1;
}

/**
 * Garbage-collect superseded Cold generations for a segment: everything strictly below `currentGen`, keeping
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
 * **Throws {@link WriteConflictError} if the segment changed underneath the pass** — not to be confused with
 * the empty array it still returns when there was genuinely nothing to collect (no row at all, or no pointer
 * yet), which is why an empty array is not a receipt. The row is read before the listing and acted on after it, so a name that was purged and
 * re-created in that window is a *different* segment wearing the same name, and its live object must not be
 * collected on the strength of the old row. Refusing is safe — the objects are not going anywhere and the next
 * pass reads a consistent row — but it has to be **distinguishable** from "there was nothing to collect", which
 * an empty array is not: `eraseIdFromSegment` reads the returned list as the physical half of its erasure
 * receipt, and would otherwise report `erased: true` over bytes still in the bucket. Re-run it.
 *
 * That state is reachable in practice: a `dropSegment` whose Cold sweep threw part-way, or a load that was
 * already writing its object when the tombstone landed and finished the write afterwards. `dropSegment` re-sweeps
 * and reports whatever it could not reclaim in `generationsRemaining`, but a drop that was never re-run leaves a
 * residual, and this is what eventually collects it from the retention sweep.
 *
 * `keep: 0` is how a subject-erasure rewrite makes a bit **physically** gone on return: the generation that held
 * it is collected the moment the rewrite is current. A reader pinned to it re-resolves on its next read.
 */
export async function gcOrphanGenerations(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { keep?: number } = {},
): Promise<number[]> {
  const keep = Math.max(0, options.keep ?? 1);
  const record = await deps.registry.get(ref);
  if (record === null) return []; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  // A set, not an array: a listing that spans a purge-and-recreate can yield the same generation number
  // twice (the objects are re-created under the numbers just swept), and the grace window below keeps the
  // newest `keep` ENTRIES — so a duplicate would silently consume a keep slot and evict a live generation.
  const seen = new Set<number>();
  for await (const key of deps.cold.list(ref)) seen.add(key.generation);
  const gens = [...seen];
  // Everything above was read BEFORE the listing and is acted on after it, and the listing is paginated —
  // seconds wide on a real object store. So re-read the row and reconcile, because BOTH branches can otherwise
  // delete an object the live pointer names, which is the forbidden `missing-cold-generation` state.
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
   *    collection working on a busy segment; only a purge-and-recreate can move it down.
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
        ? // No Cold pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
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
  // Re-proved before EVERY delete, the first included. An earlier version skipped the first on the grounds that
  // the re-read above had just covered it, which held only while the pointer could not fall: the window between
  // the re-read and the first delete was one where the pointer could only rise, and a rising pointer only makes
  // more things collectable. `rollbackSegment` removed that premise — an operator can now move the pointer
  // *down*, onto a generation this pass has already queued — and reproduced exactly that: a rollback landing in
  // that window left the pass deleting the live generation before its second iteration noticed anything.
  //
  // Cost is one registry read per object actually deleted, on a path that is already one round trip per object
  // and is never on the read path.
  for (const generation of toDelete) {
    await stillCollectable();
    await deps.cold.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}
