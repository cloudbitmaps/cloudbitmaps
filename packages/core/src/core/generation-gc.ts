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
import { requireInteger } from './check';
import type { Rng } from './determinism';
import { deleteSettled } from './settle';
import {
  IntegrityError,
  NotFoundError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
} from './errors';
import { generationsOf } from './generation-list';
import { KNOWN_SPAN, keptWindow, windowOf, usableKnownGens } from './known-generations';
import { heldGenerations } from './leases';
import type {
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  KnownGeneration,
  RegistryRecord,
  SegmentRef,
  Token,
} from './ports';
import { type Incarnation, sameIncarnation } from './token';

/** Delete one generation's object, settling a delete that got no answer by reading the object ({@link deleteSettled}). */
function deleteGeneration(
  deps: GenerationDeps,
  ref: SegmentRef,
  generation: number,
): Promise<void> {
  const key = { namespace: ref.namespace, segment: ref.segment, generation };
  return deleteSettled(deps.storage, key, undefined, undefined, {
    clock: deps.clock,
    rng: deps.rng,
  });
}

/** The two ports generation bookkeeping needs: the objects, and the pointer that says which one is current. */
interface GenerationDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** What a delete loop waits on before it reads the row again ({@link watchDeletes}). Absent, it does not wait. */
  readonly clock?: { readonly sleep?: (ms: number) => Promise<void> };
  /** Spreads the waits of a delete's read-back ({@link deleteSettled}). Absent, each wait is its whole bound. */
  readonly rng?: Rng;
}

/**
 * The waits, in milliseconds, before each further read of the row when a delete loop finds the pointer on a generation
 * it deleted, with no object under it ({@link watchDeletes}). A rollback that moved the pointer there checks the bucket
 * after its move, and when the check runs after the delete it finds the object gone and puts the pointer back: one
 * listing of the segment's objects (one page while the segment holds under a thousand) and one compare-and-swap, two
 * round trips, three when a lease write lands first. A rollback client farther from the store than the deleting
 * client takes that much longer, so the loop reads the row once at once and, with a clock that can wait, three more
 * times over 1.75 s in all, which covers clients a few hundred milliseconds away. Paid only when a read finds the
 * pointer on a missing generation the loop deleted, never on a pass where nothing raced.
 */
export const DELETE_SETTLE_WAITS_MS: readonly number[] = Object.freeze([250, 500, 1_000]);

/** What a delete loop has deleted, held to every read of the segment's row it makes after a delete. */
interface DeleteWatch {
  /** Note a delete that landed. */
  deleted(generation: number): void;
  /** Every generation noted so far. */
  readonly gone: ReadonlySet<number>;
  /**
   * `row`, a read of the row made after `held`, the row a delete was decided on, held to what was deleted: the deleted
   * generation it leaves the pointer on, with no object under it once the row is read again, or `undefined`.
   */
  check(held: RegistryRecord, row: RegistryRecord | null): Promise<number | undefined>;
  /** The same for one more read of the row, made only when a delete landed since the last {@link check}. */
  settle(held: RegistryRecord): Promise<number | undefined>;
}

/**
 * Hold a delete loop's reads of the row to what it deleted.
 *
 * Every loop that deletes generations reads the row before each delete, and one round trip remains between that read
 * and the delete. A rollback that lands inside it onto the generation being deleted passes its own check (a listing made
 * before the delete) and leaves the pointer on an object that is gone. Nothing can put the object back, so the loop
 * detects it instead: every read of the row it makes after a delete, and one more after its last delete when it made no
 * read since, is held to what it deleted.
 *
 * A read names a deleted generation when its row is active, of the incarnation `held` was read from, and its pointer
 * names one. A tombstone never does, since no rollback moves a `destroyed` row's pointer, and neither does a row purged
 * and made again, whose numbers are its own. Then:
 *
 *  - The bucket is asked, with one zero-byte read, a metadata request on every shipped driver. A number can be taken
 *    again once its object is deleted (invariant 2): after a rollback below it, a load can number it afresh and
 *    publish, and then the object there is that load's, and nothing is missing. Where the storage driver ignores a
 *    delete's condition, the loop's own delete can take that object too, and the read finds it missing, which it is.
 *  - A missing object is not yet the answer. A rollback whose own check ran after the delete finds the object gone and
 *    puts the pointer back, and the loop's read can fall between its move and that undo. So the row is read again, at
 *    once and, with a clock that can wait, after each of {@link DELETE_SETTLE_WAITS_MS}, each read judged as the first
 *    was, the bucket asked again; the answer is the generation the last of them names, only if every one names a
 *    deleted generation with no object under it.
 *
 * A read of the bucket that fails in any other way than "not found" throws: it says nothing about the object.
 */
export function watchDeletes(deps: GenerationDeps, ref: SegmentRef): DeleteWatch {
  const gone = new Set<number>();
  let unread = false;
  const named = (held: RegistryRecord, row: RegistryRecord | null): number | undefined =>
    row === null ||
    row.status !== 'active' ||
    row.currentGen === null ||
    !gone.has(row.currentGen) ||
    !sameIncarnation(held, row)
      ? undefined
      : row.currentGen;
  const missing = async (generation: number): Promise<boolean> => {
    try {
      await deps.storage.getTail({ namespace: ref.namespace, segment: ref.segment, generation }, 0);
      return false;
    } catch (err) {
      if (isNotFoundError(err)) return true;
      throw err;
    }
  };
  const sleep = deps.clock?.sleep;
  const waits = sleep === undefined ? [0] : [0, ...DELETE_SETTLE_WAITS_MS];
  /** The deleted generation `row` leaves the pointer on, with no object under it now; `undefined` otherwise. */
  const onMissing = async (
    held: RegistryRecord,
    row: RegistryRecord | null,
  ): Promise<number | undefined> => {
    const generation = named(held, row);
    return generation !== undefined && (await missing(generation)) ? generation : undefined;
  };
  const check = async (
    held: RegistryRecord,
    row: RegistryRecord | null,
  ): Promise<number | undefined> => {
    unread = false;
    let generation = await onMissing(held, row);
    for (const wait of waits) {
      if (generation === undefined) return undefined;
      if (wait > 0) await sleep!.call(deps.clock, wait);
      generation = await onMissing(held, await deps.registry.get(ref));
    }
    return generation;
  };
  return {
    deleted(generation: number): void {
      gone.add(generation);
      unread = true;
    },
    gone,
    check,
    settle: async (held) => (unread ? check(held, await deps.registry.get(ref)) : undefined),
  };
}

/** Who deleted the generation a {@link pointerOnDeletedError} names, which leads its message. */
type Deleter =
  | { readonly kind: 'collection' }
  | { readonly kind: 'erasure' }
  | { readonly kind: 'load'; readonly published: number }
  | { readonly kind: 'refused-load'; readonly refusal: string };

/**
 * The error for a pointer a delete loop found on a generation it deleted ({@link watchDeletes}). The writer that moved
 * the pointer there is a rollback, or, where the storage driver ignores a delete's condition, a load that took the
 * number again and published. A rollback slower than the loop's further reads can still put the pointer back after
 * them, so the message says to look before acting.
 */
export function pointerOnDeletedError(
  ref: SegmentRef,
  deleter: Deleter,
  generation: number,
): NotFoundError {
  const who =
    deleter.kind === 'collection'
      ? 'a collection'
      : deleter.kind === 'erasure'
        ? 'an erasure'
        : deleter.kind === 'load'
          ? `the load took effect at generation ${deleter.published}, but its collection`
          : `the load was refused (${deleter.refusal}) and published nothing, but its refusal, reclaiming its own object,`;
  return new NotFoundError(
    `segment "${ref.segment}": ${who} deleted generation ${generation}, and another writer moved the pointer onto ` +
      'it between the read of the row that allowed the delete and the delete; the row still named it, with no object ' +
      "under it, when read again. Check the segment's generations (store.generations, or checkConsistency) before " +
      'acting: if the pointer still names a generation missing from the bucket, every read of the segment fails, and ' +
      'since a deleted object cannot be restored, roll back to a generation still in the bucket. A rollback that ' +
      'found its target gone puts the pointer back itself.',
  );
}

/** {@link pointerOnDeletedError} for a load whose publish of `published` landed before its collection found it. */
function tookEffectOverMissing(ref: SegmentRef, published: number, missing: number): NotFoundError {
  return pointerOnDeletedError(ref, { kind: 'load', published }, missing);
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
  seen?: number[],
): Promise<number> {
  let highest = record?.currentGen ?? -1;
  for await (const key of deps.storage.list(ref)) {
    seen?.push(key.generation);
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
interface LoadNumber {
  readonly generation: number;
  /**
   * `true` when the number is `currentGen + 1` and the check found no object holding it. Collection by name rests
   * on it: the row named `generation - 1` as current, so every number the window evicts is below it, and nothing
   * the listing would have kept is a name the pass takes. `false` when the listing numbered the load.
   */
  readonly checked: boolean;
  /** The generations that listing found, when the load listed: a seed of the ledger reads them instead of listing again. */
  readonly listed?: readonly number[];
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
  const listed: number[] = [];
  return { generation: await aboveEverything(ref, deps, row, listed), checked: false, listed };
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
 * **Throws {@link NotFoundError} when a rollback moved the pointer onto a generation it deleted**: the rollback landed
 * between the pass's re-proof of the row and that delete, so the pointer names an object that is gone. The pass finds
 * it at its next re-proof, or, after its last delete, by reading the row once more. A deleted object cannot be
 * restored: the answer is a rollback to a generation still in the bucket.
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
 * **`options.incarnation`** is the row (its token, creation time and status) the caller read before it called. A pass
 * that reads another incarnation of it, or a row of the other kind, at its first read, after the listing or before a
 * delete, throws {@link WriteConflictError} and deletes nothing more: the name was purged and loaded again, and what the
 * new row holds is not what the caller searched. A delete it had already made stays made, and one round trip remains
 * between the last read before a delete and the delete itself, which goes by number: a row purged and created again
 * inside it can lose the generation under that number. It matters most under a tombstone, whose pass deletes every
 * object it lists, and the erasure's collection there and the retention sweep's pass both pass it. Without it the pass
 * collects whichever row it reads.
 *
 * `keep: 0` is how a subject-erasure rewrite makes a bit **physically** gone on return: the generation that held
 * it is collected the moment the rewrite is current. A live read still fetching from it heals forward to the
 * rewrite, and a pin of it (`seg.pin()`) fails with `NotFoundError` for any chunk it has yet to read.
 */
export async function gcOrphanGenerations(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: Pick<ListingOptions, 'keep' | 'incarnation'> = {},
): Promise<number[]> {
  const { deleted, missing } = await collectBelowPointer(ref, deps, options);
  if (missing !== undefined) {
    throw pointerOnDeletedError(ref, { kind: 'collection' }, missing);
  }
  return deleted;
}

/**
 * {@link gcOrphanGenerations}, reporting a rollback onto a generation it deleted in `missing` instead of throwing it: the
 * pass stopped there. For a caller that records what it deleted before it raises, as an erasure does. With `skipKnown` the
 * pass also spares every generation the row names when it reads the row before a delete (an erasure's passes on an active
 * row, which remove from the row what they mean to delete first).
 */
export async function collectBelowPointer(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: Pick<ListingOptions, 'keep' | 'skipKnown' | 'incarnation'> = {},
): Promise<{
  readonly deleted: number[];
  readonly missing?: number;
  readonly knownSpared?: number[];
}> {
  // Only the window, the known-name rule and the incarnation are passed on, whatever the caller's object carries: this
  // pass never reads a lease.
  const { deleted, missing, knownSpared } = await listingPass(ref, deps, {
    keep: options.keep,
    skipKnown: options.skipKnown,
    incarnation: options.incarnation,
  });
  return missing === undefined ? { deleted, knownSpared } : { deleted, missing, knownSpared };
}

/**
 * The row a pass is asked to collect: its incarnation and its kind. The kind is compared too, because a registry whose
 * tokens carry no incarnation id is told apart only by a creation stamp that two rows can share, while a tombstone never
 * becomes an active row again: every writer refuses it and nothing un-destroys it.
 *
 * A limit remains on such a registry: when a row is purged and created again and the new row is itself destroyed, a pass
 * asked for a tombstone accepts it, because two tombstones that share a stamp are one row to the pass. What it then
 * deletes is a destroyed row's leftovers, which the collection rule allows, but an erasure's audit event names the
 * other incarnation's leftovers, and the event carries no incarnation to tell them apart.
 */
type AskedRow = Incarnation & { readonly status: RegistryRecord['status'] };

/** Whether `row` is the row `asked` for: the same incarnation, and a tombstone if and only if `asked` is one. Any row, when none was asked for. */
function isAskedRow(asked: AskedRow | undefined, row: RegistryRecord): boolean {
  return (
    asked === undefined ||
    (sameIncarnation(asked, row) && (asked.status === 'destroyed') === (row.status === 'destroyed'))
  );
}

/**
 * Reads the row, and throws {@link WriteConflictError} when it is not the row the pass was asked to collect ({@link
 * isAskedRow}). A row that is gone is returned as `null`, for the pass to treat as it treats any gone row (an empty
 * answer at its first read, a refusal at its re-read); with no row asked for, nothing is refused. Used for the pass's
 * first read, before the listing, and for its re-read, after it.
 */
async function readHeldRow(
  deps: GenerationDeps,
  ref: SegmentRef,
  asked: AskedRow | undefined,
): Promise<RegistryRecord | null> {
  const row = await deps.registry.get(ref);
  if (row === null || isAskedRow(asked, row)) return row;
  throw refusedOtherRow(ref);
}

/** Whether the pass is quiet. A quiet pass stops where a held pass throws, so the two are not given together. */
function quietOf(options: ListingOptions): boolean {
  if (options.quiet === true && options.incarnation !== undefined) {
    throw new ValidationError('a quiet collection pass cannot be held to a row incarnation');
  }
  return options.quiet === true;
}

/** The refusal a pass makes when the pointer or the row's names moved under a delete it had queued. */
function changedWhileCollecting(ref: SegmentRef): WriteConflictError {
  return new WriteConflictError(
    `segment ${ref.segment} changed incarnation while its generations were being collected`,
  );
}

/** The refusal a pass makes when the row it reads is not the one its caller worked from. It reaches users in a ledger note. */
function refusedOtherRow(ref: SegmentRef): WriteConflictError {
  return new WriteConflictError(
    `segment ${ref.segment} is not the row this collection works from: the row was purged and created again, or is no longer of the same kind (a tombstone or an active row), since it was read`,
  );
}

/**
 * What makes a collection spare leased generations: the clock that says whether a lease has ended. Only a load's
 * collection passes one, and a load with no clock passes none: it cannot tell a live lease from an ended one, so it
 * reads none. A pass without a guard never reads the row's leases, which is what keeps erasure, shred and drop deleting
 * what a lease names.
 */
interface LeaseGuard {
  readonly now: () => number;
}

/** The generation a load's publish superseded, and the one it published over it. */
interface Superseded {
  /** The generation the row named as current when the load read it. */
  readonly generation: number;
  /** The generation the load published. */
  readonly by: number;
}

/** What a listing pass did: the generations it deleted, and whether it stopped on a rollback onto one of them. */
interface ListingResult {
  readonly deleted: number[];
  /**
   * A generation the pass deleted that the row named when the pass read it afterwards ({@link watchDeletes}),
   * quiet or not. The pass stops there, and its caller raises it.
   */
  readonly missing?: number;
  readonly knownSpared?: number[];
}

/** What a listing pass is asked to do. */
interface ListingOptions {
  keep?: number;
  protect?: readonly number[];
  quiet?: boolean;
  leases?: LeaseGuard;
  /** What the load's publish superseded, which its window keeps first when the row has no usable ledger. */
  superseded?: Superseded;
  /**
   * Spare every generation the row names when it is read again before a delete. For a pass that keeps by a count on
   * an active row: a publish or a rollback that landed since the pass chose what to delete can have made a name known.
   */
  skipKnown?: boolean;
  /**
   * The row the caller worked from. A pass that reads another incarnation of it, or a row of the other kind (a
   * tombstone for an active row, an active row for a tombstone), at its first read, at its re-read after the listing
   * or at its re-proof before a delete, throws {@link WriteConflictError} and deletes nothing more: the name was purged
   * and created again, and the generations it now holds are not the ones the caller searched. For a pass that is not
   * a load's: a quiet pass is never given one, and is refused with a `ValidationError` if it is.
   */
  incarnation?: AskedRow;
}

/**
 * {@link gcOrphanGenerations}, and what it left. With `protect` it deletes by the row's record instead of by a window:
 * every generation below the pointer that is not in `protect`, so an object no publish named (an orphan of a crashed
 * or refused load, extras a fault left) goes whatever slot it would have taken in a window. The row as the pass reads it
 * after the listing joins `protect`, so a publish that landed meanwhile keeps its own window; with no usable list there
 * the pass keeps a window of `keep` below the pointer instead. Each delete is proved against the row's list once more.
 *
 * A pass that keeps by a count has a window of `keep`: with a usable ledger, its own names first, in the order they were
 * made current, then the newest others by number; without one, {@link keptWindow}'s: with `superseded`, a load's pass
 * keeps the generation its publish superseded first, then the newest of the rest by number, and without it, as for
 * every pass that is not a load's, the newest `keep`. A pass with `skipKnown` also spares every name the row knows when
 * it re-reads the row before a delete.
 *
 * A `quiet` pass is a load's, after its publish landed: a row another writer moved means the pass stops and reports what
 * it did, where any other pass throws {@link WriteConflictError}, because a load that took effect must not fail on a
 * race it won. A row that names a generation the pass deleted is no race won, quiet or not: the pass stops and reports
 * it in `missing`.
 *
 * Exported for its test only, which gives it the combinations no caller reaches. Callers collect through
 * {@link gcOrphanGenerations}, {@link collectBelowPointer} or the load's own collection, which pass it what each
 * pass may use.
 */
export async function listingPass(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: ListingOptions,
): Promise<ListingResult> {
  const keep = options.keep ?? 1;
  const quiet = quietOf(options);
  // Refused, not clamped: `NaN` slices nothing off the end and would collect the whole grace window, and a
  // negative count that clamps to 0 collects it too, for a caller who wrote a typo.
  requireInteger(keep, { min: 0, what: 'keep' });
  const record = await readHeldRow(deps, ref, options.incarnation);
  if (record === null) return { deleted: [] }; // no authoritative pointer → don't delete anything
  const current = record.currentGen;
  // Each number once: a duplicate would silently consume a slot of the `keep` window and evict a live generation.
  const gens = await generationsOf(deps.storage, ref);
  // Everything above was read BEFORE the listing and is acted on after it, and the listing is paginated —
  // seconds wide on a real object store. So re-read the row and reconcile, because BOTH branches can otherwise
  // delete an object the live pointer names, which is the forbidden `missing-storage-generation` state.
  //
  // A purged row refuses outright, on either branch: purged-and-idle is indistinguishable from
  // purged-and-being-recreated, and the top of this function already declines to act without an authoritative
  // pointer.
  const after = await readHeldRow(deps, ref, options.incarnation);
  if (after === null) {
    if (quiet) return { deleted: [] };
    throw new WriteConflictError(`registry row for segment ${ref.segment} was purged mid-pass`);
  }

  // On a tombstone, require the *same* row. A token is not reused (ABA-safe, 2^-128 per pair of incarnations), so an unchanged one proves the
  // segment was not purged and re-created underneath this pass — which matters here because this branch deletes
  // every object it enumerated, `currentGen` included, so a re-created segment would lose the generation its
  // new pointer names.
  if (record.status === 'destroyed' && after.token !== record.token) {
    if (quiet) return { deleted: [] };
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
  // pointer) there is nothing to protect by, and the pass keeps a window of `keep` below the pointer instead.
  const named = record.status === 'destroyed' ? undefined : windowOf(after);
  const protect =
    options.protect === undefined || named === undefined
      ? undefined
      : new Set([...options.protect, ...named]);

  // What the pass has deleted, in order, and the watch every read of the row after a delete is held to.
  const done: number[] = [];
  const knownSpared: number[] = [];
  const watch = watchDeletes(deps, ref);

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
   *
   * Before either, the read is held to what the pass has deleted: a rollback that landed between an earlier re-proof
   * and its delete has moved the pointer onto an object that is gone ({@link watchDeletes}).
   */
  const stillCollectable = async (
    generation: number,
  ): Promise<'delete' | 'skip' | 'skipKnown' | 'stop' | { readonly missing: number }> => {
    const still = await deps.registry.get(ref);
    const missing = await watch.check(after, still);
    if (missing !== undefined) return { missing };
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
    const now = protect === undefined ? undefined : windowOf(still);
    const unnamed =
      protect === undefined ||
      record.status === 'destroyed' ||
      (now !== undefined && !now.includes(generation));
    const asked = isAskedRow(options.incarnation, still);
    if (!ok || !unnamed || !asked) {
      if (quiet) return 'stop';
      throw asked ? changedWhileCollecting(ref) : refusedOtherRow(ref);
    }
    // A lease that landed since the row was first read: this name is spared, and the pass goes on to the next.
    if (guard !== undefined && heldGenerations(still, guard.now()).has(generation)) return 'skip';
    // A name the row knows now was unknown when the pass chose its deletes: a publish or a rollback made it known.
    if (
      options.skipKnown === true &&
      record.status !== 'destroyed' &&
      usableKnownGens(still)?.some((e) => e.generation === generation) === true
    ) {
      return 'skipKnown';
    }
    return 'delete';
  };

  // The generation the window keeps first: the one the load's publish superseded, while the cutoff, the lower of the
  // pass's two reads of the pointer, is the load's own generation. Otherwise another writer moved the pointer before
  // the first read, or a rollback lowered it by the second, and this pass does not know what that pointer superseded:
  // the window is then the newest by number, as for a pass that knows no superseded generation. The comparison is of
  // generation numbers, not incarnations: a row purged and made again whose pointer reaches the load's number between
  // the two reads would have the old incarnation's superseded number kept first, which only chooses what is kept, as
  // the cutoff and the re-read before each delete still bound what is deleted.
  const prior =
    options.superseded !== undefined && cutoff === options.superseded.by
      ? options.superseded.generation
      : undefined;
  // The generation this load superseded is not in the listing the pass made (a lifecycle rule took it): the row's list
  // names a generation that is not there, so the window would hold fewer than `keep`. The pass counts instead, as a
  // by-name pass does when it finds the object gone, and costs no request: it has already listed.
  const supersededGone = prior !== undefined && keep >= 1 && !gens.includes(prior);
  // Leases are honoured only by a load's collection, and never on a tombstone, where every generation is garbage.
  const guard = record.status === 'destroyed' ? undefined : options.leases;
  const held = guard === undefined ? undefined : heldGenerations(after, guard.now());
  const below =
    record.status === 'destroyed' || cutoff === null
      ? []
      : gens.filter((g) => g < cutoff).sort((a, b) => b - a); // newest-first
  const candidates =
    record.status === 'destroyed'
      ? gens // all of it: no reader can resolve a generation of a tombstoned segment
      : cutoff === null
        ? // No Storage pointer yet, so "below current" selects nothing and there is nothing safe to infer: an object
          // here is either a load about to publish or an orphan we cannot tell apart from it. Deleting would race
          // that publish into a dangling pointer. It is collected once a pointer exists.
          []
        : protect !== undefined && !supersededGone
          ? // The row's list is the window: everything below the pointer it does not name is garbage.
            below.filter((g) => !protect.has(g))
          : // Delete generations below the cutoff, except the `keep` of them the grace window holds, newest first.
            outsideWindow(below, usableKnownGens(after), cutoff, prior, keep);
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
  // and is never on the read path, and one more after the last delete (below).
  for (const generation of toDelete) {
    const verdict = await stillCollectable(generation);
    if (typeof verdict === 'object') {
      return { deleted: done, missing: verdict.missing };
    }
    if (verdict === 'stop') return { deleted: done };
    if (verdict === 'skip' || verdict === 'skipKnown') {
      if (verdict === 'skipKnown') knownSpared.push(generation);
      leasedSpared.add(generation);
      continue;
    }
    await deleteGeneration(deps, ref, generation);
    done.push(generation);
    watch.deleted(generation);
  }
  // No re-proof follows the last delete, so a rollback onto it would go unseen: one read of the row covers it. Not on a
  // tombstone, whose pointer no rollback moves.
  if (record.status !== 'destroyed') {
    const missing = await watch.settle(after);
    if (missing !== undefined) return { deleted: done, missing, knownSpared };
  }
  return { deleted: done, knownSpared };
}

/**
 * The generations of `below` (newest first, all below `cutoff`) that a pass keeping `keep` of them deletes, newest first.
 *
 * With a usable ledger the window starts from the ledger's own span: of the `min(keep, 127)` most recently current names
 * it has below the cutoff, the ones present. Then the newest of the other present generations by number, until `keep` in
 * all. The superseded generation is the ledger's newest name below the pointer, so it comes first with no rule of its
 * own, and one whose object has gone does not count, so the window still holds `keep`. A name the ledger holds only for
 * a lease is older than the span, takes no slot, and is spared beside the window (the caller's lease check). With no
 * usable ledger the window is {@link keptWindow}'s: the superseded generation first, then the newest by number.
 */
function outsideWindow(
  below: readonly number[],
  known: readonly KnownGeneration[] | undefined,
  cutoff: number,
  superseded: number | undefined,
  keep: number,
): number[] {
  if (known === undefined) return keptWindow(below, superseded, keep).evict.reverse();
  const present = new Set(below);
  const span = Math.min(keep, KNOWN_SPAN);
  const named = known.filter((e) => e.generation < cutoff).map((e) => e.generation);
  const held = new Set((span === 0 ? [] : named.slice(-span)).filter((g) => present.has(g)));
  for (const g of below) {
    if (held.size >= keep) break;
    held.add(g);
  }
  return below.filter((g) => !held.has(g));
}

/** What a load's publish recorded in the row, as `publishGeneration` reports it. */
export interface PublishedKept {
  /** The window the publish recorded, as numbers, or `undefined` when it recorded none (the row then does not know which are kept). */
  readonly list: readonly number[] | undefined;
  /** The ledger the publish wrote, in the order the generations were made current, when it wrote one. */
  readonly known?: readonly KnownGeneration[];
  /** The names the publish pushed out of the window, ascending. */
  readonly evict: readonly number[];
  /** The token of the row the publish wrote, when it is known: a write settled by reading the row has none. */
  readonly token: Token | undefined;
}

/**
 * Collect after a load's publish. The row's ledger records the generations the load keeps, so the pass deletes by name
 * what the publish pushed out of that window ({@link deleteEvicted}) and lists the segment ({@link gcOrphanGenerations}'s
 * pass) only when it cannot rely on the row or must catch what a name does not:
 *
 *  - the publish recorded no window to collect by name (a `keep` above {@link MAX_KEPT_GENERATIONS}, a publish that
 *    seeded its ledger from the bucket, a row with no usable ledger, or a publish whose write was settled by reading
 *    the row after its last attempt; one settled within its attempts carries the window it wrote): the pass keeps
 *    `keep` of the generations present below the pointer, the ledger's own most recently current names first and then
 *    the newest others by number, or, over a row with no usable ledger, `previous` first and then the newest by number
 *    ({@link keptWindow}), and writes nothing: the publish already wrote the ledger, which is what the next load
 *    derives its window from. It spares every name the row knows when it re-reads the row before a delete, which a
 *    publish or a rollback that landed since can have added to;
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
 * Any fault of the collection is raised, as every fault of a collection after a landed publish is. A delete that gets
 * no answer is not one while reading its object shows it gone: it counts as deleted.
 *
 * So is a rollback onto a generation the pass deleted, which the pass finds by holding every read of the row it makes
 * after a delete to what it deleted, and by reading the row once more after its last delete
 * ({@link watchDeletes}): it throws {@link NotFoundError}, saying the load took effect at `generation` and the
 * generation the pointer names is missing. That read is the one request this adds to a load whose pass deleted
 * anything.
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
    /**
     * The generation the row named as current when the load read it, which its publish superseded. A window kept by
     * listing holds it first, while the pointer is still the load's. Absent: the load found no pointer.
     */
    previous?: number;
  },
): Promise<number[]> {
  const { generation, keep, byName, currentGone, kept, proveCurrent, leases, previous } = options;
  if (keep >= generation) return [];
  const superseded = previous === undefined ? undefined : { generation: previous, by: generation };
  const list = kept?.list;
  if (list === undefined || currentGone === true)
    return reconcile(ref, deps, { generation, keep, leases, superseded });
  const periodic = generation % LIST_COLLECTION_CADENCE === 0;
  if (byName && !periodic) {
    // A `keep` of 0 deletes the generation it supersedes, which is the one in question: whether it is there or not, it
    // is the name to take, and nothing is lost by taking it.
    if (
      keep >= 1 &&
      proveCurrent !== undefined &&
      !(await objectIsThere(deps.storage, proveCurrent))
    ) {
      return reconcile(ref, deps, { generation, keep, leases, superseded });
    }
    return deleteEvicted(ref, deps, { generation, evict: kept!.evict, leases });
  }
  const pass = await listingPass(ref, deps, {
    keep,
    protect: list,
    quiet: true,
    leases,
    superseded,
  });
  if (pass.missing !== undefined) throw tookEffectOverMissing(ref, generation, pass.missing);
  return pass.deleted;
}

/**
 * The listing pass that keeps a window of `keep` generations present, the one the load superseded first. It writes
 * nothing: the load's publish wrote the row's ledger.
 */
async function reconcile(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: {
    generation: number;
    keep: number;
    leases?: LeaseGuard;
    superseded?: Superseded;
  },
): Promise<number[]> {
  const { generation, keep, leases, superseded } = options;
  const { deleted, missing } = await listingPass(ref, deps, {
    keep,
    quiet: true,
    leases,
    superseded,
    skipKnown: true,
  });
  if (missing !== undefined) throw tookEffectOverMissing(ref, generation, missing);
  return deleted;
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
 *
 * A rollback onto a name it deleted is not a stop: every read of the row after a delete is held to what it deleted, and
 * so is one more read after its last delete when it made none since ({@link watchDeletes}). One that names a
 * deleted generation throws {@link NotFoundError}, saying the load took effect at `generation`.
 */
export async function deleteEvicted(
  ref: SegmentRef,
  deps: GenerationDeps,
  options: { generation: number; evict: readonly number[]; leases?: LeaseGuard },
): Promise<number[]> {
  const deleted: number[] = [];
  const watch = watchDeletes(deps, ref);
  // The row the first delete was decided on.
  let held: RegistryRecord | undefined;
  for (const generation of options.evict) {
    const still = await deps.registry.get(ref);
    const lost = held === undefined ? undefined : await watch.check(held, still);
    if (lost !== undefined) throw tookEffectOverMissing(ref, options.generation, lost);
    if (still === null || still.currentGen === null || still.currentGen < options.generation) break;
    const known = usableKnownGens(still);
    if (
      known === undefined ||
      generation >= still.currentGen ||
      known.some((e) => e.generation === generation)
    ) {
      break;
    }
    // A name a live lease holds is spared, and the pass goes on: the rest of the window's evictions still go.
    if (
      options.leases !== undefined &&
      heldGenerations(still, options.leases.now()).has(generation)
    ) {
      continue;
    }
    held ??= still;
    await deleteGeneration(deps, ref, generation);
    deleted.push(generation);
    watch.deleted(generation);
  }
  // No read follows the last delete, so a rollback onto it would go unseen: one read of the row covers it.
  const lost = held === undefined ? undefined : await watch.settle(held);
  if (lost !== undefined) throw tookEffectOverMissing(ref, options.generation, lost);
  return deleted;
}
