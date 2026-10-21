/**
 * Subject erasure on a loaded segment (GDPR Art. 17): remove **one id** from a segment by rewriting its current
 * generation without that id.
 *
 * There is no per-id delete on an immutable object, and there is no mutable tier to hold a tombstone, so erasure
 * is what every other write in this library is: a new generation. The current generation is streamed chunk by
 * chunk through the ascending writer — every chunk decoded, range-checked and re-encoded, the one holding the id
 * with that bit cleared — then published fenced on the generation it streamed, and that generation is collected
 * immediately (`keep: 0`), so when it answers `erased: true` the bit is **physically gone from the bucket when this
 * returns** (a noncurrent version, a replica or a backup keeps the old object until its own lifecycle removes it).
 * Bounded memory: a window of 32 chunk reads ahead of the writer, never the whole segment.
 *
 * The rewrite is the same generation without one id, so it keeps everything else: the new object carries the source's
 * metadata as it is, and the row's summary of it, built from what was written, counts one id fewer and holds the same
 * metadata. Metadata is not scanned for the id. A source object whose metadata block was stripped is another object
 * than the row's summary names: its size is not the one the summary records, so the fingerprint check refuses it
 * before the erasure reads any of its ids. Only one forged to match that fingerprint gets past, and on an encrypted
 * segment it is rewritten with the metadata of the row's sealed summary: the block's presence is not authenticated, so
 * the authenticated copy decides.
 *
 * **`erased: true` is a claim about every generation of the segment, not only the one it replaced.** A rollback
 * leaves generations above the pointer that were once current and can be made current again, so a holder can sit
 * above the pointer as well as below it, and there can be several. Before it reports `erased: true` the call
 * therefore lists the bucket once more and reads every generation it has not already seen to be clean; any that
 * still holds the id makes it report or throw instead. A number can be taken again once its object is deleted, so a
 * generation it saw clean is read again too, but for two: the one it found current and its own rewrite, each skipped
 * only while the row, read after that listing, names it with the footer checksum of the object the call read or wrote.
 * In the ordinary case that list returns one generation, the current one, which the row names: one `list` and one
 * read of the row.
 *
 * What it does NOT reach: backups, replicas and noncurrent object versions hold the old object until their own
 * lifecycle removes it. For an at-rest guarantee that reaches those, use encryption plus crypto-shred
 * (`destroySegment`), which is per segment — a per-id shred is infeasible because one DEK covers the whole segment —
 * and is complete once no retained copy of the segment's registry row holds its wrapped key, or every KEK that
 * wrapped it is destroyed.
 *
 * Concurrency. This is a **read-modify-write**, not a plain forward-only publish, and that distinction is where
 * its correctness lives: the new generation is `from` minus one bit, so it is a valid successor to `from` and to
 * nothing else. The publish is therefore fenced on `from` **and on the row it was read from**
 * (`publishGeneration`'s `expectFrom` + `expectToken`) and lands only while the pointer is still exactly there,
 * on that same row. Both halves are needed: a generation number identifies a generation only within one
 * incarnation of a name, and a name that is retired and re-created restarts at `0`, so the number alone matched
 * a different segment entirely. Anything else — a load that published in the meantime, or another
 * erasure that got there first — is reported as `reason: 'superseded'`, `erased: false`, and the caller re-runs
 * against the new generation. So is a writer that claims the same generation *number* first (write-once): the put
 * is refused with a `WriteConflictError`, which is read here as the lost race it is.
 *
 * The same answer covers the read half, and for the same reason. An erasure collects with `keep: 0`, which takes
 * every generation below its new pointer — so a racing erasure can delete the generation this call is streaming,
 * and (once it is below the winner's pointer) the object this call just wrote. All three exposed round trips (the
 * reader open, any chunk of the whole-segment rewrite, the verify) therefore report a *reason* rather than a bare
 * `NotFoundError`, which was the same event wearing an unactionable face: through `eraseSubject` it became a note
 * the facade documents as ambiguous about which side of the publish it landed on, telling an operator to triage
 * where the truth was to re-run.
 *
 * Which reason comes from **re-reading the row**, not from assuming a supersession: a moved pointer is
 * `'superseded'`, a tombstoned row `'destroyed'`, a purged row `'absent'`, a row that lost its pointer
 * `'superseded'` too (its bucket was not searched, so no claim about it is made; a re-run searches it). A pointer still on `from` means the object it names is genuinely gone — the forbidden
 * `missing-storage-generation` state — or is another object than the row's summary names by its fingerprint, and that
 * throws, because no re-run fixes either. That `NotFoundError` is the only signal of those states, so a faulting
 * re-read rethrows it rather than replacing it with a transient-looking registry error.
 *
 * **A refused rewrite deletes its own object when it would outlive the winner above the pointer.** `putImmutable`
 * commits atomically, so a rewrite whose stream throws leaves no object at all. One that completed is either
 * below the winner's pointer, where the winner's collection takes it, or above it: the case where this call took
 * its number after the winner's object was already in the bucket. Up there nothing collects it, and it was derived
 * from a generation the winner has replaced, so when the winner was another erasure it still holds the id that
 * erasure has just reported gone. That object is deleted before this call returns, once its footer matches the
 * rewrite's and a renewal of the row has refused every publish fenced on a row read before it, under the version the
 * footer read reported, unless {@link DISCARD_ATTEMPTS} renewals lose to other writes (a load, a rollback, a
 * retention write): then it is kept, and can hold the winner's id, until a later call takes it: any erasure that
 * rewrites the segment (this one's re-run among them, while its id is still in the current generation) numbers above it
 * and its `keep: 0` collection takes it, an erasure of the winner's id deletes it as a holder, and once loads number
 * past it their collection takes it as it takes any orphan — see `discardRefused`.
 *
 * Without that fence the failure was silent and severe, and both halves were reproduced: `nextGeneration` picks a
 * number above everything in the bucket, so a forward-only publish here always won — discarding a concurrent
 * load's whole set, and letting two concurrent erasures each return `erased: true` while the second one's
 * generation put the first one's id back and collected the generation that had evidenced its removal. A false
 * Art. 17 receipt is the worst output this module can produce.
 *
 * A live read still fetching from the collected generation heals forward to the rewrite, and a pin of it fails with
 * `NotFoundError` for any chunk it has yet to read: that is the documented cost of physical deletion on return. **Do not re-load the id while erasing it**: a load that lands after this rewrite
 * carries whatever its source held, and the library cannot know that source was meant to exclude the id.
 * A load already in flight writes its object above the pointer before it publishes, or, as a first load onto a row with
 * no pointer, before there is a pointer at all. An erasure that finds the id in that object renews the row's `pointerId`
 * before deleting it, so the load's publish, fenced on the row it read, is refused (`published: false`) and the pointer
 * never names a missing object (see `fence`). An erasure that finds no holder writes nothing.
 *
 * Before it deletes anything, a call that found a holder takes every generation it will delete out of the row's ledger
 * of known generations, in one write made after its search (the same write as the renewal where there is one). A
 * generation the ledger names is one a collection by a count spares, so the delete comes after the name goes: a
 * rollback that raced the write loses its swap, and a collection that reads the row before a delete spares what the row
 * names. That write is made only when the ledger names something to delete, and it is the
 * one case in which an erasure of an id held only by an older generation writes the row.
 *
 * An object sealed under a key its row does not hold cannot be searched, and no read of the segment can open it: a
 * first load's on a row with no pointer, whose key that load has not published; on a segment with a key, a first
 * load's that lost the race to the one that published, or crashed, under a key it made and never stored; and on a
 * cleartext segment with a pointer, any encrypted object, since a key is made only for a segment's first generation
 * and a publish never adds one to a segment that has generations: a first load's that minted a key and crashed, or
 * lost the race to a cleartext first load. It counts as
 * a holder whatever the id: an erasure of any id that finds one deletes it, under the same renewal of the row and read
 * before the delete, and lists it in `collected`, and a first load still in flight that wrote it is refused. Only a
 * searched object that held the id makes the answer `erased: true`. The current generation is never one of them: one
 * the row's key does not open throws, as every read of the segment does.
 */
import { type IAuditSink, NOOP_AUDIT, checkedAuditSink, safeAudit } from './audit';
import { incarnationField, sameIncarnation } from './token';
import { MAX_REMAINDER, splitId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';
import type { Yielder } from './cooperative';
import type { Entropy, Rng } from './determinism';
import {
  objectIsEncrypted,
  objectVersionOf,
  openGenerationReaderNoting,
  sameObjectUnder,
  openGenerationReader,
  provenObject,
  provesOwnObject,
  verifyGeneration,
} from './crbm-open';
import { publishGeneration } from './publish';
import { requireEntropy, writeCrbmGenerationStream } from './crbm-write';
import { DEFAULT_MAX_BITMAP_BYTES } from './crbm/format';
import { footerCrcOf } from './crbm/fingerprint';
import type { CrbmReader } from './crbm/reader';
import { mapWithConcurrency } from './concurrency';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  type NotFoundError,
  WriteConflictError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isWriteConflictError,
} from './errors';
import {
  collectBelowPointer,
  gcOrphanGenerations,
  nextGeneration,
  pointerOnDeletedError,
  watchDeletes,
} from './generation-gc';
import { UNANSWERED_BASE_MS, UNANSWERED_RESENDS, leaseChurn, onlyLeasesDiffer } from './leases';
import { renewPointer, renewsPointer } from './pointer-id';
import { pruneKnown, usableKnownGens } from './known-generations';
import { assertRegistryCanWrite } from './ports';
import { checkRequireEncryption } from './check';
import type {
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryPatch,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  Token,
} from './ports';
import { generationsOf } from './generation-list';
import { ascending } from './order';
import { deleteSettled } from './settle';
import { type ReadRetry, jitteredWait, retryRead } from './retry';
import { metadataToCarry, ownSummary, usableSummary } from './summary';
import { validateUserRef } from './validate';

/** Generations whose index and chunk are read at once while looking for a holder of the id; the keep window is small. */
const HOLDS_CONCURRENCY = 4;

/**
 * Renewals a refused rewrite's discard makes before it keeps its object: the first, and one more each time a write that
 * is neither a write of leases alone nor another erasure's renewal of the row lands between its read of the row and its
 * renewal. Those two are waited out, up to the limit on lease waits (`LEASE_ONLY_RETRIES`), and cost none, so the
 * losers of one race of erasures all delete their rewrites; a write that gets no answer is sent again within the same
 * renewal.
 */
export const DISCARD_ATTEMPTS = 8;

/**
 * Writes a call's fence makes before it gives up on a row that keeps changing under it: each one lost to another writer
 * (a load, a rollback, another erasure) that is not a write of the row's leases alone costs one. The call then reports
 * `'superseded'` with nothing deleted.
 */
export const FENCE_ATTEMPTS = 5;

/** What {@link eraseIdFromSegment} needs: the objects, the pointer, the codec, and the key material if encrypted. */
export interface EraseIdDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /**
   * Bitmap codec — the rewrite decodes and re-encodes every chunk through it. Optional in the type so this stays
   * call-compatible public API; a **flavor** package binds it (see {@link requireCodec}).
   */
  readonly codec?: CodecInterface;
  /**
   * Keystore for an **encrypted** segment: its registry record carries wrapped DEK(s), and the rewrite reuses
   * that DEK — unwrapping it to decrypt the old generation and encrypt the new one under a `(segment, generation)`
   * -bound AAD. Rewriting an encrypted segment without a keystore throws {@link KeyUnavailableError}.
   */
  readonly keystore?: IKeystore;
  /** When true, refuse to rewrite a **cleartext** segment (the same guard the read path and a load offer). */
  readonly requireEncryption?: boolean;
  /**
   * Supplying a clock that can yield makes the rewrite cooperative, as it makes a load. Its `sleep` is what a registry
   * write that got no answer waits on before a fresh one is sent; with no `sleep`, such a write is not sent again and
   * its `TransientError` is thrown.
   */
  readonly clock?: Yielder;
  /**
   * The random source that spreads the waits between the fresh compare-and-swaps of the rewrite and of the row's
   * renewal. Absent, the read retry's source is used if it has one, and otherwise each wait is its bound.
   */
  readonly rng?: Rng;
  /**
   * The source of the rewrite's identity: 12 random bytes its footer carries when the segment is cleartext (an encrypted
   * rewrite carries its index's AEAD nonce), so the rewrite is not the same object as a load of the same ids at its
   * number. Required: an erasure without one (a JavaScript caller can leave it out) is refused with
   * {@link ValidationError} before any read, keystore call, delete or write, even when it would find nothing to rewrite.
   */
  readonly entropy: Entropy;
  /** Per-chunk decode ceiling (invariant 5); defaults to 1 MiB. The `.crbm` reader refuses an entry above its own `maxPayloadBytes` (1 MiB, plus 28 bytes when encrypted) at open, so raise that on the chunk source too. */
  readonly maxBitmapBytes?: number;
  /**
   * The store's read retry, for the reads the rewrite makes along the way: the generation it rewrites and each of its
   * chunks, the read-back that verifies the generation it wrote, and any other generation it checks for the id. A
   * transient fault on one is run again under it rather than failing the erasure. Absent, each read is made once.
   * The deletes are not retried, and the rewrite's registry write and the row's renewal are settled as a load's is.
   */
  readonly readRetry?: ReadRetry;
}

export interface EraseIdResult {
  readonly segment: string;
  readonly namespace?: string;
  /**
   * True iff the id **was** in the segment — in its current generation, or in any other generation still in the
   * bucket, above the pointer or below it — and **no generation of the segment holds it now**. The current
   * generation is one without it, every generation that held it has been deleted (see `collected`), and the call
   * listed the bucket and read what was left before saying so. This is the field an erasure ledger records.
   */
  readonly erased: boolean;
  /**
   * Why the id was not erased, when `erased` is false. `'absent'` (no registry row), `'destroyed'` (a tombstone; its
   * objects are searched first), `'no-generation'` (a row with no generation yet when the call read it, its first
   * read: its bucket can hold first loads' objects, none of them found to hold the id, and `collected` names any this
   * call deleted unsearched, see below),
   * `'not-member'` (no
   * generation in the bucket holds the id — the common case across a fleet scan — with the same note on `collected`),
   * or `'superseded'`.
   *
   * **`'superseded'` means this call did not erase the id, not that the id is still there.** Another writer — a
   * load, another erasure, or a rollback — moved the pointer off the generation this call read (on a row with no
   * pointer, any other write of the row before this call renewed it, a `setRetention` included), or replaced an
   * object it meant to delete (another erasure deleted a holder above the pointer, or on a row with no pointer, and a
   * load stored another object under its number, so the storage driver's conditional delete refused this call's,
   * whether or not the pointer moved). What it was doing no longer follows from what is current: a rewrite derived
   * from that generation is not a valid successor to the new one, and a generation it meant to delete may be the one
   * the pointer now names, or another object than the one it read.
   * Re-run against the new generation: if the id is still present it is erased then; if the racing writer was
   * another erasure of the *same* id, the re-run reports `'not-member'` because it is already gone. Either way the
   * re-run settles it, which is why it is the documented action for this reason and for no other.
   *
   * `'absent'` and `'destroyed'` are also returned when the row changes *underneath* a call already in flight, not
   * only when it is read up front — a concurrent `dropSegment` gives `'destroyed'`, once the tombstone's objects have
   * been searched as a fresh call searches them, and a retention sweep that purges the row gives `'absent'`.
   * `'no-generation'` is only the answer to a row read with no generation: a row that loses its pointer *after* the
   * call found one (a purge and re-creation, or a hand-made write) is `'superseded'`, because the call found a holder
   * in that bucket and stopped before deleting it, and a re-run searches it again.
   */
  readonly reason?: 'absent' | 'destroyed' | 'no-generation' | 'not-member' | 'superseded';
  /**
   * The generation the id was found in (present whenever one was read) — the newest of them, when the current
   * generation did not hold it and several others did.
   */
  readonly fromGeneration?: number;
  /**
   * The generation written without the id (present whenever one was written, even if `superseded`). A refused
   * rewrite whose object sits above the winner's pointer deletes that object again before it returns, when its footer
   * matches the rewrite's and a renewal of the row refuses every publish fenced on a row read before it.
   */
  readonly generation?: number;
  /**
   * Generations this call deleted. On a rewrite that is normally `[fromGeneration]`, plus any older orphans. When
   * the current generation did not hold the id and a generation this call searched did, it is every generation below
   * the pointer (`keep: 0` takes them together) and each one above the pointer that held the id; the ones above it
   * that did not hold the id stay, because they are an operator's rollback targets. On a row with no pointer it is
   * each first load's object that held the id. Wherever it found them, it is also each object sealed under a key the
   * row does not hold, which this call cannot search and deletes whatever the id. When those are the only holders, it
   * is only those, deleted one by one, and every generation this call searched stays: `reason` is then
   * `'no-generation'` on a row with no pointer and `'not-member'` on one with a pointer. Empty when nothing was
   * deleted.
   *
   * **It is what THIS call deleted, not the proof that the id is gone** — those differ: a concurrent collector can
   * take a generation holding the id first, and then `erased: true` is returned without it in `collected`, because
   * the claim is about the bucket rather than about who emptied it. Treat a non-empty `collected` as evidence and
   * a missing holder as "someone else got there", never as a failure.
   *
   * A call that cannot establish the claim **throws** `WriteConflictError` or the underlying fault rather than
   * report `erased: true` over bytes that are still there. Four ways that happens: a Storage `delete` fault the call cannot settle by reading the object back; a
   * collection pass that could not prove the segment was still the same one (which an ordinary retirement landing
   * mid-call is enough to cause); the same refusal on the path where the current generation did not hold the id
   * and nothing was published at all; and a generation still holding the id when the bucket is listed at the end
   * — one an operator rolled the pointer onto while a rewrite was collecting, say, or, on a row with no pointer, the
   * object of a first load that read the row before this call renewed it and wrote it after this call listed the
   * bucket. The row write an erasure makes before deleting a holder a load may still publish, or before a refused
   * rewrite discards its own object, when it gets no answer that reading the row can settle, throws the registry's
   * `TransientError`, and that object is not deleted.
   *
   * A delete that gets no answer is settled by reading its key: gone, it counts as deleted and is listed in
   * `collected`. Another object under the number, for a delete conditioned on the version searched, is not counted as
   * deleted: the receipt then rests on the listing of the bucket, and says `erased: true` only when that object does
   * not hold the id. When that read fails too, or the delete lands after it, the call reports the fault, and a re-run
   * finds the object gone and lists nothing for the segment: keep the error with the ledger as the record of the
   * deletion.
   *
   * A rollback that lands between the call's read of the row and one of its deletes, onto the generation being deleted,
   * leaves the pointer on an object that is gone. The call finds it at its next read of the row, or by reading the row
   * once more after its last delete, and **throws `NotFoundError`** rather than report anything: every read of the
   * segment fails until a rollback moves the pointer to a generation still in the bucket, and nothing restores the
   * deleted object. When nothing left in the bucket holds the id, the call has emitted its `segment.collect` event
   * first, so the deletion is on the record. Re-run it after that rollback.
   *
   * **Re-run it**, and read what the re-run says rather than assuming it finished the job. The re-run looks for
   * the id in every generation in the bucket, not only the current one, and there are three outcomes:
   *
   *  - `erased: true` naming the generation it found the id in — the ordinary case, and the one that gives you
   *    the receipt the failed call could not;
   *  - `'not-member'` — a racing collector took that generation first. The bit is gone, but **no run reports a
   *    receipt for it**, so keep the failed call's error alongside your ledger if you need the audit trail;
   *  - `'absent'` — the segment's registry row is gone, so it is no longer a segment at all and
   *    `store.eraseSubject` will not even scan it. Anything left in the bucket is an **orphan**: list it with
   *    `listGenerations` (`store.generations`) and delete it with `dropSegment` (`store.dropSegment`), which both
   *    read the bucket as well as the row. `checkConsistency()` and the generation collection start from the row, so
   *    neither reaches a segment that has none.
   */
  readonly collected: readonly number[];
}

/**
 * Remove `id` from `ref`: rewrite its current generation without it, and delete every other generation that holds
 * it. See the module note for the contract.
 *
 * Emits one `segment.rewrite` audit event at the publish (before the superseded generation is collected), so the
 * compliance record exists the moment the generation without the id is authoritative. An erasure that rewrites nothing,
 * because only other generations held the id, emits one `segment.collect` once no generation holds it, and so does one
 * that deleted only objects no read of the segment can open, which names no generation the id was found in. Either
 * event comes before the `NotFoundError` of a rollback that moved the pointer onto a generation the call deleted.
 */
export async function eraseIdFromSegment(
  ref: SegmentRef,
  id: number,
  deps: EraseIdDeps,
  options: { audit?: IAuditSink } = {},
): Promise<EraseIdResult> {
  const first: Pass = {};
  const result = await eraseOnce(ref, id, deps, options, first);
  // A row tombstoned while this call ran is searched as a fresh call searches one: a cleartext destroy, or a drop whose
  // sweep left an object, leaves objects that can still hold the id. Once: the second pass starts on the tombstone.
  if (result.reason === 'destroyed' && first.tombstoned === false) {
    const second: Pass = {};
    const again = await eraseOnce(ref, id, deps, options, second);
    // Nothing under the tombstone holds the id: the first pass's report stands, with the generation it read.
    if (again.reason === 'destroyed') return result;
    if (!again.erased) {
      if (second.missing !== undefined) throw second.missing;
      return again;
    }
    // Erased under the tombstone: the report covers both passes, what each deleted and the newest holder either read.
    const collected = [...new Set([...result.collected, ...again.collected])].sort(ascending);
    const newest = Math.max(result.fromGeneration ?? -1, again.fromGeneration ?? -1);
    const merged = { ...again, collected, ...(newest >= 0 ? { fromGeneration: newest } : {}) };
    return recordCollect(ref, merged, second, options);
  }
  return recordCollect(ref, result, first, options);
}

/**
 * What one pass of {@link eraseIdFromSegment} saw: whether the row it read first was a tombstone, the token of the row it
 * read when it finished by deleting objects and rewriting none, whether one of those it searched held the id, and the
 * error to raise once the call has recorded what it deleted, when the row named a generation it deleted.
 */
interface Pass {
  tombstoned?: boolean;
  collectedOn?: Token;
  found?: boolean;
  missing?: NotFoundError;
}

/** What the row says about a call's premise: `null` while it holds, otherwise the reason to report. */
type Verdict = 'superseded' | 'absent' | 'destroyed' | null;

/** What the search for an id in an object needs of the store: the objects, the codec, and the read bounds. */
export type SearchDeps = Pick<EraseIdDeps, 'storage' | 'codec' | 'maxBitmapBytes' | 'readRetry'>;

/** What {@link holds} and its callers read of an {@link EraseCall}, so a search that deletes nothing can build one. */
type HoldsCall = Pick<
  EraseCall,
  | 'ref'
  | 'chunkKey'
  | 'remainder'
  | 'codec'
  | 'maxBytes'
  | 'base'
  | 'tombstoned'
  | 'aead'
  | 'read'
  | 'sealed'
  | 'versions'
> & { readonly deps: SearchDeps };

/**
 * What one pass of {@link eraseIdFromSegment} works from, passed to every phase of it. The first group is fixed once the
 * row is read; the second is what the phases change as they go, and each field says who changes it.
 */
interface EraseCall {
  readonly ref: SegmentRef;
  readonly deps: EraseIdDeps;
  /** What the pass records for the caller. */
  readonly seen: Pass;
  readonly audit: IAuditSink;
  /** The id's chunk and its remainder within it. */
  readonly chunkKey: number;
  readonly remainder: number;
  readonly codec: CodecInterface;
  readonly maxBytes: number;
  /** The segment's name, as every key and result of this call carries it. */
  readonly base: { readonly segment: string; readonly namespace: string | undefined };
  /** The row this call read first. */
  readonly record: RegistryRecord;
  /** Whether that row was a tombstone, and whether it was a row with no pointer. */
  readonly tombstoned: boolean;
  readonly pointerless: boolean;
  /** The generation the pointer named, or `-1` on a row with no pointer. */
  readonly from: number;
  /**
   * The row this rewrite derives its content from, not just the number it points at. `nextGeneration` restarts
   * at `0` once a row is purged and the bucket emptied, so a retired-and-re-created name presents a *different*
   * segment at the *same* `currentGen` — which `expectFrom` alone matched, republishing one incarnation's
   * content over another's and reporting `erased: true`. A token is not reused across incarnations, but for a collision of probability 2^-128 per pair.
   */
  readonly fromToken: Token;
  /** The segment's DEK, when its row holds one. */
  readonly aead: Aead | undefined;
  readonly fromKey: GenKey;
  /** A read this call makes, under the store's read retry when it was given one. */
  readonly read: <T>(op: () => Promise<T>) => Promise<T>;
  /**
   * Generations `holds` could not search and counts as holders: objects sealed under a key the row does not hold. On a
   * row with no pointer, a first load's whose key that load has not published; on a row with a key, one whose index
   * does not open under it, which no read of the segment can open either.
   */
  readonly sealed: Set<number>;
  /**
   * The version of the object `holds` last met under each generation, as the driver reported it on the read that
   * decided what the object is: the open of one it searched, the footer read that found one encrypted under a row with
   * no key, or the open whose index failed its authentication under the row's key. It is what a delete of that
   * generation as a holder is conditioned on, so it removes that object and not one stored under the number since.
   */
  readonly versions: Map<number, string | undefined>;
  /**
   * The fingerprint of the object this call opened under `from`, once it has: {@link holderLeft} skips `from`, when
   * this call found it clean, only while the row names it with that object's footer checksum.
   */
  fromFingerprint: string | undefined;
  /**
   * The row this call holds its premise against: `record`, until the call writes the row itself ({@link
   * fence}), after which it is the row it wrote, so its own write is not read as another writer's.
   */
  premise: RegistryRecord;
  premiseToken: Token;
  /** Writes lost to other writers across every fence of this call: the bound is the call's, not each fence's. */
  fenceLost: number;
  /** The object this call's rewrite wrote, once it exists: its number, and its fingerprint, which tells it apart. */
  rewrote: { readonly generation: number; readonly fingerprint: string } | undefined;
}

/**
 * Emit `segment.collect` for a call that finished by deleting the holders and rewriting none, from the report the call
 * returns, so the event and the ledger entry carry the same generations: the whole call's, both passes included. It
 * names the generation the id was found in only when a searched one held it: a call that deleted only objects it could
 * not search found it in none. Then, when the pass found the row naming a generation it deleted, it throws that error
 * in place of the report: the deletion is on the record, and the segment no longer reads.
 */
function recordCollect(
  ref: SegmentRef,
  result: EraseIdResult,
  pass: Pass,
  options: { audit?: IAuditSink },
): EraseIdResult {
  if (pass.collectedOn !== undefined) {
    safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
      kind: 'segment.collect',
      namespace: ref.namespace,
      segment: ref.segment,
      ...incarnationField(pass.collectedOn),
      ...(pass.found === true && result.fromGeneration !== undefined
        ? { fromGeneration: result.fromGeneration }
        : {}),
      collected: [...result.collected],
    });
  }
  if (pass.missing !== undefined) throw pass.missing;
  return result;
}

/**
 * One pass of {@link eraseIdFromSegment}. It records in `seen` what {@link Pass} says.
 *
 * It reads the row, resolves the key, builds the {@link EraseCall} every phase is passed, and picks the phase by what
 * the row is:
 *
 *   row ─┬─ tombstone ─────▶ underTombstone   search every object; one holder: collect them all
 *        ├─ no pointer ────▶ unpublished      search each first load's object; fence; delete the holders
 *        └─ pointer ───────▶ stage ─┬─ id in the current generation ─▶ finishRewrite (publish, collect, prove)
 *                                   ├─ id elsewhere or nowhere ──────▶ notInCurrent  (fence, collect, delete)
 *                                   └─ the row moved on ─────────────▶ discardRefused (when it wrote its rewrite),
 *                                                                      then the reason
 *
 * A phase that deletes by name or by the row's ledger first takes those names out of the row (`fence`, which writes
 * again when a write is lost), then deletes (`deleteFenced`, or a collection below the pointer that `collectAgain`
 * fences and runs again while it spares a name the row has taken back), and last `holderLeft`, the one place that
 * decides `erased: true`. `underTombstone` writes nothing: its collection holds the tombstone's token. `finishRewrite`'s
 * write is the publish, and a refused publish discards what it wrote.
 */
async function eraseOnce(
  ref: SegmentRef,
  id: number,
  deps: EraseIdDeps,
  options: { audit?: IAuditSink },
  seen: Pass,
): Promise<EraseIdResult> {
  validateUserRef(ref, 'eraseIdFromSegment');
  checkedAuditSink(options.audit, 'eraseIdFromSegment');
  const { chunkKey, remainder } = splitId(id); // validates the u32 range
  const codec = requireCodec(deps.codec, 'eraseIdFromSegment');
  requireEntropy(deps.entropy, 'eraseIdFromSegment');
  const maxBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
  const base = { segment: ref.segment, namespace: ref.namespace };
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  const read = <T>(op: () => Promise<T>): Promise<T> => retryRead(op, deps.readRetry);

  const record = await deps.registry.get(ref);
  if (record === null) return { ...base, erased: false, reason: 'absent', collected: [] };
  // A tombstone is no proof nothing readable is left (see `underTombstone`), nor a row with no pointer that nothing
  // was written (see `unpublished`): both are searched.
  const tombstoned = record.status === 'destroyed';
  seen.tombstoned = tombstoned;
  const pointerless = !tombstoned && record.currentGen === null;
  const from = record.currentGen ?? -1;
  const fromToken = record.token;

  const aead = await resolveDek(ref, deps, record, { tombstoned, pointerless });

  const fromKey: GenKey = { ...base, generation: from };
  const c: EraseCall = {
    ref,
    deps,
    seen,
    audit,
    chunkKey,
    remainder,
    codec,
    maxBytes,
    base,
    record,
    tombstoned,
    pointerless,
    from,
    fromToken,
    aead,
    fromKey,
    read,
    sealed: new Set(),
    versions: new Map(),
    fromFingerprint: undefined,
    premise: record,
    premiseToken: fromToken,
    fenceLost: 0,
    rewrote: undefined,
  };

  if (tombstoned) return await underTombstone(c);
  if (pointerless) return await unpublished(c);
  const staged = await stage(c);
  if ('erased' in staged) {
    if (!staged.erased && staged.generation !== undefined && c.rewrote !== undefined) {
      await discardRefused(c, c.rewrote);
    }
    return staged;
  }
  return await finishRewrite(c, staged);
}

/**
 * What the row says about the premise this call was working from — `null` when the premise still holds
 * (the pointer is exactly `from`, or still absent on a row that had none, on the same row, so nothing raced us),
 * otherwise the reason to report.
 *
 * Each state gets the answer this function already gives when it reads that state *up front*, so a caller
 * branching on `reason` never has to care at which point in the call it was discovered: a tombstoned row is
 * `'destroyed'` (a concurrent `dropSegment` leaves `currentGen` where it was, so testing the pointer alone
 * would miss it and report an error for a segment the operator deliberately dropped), a vanished row is
 * `'absent'` (the retention sweep purged a tombstone while we worked), a row with no pointer is
 * `'superseded'` (the call found a holder in a bucket whose row has no pointer now and stopped before deleting it, so
 * it cannot report `'no-generation'`), and a pointer that moved is `'superseded'`. On a row that had no
 * pointer, a pointer that appeared is `'superseded'`: a load published, or a rollback moved onto an object.
 */
function rowVerdict(
  c: EraseCall,
  row: RegistryRecord | null,
  alsoIgnore: readonly (keyof RegistryRecord)[] = [],
): Verdict {
  const { pointerless, from } = c;
  if (row === null) return 'absent';
  if (row.status === 'destroyed') return 'destroyed';
  // A different row is a different lineage even at the same pointer value — see `fromToken`.
  // A write of the row's leases alone, which readers make, is not another writer's: the premise still holds.
  const same = row.token === c.premiseToken || onlyLeasesDiffer(c.premise, row, alsoIgnore);
  if (pointerless) return row.currentGen === null && same ? null : 'superseded';
  // A row that lost its pointer mid-call may still have a bucket that holds the id: it is not searched here, so the
  // answer is the one that asks for a re-run, which searches it up front.
  if (row.currentGen === null) return 'superseded';
  return row.currentGen === from && same ? null : 'superseded';
}

/** The answer for a call whose premise stopped holding: `reason`, with the generation it wrote when it wrote one. */
function refusedResult(
  c: EraseCall,
  reason: 'superseded' | 'absent' | 'destroyed',
  generation?: number,
): EraseIdResult {
  const { base, from } = c;
  return { ...base, erased: false, reason, fromGeneration: from, generation, collected: [] };
}

/** The crypto for the object at `generation`: the segment's DEK, bound to that generation. */
function cryptoAt(c: HoldsCall, generation: number): CrbmCrypto | undefined {
  const { ref, aead } = c;
  return aead === undefined
    ? undefined
    : { aead, aadFor: (scope) => aadFor(ref, generation, scope) };
}

/** Whether `holds` found the id in `generation`, as opposed to counting it a holder it could not search. */
function found(c: HoldsCall, generation: number, held: boolean | null): boolean {
  return held === true && !c.sealed.has(generation);
}

/**
 * Whether `generation` still holds the id: its index is opened, and the id's chunk is fetched only if the index
 * lists it. `null` when the object is gone — a concurrent collector took it, which is not a failure of this call
 * but the outcome it wants — and when the chunk's read fails because another object is under the number by then:
 * the object listed is gone in that case too. `true`, and the generation noted in `sealed`, for an object sealed
 * under a key the row does not hold: it cannot be searched, so it is treated as one that may hold the id. Any other
 * fault propagates: it must never be swallowed into a clean receipt.
 *
 * Which key an object is sealed under is read from where its open fails, since its footer names none. Every check
 * before the index's authentication passes for an object sealed under another key, and that authentication fails:
 * the index was not sealed under the row's key for this segment and generation, so no read through the row opens
 * it. That is all "sealed elsewhere" means: an index altered and given new checksums fails the same way, opens for no
 * read either, and is counted the same. An object whose index opens under the row's key is the segment's own, and a
 * chunk of it that then fails its checks is corruption, which throws, as does a footer or checksum that does not
 * match, or an object cut short, none of which reaches the index's authentication. The row's key never changes while the row lives (a key is made only for a
 * segment's first generation, a publish never adds one to a segment that has generations, and only a crypto-shred,
 * which tombstones the row, removes it), so no generation a reader of the row can open is ever counted here.
 */
async function holds(c: HoldsCall, generation: number): Promise<boolean | null> {
  const { deps, chunkKey, remainder, codec, maxBytes, base, tombstoned, read, sealed, versions } =
    c;
  const key: GenKey = { ...base, generation };
  const crypto = cryptoAt(c, generation);
  try {
    let reader: CrbmReader;
    const index = { refused: false };
    // The version the open's tail read reported, kept through a failed open: an object found sealed elsewhere is
    // deleted on that read.
    let opened: string | undefined;
    try {
      reader = await read(() =>
        openGenerationReaderNoting(
          deps.storage,
          key,
          crypto === undefined ? undefined : noticingIndex(crypto, index),
          (version) => (opened = version),
        ),
      );
    } catch (err) {
      // A cleartext object under an encrypted segment was never one of its generations, so no read believes it.
      // It may still hold the subject in the clear, so the erasure looks in it without the key, and deletes it
      // when it holds the id, as it does any holder. Only its footer is asked first, on this path alone.
      if (crypto === undefined) {
        // The footer is asked only after a fault that is an answer: one the read retry gave up on says nothing about
        // the object, and is thrown as it is, with no more reads.
        let footer: string | undefined;
        const encrypted =
          !isTransientError(err) &&
          (await read(() => objectIsEncrypted(deps.storage, key, (version) => (footer = version))));
        if (encrypted) {
          // Under a tombstone an encrypted object is sealed under a key that was shredded or is not held, and no
          // read through the library finds anything in it. Under a row with no pointer it is a first load's, sealed
          // under a key that load has not published yet; under a cleartext row with a pointer it is a first load's
          // that minted a key and crashed, or lost the race to a cleartext first load, since a key is made only for
          // a segment's first generation and a publish never adds one to a segment that has generations. Either
          // way it cannot be searched, so it counts as a holder.
          if (tombstoned) return false;
          sealed.add(generation);
          versions.set(generation, footer);
          return true;
        }
        throw err;
      }
      if (isIntegrityError(err) && index.refused) {
        sealed.add(generation);
        versions.set(generation, opened);
        return true;
      }
      if (!isIntegrityError(err) || (await read(() => objectIsEncrypted(deps.storage, key)))) {
        throw err;
      }
      reader = await read(() => openGenerationReader(deps.storage, key, undefined));
    }
    versions.set(generation, objectVersionOf(reader));
    // An object that opens is searched, whatever was under the number when it was last looked at.
    sealed.delete(generation);
    let bytes: Uint8Array | null;
    try {
      bytes = await read(() => reader.getChunk(chunkKey));
    } catch (err) {
      // A chunk that fails its checks, or a range the object does not have, is corruption only in the object its
      // index was read from. One stored under the number since (that object deleted, by another erasure as a
      // holder, say, and the number taken again by a load) answers the range read with its own bytes, and then the
      // object this call searched is gone, as the generation it listed is.
      if (
        !isTransientError(err) &&
        !(await read(() => sameObjectUnder(deps.storage, key, reader.fingerprint)))
      ) {
        return null;
      }
      throw err;
    }
    return bytes !== null && codec.safeDeserialize(bytes, maxBytes).has(remainder);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * `holds` over `generations`, read a few at a time, with the outcomes the serial scan would have produced: they
 * come back in the order given, ending at the first generation found to hold the id when `stopAtHolder` is set (a
 * generation read beyond it is read for nothing and dropped; one that could not be searched does not end it), and
 * the first fault in that order is the one thrown, so a fault past a holder never surfaces, as it never did.
 */
async function holdsEach(
  c: HoldsCall,
  generations: readonly number[],
  { stopAtHolder }: { readonly stopAtHolder: boolean },
): Promise<{ generation: number; held: boolean | null }[]> {
  // The lowest index that holds the id so far. A generation past it can never be reached by the in-order walk
  // below, so a worker that would start one skips it: the reads wasted past the first holder are only those
  // already in flight when it was found, fewer than the bound.
  let firstHolder = Infinity;
  const settled = await mapWithConcurrency(
    generations,
    HOLDS_CONCURRENCY,
    async (generation, index) => {
      if (stopAtHolder && index > firstHolder) {
        return { generation, held: null, fault: undefined };
      }
      try {
        const held = await holds(c, generation);
        if (found(c, generation, held) && index < firstHolder) firstHolder = index;
        return { generation, held, fault: undefined };
      } catch (fault) {
        return { generation, held: null, fault: { error: fault } };
      }
    },
  );
  const outcomes: { generation: number; held: boolean | null }[] = [];
  for (const { generation, held, fault } of settled) {
    if (fault !== undefined) throw fault.error;
    outcomes.push({ generation, held });
    if (stopAtHolder && found(c, generation, held)) break;
  }
  return outcomes;
}

/**
 * The receipt check, and the one place `erased: true` is decided: the newest generation still in the bucket that
 * holds the id, or `undefined` when none does. `clean` names the generations this call has already read or
 * written without the id; every other generation present is read now.
 *
 * A number in `clean` names the object this call read or wrote only while that object is there, and a number can be
 * taken again once its object is deleted (invariant 2). Another erasure can delete a generation this call found
 * clean and a load take its number, within one row; and a drop, a purge and a first load of the name number from 0
 * again, under a new row. Either way the object listed is another one, which can hold the id. So every generation in
 * `clean` is read again, but for two, which are skipped only while the row's ledger (`knownGens`) names them with the
 * footer checksum of the object this call opened or wrote there: `from`, the generation it found current, and its own
 * rewrite. The checksum covers the object's write identity, so it names that object (to its 32 bits) and not merely
 * the same ids. Those two are generations the pointer named while this call held them, and no writer of the library
 * leaves an entry for one naming another object: no collection takes a generation the pointer names (invariant 4), a
 * number below the pointer is taken again only after the pointer moves down or the name is created again, and a load
 * that seeds a ledger from the bucket read the object while the pointer named it. Any other entry can outlive its
 * object: such a seed names each object as it read it, and another erasure can delete one above the pointer before
 * that load publishes; a lifecycle rule deletes an object without touching the row. The row's incarnation vouches for
 * nothing either: within one row a load takes a number this call found clean as readily as under a new one.
 *
 * The row is read after the listing, since one read before it can still vouch for an object deleted before the
 * listing, and only when the listing names one of those two. A row with no usable ledger (a row with no pointer has
 * none) vouches for nothing. The read only spares opens, so when it fails the receipt vouches for nothing and reads
 * every listed generation, rather than lose its answer after the deletes.
 *
 * It verifies the **claim** — no generation of the segment holds the id — rather than what this call deleted,
 * in both directions. A holder missing from `collected` does not mean it survived: a concurrent collector
 * (the generation collection with `keep: 0`, which this call and a retirement run) may simply have
 * taken it first, and then the claim is true no matter who made it true. And a collection pass that declined
 * does not mean nothing was left: it returns an empty list when the row was gone as it started, the same value
 * it returns when there was genuinely nothing to collect, and a retirement only has to land between this call's
 * publish and its collect for that to happen.
 *
 * Nor is the generation this call replaced the only one to look at. A rollback can move the pointer onto a
 * holder while the collection runs, and the collection then takes the lower pointer as its bound and leaves
 * that holder current; and a concurrent writer that derived its object from the generation this call replaced
 * can leave one above the pointer. So the list is of everything, and in the ordinary case it returns only the
 * current generation, which is in `clean` and which the row names: one `list`, one read of the row, and no read of an
 * object.
 */
async function holderLeft(c: EraseCall, clean: ReadonlySet<number>): Promise<number | undefined> {
  const { ref, deps } = c;
  const listed = (await generationsOf(deps.storage, ref)).reverse();
  const own = (generation: number): string | undefined =>
    clean.has(generation) ? ownFingerprint(c, generation) : undefined;
  // Read after the listing: a row read before it can name an object the listing no longer finds under that number.
  const known = listed.some((generation) => own(generation) !== undefined)
    ? await ledgerAfterListing(c)
    : undefined;
  const vouched = (generation: number): boolean => {
    const fingerprint = own(generation);
    if (fingerprint === undefined || known === undefined) return false;
    const footerCrc = footerCrcOf(fingerprint);
    return known.some((e) => e.generation === generation && e.footerCrc === footerCrc);
  };
  const toRead = listed.filter((generation) => !vouched(generation));
  return (await holdsEach(c, toRead, { stopAtHolder: true })).find(
    (outcome) => outcome.held === true,
  )?.generation;
}

/**
 * The fingerprint of the object this call opened as `from` or wrote as its rewrite, when `generation` is one of those:
 * the two generations {@link holderLeft} can skip.
 */
function ownFingerprint(c: EraseCall, generation: number): string | undefined {
  if (generation === c.from) return c.fromFingerprint;
  if (generation === c.rewrote?.generation) return c.rewrote.fingerprint;
  return undefined;
}

/**
 * The row's usable ledger, read after the receipt's listing, or `undefined`, which vouches for nothing. The read only
 * spares opens, so any fault on it gives `undefined`: the receipt then reads every listed generation, as it would with
 * no ledger, and its answer is not lost after the deletes.
 */
async function ledgerAfterListing(c: EraseCall): Promise<ReturnType<typeof usableKnownGens>> {
  try {
    return usableKnownGens(await c.deps.registry.get(c.ref));
  } catch {
    return undefined;
  }
}

/** The error for a generation that still holds the id (or cannot be searched) after the call tried to remove it. */
function cannotRemove(c: EraseCall, generation: number): WriteConflictError {
  const { ref, sealed } = c;
  return new WriteConflictError(
    `erasure of segment ${ref.segment} could not remove generation ${generation}, which ${
      sealed.has(generation) ? 'cannot be searched, so may hold the id,' : 'still holds the id'
    } and is still in the bucket; re-run`,
  );
}

/** What a {@link fence} is asked to do. */
interface FencePlan {
  /** The holders it deletes by name afterwards, newest first. */
  readonly byName: readonly number[];
  /** Whether a collection below the pointer follows. */
  readonly sweeps: boolean;
  /** The generation the collection that follows deletes everything below, when it is not `from` (a rewrite's own). */
  readonly below?: number;
}

/** What a {@link fence} reports. */
interface Fenced {
  readonly moved: Verdict;
  readonly sweep: boolean;
  readonly byName: readonly number[];
  /** Whether the row it acted on had a usable ledger. */
  readonly ledger: boolean;
  /** Whether it wrote a ledger that names fewer generations. */
  readonly pruned: boolean;
  /** Whether the pointer had moved past every holder to delete by name, so the collection takes them. */
  readonly past?: boolean;
}

/** A fence that wrote nothing and reports why. */
function fenceRefused(moved: Verdict): Fenced {
  return { moved, sweep: false, byName: [], ledger: true, pruned: false };
}

/**
 * The generations a fence takes out of the row's ledger: the holders it deletes by name, and, when it sweeps, every
 * entry numbered below the lower of `plan.below` (or `from`) and the pointer, and the holders below the pointer. The
 * current generation is never one of them.
 */
function doomedGenerations(
  c: EraseCall,
  plan: FencePlan,
  byName: readonly number[],
  ledger: ReturnType<typeof usableKnownGens>,
  pointer: number | null,
): Set<number> {
  const { from } = c;
  const doomed = new Set<number>(byName);
  if (plan.sweeps && ledger !== undefined && pointer !== null) {
    const bound = Math.min(plan.below ?? from, pointer);
    for (const e of ledger) if (e.generation < bound) doomed.add(e.generation);
    if (byName.length === 0) for (const h of plan.byName) if (h < pointer) doomed.add(h);
  }
  if (pointer !== null) doomed.delete(pointer);
  return doomed;
}

/**
 * The one write this call makes to the row before it deletes anything: it removes from the row's ledger of known
 * generations (`knownGens`) every generation it is about to delete, and, where a load in flight may still publish
 * what it deletes, renews the row's `pointerId`.
 *
 * **The prune.** A generation the row names is one a pass that keeps by a count spares. So a generation is taken out of the ledger first, and only then deleted: a rollback that read the
 * row before the write loses its swap on the write's token. The generations are `byName`, the holders this call deletes one by one, and, when `sweeps` (a searched
 * holder was found, so the collection below the pointer follows and deletes everything there), every entry of the
 * ledger numbered below the lower of `from` and the pointer the fence finds. That bound is `from` when a load has
 * since moved the pointer forward, so `from`, which this call found clean and which the load's window holds, stays
 * known and is spared; and the pointer when a rollback has moved it down onto an older generation, which the
 * collection leaves current. The current generation is never removed. A row with no usable ledger names nothing, and
 * is not written for it.
 *
 * **The renewal** is made where no other write fences a load in flight: the deletes by name (a holder above the pointer,
 * one sealed under a key the row does not hold, any holder on a row with no pointer, where every object is a first
 * load's), and a sweep that found a searched holder when the ledger names nothing to prune. A holder below the pointer
 * needs no renewal to keep a load from publishing that number, but a load that read the row before the call began
 * carries its own input, which may hold the id, and only a write of the row refuses it. A prune is such a write, so
 * with one no renewal is added. So every load that read the row before the call began is refused, by this call's
 * write or by another write that already changed the token: the renewal is skipped when a prune is made, when another
 * writer changed a field but the leases since the call read the row, and when a load has already moved the pointer
 * past the holders (that move refused every load that read the row before it). The pointer is
 * named at the value it has ({@link renewPointer}), which changes nothing a read resolves and renews the row's
 * `pointerId`, the value the load's fence compares. A load numbers its object above the pointer (above everything in
 * the bucket, on a row with no pointer) and publishes it with a compare-and-swap fenced on the row it read, which a
 * write of the row's leases alone does not refuse. Re-proving the row before each delete does not fence it: the load can
 * publish at any time after the delete, and its row would then name an object that is not there. If the load published
 * first, this write loses and the row says why: a pointer that moved off `from` is `'superseded'` where a renewal is
 * needed. The one exception is a pointer that moved forward past every holder to delete by name: they are below it now,
 * where no load can publish and the collection takes them, so they are pruned and left to the collection and nothing
 * is renewed. A pointer that moved forward is no obstacle to a prune alone, since the collection below the pointer is
 * bounded by the pointer it reads.
 *
 * **No write when none is owed.** The call goes on under the row it read when the ledger names nothing to remove and
 * either the row differs from the one read at the call's start in any field but its leases (a write of `knownGens`
 * alone counts: that change already moved the token every earlier load fences on, so no renewal is added), or, where
 * a renewal is needed, another writer's renewal landed after this call listed the bucket. A load that wrote a
 * holder the listing found read the row before it wrote, so before that renewal, and its fence refuses it; one
 * renewal that landed before the listing does not license a delete, since a load could have read that row and written a
 * holder since. That is why the row is read here, after the listing, and compared with the row each later read finds. A
 * concurrent erasure's write is such a licence: two erasures of different ids on one segment that both prune the
 * same entries write once between them, the second going on under the first's write.
 *
 * **A write that loses** to another writer is tried again from the row read after it, with the
 * prune applied to that fresh row. The fifth lost write across the call's fences ends the call with `'superseded'`;
 * when it is the first write, nothing has been deleted. A write of the row's
 * leases alone that lands in between is waited out and costs no attempt, within the lease writers' bound. A row that is
 * another incarnation of the name, or one that no longer fits the premise of a call that renews (a pointer that moved,
 * a write of anything but leases, the ledger and the `pointerId`) gives its reason, as anywhere else in this function.
 * A row that is gone, a tombstone, or one with no pointer has no ledger to prune and nothing to renew: the deletes by
 * name stop with the row's reason, and the collection runs and reads the row itself. On the path with nothing to delete
 * by name no reason is reported, so a holder left in the bucket is never answered with `'absent'`; the call throws.
 *
 * **A row with no usable ledger** names nothing to prune when it is read, but a load that publishes before the
 * collection reads the row starts a ledger from the bucket, which names the holders the collection then spares. So
 * the caller reads the row again after the collection, and what the ledger then names below the bound is pruned and
 * collected again, within the passes' own bound of five.
 *
 * A write that gets no answer is settled by reading the row, and nothing is deleted until it is: a landing is gone on
 * under; a row still as the write found it gets a fresh compare-and-swap from the row just read, a request of its own
 * carrying the same version, so at most one of the two lands, after a wait on the injected clock under 500 ms, then 1 s,
 * then 2 s (spread by the rng), at most three times, as a load's publish does; then, or at once with no clock to wait on,
 * or when the row cannot be read, the registry's `TransientError` is thrown.
 */
async function fence(c: EraseCall, plan: FencePlan): Promise<Fenced> {
  const { ref, deps, record, pointerless, from } = c;
  const renewal = rowRenewal(ref, deps);
  const churn = leaseChurn({ clock: deps.clock, rng: renewal.rng });
  const first = await deps.registry.get(ref);
  let row = first;
  for (;;) {
    // A row that is gone, a tombstone, or a hand-made row with no pointer has no ledger to prune and nothing to renew.
    // The deletes by name stop with the row's reason; the collection still runs and reads the row itself (it declines
    // on a gone row, and deletes every object under a tombstone). No reason is reported on the sweep-only path, so a
    // holder left in the bucket is never answered with `'absent'`.
    if (row === null || row.status === 'destroyed' || (!pointerless && row.currentGen === null)) {
      if (row !== null && !sameIncarnation(record, row)) return fenceRefused('superseded');
      // An active row with no pointer, found by a call that found a pointer: it lost it mid-call.
      const reason =
        row === null ? 'absent' : row.status === 'destroyed' ? 'destroyed' : 'superseded';
      return {
        moved: plan.byName.length > 0 ? reason : null,
        sweep: plan.sweeps,
        byName: [],
        ledger: true,
        pruned: false,
      };
    }
    if (!sameIncarnation(record, row)) return fenceRefused('superseded');
    const held =
      row.token === record.token || onlyLeasesDiffer(record, row, ['pointerId', 'knownGens']);
    const pointer = row.currentGen;
    let byName = plan.byName;
    let moved: Verdict = null;
    let pastHolders = false;
    if (plan.byName.length > 0 && !held) {
      // A pointer moved forward past every holder to delete by name puts them below it, where the collection takes
      // them; no load in flight can publish a number below the pointer, so no renewal is owed.
      const below =
        plan.sweeps &&
        !pointerless &&
        pointer !== null &&
        pointer > from &&
        plan.byName.every((h) => h <= pointer);
      if (!below) return fenceRefused('superseded');
      byName = [];
      moved = 'superseded';
      pastHolders = true;
    }
    const ledger = usableKnownGens(row);
    const doomed = doomedGenerations(c, plan, byName, ledger, pointer);
    const named = ledger !== undefined && ledger.some((e) => doomed.has(e.generation));
    // A sweep that found a holder owes the row a write when nothing else has fenced the loads that read it before the
    // call began: a prune is such a write, and so is any write of another field since the call read the row.
    const sweepOwes = plan.sweeps && !pastHolders && !named && onlyLeasesDiffer(record, row);
    const renew = byName.length > 0 || sweepOwes;
    const renewedAfter = held && row.pointerId !== first!.pointerId;
    if (!named && (!renew || renewedAfter)) {
      c.premise = row;
      c.premiseToken = row.token;
      return {
        moved,
        sweep: plan.sweeps,
        byName,
        ledger: ledger !== undefined,
        pruned: false,
        past: pastHolders,
      };
    }
    const written = await renewal.write(row, {
      ...(renew ? renewPointer(row) : {}),
      ...(named ? { knownGens: pruneKnown(row, doomed) } : {}),
    });
    if ('row' in written) {
      c.premise = written.row;
      c.premiseToken = written.row.token;
      return {
        moved,
        sweep: plan.sweeps,
        byName,
        ledger: ledger !== undefined,
        pruned: named,
        past: pastHolders,
      };
    }
    const now = written.lost;
    const settled = await churn.settle(row, now, () => deps.registry.get(ref));
    if (settled !== undefined) {
      row = settled.row;
      continue;
    }
    c.fenceLost += 1;
    if (c.fenceLost >= FENCE_ATTEMPTS) return fenceRefused('superseded');
    row = now;
  }
}

/**
 * The collection again, after one that spared a generation the row names, and after one made over a row that had no
 * usable ledger at the fence. Either a rollback onto a holder, or a load that took the holder into its window, or a
 * load that started a ledger from the bucket, made the row name what the collection meant to delete since the fence
 * took it out. So the fence is made again (with `by` the holders the pointer moved past, and the collection's `below`
 * bound when it is not `from`) and the collection runs again, until one spares nothing the row names. Each pass that
 * writes costs a lost write only when its write is lost (a landed prune counts nothing), and the passes are bounded
 * apart, at most as many as the fences' attempts: a call whose last pass still spared a name the row knows stops there,
 * and throws when a holder is left.
 */
async function collectAgain(
  c: EraseCall,
  start: { readonly spared: readonly number[]; readonly ledgered: boolean },
  plan: { readonly byName: readonly number[]; readonly below?: number },
): Promise<{ deleted: number[]; missing?: number; moved: Verdict }> {
  const { ref, deps } = c;
  const deleted: number[] = [];
  let moved: Verdict = null;
  let missing: number | undefined;
  let spared = start.spared;
  for (
    let passes = 0;
    passes < FENCE_ATTEMPTS &&
    missing === undefined &&
    ((!start.ledgered && passes === 0) || spared.length > 0);
    passes++
  ) {
    const again = await fence(c, { byName: plan.byName, sweeps: true, below: plan.below });
    if (again.moved !== null && again.past !== true) {
      moved = again.moved;
      break;
    }
    if (!again.pruned) break;
    const more = await collectBelowPointer(ref, deps, { keep: 0, skipKnown: true });
    deleted.push(...more.deleted);
    missing = more.missing;
    spared = more.knownSpared ?? [];
  }
  return missing === undefined ? { deleted, moved } : { deleted, moved, missing };
}

/**
 * Delete `holders`, newest first, each after reading the row and finding it still the one {@link fence} made (or
 * that row with only its leases changed), and stop at the first that is not. Returns what was deleted, the
 * row's reason when the deletes stopped, and, in `missing`, a generation it deleted that the row then named.
 *
 * One round trip remains between that read and its delete: a rollback that lands inside it onto the holder being
 * deleted leaves the pointer naming a missing object. The row's ledger no longer names a generation this call deletes
 * (it was taken out before), so a rollback needs `allowUnknown` to move onto one: above the pointer, and on a row with
 * no pointer, onto an object the rollback accepts (on a row with no key, a cleartext one: it refuses an encrypted
 * target there). Below the pointer the flag is not needed where the pointer alone decides (a row with no usable ledger,
 * or a number below a full ledger's bound), and then it is an object sealed under a key the row does not hold, which
 * only a rollback with no key at hand moves onto, since one with the key refuses an object it cannot open. The rollback's own
 * move-then-verify catches every such landing except one whose check runs before the delete, and a condition on the
 * object cannot close it, since the pointer then names the very object this call read. So it is detected instead:
 * every read of the row after a delete is held to what was deleted, and so is one more read after the last delete
 * when none followed it ({@link deletedUnderPointer}). The deletes stop at the first such read.
 *
 * What the condition does close is another object under the number. In that round trip another erasure of the id can
 * delete the holder, and a load that read the row after both renewals take its number, write and publish: nothing
 * refuses that publish. Each delete passes the version of the read that made the object a holder (`versions`): the
 * open of one this call searched, the footer read that found one encrypted under a row with no key, or the open whose
 * index failed its authentication under the row's key. So a driver that reports `conditionalDelete` refuses it for
 * any other object, and the deletes stop there, with the row's reason, `'superseded'` when the row gives none. On a
 * driver that does not, the delete removes whatever is under the number, the load's published object included.
 */
async function deleteFenced(
  c: EraseCall,
  holders: readonly number[],
  fenced: Verdict,
): Promise<{ deleted: number[]; moved: Verdict; missing?: number }> {
  const { ref, deps, base, versions } = c;
  const deleted: number[] = [];
  const watch = watchDeletes(deps, ref);
  let moved = fenced;
  for (const generation of holders) {
    if (moved !== null) break;
    const row = await deps.registry.get(ref);
    const missing = await watch.check(c.premise, row);
    if (missing !== undefined) return { deleted, moved: 'superseded', missing };
    // Another erasure's fence (a renewal of the pointerId, a prune of the ledger) leaves the premise standing.
    moved = rowVerdict(c, row, ['pointerId', 'knownGens']);
    // A holder the row names again (a rollback onto it, and away, since the fence took it out) is a window entry: it is
    // not deleted from under the row.
    if (moved === null && usableKnownGens(row)?.some((e) => e.generation === generation)) {
      moved = 'superseded';
    }
    if (moved !== null) break;
    try {
      await deleteSettled(
        deps.storage,
        { ...base, generation },
        { ifVersion: versions.get(generation) },
        c.read,
        { clock: deps.clock, rng: deps.rng },
      );
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // Another object is under the number now: the one searched was deleted, and the number taken again. What this
      // call was doing no longer follows from what is there, so it deletes nothing more, and the row says why.
      moved = rowVerdict(c, await deps.registry.get(ref)) ?? 'superseded';
      break;
    }
    deleted.push(generation);
    watch.deleted(generation);
  }
  // No read follows the last delete, so a rollback onto it would go unseen: one read of the row covers it.
  const missing = await watch.settle(c.premise);
  if (missing !== undefined) return { deleted, moved: 'superseded', missing };
  return { deleted, moved };
}

/**
 * Note that a delete loop of this call found the row naming `missing`, a generation it deleted. The call raises it in
 * place of its answer ({@link recordCollect}), after the `segment.collect` event when nothing left in the bucket holds
 * the id, and with no event when something does, since the erasure did not finish. Not thrown here: a `NotFoundError`
 * thrown while {@link stage} runs is translated by re-reading the row, which would report this as a race.
 */
function notePointerOnDeleted(c: EraseCall, missing: number): void {
  const { ref, seen } = c;
  seen.missing = pointerOnDeletedError(ref, { kind: 'erasure' }, missing);
}

/**
 * The answer for an erasure that deleted the generations holding the id and rewrote none, once a listing found no
 * holder left. The pass notes the row it read, the active one or the tombstone, for the `segment.collect` event the
 * call emits once it has its whole report.
 */
function collectedAll(
  c: EraseCall,
  fromGeneration: number,
  collected: readonly number[],
): EraseIdResult {
  const { seen, base, record } = c;
  seen.collectedOn = record.token;
  seen.found = true;
  return {
    ...base,
    erased: true,
    fromGeneration,
    collected: [...collected].sort(ascending),
  };
}

/**
 * The answer for an erasure that found no generation holding the id and deleted only objects it could not search,
 * once a listing found none of those left: `answer`, with what it deleted. When it deleted any, the pass notes the
 * row it read, so the call emits `segment.collect` for them, naming no generation the id was found in.
 */
function sealedOnly(
  c: EraseCall,
  answer: EraseIdResult,
  collected: readonly number[],
): EraseIdResult {
  const { seen, record } = c;
  if (collected.length > 0) seen.collectedOn = record.token;
  return { ...answer, collected: [...collected].sort(ascending) };
}

/**
 * The row names no generation, so nothing has been published, but a first load's object can be in the bucket: its
 * load still running, or one that wrote and never published (a crash, or a registry write that got no answer, after
 * which the object is kept by design). Each object is searched, and each one that holds the id is a holder. So is each
 * one sealed under a key no row holds yet, a first load's of an encrypted segment: this call holds no key for it, so it
 * cannot search it, and, whatever id it is asked to erase, it treats it as one that may hold it.
 *
 * With no holder it writes nothing, and a first load in flight publishes as it would have. With one, it renews the
 * row's `pointerId` ({@link fence}) before it deletes any, so the load that wrote it, fenced on the row it read
 * (or on there being no row, once a row appeared), is refused at its publish and never names an object that is gone;
 * then it deletes each holder while the row is still the one it renewed. A load that read the row after the renewal
 * writes an object of its own, numbered above every holder, which this call never deletes.
 *
 * `erased: true` only when a searched object held the id, as anywhere else. With only sealed holders the answer is
 * `'no-generation'`, with the generations it deleted in `collected`: the id was never found, and those objects can no
 * longer be published. Then {@link holderLeft} decides, as it does above the pointer: a holder written after the
 * listing, by a load that read the row before the renewal, is left, and that throws for a re-run, which renews again
 * and deletes it.
 */
async function unpublished(c: EraseCall): Promise<EraseIdResult> {
  const { ref, deps, base, sealed } = c;
  const newestFirst = (await generationsOf(deps.storage, ref)).reverse();
  const holders: number[] = []; // newest first
  const clean = new Set<number>();
  for (const { generation, held } of await holdsEach(c, newestFirst, { stopAtHolder: false })) {
    if (held === true) holders.push(generation);
    else if (held === false) clean.add(generation);
  }
  const none: EraseIdResult = { ...base, erased: false, reason: 'no-generation', collected: [] };
  if (holders.length === 0) return none;
  // The newest object that was searched and held the id; a sealed one could not be searched.
  const newest = holders.find((generation) => !sealed.has(generation));

  const fenced = await fence(c, { byName: holders, sweeps: false });
  const { deleted, moved, missing } = await deleteFenced(c, fenced.byName, fenced.moved);
  const collected = [...deleted].sort(ascending);
  const left = await holderLeft(c, clean);
  if (missing !== undefined) notePointerOnDeleted(c, missing);
  if (left === undefined) {
    return newest === undefined
      ? sealedOnly(c, none, collected)
      : collectedAll(c, newest, collected);
  }
  if (moved !== null) {
    return {
      ...base,
      erased: false,
      reason: moved,
      ...(newest === undefined ? {} : { fromGeneration: newest }),
      collected,
    };
  }
  throw cannotRemove(c, left);
}

/** The newest object listed under the tombstone that holds the id, searched as `holds` searches one; reads only. */
async function holderUnderTombstone(c: HoldsCall): Promise<{ generation: number } | undefined> {
  const newestFirst = (await c.read(() => generationsOf(c.deps.storage, c.ref))).reverse();
  return (await holdsEach(c, newestFirst, { stopAtHolder: true })).find((h) => h.held === true);
}

/**
 * The newest generation left under a tombstone that holds `id` in the clear, or `null`: the search
 * {@link eraseIdFromSegment} makes under a tombstone, without its deletes. The caller has read the row as `destroyed`;
 * this reads no row. It lists the bucket once and opens objects newest first, a few at a time, stopping at the first
 * that holds the id; an object sealed under a key is no holder. It writes and deletes nothing. A fault on a read is
 * thrown, after the read retry in `deps.readRetry` (the listing is retried too), never read as "not found".
 */
export async function findIdUnderTombstone(
  ref: SegmentRef,
  id: number,
  deps: SearchDeps,
): Promise<number | null> {
  validateUserRef(ref, 'findIdUnderTombstone');
  const { chunkKey, remainder } = splitId(id);
  const codec = requireCodec(deps.codec, 'findIdUnderTombstone');
  const c: HoldsCall = {
    ref,
    deps,
    chunkKey,
    remainder,
    codec,
    maxBytes: deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES,
    base: { segment: ref.segment, namespace: ref.namespace },
    tombstoned: true,
    aead: undefined,
    read: <T>(op: () => Promise<T>): Promise<T> => retryRead(op, deps.readRetry),
    sealed: new Set(),
    versions: new Map(),
  };
  return (await holderUnderTombstone(c))?.generation ?? null;
}

/**
 * The row is a tombstone, so no generation is the segment's any more and every object left is garbage (invariant 4's
 * one exception). A crypto-shred leaves objects no read through the library can open (the row holds no key), but a
 * cleartext
 * destroy, a drop whose sweep left something, or a write that landed after it leaves objects anyone can read. Each is
 * searched; when one holds the id,
 * the collection's tombstone pass deletes them all, re-proving the row's token before each delete, and what is left
 * is read again. One listing for a tombstone with nothing left.
 */
async function underTombstone(c: EraseCall): Promise<EraseIdResult> {
  const { ref, deps, base } = c;
  const holder = await holderUnderTombstone(c);
  if (holder === undefined) return { ...base, erased: false, reason: 'destroyed', collected: [] };
  const collected = await gcOrphanGenerations(ref, deps, { keep: 0, incarnation: c.record });
  const left = await holderLeft(c, new Set());
  if (left !== undefined) throw cannotRemove(c, left);
  return collectedAll(c, holder.generation, collected);
}

/**
 * The id is not in the current generation — which is **not** the same as not being in the bucket.
 *
 * A re-seed that simply stops including someone leaves their bit in the generation it dropped them from, and
 * the collection a load runs after it publishes (default `keep: 1`) *retains* exactly that
 * generation as the reader grace window. So the ordinary lifecycle of a rotating audience leaves an ex-member's
 * bit sitting in a retained object. Answering `'not-member'` there would filter the segment out of the
 * `eraseSubject` ledger entirely: a clean Art. 17 receipt over bytes still in the bucket, for the one
 * population most likely to be asking, people who already left.
 *
 * And the generations **above** the pointer count too. After a rollback they include the ones it rolled back
 * from, which `rollbackSegment` makes current again, with no flag while the row's ledger names them and with
 * `allowUnknown` once this call has taken them out, so a holder there is one operator action from being served. There can be several: every generation loaded after the one the pointer
 * was rolled back to.
 *
 * So look, at all of them. A holder cannot be rewritten — a rewrite of a non-current generation would regress
 * the pointer — so the only remedy is to delete it:
 *
 *  - **Below the pointer**, `gcOrphanGenerations` with `keep: 0` takes every generation at once, re-proving the
 *    row before each delete. It costs the segment its grace window and its older rollback targets, which is
 *    proportionate: only a segment that genuinely held the subject pays it.
 *  - **Above the pointer**, collection never looks, so each holder is deleted here, and only the holders (an
 *    object no read of the segment can open is one, whatever the id): a
 *    generation up there without the id is still an operator's rollback target and stays. This is the one place
 *    the library deletes an above-pointer object that it did not write, and it costs `rollbackSegment` a
 *    target, deliberately: a rollback point that still contains data we were required to erase is not a
 *    rollback point, and keeping it would make the erasure undoable by an ordinary operator action. Each delete
 *    is re-proved against the row first, as collection's are, because the danger is the same one: a rollback
 *    that lands on a generation this call has queued, which would leave the pointer naming a missing object.
 *    If the pointer has moved at all, the deletes stop. One round trip remains between that read and the delete,
 *    exactly as in collection's own loop, and on a row with no pointer too ({@link deleteFenced}): a rollback that
 *    lands inside it onto the generation being deleted leaves the pointer naming a missing object. The rollback's
 *    own move-then-verify catches every such landing except one whose check runs before the delete. A condition on
 *    the object cannot close that one, since the pointer then names the very object this call read, so the call
 *    detects it, as collection does, and throws `NotFoundError`: after its `segment.collect` event when nothing left
 *    in the bucket holds the id, at once when something does.
 *    What the condition does close is another object under the number: in that round trip another erasure can
 *    delete the holder and a load take its number, write and publish. Each delete passes the version of the read
 *    that made the object a holder (`versions`), so a driver that reports `conditionalDelete` refuses it for any
 *    other object, and the deletes stop as they do for a moved row. On a driver that does not, the delete removes
 *    whatever is under the number.
 *
 * An object sealed under a key the row does not hold is a holder this call cannot search ({@link holds}). Beside a
 * generation that was searched and held the id, it goes as any holder does: above the pointer by name, below it with
 * the collection. With no such generation, nothing proves the segment held the subject, so the collection does not
 * run: each of those objects is deleted by name, above the pointer or below it, under the same renewal of the row and
 * read before each delete, and the generations below the pointer that were searched and found clean stay.
 *
 * Then {@link holderLeft} decides. If nothing in the bucket holds the id, the claim is true however the pointer
 * moved meanwhile: a load that published mid-call puts every holder below its pointer, where the collection
 * takes them. If something still holds it and the pointer moved, the row says why, as it does everywhere else in
 * this function. If something holds it and the pointer did not move, the delete that should have taken it did
 * not, and that throws.
 *
 * **The cost is paid only where it is owed.** The cheap filter comes first: one `list`, and if the segment has no
 * other generations at all — true of any store that collects with `keep: 0`, and of a segment loaded once —
 * nothing else is read. Then per generation, the index is opened and the chunk is fetched only if the index
 * says that chunk exists: every generation above the pointer, since each holder there must be found; and below
 * it only until the first holder, since `keep: 0` takes the rest regardless (a few reads already in flight when it
 * is found may land past it, fewer than the scan's bound) — and not at all once a holder was found above. `eraseSubject` fans this out across every registered segment, so the filter is what keeps a
 * fleet-wide subject scan from doubling its reads on segments that never held the id.
 */
async function notInCurrent(c: EraseCall): Promise<EraseIdResult> {
  const { ref, deps, base, from, sealed } = c;
  const notMember: EraseIdResult = {
    ...base,
    erased: false,
    reason: 'not-member',
    fromGeneration: from,
    collected: [],
  };
  const newestFirst = (await generationsOf(deps.storage, ref)).filter((g) => g !== from).reverse();
  if (newestFirst.length === 0) return notMember;

  const clean = new Set<number>([from]);
  const holdersAbove: number[] = []; // newest first, those that could not be searched included
  for (const { generation, held } of await holdsEach(
    c,
    newestFirst.filter((g) => g > from),
    { stopAtHolder: false },
  )) {
    if (held === true) holdersAbove.push(generation);
    else if (held === false) clean.add(generation);
  }
  const foundAbove = holdersAbove.find((generation) => !sealed.has(generation));
  let holderBelow: number | undefined;
  const sealedBelow: number[] = [];
  if (foundAbove === undefined) {
    for (const { generation, held } of await holdsEach(
      c,
      newestFirst.filter((g) => g < from),
      { stopAtHolder: true },
    )) {
      if (found(c, generation, held)) holderBelow = generation;
      else if (held === true) sealedBelow.push(generation);
      else if (held === false) clean.add(generation);
    }
  }
  const newest = foundAbove ?? holderBelow;
  // Where a searched generation held the id, the collection takes every generation below the pointer, those that
  // could not be searched with them. Where none did, those are deleted one by one, under the fence, and the
  // generations below the pointer that were searched and found clean stay.
  const fenced = newest === undefined ? [...holdersAbove, ...sealedBelow] : holdersAbove;
  if (newest === undefined && fenced.length === 0) return notMember;

  // One write to the row before any delete: the generations about to go leave its ledger, and the deletes by name are
  // fenced against a load in flight (see `fence`). A call it refuses deletes nothing.
  const sweeping = newest !== undefined;
  let moved: Verdict = null;
  let byName: readonly number[] = fenced;
  let sweep = sweeping;
  let ledgered = true;
  let past = false;
  if (sweeping || fenced.length > 0) {
    const made = await fence(c, { byName: fenced, sweeps: sweeping });
    moved = made.moved;
    byName = made.byName;
    sweep = made.sweep;
    ledgered = made.ledger;
    past = made.past === true;
  }
  const swept: { deleted: number[]; missing?: number; knownSpared?: number[] } = sweep
    ? await collectBelowPointer(ref, deps, { keep: 0, skipKnown: true })
    : { deleted: [] };
  const collected = [...swept.deleted];
  let missing = swept.missing;
  if (sweep && missing === undefined && (moved === null || past)) {
    const again = await collectAgain(
      c,
      { spared: swept.knownSpared ?? [], ledgered },
      { byName: past ? fenced : [] },
    );
    collected.push(...again.deleted);
    missing = again.missing;
    // A row gone in the second fence leaves the reason the call already had: a holder may still be in the bucket.
    if (again.moved !== null && again.moved !== 'absent') {
      moved = again.moved;
    }
  }
  // A collection that stopped on a rollback has moved the pointer off `from`, so nothing above it is deleted.
  if (byName.length > 0 && missing === undefined) {
    const deleted = await deleteFenced(c, byName, moved);
    collected.push(...deleted.deleted);
    moved = deleted.moved;
    missing = deleted.missing;
  }

  const left = await holderLeft(c, clean);
  if (missing !== undefined) notePointerOnDeleted(c, missing);
  if (left === undefined) {
    if (newest !== undefined) return collectedAll(c, newest, collected);
    return sealedOnly(c, notMember, collected);
  }
  if (moved !== null || missing !== undefined) {
    return {
      ...base,
      erased: false,
      reason: moved ?? 'superseded',
      fromGeneration: newest ?? from,
      collected,
    };
  }
  throw cannotRemove(c, left);
}

/** A rewrite that exists and is verified, ready to publish. */
interface Staged {
  readonly generation: number;
  readonly key: GenKey;
  readonly fingerprint: string;
  readonly summary: RegistrySummary;
}

/**
 * Read `from`, write its successor, and verify it — the read-modify-write whose premise is that the pointer is
 * still at `from`. Returns a staged generation, or the result to report if the premise stopped holding.
 *
 * **Every object this phase touches can be deleted underneath it, by a concurrent call of this very
 * function.** An erasure collects with `keep: 0`, which takes every generation below its new pointer — so a
 * racing erasure deletes `from` while we are still streaming it, and deletes *the object we just wrote* too,
 * since ours is below its pointer and can never become current. There are three separate round trips exposed:
 * the reader open, every chunk of the rewrite (a whole-segment read — by far the longest window), and the
 * verify.
 *
 * The documented answer to that race is `reason: 'superseded'` — *this call did not erase it; re-run against
 * the new generation* — and it is what the publish already reports when its `expectFrom` fence fails. A bare
 * `NotFoundError` instead is the same event wearing a different, unactionable face; through `eraseSubject` it
 * becomes a note the facade documents as ambiguous about which side of the publish it landed on, so an
 * Art. 17 operator is told *triage this* where the truth is *re-run*.
 *
 * **A `NotFoundError` is translated only after re-reading the row, and the row decides which answer.** The
 * pointer still at exactly `from` means the object it names is genuinely absent — the forbidden
 * `missing-storage-generation` state a failed publish leaves behind — or is another object than the row's summary
 * names by its fingerprint, and that **throws**, because it is an integrity problem rather than a race and no
 * re-run fixes it. A pointer that moved is `'superseded'`, and so is a row whose `currentGen` is `null`: the call
 * found a pointer, so it never searched the bucket of a row with none, and `'no-generation'` would claim a search it did
 * not make; the re-run searches it. The row **gone** (the retention sweep purged a tombstone while we worked) is
 * `'absent'` and a tombstoned row `'destroyed'`, the answers this function gives when it reads either state up front.
 *
 * `generation` is set only once the object is **durable**. Reporting it from `nextGeneration` was wrong in a
 * way worth naming: if the row is gone by then, `nextGeneration` finds no row and no objects and restarts at
 * `0`, so the ledger read `fromGeneration: 0 → generation: 0` — the generation that *held* the bit named as
 * the one written *without* it, for an object that was never written.
 */
async function stage(c: EraseCall): Promise<EraseIdResult | Staged> {
  const {
    ref,
    deps,
    chunkKey,
    remainder,
    codec,
    maxBytes,
    base,
    record,
    from,
    aead,
    fromKey,
    read,
  } = c;
  /** Set only once the object exists in the bucket — see the note above. */
  let written: number | undefined;
  // The row's summary of `from`, when it has one this call can use: the rewrite reads only the object it names, as a
  // live read does, so an object put under the number from outside the library is never published as the rewrite.
  const described = usableSummary(ref, record, aead);
  try {
    const reader = await read(() =>
      openGenerationReader(deps.storage, fromKey, cryptoAt(c, from), {}, described?.fingerprint),
    );
    c.fromFingerprint = reader.fingerprint;
    const bytes = await read(() => reader.getChunk(chunkKey));
    // `return await`, not `return`: the sweep's rejection must land in the `catch` below, which is where a
    // `NotFoundError` is translated by re-reading the row. A bare `return` of the promise hands it past the `try`.
    if (bytes === null) return await notInCurrent(c);
    const target = codec.safeDeserialize(bytes, maxBytes);
    assertRemaindersInRange(target, chunkKey); // invariant 5, on the chunk we are about to re-encode
    if (!target.has(remainder)) return await notInCurrent(c);
    target.remove(remainder);

    // The rewrite is written before its row is: refuse here, not after, on a registry that cannot write one.
    assertRegistryCanWrite(deps.registry, 'eraseIdFromSegment');
    const generation = await nextGeneration(ref, deps);
    const key: GenKey = { ...base, generation };
    // The generation's metadata is part of it: the rewrite is the same generation without one id, so the new object
    // carries the source's metadata as it is, and the row's summary of it says so. An erasure does not scan the
    // metadata; it is the caller's to keep free of ids. On an encrypted segment a source with no metadata block, whose
    // row's sealed summary of this generation has metadata, is carried with the row's: the block's presence is not
    // authenticated and the summary is, so a stripped block is not made permanent by the rewrite. Such a source gets
    // here only past a fingerprint forged to match the row's, since stripping the block changes the object's size.
    const metadata = metadataToCarry(reader.metadata, aead === undefined ? undefined : described);
    let tally: Awaited<ReturnType<typeof writeCrbmGenerationStream>>;
    try {
      tally = await writeCrbmGenerationStream(
        deps.storage,
        key,
        rewrite(reader, chunkKey, target, codec, maxBytes, read),
        {
          crypto: cryptoAt(c, generation),
          clock: deps.clock,
          metadata,
          entropy: deps.entropy,
        },
      );
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      // Another writer, usually an erasure of a different id on this segment, took the number between this call's
      // `nextGeneration` and its put. Nothing of ours is in the bucket, so nothing is discarded. A retry would number
      // again and be fenced on `from`, which that writer moves, so the answer is the one a lost publish gives.
      let now: RegistryRecord | null;
      try {
        now = await deps.registry.get(ref);
      } catch {
        throw err;
      }
      return refusedResult(c, rowVerdict(c, now) ?? 'superseded');
    }
    written = generation; // `putImmutable` commits atomically, so the object exists exactly now
    c.rewrote = { generation, fingerprint: tally.fingerprint };
    // Re-check the pointer before spending the verification read. The fence below is what makes the publish
    // correct; this only saves a round trip on the common race, which the catch reports either way.
    const beforeVerify = await deps.registry.get(ref);
    const early = rowVerdict(c, beforeVerify, ['knownGens']);
    if (early !== null) return refusedResult(c, early, written);
    await read(() =>
      verifyGeneration(deps.storage, key, { ...tally, metadata }, cryptoAt(c, generation)),
    );
    // The row's summary is built from what was written, never copied from the row it replaces: whatever that one
    // held, a cached count or metadata that disagreed with the object it described goes with it.
    const summary = ownSummary(
      ref,
      generation,
      {
        cardinality: tally.cardinality,
        metadata,
        fingerprint: tally.fingerprint,
        tailBytes: tally.tailBytes,
      },
      aead,
    );
    return { generation, key, fingerprint: tally.fingerprint, summary };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // The row decides which answer this is — but only if it can be read. A re-read that faults must not
    // replace the `NotFoundError`: that error is the ONLY signal of the integrity state below, and swapping
    // it for a transient-looking registry fault loses the one thing an operator needs to see.
    let now: RegistryRecord | null;
    try {
      now = await deps.registry.get(ref);
    } catch {
      throw err;
    }
    const verdict = rowVerdict(c, now);
    if (verdict !== null) return refusedResult(c, verdict, written);
    // The pointer still names the object, and it is missing or is another object than the row's summary names:
    // neither is a race, and nothing was published from it.
    throw err;
  }
}

/**
 * Delete the object a refused rewrite wrote, when it would otherwise outlive the winner above its pointer.
 *
 * Only one position needs it: the pointer moved forward past `from` and stopped **below** `written`. Two winners
 * leave it there: one whose object was already in the bucket when this call took its number (`nextGeneration`
 * numbers above everything present), and a load that numbered after it from its own row, which takes
 * `currentGen + 1` whenever no object holds that number, below this call's object. Either way the object is
 * above the winner's pointer, where no collection ever looks. The
 * object was derived from `from`, so when the winner was another erasure it still holds the id that erasure
 * has just reported gone, one `rollback({ allowUnknown: true })` from being served, and the newest superseded
 * generation once a later load raises the pointer past it, which is exactly what that load's `keep` retains.
 *
 * Under a tombstone it is deleted too, as a refused load deletes its own: every generation under one is garbage
 * (invariant 4's one exception), and a drop that landed while this rewrite streamed usually finished its sweep
 * before the object committed, so nothing else would take it. It is a copy of the dropped segment less one id.
 *
 * Everywhere else the object is left alone, as a refused load leaves its own once the row has changed. At or
 * above `written` the pointer either names it or belongs to a writer that numbered after it and whose
 * collection takes it; at or below `from` nothing replaced `from`; and a row that is gone or without a pointer
 * is not one this call can reason about. The position is read from a fresh row.
 *
 * Above the winner's pointer the number can be taken again: another erasure, of an id this object still holds,
 * deletes it as a holder, and a load numbers `currentGen + 1`, which can be `written`. A footer names a write, not just
 * a set of ids: its checksum covers the write identity the writer drew, so a load of the ids this object holds writes
 * another footer. So the object is first matched to this rewrite's fingerprint by one read of its footer (one that is
 * gone, is another object, or cannot be read is kept, a load's object of the same ids included), and then the row the
 * position was read from is renewed ({@link rowRenewal}) before the delete. Whoever wrote the object that read matched
 * read its row before writing it, so before the renewal, and its publish, fenced on that row, is refused. A publish
 * that landed after this call read the row makes the renewal lose, and the call reads the row and decides again. One
 * that landed before it left the pointer on the number or above it, and the object is kept. Since the match names this
 * rewrite's write, a generation a load published and a rollback then moved the pointer below is kept too, where a
 * footer shared by two writers (an all-zero identity) would have had it deleted as if it were the rewrite. A renewal
 * lost to a write of leases
 * alone, or to another erasure's renewal, is waited out, up to the limit on lease waits, and costs nothing; the object
 * is kept after {@link DISCARD_ATTEMPTS} renewals lost to other writes. Only this call's own renewal licenses the
 * delete: another erasure's, landing between this call's read of the row and its footer read, lets a load read the
 * renewed row and take the number before the footer read. A name purged and re-created is decided the same way, on
 * its own row.
 *
 * The delete passes the version the footer read reported, so on a storage driver that reports `conditionalDelete` it
 * removes that object and no other: an object put under the number after the renewal, by a load that read the renewed
 * row once another erasure had deleted this one, stays, and that refusal is swallowed, since the object this call
 * wrote is gone. That one round trip stays open where the driver ignores the condition: there the delete removes
 * the load's generation. A driver that derives its versions from the bytes is covered, since another write's bytes
 * differ by the write identity. A rollback onto the
 * object inside it leaves the pointer on a missing object too, and nothing reports it. Any other fault of the discard,
 * the renewal's `TransientError` included, is thrown in place of the refusal, unlike a refused load's reclaim, which
 * swallows every fault: the object this call would leave above the pointer can hold an id that another erasure has
 * reported gone. Under a tombstone the delete is by number, with no read and no renewal: every writer refuses a
 * `destroyed` row until it is purged, so no load takes the number again.
 *
 * Returns the row it read last, so a refused publish reports what that row says.
 */
async function discardRefused(
  c: EraseCall,
  own: { readonly generation: number; readonly fingerprint: string },
): Promise<RegistryRecord | null> {
  const { ref, deps, base, from } = c;
  const key: GenKey = { ...base, generation: own.generation };
  const renewal = rowRenewal(ref, deps);
  const churn = leaseChurn({ clock: deps.clock, rng: renewal.rng });
  let row = await deps.registry.get(ref);
  for (let attempts = 1; ; attempts++) {
    if (row !== null && row.status === 'destroyed') {
      await deleteSettled(deps.storage, key, undefined, c.read, {
        clock: deps.clock,
        rng: deps.rng,
      });
      return row;
    }
    if (row === null || row.status !== 'active' || row.currentGen === null) return row;
    if (row.currentGen <= from || row.currentGen >= own.generation) return row;
    const proven = await provenObject(deps.storage, key, own.fingerprint);
    if (proven === null) return row;
    // The proof reads one object at one moment, and a load can have taken the number again since. Renewing the
    // row this decision read refuses every publish fenced on a row read before the proof; a renewal that loses means
    // another write landed since, so the decision is made again from the row read after it.
    const renewed = await renewal.renew(row);
    if ('row' in renewed) {
      try {
        await deleteSettled(deps.storage, key, { ifVersion: proven.version }, c.read, {
          clock: deps.clock,
          rng: deps.rng,
        });
      } catch (err) {
        if (!isWriteConflictError(err)) throw err;
      }
      return row;
    }
    // A row changed only in its leases, or renewed by another erasure, is waited out and costs no attempt: losing to
    // the other losers of one race must not leave an object holding the id the winner reported erased.
    const settled = await churn.settle(row, renewed.lost, () => deps.registry.get(ref), [
      'pointerId',
    ]);
    if (settled === undefined && attempts >= DISCARD_ATTEMPTS) return renewed.lost;
    if (settled !== undefined) attempts -= 1;
    row = settled === undefined ? renewed.lost : settled.row;
  }
}

/**
 * Publish the rewrite fenced on the row it was derived from, and, once it is authoritative, delete every generation
 * below it and prove none holds the id.
 */
async function finishRewrite(c: EraseCall, staged: Staged): Promise<EraseIdResult> {
  const { ref, deps, audit, base, record, from, fromToken } = c;
  const { generation, key, fingerprint, summary } = staged;

  // Read-modify-write, not merely forward-only, and the distinction is the whole correctness of this function.
  //
  // The new generation's content is `from` minus one bit, so it is only a valid successor to `from`. Publishing
  // it forward-only would land it over ANY newer generation, because `nextGeneration` deliberately picks a number
  // above everything in the bucket — including an object a concurrent writer just published. Two ways that goes
  // wrong: a load that published between our read and our publish would have its whole set discarded and its
  // object collected; and of two concurrent erasures, the second one's generation would put the FIRST one's id
  // back, deleting the generation that evidenced its removal, while both returned `erased: true` with a
  // `segment.rewrite` event. A false Art. 17 receipt is the worst output this module can produce.
  //
  // `expectFrom` makes the publish land only while the pointer is still exactly `from`.
  //
  // Reported, not thrown — the caller re-runs against the new generation, which may or may not still hold the id.
  const published = await publishGeneration(deps.registry, key, {
    expectFrom: from,
    expectToken: fromToken,
    // A lease written while the rewrite streams moves the token and nothing it derived from: it does not refuse it.
    expectRow: record,
    expectRowIgnores: ['knownGens'],
    summary,
    // The row then records that no generation below the new pointer is kept, as the collection below leaves it: its
    // ledger is the rewrite alone, whose footer checksum is the one its summary describes.
    footerCrc: footerCrcOf(fingerprint),
    keep: 0,
    // Every generation below the new pointer is deleted whatever a lease says, so the row drops its leases.
    clearLeases: true,
    // A write that ends without an answer is settled by reading the row: a registry that reports its writes' tokens
    // settles it by the row's `pointerId`; any other takes a pointer at this number for this rewrite's only over an
    // object whose footer matches what it wrote, which carries this rewrite's own write identity, so another write's
    // object cannot pass for it.
    holdsOwnObject: () => provesOwnObject(deps.storage, key, fingerprint),
    clock: deps.clock,
    rng: deps.rng ?? deps.readRetry?.rng,
  });
  if (!published) {
    // The publish refuses on the row's token before it looks at the row's status, so the row read here says why:
    // a concurrent `dropSegment` is `'destroyed'`, not a race a re-run would win.
    const now = await discardRefused(c, { generation, fingerprint });
    return {
      ...base,
      erased: false,
      reason: rowVerdict(c, now) ?? 'superseded',
      fromGeneration: from,
      generation,
      collected: [],
    };
  }
  audit.onEvent({
    kind: 'segment.rewrite',
    namespace: ref.namespace,
    segment: ref.segment,
    ...incarnationField(fromToken),
    fromGeneration: from,
    generation,
  });
  // `keep: 0`: the whole point is that the generation holding the bit does not survive this call. Every
  // generation below the new pointer is safe to take: the CAS succeeded while the pointer was still at `from`, so
  // nothing in `(from, generation)` had been published before us, and no read that resolves the pointer can reach
  // any of them. Deleting them is the strongest form of the "physically gone on return" claim rather than a risk to
  // a load still in flight. The pointer can still move DOWN onto one of them — an operator's `rollbackSegment`,
  // or a purge-and-recreate (invariant 1) — which is why the collector re-proves the row before every delete
  // rather than trusting the one this call read, and why the receipt below reads what is left rather than
  // assuming. A rollback that lands between a re-proof and its delete, and that the row still shows when read again, makes
  // the call throw `NotFoundError`, after the `segment.rewrite` event above: the collection stopped there.
  const swept = await collectBelowPointer(ref, deps, { keep: 0, skipKnown: true });
  if (swept.missing !== undefined) {
    throw pointerOnDeletedError(ref, { kind: 'erasure' }, swept.missing);
  }
  const collected = [...swept.deleted];
  let missing: number | undefined;
  // The collection spared a generation the row names, which a rollback onto it or a load's window made known after the
  // rewrite's write left the ledger as the rewrite alone: it is taken out again and the collection runs again.
  if (missing === undefined && (swept.knownSpared?.length ?? 0) > 0) {
    const again = await collectAgain(
      c,
      { spared: swept.knownSpared ?? [], ledgered: true },
      { byName: [], below: generation },
    );
    collected.push(...again.deleted);
    missing = again.missing;
  }
  if (missing !== undefined) {
    throw pointerOnDeletedError(ref, { kind: 'erasure' }, missing);
  }
  const left = await holderLeft(c, new Set([generation]));
  if (left !== undefined) throw cannotRemove(c, left);
  return { ...base, erased: true, fromGeneration: from, generation, collected };
}

/**
 * The segment's DEK, reused across generations. Resolved before any object I/O so a slow keystore/KMS call
 * sits outside the read-write window; an encrypted row with no keystore is a lost key, not a cleartext segment.
 * Under a tombstone no key is held: its objects are searched in the clear, and one sealed under its key is skipped.
 */
async function resolveDek(
  ref: SegmentRef,
  deps: EraseIdDeps,
  record: RegistryRecord,
  row: { readonly tombstoned: boolean; readonly pointerless: boolean },
): Promise<Aead | undefined> {
  checkRequireEncryption(deps.requireEncryption);
  if (row.tombstoned) return undefined;
  if (record.wrappedDeks !== undefined && record.wrappedDeks.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted, and the erasure has no keystore to open its key ` +
          `(encryption.keystore on the store)`,
      );
    }
    return await deps.keystore.openDek(record.wrappedDeks);
  }
  // A row with no pointer holds no key because it holds no data yet, so it is not a cleartext segment.
  if (!row.pointerless && deps.requireEncryption === true) {
    throw new KeyUnavailableError(
      `requireEncryption: segment "${ref.segment}" is cleartext but encryption is required`,
    );
  }
  return undefined;
}

/**
 * `crypto`, noting in `index.refused` when the object's index fails its authentication under it: the AAD it is opened
 * with is the one `crypto` gives the index of this segment and generation. The reader authenticates the index after
 * every check of the footer and of the index's checksum, and before anything else it decrypts, so a refusal there says
 * the object was not sealed under this key for this generation, rather than that it is damaged.
 */
function noticingIndex(crypto: CrbmCrypto, index: { refused: boolean }): CrbmCrypto {
  const indexAad = crypto.aadFor('index');
  return {
    aadFor: crypto.aadFor,
    aead: {
      seal: (plaintext, aad) => crypto.aead.seal(plaintext, aad),
      open: (sealed, aad) => {
        try {
          return crypto.aead.open(sealed, aad);
        } catch (err) {
          if (sameBytes(aad, indexAad)) index.refused = true;
          throw err;
        }
      },
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The writes of one erasure step to a row, on the token of the row it is given: a renewal of the row's `pointerId`
 * ({@link renewPointer}), which changes nothing a read resolves and refuses every publish fenced on a row read before it,
 * or any other patch, such as the fence's removal of generations from the row's ledger.
 *
 * `write` answers with the row as its write left it, or, when the write did not land, with the row read after it
 * (`lost`; `null` for a row that is gone), for the caller to decide on. A write that gets no answer is settled by
 * reading the row. A row still as the write found it gets a fresh compare-and-swap from the row just read, a request of
 * its own carrying the same version, so at most one of the two lands, after a wait on the injected clock under 500 ms,
 * then 1 s, then 2 s (spread by the rng), at most three times across the writes of one such step, as a load's publish
 * does (a call's fences are one step each, and a call makes up to six); then, or at once with no clock to wait on, or
 * when the row cannot be read, the registry's `TransientError` is thrown.
 * Any other row is `lost`, the step's own write possibly among it: only the caller knows what may follow from it.
 */
function rowRenewal(
  ref: SegmentRef,
  deps: EraseIdDeps,
): {
  readonly rng: Rng | undefined;
  write(
    row: RegistryRecord,
    patch: RegistryPatch,
  ): Promise<{ readonly row: RegistryRecord } | { readonly lost: RegistryRecord | null }>;
  renew(
    row: RegistryRecord,
  ): Promise<{ readonly row: RegistryRecord } | { readonly lost: RegistryRecord | null }>;
} {
  const rng = deps.rng ?? deps.readRetry?.rng;
  let resends = 0;
  const write = async (
    row: RegistryRecord,
    patch: RegistryPatch,
  ): Promise<{ readonly row: RegistryRecord } | { readonly lost: RegistryRecord | null }> => {
    let current = row;
    for (;;) {
      let failure: unknown;
      try {
        const { token } = await deps.registry.compareAndSwap(ref, current.token, patch);
        // The row as this write left it: its patch applied, and its pointerId the token the write was given when the
        // patch names a field a read resolves through.
        return {
          row: {
            ...current,
            token,
            pointerId: renewsPointer(patch) ? token : current.pointerId,
            ...('knownGens' in patch ? { knownGens: patch.knownGens } : {}),
          },
        };
      } catch (err) {
        if (!isWriteConflictError(err) && !isTransientError(err)) throw err;
        failure = err;
      }
      const unanswered = isTransientError(failure);
      let now: RegistryRecord | null;
      try {
        now = await deps.registry.get(ref);
      } catch (readErr) {
        // A write that got no answer stays unsettled, and the registry's own error says so. A row that is not one the
        // library wrote says more than that, and is thrown as it is.
        if (!unanswered || isIntegrityError(readErr)) throw readErr;
        throw failure;
      }
      if (!unanswered || now === null || now.token !== current.token) return { lost: now };
      // Not landed, or still on its way: a fresh write from the row just read, a bounded number of times.
      if (deps.clock?.sleep === undefined || resends >= UNANSWERED_RESENDS) throw failure;
      const bound = UNANSWERED_BASE_MS * 2 ** resends;
      resends += 1;
      await jitteredWait(deps.clock, rng, bound);
      current = now;
    }
  };
  return { rng, write, renew: (row) => write(row, renewPointer(row)) };
}

/** How many ranges the erasure rewrite keeps open or landed ahead of the writer. */
const REWRITE_RANGES_AHEAD = 4;

/**
 * The new generation's chunks, ascending: every chunk of the old generation decoded and passed through, except
 * `chunkKey`, which is replaced by `replacement` (already missing the id). Decoding rather than copying bytes is
 * deliberate — it puts every chunk through the **safe** deserializer and the size cap on the one path that
 * rewrites a whole segment, so a chunk that is not decodable, or is larger than the cap, stops the rewrite
 * instead of being copied forward — and the writer skips a chunk the removal emptied. Reads run ahead of the writer
 * through the reader's coalesced stream, in key order: neighbouring chunks share one range request, so the erasure
 * costs a few range requests rather than one per chunk. Each chunk is decoded only as the writer reaches it, so a
 * corrupt one still stops the rewrite naming that chunk and not a later one. At most {@link REWRITE_RANGES_AHEAD}
 * ranges are held ahead of the writer, in flight or landed and not yet taken, each at most 1 MiB plus 28 bytes unless
 * one chunk alone is larger (and no chunk is larger than the reader's per-chunk payload cap, which refuses a longer
 * index entry when the object is opened); a well-formed segment's chunks are about 8 KiB each, so a range of them
 * holds many.
 *
 * Both halves of **invariant 5** apply, including the remainder range: a chunk of a 16-bit-keyed segment cannot
 * hold a value above `MAX_REMAINDER`, and one that does was not written by this codec. Carrying it forward would
 * re-encode pre-existing corruption into a brand-new object and then report `erased: true` over a segment that
 * still cannot be read — so the rewrite stops instead, naming the chunk. An `IntegrityError` here says "this
 * segment is corrupt", which is what the operator needs to know; a successful-looking erasure says nothing. The
 * check is one `maximum()` call per chunk against a bitmap this function has already decoded, so honouring the
 * invariant costs nothing measurable on a path that is re-encoding every chunk anyway. Each chunk is read through
 * `read`, the caller's read retry.
 */
async function* rewrite(
  reader: CrbmReader,
  chunkKey: number,
  replacement: CodecBitmap,
  codec: CodecInterface,
  maxBytes: number,
  read: <T>(op: () => Promise<T>) => Promise<T>,
): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
  const keys = [...reader.chunkKeys()].sort(ascending);
  // The replaced chunk is never read: it is already in hand. Every other chunk comes through the reader's coalesced
  // stream: neighbouring chunks share one range request, each range goes out under the caller's read retry on its
  // own, and the stream holds at most REWRITE_RANGES_AHEAD ranges. It is the same reader, so the whole rewrite reads
  // the one generation the call opened, and each chunk passes the checks a read of it alone passes.
  const stream = reader.readChunks(
    keys.filter((k) => k !== chunkKey),
    { concurrency: REWRITE_RANGES_AHEAD, readRange: read },
  );
  try {
    for (const k of keys) {
      if (k === chunkKey) {
        yield { chunkKey: k, bitmap: replacement };
        continue;
      }
      const item = await stream.next();
      // The stream yields one item per key asked for; it ending early would drop chunks from the new generation.
      if (item.done === true || item.value.key !== k) {
        throw new IntegrityError(`the chunk stream ended before chunk ${k}`);
      }
      const bytes = item.value.bytes;
      if (bytes === null) continue; // listed but absent: nothing to carry forward
      const bitmap = codec.safeDeserialize(bytes, maxBytes);
      assertRemaindersInRange(bitmap, k);
      yield { chunkKey: k, bitmap };
    }
  } finally {
    // However the rewrite ends, the stream sends nothing more; its reads in flight finish and are dropped.
    await stream.return(undefined);
  }
}

/**
 * Invariant 5's range half, for one decoded chunk: every value in a chunk is a 16-bit remainder, so a value above
 * `MAX_REMAINDER` means the object was not written by this codec. `maximum()` is optional on the codec seam (a
 * codec with no size decision to make may omit it); when it is absent the check is skipped rather than faked.
 */
function assertRemaindersInRange(bitmap: CodecBitmap, chunkKey: number): void {
  const max = bitmap.maximum?.();
  if (max !== undefined && max > MAX_REMAINDER) {
    throw new IntegrityError(
      `chunk ${chunkKey} payload holds value ${max}, outside the 16-bit remainder range [0, ${MAX_REMAINDER}] — ` +
        `the stored object is corrupt or was not written by this codec; refusing to carry it into a new generation`,
    );
  }
}
