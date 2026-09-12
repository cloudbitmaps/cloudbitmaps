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
 * A tombstoned segment resolves no generation at all, so no reader is or can become pinned to one; and nothing
 * else in the library would ever collect them — without this those objects are billed forever.
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
  const gens: number[] = [];
  for await (const key of deps.cold.list(ref)) gens.push(key.generation);
  const toDelete =
    record.status === 'destroyed'
      ? gens.sort((a, b) => a - b) // all of it: no reader can be pinned to a tombstoned segment
      : current === null
        ? // No Cold pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
          // here is either a load about to publish or an orphan we cannot tell apart from it. Deleting would race
          // that publish into a dangling pointer. It is collected once a pointer exists.
          []
        : // Delete generations below current, except the newest `keep` of them (the grace window).
          gens
            .filter((g) => g < current)
            .sort((a, b) => b - a) // newest-first
            .slice(keep);
  for (const generation of toDelete) {
    await deps.cold.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}
