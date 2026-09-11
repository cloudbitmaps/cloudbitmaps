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
 * **A generation's age comes from the registry, not from the objects.** The row records each generation that
 * was current and the instant it stopped being — see {@link RegistryRecord.supersededGens} — so a generation
 * is dated exactly or not at all. Dating by the object that replaced it cannot work: a load that writes its
 * object and crashes leaves an orphan the next publish numbers past, and from a listing that orphan is
 * indistinguishable from a real successor, so a generation superseded seconds ago reads as days old.
 *
 * A generation below the pointer that the row never recorded as current was **skipped** by it — the ordinary
 * orphan — so no reader can ever have resolved it and it is collected without waiting out the floor.
 *
 * **Unknown age is not old age.** A generation the row cannot date — one written before this existed, or one
 * whose entry has aged out of the capped list — is **kept**. The unsafe reading would delete a
 * just-superseded generation on the first run after an upgrade, which is the opposite of what the knob was
 * set for. Omit `minAgeMs` and behaviour is exactly as it was.
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
  // A negative `keep` clamping to 0 is long-standing, documented behaviour. `NaN` is the one value that must
  // be refused: `Math.max(0, NaN)` is `NaN`, and `slice(NaN)` is `slice(0)`, so it silently turns the grace
  // window off while looking exactly like a working setting.
  if (options.keep !== undefined && !Number.isFinite(options.keep)) {
    throw new ValidationError(
      `gcOrphanGenerations: \`keep\` must be a finite number; got ${String(options.keep)}`,
    );
  }
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
  const dating = minAgeMs !== undefined;
  const gens: number[] = [];
  for await (const key of deps.cold.list(ref)) gens.push(key.generation);

  // Every deletion rests on what the REGISTRY recorded, and on nothing else. The row names each generation
  // that was current and when it stopped being — so a generation is dated exactly, or not at all.
  //
  // The alternative, dating a generation by the object that replaced it, is unsound for a reason no amount of
  // clamping fixes: a load that writes its object and crashes leaves an orphan the next publish numbers past,
  // and from a listing that orphan is indistinguishable from a real successor. Dating by it reports a
  // generation superseded seconds ago as days old.
  // Two separate facts, and conflating them is a deletion bug: **was it ever current** (so a window applies)
  // and **when did it stop** (so the window can be evaluated). An entry names a generation that was current;
  // only a usable instant can date it.
  const retired = new Map<number, number>();
  const everCurrent = new Set<number>();
  let oldestTracked = Number.POSITIVE_INFINITY;
  if (dating) {
    for (const entry of record.supersededGens ?? []) {
      // Shape is checked here rather than at the read boundary: a nonsensical entry must cost its own
      // generation its date, never the whole row.
      if (typeof entry?.gen !== 'number' || !Number.isInteger(entry.gen)) continue;
      everCurrent.add(entry.gen);
      oldestTracked = Math.min(oldestTracked, entry.gen);
      if (typeof entry.at === 'number' && Number.isFinite(entry.at) && !retired.has(entry.gen)) {
        retired.set(entry.gen, entry.at);
      }
    }
  }
  const oldEnough = (g: number): boolean => {
    const at = retired.get(g);
    if (at !== undefined) return (options.now as number) - at >= (minAgeMs as number);
    // Recorded as current but not datable — a malformed instant, say. Unknown age is not old age.
    if (everCurrent.has(g)) return false;
    // Never recorded, and newer than everything the row tracks: the pointer skipped it, so no reader can ever
    // have resolved it and there is no window to serve. Restricted to generations ABOVE the oldest entry,
    // because below that the list may simply have been capped — and "we stopped tracking it" is not evidence
    // that it was never current.
    return g > oldestTracked;
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
            .filter((g) => !dating || oldEnough(g));
  for (const generation of toDelete) {
    await deps.cold.delete({ namespace: ref.namespace, segment: ref.segment, generation });
  }
  return toDelete;
}
