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
 * **`minAgeMs` is the time half of the window, and it is the half that protects a reader.** `keep` counts
 * generations, and counting cannot describe what endangers one: a reader resolves `currentGen` once and then
 * fetches from it, so the risk is publishes landing underneath, not how many objects exist. Publish twice in
 * quick succession and the generation a reader resolved seconds ago is already the third-newest — outside
 * `keep: 1`, and collected while it is still being read. `minAgeMs` refuses to collect a generation until it
 * has been superseded for that long, so no publish rate can outrun it. The two compose: a generation goes only
 * when it is **both** outside `keep` **and** older than the floor.
 *
 * **A generation's age is when its SUCCESSOR was written**, not when it was. Its own age is the intuitive
 * measure and the wrong one — a generation written a week ago but superseded one second ago is precisely the
 * one a reader is still on. So the age of generation *G* comes from `createdAt` on generation *G+1*
 * ({@link ListedGeneration}), except for the newest superseded generation, whose supersession the registry
 * records exactly as {@link RegistryRecord.currentGenSince}. Ages are then made monotonic — an older
 * generation cannot have stopped being current *later* than a newer one — which keeps a clock skew or an
 * out-of-order listing from inventing a young generation out of an old one.
 *
 * The approximation errs in one direction and is documented rather than hidden: `createdAt` is when the
 * successor object was *written*, slightly before it was *published*, so a generation can read as older than
 * it is by the duration of one load. That is minutes at most, against a floor measured in hours.
 *
 * **Unknown age is not old age.** A generation whose age cannot be established — no `createdAt` from the
 * driver, no `currentGenSince` on the row, a value outside the row's own audit window — is **kept**. The
 * unsafe reading would delete a just-superseded generation on the first run after an upgrade, which is the
 * opposite of what the knob was set for. Omit `minAgeMs` and behaviour is exactly as it was.
 *
 * `keep: 0` is how a subject-erasure rewrite makes a bit **physically** gone on return: the generation that held
 * it is collected the moment the rewrite is current. A reader pinned to it re-resolves on its next read. That
 * path passes no `minAgeMs` — an erasure's contract is that the bit is gone when the call returns, so it
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
    // silently switch the guard off — the one failure mode a durability knob must not have, because it is
    // indistinguishable from a working one until a reader breaks.
    if (options.now === undefined || !Number.isFinite(options.now)) {
      throw new ValidationError(
        `gcOrphanGenerations: \`minAgeMs\` needs a finite \`now\` (epoch-ms) — core reads no clock of its own; got ${String(options.now)}`,
      );
    }
  }
  const record = await deps.registry.get(ref);
  if (record === null) return []; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  const gens: number[] = [];
  const createdAt = new Map<number, number>();
  for await (const key of deps.cold.list(ref)) {
    gens.push(key.generation);
    // Only a finite instant is a fact. Anything else is "unknown", which keeps the generation.
    if (key.createdAt !== undefined && Number.isFinite(key.createdAt)) {
      createdAt.set(key.generation, key.createdAt);
    }
  }
  // When each superseded generation stopped being current, newest-first. The newest one is exact — the
  // registry recorded the instant its successor took over. Every older one is dated by the object that
  // replaced it, which is the only per-generation evidence there is.
  //
  // Two different clocks meet here: the registry's and the object store's. So object evidence is only
  // believed inside the window the ROW itself vouches for — a generation cannot have stopped being current
  // before its segment's row existed, nor after the pointer last moved. An instant outside that window is not
  // a late timestamp, it is a broken one (a lagging writer, a restored object, a driver reporting nonsense),
  // and it is discarded as *unknown* rather than used, because the direction it fails in is the one that
  // deletes: an instant that reads too early makes a generation look older than it is.
  //
  // Each generation is dated on its own evidence, with no smoothing between them. It is tempting to enforce
  // the obvious constraint — an older generation cannot have stopped being current later than a newer one —
  // but enforcing it means lowering the older one's instant, and a lower instant is an OLDER generation,
  // which is the direction that deletes. Two timestamps that contradict each other are resolved the other
  // way here, by simply believing each one: a contradiction can then only make a generation look younger,
  // and younger means kept.
  const supersededAt = new Map<number, number>();
  if (minAgeMs !== undefined && current !== null && record.currentGenSince !== undefined) {
    const floor = record.createdAt;
    const ceiling = record.currentGenSince;
    const descending = gens.filter((g) => g < current).sort((a, b) => b - a);
    for (const [i, g] of descending.entries()) {
      // The newest superseded generation was replaced by `current`, and the registry timed that exactly.
      // Every older one is dated by the object above it in this listing. A generation collected earlier only
      // makes that successor's timestamp later than the truth, which reads as younger — the safe direction.
      const at = i === 0 ? ceiling : createdAt.get(descending[i - 1]!);
      if (at === undefined || at < floor || at > ceiling) continue; // unknown ⇒ `oldEnough` keeps it
      supersededAt.set(g, at);
    }
  }
  const oldEnough = (g: number): boolean => {
    const at = supersededAt.get(g);
    if (at === undefined) return false; // unknown age is not old age
    return (options.now as number) - at >= (minAgeMs as number);
  };

  const toDelete =
    record.status === 'destroyed'
      ? gens.sort((a, b) => a - b) // all of it: no reader can be pinned to a tombstoned segment
      : current === null
        ? // No Cold pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
          // here is either a load about to publish or an orphan we cannot tell apart from it. Deleting would race
          // that publish into a dangling pointer. It is collected once a pointer exists.
          []
        : // Delete generations below current, except the newest `keep` of them (the grace window) and, when a
          // floor is set, any whose supersession is too recent or simply unknown.
          gens
            .filter((g) => g < current)
            .sort((a, b) => b - a) // newest-first
            .slice(keep)
            .filter((g) => minAgeMs === undefined || oldEnough(g));
  for (const generation of toDelete) {
    await deps.cold.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}
