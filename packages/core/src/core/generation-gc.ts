/**
 * Generation bookkeeping for the loaded store: which generation a writer should take next, and which
 * superseded generations may be collected.
 *
 * Storage generations are write-once, generation-keyed objects (`<segment>.<gen>.crbm`) behind one registry pointer
 * (`currentGen`). Every write path in the library — a load, an `*Into` materialisation, a subject-erasure rewrite —
 * writes a **new** object and then advances the pointer. Every load that finds a row fences its publish on the
 * row's token, and every load that finds none on that absence, guarded or not; a guarded load (the default, since the
 * empty refusal needs the size of the current generation) also fences on the pointer it judged (`expectFrom`). An
 * `*Into` materialisation is a load, and publishes the same way. The rewrite is
 * fenced on its source generation and the row's token (see invariant 1). That leaves the superseded object in the bucket, still billed, so something has
 * to collect it: {@link gcOrphanGenerations}, or, for a load whose row records the generations it keeps, the names its
 * publish pushed out of that window ({@link deleteEvicted}). Pure orchestration over the driver ports — no I/O, time or
 * randomness of its own.
 */
import {
  IntegrityError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
  isWriteConflictError,
} from './errors';
import { MAX_KEPT_GENERATIONS, usableKeptGens } from './kept-generations';
import { heldGenerations } from './leases';
import type {
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  SegmentRef,
  Token,
} from './ports';

/** The two ports generation bookkeeping needs: the objects, and the pointer that says which one is current. */
export interface GenerationDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
}

/**
 * The generation number a writer should use for the segment's **next** object: one above the highest generation
 * the registry points at *or* that is present in Storage — whichever is higher. The erasure rewrite numbers this
 * way; a load numbers with {@link nextLoadGeneration}, which lists as this does when its existence check finds the
 * number taken or cannot answer.
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
  return numberAbove(highest);
}

/** `highest + 1`, refused when it is not a safe integer: a generation past that cannot be written or read back. */
function numberAbove(highest: number): number {
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new IntegrityError('the segment has no generation number left above its highest');
  }
  return highest + 1;
}

/** The number a load takes, and whether one existence check proved it free (so nothing is above the pointer). */
export interface LoadNumber {
  readonly generation: number;
  /**
   * `true` when the number is `currentGen + 1` and the check found no object holding it. Collection by name rests
   * on it: the row named `generation - 1` as current, so every number the window evicts is below it, and nothing
   * the listing would have kept is a name the pass takes. `false` when the listing numbered the load.
   */
  readonly checked: boolean;
}

/**
 * The generation number a load takes, from the row it has already read: `currentGen + 1` (0 with no row or no
 * pointer yet) when no object holds that number, which one existence check proves (a zero-byte `getTail`, one
 * metadata request on every shipped driver); otherwise one above the pointer and above everything listed, as
 * {@link nextGeneration} numbers. The check finding the number taken (a crashed load's orphan, the object of a
 * load still in flight, or the generations a rollback left above the pointer) and the check failing in any way
 * other than "not found" both take the listing, so the listing stays the authority whenever the check cannot
 * prove the number free. A failed check falls back silently: nothing records it, and what it costs is the listing,
 * one more PUT-class request on S3, so a fault that makes every check fail shows only in the bill.
 *
 * A load can therefore take a number **below** an object already in the bucket: an orphan at `currentGen + 2`
 * with `currentGen + 1` free is numbered under, not past. That is as safe as a listing's number. A load never
 * takes a number an object holds, and a put that races onto one fails write-once, so the load reports
 * `superseded`. The orphan above stays unpublished; the load whose check meets it numbers past it by the listing,
 * and collection takes it once a generation above it is current. Like a listing's, the number can be one whose
 * object was deleted (an erasure removes the generations above a rolled-back pointer that held the id), which is
 * why nothing identifies a generation by its number alone: the reader cache and the chunk cache key on the number and
 * the row's `pointerId`, which every write that takes a number again renews, and an open of a row with a usable
 * summary holds the object to the fingerprint the summary records; a pin keys on its object's fingerprint.
 */
export async function nextLoadGeneration(
  ref: SegmentRef,
  deps: GenerationDeps,
  row: RegistryRecord | null,
): Promise<LoadNumber> {
  const generation = numberAbove(row?.currentGen ?? -1);
  try {
    await deps.storage.getTail({ namespace: ref.namespace, segment: ref.segment, generation }, 0);
  } catch (err) {
    if (isNotFoundError(err)) return { generation, checked: true };
  }
  return { generation: await aboveEverything(ref, deps, row), checked: false };
}

/**
 * How often a load that could collect by name lists instead: every generation divisible by this. A name-only pass
 * takes the names its publish pushed out of the row's window and never looks at the rest, so what it misses (a crashed
 * or refused load's object, a delete that failed, extras a fault left after a `keep` that shrank, an object a rollback
 * or an erasure left stranded below the pointer) waits for a listing. The number is a generation's, not a clock's, so the choice needs
 * no state and no time, and a segment that loads cleanly lists once in this many loads at most. The bound is in
 * generation numbers: a rollback moves the pointer down, and the loads that then take the numbers above it count
 * from there.
 */
export const LIST_COLLECTION_CADENCE = 16;

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
 * That state is reachable in practice: a `dropSegment` whose Storage sweep threw part-way, or a load that had read
 * the row before the tombstone landed, wrote its object afterwards, and stopped before its refusal deleted it. `dropSegment` re-sweeps
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
  // Only the window is passed on, whatever the caller's object carries: this pass never reads a lease.
  return (await listingPass(ref, deps, { keep: options.keep })).deleted;
}

/**
 * What makes a collection spare leased generations: the clock that says whether a lease has ended. Only a load's
 * collection passes one, and a load with no clock passes none: it cannot tell a live lease from an ended one, so it
 * reads none. A pass without a guard never reads the row's leases, which is what keeps erasure, shred and drop deleting
 * what a lease names.
 */
export interface LeaseGuard {
  readonly now: () => number;
}

/** What a listing pass did: the generations it deleted, and the ones below the pointer it left. */
interface ListingResult {
  readonly deleted: number[];
  /** The generations below the pointer the pass kept, ascending. Empty on a tombstone or with no pointer. */
  readonly kept: number[];
  /** Whether the pass ran to its end. A `quiet` pass that met a writer that moved the row stops early, and is not. */
  readonly complete: boolean;
}

/**
 * {@link gcOrphanGenerations}, and what it left. With `protect` it deletes by the row's record instead of by a window:
 * every generation below the pointer that is not in `protect`, so an object no publish named (an orphan of a crashed
 * or refused load, extras a fault left) goes whatever slot it would have taken in a window. The row as the pass reads it
 * after the listing joins `protect`, so a publish that landed meanwhile keeps its own window; with no usable list there
 * the pass keeps the newest `keep` below the pointer instead. Each delete is proved against the row's list once more.
 *
 * A `quiet` pass is a load's, after its publish landed: a row another writer moved means the pass stops and reports what
 * it did, where any other pass throws {@link WriteConflictError}, because a load that took effect must not fail on a
 * race it won.
 */
async function listingPass(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: {
    keep?: number;
    protect?: readonly number[];
    quiet?: boolean;
    leases?: LeaseGuard;
  },
): Promise<ListingResult> {
  const keep = options.keep ?? 1;
  const quiet = options.quiet === true;
  // Refused, not clamped: `NaN` slices nothing off the end and would collect the whole grace window, and a
  // negative count that clamps to 0 collects it too, for a caller who wrote a typo.
  if (!Number.isInteger(keep) || keep < 0) {
    throw new ValidationError(`keep must be a non-negative integer; got ${String(keep)}`);
  }
  const record = await deps.registry.get(ref);
  if (record === null) return { deleted: [], kept: [], complete: true }; // no authoritative pointer → don't delete anything
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
  if (after === null) {
    if (quiet) return { deleted: [], kept: [], complete: false };
    throw new WriteConflictError(`registry row for segment ${ref.segment} was purged mid-pass`);
  }

  // On a tombstone, require the *same* row. A token is not reused (ABA-safe, 2^-128 per pair of incarnations), so an unchanged one proves the
  // segment was not purged and re-created underneath this pass — which matters here because this branch deletes
  // every object it enumerated, `currentGen` included, so a re-created segment would lose the generation its
  // new pointer names.
  if (record.status === 'destroyed' && after.token !== record.token) {
    if (quiet) return { deleted: [], kept: [], complete: false };
    throw new WriteConflictError(
      `segment ${ref.segment} changed incarnation while its generations were being listed`,
    );
  }

  // On the ordinary branch, take the LOWER of the two pointers. Within one incarnation the pointer only moves
  // forward, so a publish landing mid-listing leaves the cutoff exactly where it was and routine GC still
  // collects — refusing on any token change would make GC useless on a busy segment. But the pointer is only
  // monotonic *within* an incarnation: the numbering restarts at 0 once a row is purged and the bucket
  // emptied, so a name that was retired and re-created wears a LOWER `currentGen` than the one read before the
  // listing — and `rollbackSegment` lets an operator lower it deliberately — so `g < current` would then select
  // a live object. `Math.min` is what makes a
  // regressed pointer narrow the cutoff instead of widening it.
  const cutoff =
    current === null || after.currentGen === null ? null : Math.min(current, after.currentGen);

  // What a protecting pass spares: what the publish named, and what the row names now, which a publish that landed since
  // has added to. With no usable list on the row now (a rollback dropped it, or a writer that records none moved the
  // pointer) there is nothing to protect by, and the pass keeps the newest `keep` below the pointer as a window does.
  const named = record.status === 'destroyed' ? undefined : usableKeptGens(after);
  const protect =
    options.protect === undefined || named === undefined
      ? undefined
      : new Set([...options.protect, ...named]);

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
  const stillCollectable = async (generation: number): Promise<'delete' | 'skip' | 'stop'> => {
    const still = await deps.registry.get(ref);
    if (still === null) {
      if (quiet) return 'stop';
      throw new WriteConflictError(`registry row for segment ${ref.segment} was purged mid-pass`);
    }
    const ok =
      record.status === 'destroyed'
        ? still.token === after.token
        : cutoff === null || (still.currentGen !== null && still.currentGen >= cutoff);
    // A protecting pass deletes what the row does not name, so the row must still name something it can be held to:
    // a rollback drops the list, and a publish since may have added a name this pass did not know.
    const now = protect === undefined ? undefined : usableKeptGens(still);
    const unnamed =
      protect === undefined ||
      record.status === 'destroyed' ||
      (now !== undefined && !now.includes(generation));
    if (!ok || !unnamed) {
      if (quiet) return 'stop';
      throw new WriteConflictError(
        `segment ${ref.segment} changed incarnation while its generations were being collected`,
      );
    }
    // A lease that landed since the row was first read: this name is spared, and the pass goes on to the next.
    if (guard !== undefined && heldGenerations(still, guard.now()).has(generation)) return 'skip';
    return 'delete';
  };

  // Leases are honoured only by a load's collection, and never on a tombstone, where every generation is garbage.
  const guard = record.status === 'destroyed' ? undefined : options.leases;
  const held = guard === undefined ? undefined : heldGenerations(after, guard.now());
  const below =
    record.status === 'destroyed' || cutoff === null
      ? []
      : gens.filter((g) => g < cutoff).sort((a, b) => b - a); // newest-first
  const candidates =
    record.status === 'destroyed'
      ? gens.sort((a, b) => a - b) // all of it: no reader can resolve a generation of a tombstoned segment
      : cutoff === null
        ? // No Storage pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
          // here is either a load about to publish or an orphan we cannot tell apart from it. Deleting would race
          // that publish into a dangling pointer. It is collected once a pointer exists.
          []
        : protect !== undefined
          ? // The row's list is the window: everything below the pointer it does not name is garbage.
            below.filter((g) => !protect.has(g))
          : // Delete generations below the cutoff, except the newest `keep` of them (the grace window).
            below.slice(keep);
  // A generation a live lease holds is spared beside the ones the row names, and takes no slot of the window.
  const leasedSpared = new Set(candidates.filter((g) => held?.has(g) === true));
  const toDelete = candidates.filter((g) => !leasedSpared.has(g));
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
  const done: number[] = [];
  for (const generation of toDelete) {
    const verdict = await stillCollectable(generation);
    if (verdict === 'stop') return { deleted: done, kept: [], complete: false };
    if (verdict === 'skip') {
      leasedSpared.add(generation);
      continue;
    }
    await deps.storage.delete({ namespace: ref.namespace, segment: ref.segment, generation });
    done.push(generation);
  }
  const deleted = new Set(done);
  return {
    deleted: done,
    kept: below.filter((g) => !deleted.has(g) && !leasedSpared.has(g)).reverse(),
    complete: true,
  };
}

/** What a load's publish recorded in the row, as `publishGeneration` reports it. */
export interface PublishedKept {
  /** The list the publish wrote, or `undefined` when it wrote none (the row then does not know which are kept). */
  readonly list: readonly number[] | undefined;
  /** The names the publish pushed out of the window, ascending. */
  readonly evict: readonly number[];
  /** The token of the row the publish wrote, when it is known: a write settled by reading the row has none. */
  readonly token: Token | undefined;
}

/**
 * Collect after a load's publish. The row records the generations the load keeps, so the pass deletes by name what the
 * publish pushed out of that window ({@link deleteEvicted}) and lists the segment ({@link gcOrphanGenerations}'s
 * pass) only when it cannot rely on the row or must catch what a name does not:
 *
 *  - the row recorded no list (a `keep` above {@link MAX_KEPT_GENERATIONS}, a row an earlier schema wrote, one a
 *    rollback or an erasure moved, or a publish whose write was settled by reading the row): the pass keeps the
 *    newest `keep` generations present below the pointer, and records them with one compare-and-swap, fenced on the
 *    publish's own token, so the next load collects by name;
 *  - the guard found the current generation's object gone, or, for a `keep` of 1 or more when the guard took the size
 *    from the row's summary and opened nothing, one zero-byte read of it does not find it (`proveCurrent`): the
 *    window then counts a generation that is not there, so the same pass keeps what is;
 *  - a number the listing chose (something sits above the pointer, or the existence check could not answer), a
 *    caller that asks for a listing, and every {@link LIST_COLLECTION_CADENCE}th generation: the pass deletes every
 *    generation below the pointer the row does not name, which collects what a name-only pass leaves.
 *
 * It makes no request when `keep` is at least the generation published, since no more generations than that exist
 * below it. A load onto a `destroyed` row is refused at its publish and never reaches here; a drop that lands after
 * the publish leaves this pass collecting the tombstone's generations, and the drop's own sweep takes the rest.
 *
 * The seed's compare-and-swap moves the row's token, so a derived writer in flight on the row (an erasure rewrite)
 * meets a lost fence and re-derives: it happens once per row that recorded no list. A `WriteConflictError` from it is
 * a lost race, and the load took effect, so it is not raised; the next load records the list. Any other fault is
 * raised, as every fault of a collection after a landed publish is.
 */
export async function collectAfterLoad(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: {
    generation: number;
    keep: number;
    /** The load's number was proved free by one existence check, and no caller asked for a listing. */
    byName: boolean;
    /** The guard opened the current generation's object and found it gone. */
    currentGone?: boolean;
    kept: PublishedKept | undefined;
    /**
     * The object the load's row named as current, which the caller did not open. Before it collects by name, the pass
     * looks for this object with one zero-byte read, and lists instead unless that finds it: a name-only pass is
     * safe only while the object the row named is in the bucket.
     */
    proveCurrent?: GenKey;
    /** Spare the generations the row's live leases hold. Absent, the pass ignores leases. */
    leases?: LeaseGuard;
  },
): Promise<number[]> {
  const { generation, keep, byName, currentGone, kept, proveCurrent, leases } = options;
  if (keep >= generation) return [];
  const list = kept?.list;
  if (list === undefined || currentGone === true)
    return reconcile(ref, deps, { keep, kept, leases });
  const periodic = generation % LIST_COLLECTION_CADENCE === 0;
  if (byName && !periodic) {
    // A `keep` of 0 deletes the generation it supersedes, which is the one in question: whether it is there or not, it
    // is the name to take, and nothing is lost by taking it.
    if (
      keep >= 1 &&
      proveCurrent !== undefined &&
      !(await objectIsThere(deps.storage, proveCurrent))
    ) {
      return reconcile(ref, deps, { keep, kept, leases });
    }
    return deleteEvicted(ref, deps, { generation, evict: kept!.evict, leases });
  }
  return (await listingPass(ref, deps, { keep, protect: list, quiet: true, leases })).deleted;
}

/**
 * The listing pass that keeps the newest `keep` generations present, then records what it kept in the row, once, when
 * the row recorded none and `keep` fits the list.
 */
async function reconcile(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { keep: number; kept: PublishedKept | undefined; leases?: LeaseGuard },
): Promise<number[]> {
  const { keep, kept, leases } = options;
  const {
    deleted,
    kept: present,
    complete,
  } = await listingPass(ref, deps, { keep, quiet: true, leases });
  const token = kept?.token;
  if (
    complete &&
    token !== undefined &&
    keep <= MAX_KEPT_GENERATIONS &&
    !sameList(kept?.list, present)
  ) {
    try {
      await deps.registry.compareAndSwap(ref, token, { keptGens: present });
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
    }
  }
  return deleted;
}

function sameList(a: readonly number[] | undefined, b: readonly number[]): boolean {
  return a !== undefined && a.length === b.length && a.every((g, i) => g === b[i]);
}

/**
 * Whether an object is in the bucket, from one zero-byte read, a metadata request on every shipped driver. False when it
 * is not there and when the read fails in any way: a caller that collects by name on `true` needs the proof, and
 * lists when it does not have it.
 */
async function objectIsThere(storage: IStorageDriver, key: GenKey): Promise<boolean> {
  try {
    await storage.getTail(key, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete, with no listing, the generations a publish of `generation` pushed out of its row's window, `evict`, taken
 * from the list the publish was written against. Returns the names asked for, whether or not an object was there: a
 * delete of an absent object succeeds on every backend and says nothing, so a generation a concurrent pass, an erasure
 * or a lifecycle rule had already taken is listed all the same. A list is not a receipt (invariant 4), and neither is
 * this.
 *
 * Each delete re-reads the row first (invariant 4) and stops the pass, deleting nothing more and raising nothing, unless
 * the row still has a pointer at or above `generation` (a rollback, or a name purged and re-created with fewer loads,
 * has moved it below: the publish already landed, nothing here protects it or needs the result), the name is below
 * that pointer, and the row's own list is usable and does not name it. The last condition is what keeps a late delete
 * from taking a generation that a later publish, after a rollback, put in the window. A pointer that has moved above
 * `generation` does not stop it: a publish landing in the meantime leaves routine collection working. A fault, a
 * registry read or a delete that throws, propagates, with the pointer at `generation`.
 */
export async function deleteEvicted(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { generation: number; evict: readonly number[]; leases?: LeaseGuard },
): Promise<number[]> {
  const deleted: number[] = [];
  for (const generation of options.evict) {
    const still = await deps.registry.get(ref);
    if (still === null || still.currentGen === null || still.currentGen < options.generation) break;
    const named = usableKeptGens(still);
    if (named === undefined || generation >= still.currentGen || named.includes(generation)) break;
    // A name a live lease holds is spared, and the pass goes on: the rest of the window's evictions still go.
    if (
      options.leases !== undefined &&
      heldGenerations(still, options.leases.now()).has(generation)
    ) {
      continue;
    }
    await deps.storage.delete({ namespace: ref.namespace, segment: ref.segment, generation });
    deleted.push(generation);
  }
  return deleted;
}
