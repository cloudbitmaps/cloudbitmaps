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
import { ValidationError } from './errors';
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
 * the most recent `keep` of them as a grace window for in-flight readers pinned to a just-superseded
 * generation (**invariant 4**). Generations ≥ `currentGen` are never touched. Returns the generations deleted.
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
 * **`minAgeMs` is the time half of the window, and it is the half that actually protects a reader.** `keep`
 * counts generations, so a burst of publishes walks a generation out of the window while a reader is still on
 * it: with `keep: 1`, publishing twice in quick succession makes the generation a reader resolved two seconds
 * ago the third-newest, and therefore collectable. `minAgeMs` refuses to collect anything until the pointer has
 * been still for that long — `now - currentGenSince` — so no publish rate can outrun it. The two compose: a
 * generation is collected only when it is **both** outside `keep` and older than `minAgeMs`.
 *
 * The clock is the registry's {@link RegistryRecord.currentGenSince}, not the stored object's age. Object age
 * is the intuitive choice (it is what Iceberg's `expire_snapshots older_than` and Delta's `VACUUM` use) and it
 * is wrong here: a generation written a week ago but superseded one second ago is precisely the one still being
 * read, and object age reports it as a week old. Those systems can use file age because their readers hold a
 * snapshot reference that expiry consults; a reader here resolves a pointer and lets go.
 *
 * A row with **no** `currentGenSince` — written before the field existed, or by a third-party driver that does
 * not carry it — has an unknown age, not an infinite one. With `minAgeMs` set, such a segment is skipped and
 * nothing is collected: the first publish after the upgrade stamps the field and the next run proceeds. Without
 * `minAgeMs`, behaviour is exactly as before.
 *
 * `keep: 0` is how a subject-erasure rewrite makes a bit **physically** gone on return: the generation that held
 * it is collected the moment the rewrite is current. A reader pinned to it re-resolves on its next read. That
 * path passes no `minAgeMs` — an erasure's whole contract is that the bit is gone when the call returns, so it
 * cannot wait out a grace window.
 */
export async function gcOrphanGenerations(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { keep?: number; minAgeMs?: number; now?: number } = {},
): Promise<number[]> {
  const keep = Math.max(0, options.keep ?? 1);
  const { minAgeMs } = options;
  if (minAgeMs !== undefined) {
    if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
      throw new ValidationError(
        `gcOrphanGenerations: \`minAgeMs\` must be a non-negative, finite number of milliseconds; got ${String(minAgeMs)}`,
      );
    }
    // Required rather than defaulted, because `core/` owns no clock (invariant 7) and a default of 0 would
    // silently turn the guard off — the one failure mode a durability knob must not have.
    if (options.now === undefined) {
      throw new ValidationError(
        'gcOrphanGenerations: `minAgeMs` needs `now` (epoch-ms) — core reads no clock of its own.',
      );
    }
    if (!Number.isFinite(options.now)) {
      throw new ValidationError(
        `gcOrphanGenerations: \`now\` must be a finite epoch-ms; got ${String(options.now)}`,
      );
    }
  }
  const record = await deps.registry.get(ref);
  if (record === null) return []; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  const gens: number[] = [];
  for await (const key of deps.cold.list(ref)) gens.push(key.generation);
  // The time window, applied to the whole segment: `currentGenSince` says when the pointer last moved, and every
  // superseded generation stopped being current at or before that instant, so one comparison settles all of
  // them. A `destroyed` segment is exempt — it resolves no generation, so no reader is or can become pinned to
  // one, and the window would only keep paying for objects nobody can read.
  if (minAgeMs !== undefined && record.status !== 'destroyed') {
    // Unknown age, not infinite age. Wrong-units `now` (seconds against ms) lands here too and keeps everything,
    // which is the safe direction for a guard whose other outcome is deletion.
    if (record.currentGenSince === undefined) return [];
    if ((options.now as number) - record.currentGenSince < minAgeMs) return [];
  }
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
