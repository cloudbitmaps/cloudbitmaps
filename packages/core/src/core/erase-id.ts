/**
 * Subject erasure on a loaded segment (GDPR Art. 17): remove **one id** from a segment by rewriting its current
 * generation without that id.
 *
 * There is no per-id delete on an immutable object, and there is no mutable tier to hold a tombstone, so erasure
 * is what every other write in this library is: a new generation. The current generation is streamed chunk by
 * chunk through the ascending writer — every chunk decoded, range-checked and re-encoded, the one holding the id
 * with that bit cleared — then published fenced on the generation it streamed, and that generation is collected immediately
 * (`keep: 0`), so the bit is **physically gone from the bucket when this returns**. Bounded memory: a window of 32
 * chunk reads ahead of the writer, never the whole segment.
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
 * still holds the id makes it report or throw instead. In the ordinary case that list returns one generation, the
 * current one, and costs one `list`.
 *
 * What it does NOT reach: backups, replicas and noncurrent object versions hold the old object until their own
 * lifecycle removes it. For an at-rest guarantee that survives those, use encryption plus crypto-shred
 * (`destroySegment`), which is per segment — a per-id shred is infeasible because one DEK covers the whole segment.
 *
 * Concurrency. This is a **read-modify-write**, not a plain forward-only publish, and that distinction is where
 * its correctness lives: the new generation is `from` minus one bit, so it is a valid successor to `from` and to
 * nothing else. The publish is therefore fenced on `from` **and on the row it was read from**
 * (`publishGeneration`'s `expectFrom` + `expectToken`) and lands only while the pointer is still exactly there,
 * on that same row. Both halves are needed: a generation number identifies a generation only within one
 * incarnation of a name, and a name that is retired and re-created restarts at `0`, so the number alone matched
 * a different segment entirely. Anything else — a load that published in the meantime, or another
 * erasure that got there first — is reported as `reason: 'superseded'`, `erased: false`, and the caller re-runs
 * against the new generation. A writer that claims the same generation *number* first surfaces as a
 * `WriteConflictError` (write-once).
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
 * `'superseded'`, a tombstoned row `'destroyed'`, a purged row `'absent'`, a row with no pointer
 * `'no-generation'`. A pointer still on `from` means the object it names is genuinely gone — the forbidden
 * `missing-storage-generation` state — or is another object than the row's summary names by its fingerprint, and that
 * throws, because no re-run fixes either. That `NotFoundError` is the only signal of those states, so a faulting
 * re-read rethrows it rather than replacing it with a transient-looking registry error.
 *
 * **A refused rewrite deletes its own object when it would outlive the winner above the pointer.** `putImmutable`
 * commits atomically, so a rewrite whose stream throws leaves no object at all. One that completed is either
 * below the winner's pointer, where the winner's collection takes it, or above it: the case where this call took
 * its number after the winner's object was already in the bucket. Up there nothing collects it, and it was derived
 * from a generation the winner has replaced, so when the winner was another erasure it still holds the id that
 * erasure has just reported gone. That object is deleted before this call returns — see `discardRefused`.
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
 * never names a missing object (see `fenceInFlight`). An erasure that finds no holder writes nothing.
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
import { incarnationField } from './token';
import { MAX_REMAINDER, splitId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';
import type { Yielder } from './cooperative';
import type { Rng } from './determinism';
import {
  objectIsEncrypted,
  openGenerationReader,
  provesOwnObject,
  publishGeneration,
  verifyGeneration,
  writeCrbmGenerationStream,
} from './crbm-storage-source';
import { DEFAULT_MAX_BITMAP_BYTES } from './crbm/format';
import type { CrbmReader } from './crbm/reader';
import { mapWithConcurrency } from './concurrency';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  ValidationError,
  WriteConflictError,
  isIntegrityError,
  isNotFoundError,
  isTransientError,
  isWriteConflictError,
} from './errors';
import { gcOrphanGenerations, nextGeneration } from './generation-gc';
import { UNANSWERED_BASE_MS, UNANSWERED_RESENDS, leaseChurn, onlyLeasesDiffer } from './leases';
import { renewPointer } from './pointer-id';
import { assertRegistryCanWrite } from './ports';
import type {
  GenKey,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  Token,
} from './ports';
import { type ReadRetry, retryRead } from './retry';
import { metadataToCarry, summaryOf, usableSummary } from './summary';
import { validateUserRef } from './validate';

/** Generations whose index and chunk are read at once while looking for a holder of the id; the keep window is small. */
const HOLDS_CONCURRENCY = 4;

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
   * Why the id was not erased, when `erased` is false. `'absent'` (no registry row), `'destroyed'` (a crypto-shred
   * tombstone — already unreadable), `'no-generation'` (a row with no Storage data yet: no object in its bucket held
   * the id, and `collected` names any object this call deleted unsearched, see below), `'not-member'` (no
   * generation in the bucket holds the id — the common case across a fleet scan — with the same note on `collected`),
   * or `'superseded'`.
   *
   * **`'superseded'` means this call did not erase the id, not that the id is still there.** Another writer — a
   * load, another erasure, or a rollback — moved the pointer off the generation this call read, so what it was
   * doing no longer follows from what is current: a rewrite derived from that generation is not a valid successor
   * to the new one, and a generation it meant to delete above the pointer may be the one the pointer now names.
   * Re-run against the new generation: if the id is still present it is erased then; if the racing writer was
   * another erasure of the *same* id, the re-run reports `'not-member'` because it is already gone. Either way the
   * re-run settles it, which is why it is the documented action for this reason and for no other.
   *
   * The first three reasons are also returned when the row changes *underneath* a call already in flight, not
   * only when it is read up front — a concurrent `dropSegment` gives `'destroyed'`, once the tombstone's objects have
   * been searched as a fresh call searches them, and a retention sweep that purges the row gives `'absent'`. A caller
   * branching on `reason` never has to care which it was.
   */
  readonly reason?: 'absent' | 'destroyed' | 'no-generation' | 'not-member' | 'superseded';
  /**
   * The generation the id was found in (present whenever one was read) — the newest of them, when the current
   * generation did not hold it and several others did.
   */
  readonly fromGeneration?: number;
  /**
   * The generation written without the id (present whenever one was written, even if `superseded`). A refused
   * rewrite whose object sits above the winner's pointer deletes that object again before it returns.
   */
  readonly generation?: number;
  /**
   * Generations this call deleted. On a rewrite that is normally `[fromGeneration]`, plus any older orphans. When
   * the current generation did not hold the id, it is every generation below the pointer (`keep: 0` takes them
   * together) and each one above the pointer that held the id; the ones above it that did not hold the id stay,
   * because they are an operator's rollback targets. On a row with no pointer it is each first load's object that
   * held the id. Wherever it found them, it is also each object sealed under a key the row does not hold, which this
   * call cannot search and deletes whatever the id: with only those, `reason` is `'no-generation'` on a row with no
   * pointer and `'not-member'` on one with a pointer, and they are listed here. Empty when nothing was deleted.
   *
   * **It is what THIS call deleted, not the proof that the id is gone** — those differ: a concurrent collector can
   * take a generation holding the id first, and then `erased: true` is returned without it in `collected`, because
   * the claim is about the bucket rather than about who emptied it. Treat a non-empty `collected` as evidence and
   * a missing holder as "someone else got there", never as a failure.
   *
   * A call that cannot establish the claim **throws** `WriteConflictError` or the underlying fault rather than
   * report `erased: true` over bytes that are still there. Four ways that happens: a Storage `delete` fault; a
   * collection pass that could not prove the segment was still the same one (which an ordinary retirement landing
   * mid-call is enough to cause); the same refusal on the path where the current generation did not hold the id
   * and nothing was published at all; and a generation still holding the id when the bucket is listed at the end
   * — one an operator rolled the pointer onto while a rewrite was collecting, say, or, on a row with no pointer, the
   * object of a first load that read the row before this call renewed it and wrote it after this call listed the
   * bucket. The row write an erasure makes before deleting a holder a load may still publish, when it gets no answer
   * that reading the row can settle, throws the registry's `TransientError`, and that holder is not deleted.
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
 * that deleted only objects no read of the segment can open, which names no generation the id was found in.
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
    if (!again.erased) return again;
    // Erased under the tombstone: the report covers both passes, what each deleted and the newest holder either read.
    const collected = [...new Set([...result.collected, ...again.collected])].sort((a, b) => a - b);
    const newest = Math.max(result.fromGeneration ?? -1, again.fromGeneration ?? -1);
    const merged = { ...again, collected, ...(newest >= 0 ? { fromGeneration: newest } : {}) };
    return recordCollect(ref, merged, second, options);
  }
  return recordCollect(ref, result, first, options);
}

/**
 * What one pass of {@link eraseIdFromSegment} saw: whether the row it read first was a tombstone, the token of the row it
 * read when it finished by deleting objects and rewriting none, and whether one of those it searched held the id.
 */
interface Pass {
  tombstoned?: boolean;
  collectedOn?: Token;
  found?: boolean;
}

/**
 * Emit `segment.collect` for a call that finished by deleting the holders and rewriting none, from the report the call
 * returns, so the event and the ledger entry carry the same generations: the whole call's, both passes included. It
 * names the generation the id was found in only when a searched one held it: a call that deleted only objects it could
 * not search found it in none.
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
  return result;
}

/** One pass of {@link eraseIdFromSegment}. It records in `seen` what {@link Pass} says. */
async function eraseOnce(
  ref: SegmentRef,
  id: number,
  deps: EraseIdDeps,
  options: { audit?: IAuditSink },
  seen: Pass,
): Promise<EraseIdResult> {
  validateUserRef(ref);
  checkedAuditSink(options.audit, 'eraseIdFromSegment');
  const { chunkKey, remainder } = splitId(id); // validates the u32 range
  const codec = requireCodec(deps.codec, 'eraseIdFromSegment');
  const maxBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
  const base = { segment: ref.segment, namespace: ref.namespace };
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  /** A read this call makes, under the store's read retry when it was given one. */
  const read = <T>(op: () => Promise<T>): Promise<T> => retryRead(op, deps.readRetry);

  const record = await deps.registry.get(ref);
  if (record === null) return { ...base, erased: false, reason: 'absent', collected: [] };
  // A tombstone is no proof nothing readable is left (see `underTombstone`), nor a row with no pointer that nothing
  // was written (see `unpublished`): both are searched.
  const tombstoned = record.status === 'destroyed';
  seen.tombstoned = tombstoned;
  const pointerless = !tombstoned && record.currentGen === null;
  const from = record.currentGen ?? -1;
  /**
   * The row this rewrite derives its content from, not just the number it points at. `nextGeneration` restarts
   * at `0` once a row is purged and the bucket emptied, so a retired-and-re-created name presents a *different*
   * segment at the *same* `currentGen` — which `expectFrom` alone matched, republishing one incarnation's
   * content over another's and reporting `erased: true`. A token is not reused across incarnations, but for a collision of probability 2^-128 per pair.
   */
  const fromToken = record.token;
  /**
   * The row this call holds its premise against: `record`, until the call writes the row itself ({@link
   * fenceInFlight}), after which it is the row it wrote, so its own write is not read as another writer's.
   */
  let premise: RegistryRecord = record;
  let premiseToken = fromToken;

  // The segment's DEK, reused across generations. Resolved before any object I/O so a slow keystore/KMS call
  // sits outside the read-write window; an encrypted row with no keystore is a lost key, not a cleartext segment.
  // Under a tombstone no key is held: its objects are searched in the clear, and one sealed under its key is skipped.
  let aead: Aead | undefined;
  if (tombstoned) {
    // nothing to resolve
  } else if (record.wrappedDeks !== undefined && record.wrappedDeks.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but eraseIdFromSegment has no keystore`,
      );
    }
    aead = await deps.keystore.openDek(record.wrappedDeks);
  } else if (!pointerless && deps.requireEncryption === true) {
    // A row with no pointer holds no key because it holds no data yet, so it is not a cleartext segment.
    throw new ValidationError(`requireEncryption: segment "${ref.segment}" is cleartext`);
  }
  // The AAD binds each chunk/index to (segment, generation), so reading gen g and writing gen g' use distinct
  // contexts over the same DEK.
  const cryptoAt = (generation: number): CrbmCrypto | undefined =>
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, generation, scope) };

  const fromKey: GenKey = { ...base, generation: from };
  const refused = (
    reason: 'superseded' | 'absent' | 'no-generation' | 'destroyed',
    generation?: number,
  ): EraseIdResult => ({
    ...base,
    erased: false,
    reason,
    fromGeneration: from,
    generation,
    collected: [],
  });

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
   * `'no-generation'`, and a pointer that moved is `'superseded'`. On a row that had no pointer, a pointer that
   * appeared is `'superseded'`: a load published, or a rollback moved onto an object.
   */
  const rowVerdict = (
    row: RegistryRecord | null,
  ): 'superseded' | 'absent' | 'no-generation' | 'destroyed' | null => {
    if (row === null) return 'absent';
    if (row.status === 'destroyed') return 'destroyed';
    // A different row is a different lineage even at the same pointer value — see `fromToken`.
    // A write of the row's leases alone, which readers make, is not another writer's: the premise still holds.
    const same = row.token === premiseToken || onlyLeasesDiffer(premise, row);
    if (pointerless) return row.currentGen === null && same ? null : 'superseded';
    if (row.currentGen === null) return 'no-generation';
    return row.currentGen === from && same ? null : 'superseded';
  };

  /**
   * Generations `holds` could not search and counts as holders: objects sealed under a key the row does not hold. On a
   * row with no pointer, a first load's whose key that load has not published; on a row with a key, one whose index
   * does not open under it, which no read of the segment can open either.
   */
  const sealed = new Set<number>();
  /**
   * Whether `generation` still holds the id: its index is opened, and the id's chunk is fetched only if the index
   * lists it. `null` when the object is gone — a concurrent collector took it, which is not a failure of this call
   * but the outcome it wants. `true`, and the generation noted in `sealed`, for an object sealed under a key the row
   * does not hold: it cannot be searched, so it is treated as one that may hold the id. Any other fault propagates: it
   * must never be swallowed into a clean receipt.
   *
   * Which key an object is sealed under is read from where its open fails, since its footer names none. Every check
   * before the index's authentication passes for an object sealed under another key, and that authentication fails:
   * the index was not sealed under the row's key for this segment and generation, so no read through the row opens
   * it. An object whose index opens under the row's key is the segment's own, and a chunk of it that then fails its
   * checks is corruption, which throws. The row's key never changes while the row lives (a key is made only for a
   * segment's first generation, a publish never adds one to a segment that has generations, and only a crypto-shred,
   * which tombstones the row, removes it), so no generation a reader of the row can open is ever counted here.
   */
  const holds = async (generation: number): Promise<boolean | null> => {
    const key: GenKey = { ...base, generation };
    const crypto = cryptoAt(generation);
    try {
      let reader: CrbmReader;
      const index = { refused: false };
      try {
        reader = await read(() =>
          openGenerationReader(
            deps.storage,
            key,
            crypto === undefined ? undefined : noticingIndex(crypto, index),
          ),
        );
      } catch (err) {
        // A cleartext object under an encrypted segment was never one of its generations, so no read believes it.
        // It may still hold the subject in the clear, so the erasure looks in it without the key, and deletes it
        // when it holds the id, as it does any holder. Only its footer is asked first, on this path alone.
        if (crypto === undefined) {
          // The footer is asked only after a fault that is an answer: one the read retry gave up on says nothing about
          // the object, and is thrown as it is, with no more reads.
          if (!isTransientError(err) && (await read(() => objectIsEncrypted(deps.storage, key)))) {
            // Under a tombstone an encrypted object is sealed under a key that was shredded or is not held, and no
            // read through the library finds anything in it. Under a row with no pointer it is a first load's, sealed
            // under a key that load has not published yet; under a cleartext row with a pointer it is a first load's
            // that minted a key and crashed, or lost the race to a cleartext first load, since a key is made only for
            // a segment's first generation and a publish never adds one to a segment that has generations. Either
            // way it cannot be searched, so it counts as a holder.
            if (tombstoned) return false;
            sealed.add(generation);
            return true;
          }
          throw err;
        }
        if (isIntegrityError(err) && index.refused) {
          sealed.add(generation);
          return true;
        }
        if (!isIntegrityError(err) || (await read(() => objectIsEncrypted(deps.storage, key)))) {
          throw err;
        }
        reader = await read(() => openGenerationReader(deps.storage, key, undefined));
      }
      const bytes = await read(() => reader.getChunk(chunkKey));
      return bytes !== null && codec.safeDeserialize(bytes, maxBytes).has(remainder);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };

  /** Whether `holds` found the id in `generation`, as opposed to counting it a holder it could not search. */
  const found = (generation: number, held: boolean | null): boolean =>
    held === true && !sealed.has(generation);

  /**
   * `holds` over `generations`, read a few at a time, with the outcomes the serial scan would have produced: they
   * come back in the order given, ending at the first generation found to hold the id when `stopAtHolder` is set (a
   * generation read beyond it is read for nothing and dropped; one that could not be searched does not end it), and
   * the first fault in that order is the one thrown, so a fault past a holder never surfaces, as it never did.
   */
  const holdsEach = async (
    generations: readonly number[],
    stopAtHolder: boolean,
  ): Promise<{ generation: number; held: boolean | null }[]> => {
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
          const held = await holds(generation);
          if (found(generation, held) && index < firstHolder) firstHolder = index;
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
      if (stopAtHolder && found(generation, held)) break;
    }
    return outcomes;
  };

  /**
   * The receipt check, and the one place `erased: true` is decided: the newest generation still in the bucket that
   * holds the id, or `undefined` when none does. `clean` names the generations this call has already read or
   * written without the id; every other generation present is read now.
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
   * current generation, which is in `clean`: one `list`, and no read.
   */
  const holderLeft = async (clean: ReadonlySet<number>): Promise<number | undefined> => {
    const present = new Set<number>();
    for await (const key of deps.storage.list(ref)) present.add(key.generation);
    const toRead = [...present]
      .sort((a, b) => b - a)
      .filter((generation) => !clean.has(generation));
    return (await holdsEach(toRead, true)).find((outcome) => outcome.held === true)?.generation;
  };

  const cannotRemove = (generation: number): WriteConflictError =>
    new WriteConflictError(
      `erasure of segment ${ref.segment} could not remove generation ${generation}, which still holds the id and is still in the bucket; re-run`,
    );

  /**
   * Renew the row's `pointerId` before deleting a holder that a load in flight may still publish, so that load is
   * refused rather than landing on the object this call is about to delete: a holder above the pointer, or any holder
   * on a row with no pointer, where every object is a first load's.
   *
   * A load numbers its object above the pointer (above everything in the bucket, on a row with no pointer) and
   * publishes it with a compare-and-swap fenced on the row it read, which a write of the row's leases alone does not
   * refuse. Re-proving the row before each delete does not fence it: the load can publish at any time after the delete,
   * and its row would then name an object that is not there. So this call writes the row first, naming the pointer at
   * the value it has ({@link renewPointer}). That changes nothing a read resolves, and renews the row's `pointerId`,
   * which the load's fence compares: the load sees another writer and is refused. If the load published first, this
   * write loses and the row says why. A write of leases alone that lands in between is waited out and written over,
   * within the lease writers' bound.
   *
   * The licence is a renewal that lands after this call listed the bucket. A load that wrote a holder the listing found
   * read the row before it wrote, so before that renewal, and its fence refuses it. That is why the row this write is
   * made against is read here, after the listing, and why a renewal that landed after that read, this call's or a
   * concurrent erasure's, licenses the deletes alike, while one that landed before it does not: a load could have read
   * that one and written a holder since.
   *
   * A write that gets no answer is settled by reading the row, and nothing is deleted until it is. A row that is gone,
   * a tombstone, or one another writer changed gives its reason, as anywhere else in this function; a renewal that
   * landed after the row the write was made against goes on, as above. A row still as the write found it gets a fresh
   * compare-and-swap from the row just read, a request of its own carrying the same version, so at most one of the two
   * lands, after a wait on the injected clock under 500 ms, then 1 s, then 2 s (spread by the rng), at most three
   * times, as a load's publish does; then, or at once with no clock to wait on, or when the row cannot be read, the
   * registry's `TransientError` is thrown.
   */
  const fenceInFlight = async (): Promise<ReturnType<typeof rowVerdict>> => {
    const rng = deps.rng ?? deps.readRetry?.rng;
    const churn = leaseChurn({ clock: deps.clock, rng });
    let resends = 0;
    let row = await deps.registry.get(ref);
    for (;;) {
      const verdict = rowVerdict(row);
      if (verdict !== null) return verdict;
      const current = row!;
      let failure: unknown;
      try {
        const { token } = await deps.registry.compareAndSwap(
          ref,
          current.token,
          renewPointer(current),
        );
        // The row as this write left it: the same, its pointerId renewed to the token the write was given.
        premise = { ...current, token, pointerId: token };
        premiseToken = token;
        return null;
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
      if (now !== null && renewedSince(current, now)) {
        premise = now;
        premiseToken = now.token;
        return null;
      }
      if (unanswered && now !== null && now.token === current.token) {
        // Not landed, or still on its way: a fresh write from the row just read, a bounded number of times.
        const sleep = deps.clock?.sleep;
        if (sleep === undefined || resends >= UNANSWERED_RESENDS) throw failure;
        const bound = UNANSWERED_BASE_MS * 2 ** resends;
        resends += 1;
        await sleep.call(deps.clock, Math.floor((rng?.next() ?? 1) * bound));
        row = now;
        continue;
      }
      // A write of leases alone is waited out, as every lease-aware writer waits it out; any other write is read for
      // what it says, and one that leaves the premise standing past the wait's bound is reported as a race.
      const settled = await churn.settle(current, now, () => deps.registry.get(ref));
      if (settled === undefined) return rowVerdict(now) ?? 'superseded';
      row = settled.row;
    }
  };

  /**
   * Delete `holders`, newest first, each after reading the row and finding it still the one {@link fenceInFlight}
   * renewed (or that row with only its leases changed), and stop at the first that is not. Returns what was deleted, and
   * the row's reason when the deletes stopped.
   *
   * One round trip remains between that read and its delete: a rollback that lands inside it onto the holder being
   * deleted leaves the pointer naming a missing object. Above the pointer that is one with `allowForward`; below it, an
   * object sealed under a key the row does not hold, which only a rollback with no key at hand moves onto, since one
   * with the key refuses an object it cannot open. The rollback's own move-then-verify catches every such landing
   * except one whose check runs before the delete, and no storage port offers a conditional delete to close it.
   */
  const deleteFenced = async (
    holders: readonly number[],
  ): Promise<{ deleted: number[]; moved: ReturnType<typeof rowVerdict> }> => {
    const deleted: number[] = [];
    let moved = await fenceInFlight();
    for (const generation of holders) {
      if (moved !== null) break;
      moved = rowVerdict(await deps.registry.get(ref));
      if (moved !== null) break;
      await deps.storage.delete({ ...base, generation });
      deleted.push(generation);
    }
    return { deleted, moved };
  };

  /**
   * The answer for an erasure that deleted the generations holding the id and rewrote none, once a listing found no
   * holder left. The pass notes the row it read, the active one or the tombstone, for the `segment.collect` event the
   * call emits once it has its whole report.
   */
  const collectedAll = (fromGeneration: number, collected: readonly number[]): EraseIdResult => {
    seen.collectedOn = record.token;
    seen.found = true;
    return {
      ...base,
      erased: true,
      fromGeneration,
      collected: [...collected].sort((a, b) => a - b),
    };
  };

  /**
   * The answer for an erasure that found no generation holding the id and deleted only objects it could not search,
   * once a listing found none of those left: `answer`, with what it deleted. When it deleted any, the pass notes the
   * row it read, so the call emits `segment.collect` for them, naming no generation the id was found in.
   */
  const sealedOnly = (answer: EraseIdResult, collected: readonly number[]): EraseIdResult => {
    if (collected.length > 0) seen.collectedOn = record.token;
    return { ...answer, collected: [...collected].sort((a, b) => a - b) };
  };

  /**
   * The row names no generation, so nothing has been published, but a first load's object can be in the bucket: its
   * load still running, or one that wrote and never published (a crash, or a registry write that got no answer, after
   * which the object is kept by design). Each object is searched, and each one that holds the id is a holder. So is each
   * one sealed under a key no row holds yet, a first load's of an encrypted segment: this call holds no key for it, so it
   * cannot search it, and, whatever id it is asked to erase, it treats it as one that may hold it.
   *
   * With no holder it writes nothing, and a first load in flight publishes as it would have. With one, it renews the
   * row's `pointerId` ({@link fenceInFlight}) before it deletes any, so the load that wrote it, fenced on the row it read
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
  const unpublished = async (): Promise<EraseIdResult> => {
    const generations: number[] = [];
    for await (const key of deps.storage.list(ref)) generations.push(key.generation);
    const newestFirst = generations.sort((a, b) => b - a);
    const holders: number[] = []; // newest first
    const clean = new Set<number>();
    for (const { generation, held } of await holdsEach(newestFirst, false)) {
      if (held === true) holders.push(generation);
      else if (held === false) clean.add(generation);
    }
    const none: EraseIdResult = { ...base, erased: false, reason: 'no-generation', collected: [] };
    if (holders.length === 0) return none;
    // The newest object that was searched and held the id; a sealed one could not be searched.
    const newest = holders.find((generation) => !sealed.has(generation));

    const { deleted, moved } = await deleteFenced(holders);
    const collected = [...deleted].sort((a, b) => a - b);
    const left = await holderLeft(clean);
    if (left === undefined) {
      return newest === undefined ? sealedOnly(none, collected) : collectedAll(newest, collected);
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
    throw cannotRemove(left);
  };

  /**
   * The row is a tombstone, so no generation is the segment's any more and every object left is garbage (invariant 4's
   * one exception). A crypto-shred leaves objects no key opens, but a cleartext destroy, a drop whose sweep left
   * something, or a write that landed after it leaves objects anyone can read. Each is searched; when one holds the id,
   * the collection's tombstone pass deletes them all, re-proving the row's token before each delete, and what is left
   * is read again. One listing for a tombstone with nothing left.
   */
  const underTombstone = async (): Promise<EraseIdResult> => {
    const generations: number[] = [];
    for await (const key of deps.storage.list(ref)) generations.push(key.generation);
    const newestFirst = generations.sort((a, b) => b - a);
    const holder = (await holdsEach(newestFirst, true)).find((h) => h.held === true);
    if (holder === undefined) return { ...base, erased: false, reason: 'destroyed', collected: [] };
    const collected = await gcOrphanGenerations(ref, deps, { keep: 0 });
    const left = await holderLeft(new Set());
    if (left !== undefined) throw cannotRemove(left);
    return collectedAll(holder.generation, collected);
  };

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
   * from, which `rollbackSegment` with `allowForward` makes current again, so a holder there is one ordinary
   * operator action from being served. There can be several: every generation loaded after the one the pointer
   * was rolled back to.
   *
   * So look, at all of them. A holder cannot be rewritten — a rewrite of a non-current generation would regress
   * the pointer — so the only remedy is to delete it:
   *
   *  - **Below the pointer**, `gcOrphanGenerations` with `keep: 0` takes every generation at once, re-proving the
   *    row before each delete. It costs the segment its grace window and its older rollback targets, which is
   *    proportionate: only a segment that genuinely held the subject pays it.
   *  - **Above the pointer**, collection never looks, so each holder is deleted here, and only the holders: a
   *    generation up there without the id is still an operator's rollback target and stays. This is the one place
   *    the library deletes an above-pointer object that it did not write, and it costs `rollbackSegment` a
   *    target, deliberately: a rollback point that still contains data we were required to erase is not a
   *    rollback point, and keeping it would make the erasure undoable by an ordinary operator action. Each delete
   *    is re-proved against the row first, as collection's are, because the danger is the same one: a rollback
   *    that lands on a generation this call has queued, which would leave the pointer naming a missing object.
   *    If the pointer has moved at all, the deletes stop. One round trip remains between that read and the delete,
   *    exactly as in collection's own loop, and on a row with no pointer too ({@link deleteFenced}).
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
  const notInCurrent = async (): Promise<EraseIdResult> => {
    const notMember: EraseIdResult = {
      ...base,
      erased: false,
      reason: 'not-member',
      fromGeneration: from,
      collected: [],
    };
    const others = new Set<number>();
    for await (const key of deps.storage.list(ref)) {
      if (key.generation !== from) others.add(key.generation);
    }
    if (others.size === 0) return notMember;
    const newestFirst = [...others].sort((a, b) => b - a);

    const clean = new Set<number>([from]);
    const holdersAbove: number[] = []; // newest first, those that could not be searched included
    for (const { generation, held } of await holdsEach(
      newestFirst.filter((g) => g > from),
      false,
    )) {
      if (held === true) holdersAbove.push(generation);
      else if (held === false) clean.add(generation);
    }
    const foundAbove = holdersAbove.find((generation) => !sealed.has(generation));
    let holderBelow: number | undefined;
    const sealedBelow: number[] = [];
    if (foundAbove === undefined) {
      for (const { generation, held } of await holdsEach(
        newestFirst.filter((g) => g < from),
        true,
      )) {
        if (found(generation, held)) holderBelow = generation;
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

    const collected =
      newest === undefined ? [] : [...(await gcOrphanGenerations(ref, deps, { keep: 0 }))];
    let moved: ReturnType<typeof rowVerdict> = null;
    if (fenced.length > 0) {
      const deleted = await deleteFenced(fenced);
      collected.push(...deleted.deleted);
      moved = deleted.moved;
    }

    const left = await holderLeft(clean);
    if (left === undefined) {
      if (newest !== undefined) return collectedAll(newest, collected);
      return sealedOnly(notMember, collected);
    }
    if (moved !== null) {
      return { ...base, erased: false, reason: moved, fromGeneration: newest ?? from, collected };
    }
    throw cannotRemove(left);
  };

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
   * re-run fixes it. A pointer that moved is `'superseded'`. The
   * other two states are not supersessions and are not reported as one: the row **gone** (the retention sweep
   * purged a tombstone while we worked) is `'absent'`, and a row whose `currentGen` is `null` is
   * `'no-generation'` — the same answers this function gives when it reads either state up front, so a caller
   * branching on `reason` never has to special-case where in the call it was discovered.
   *
   * `generation` is set only once the object is **durable**. Reporting it from `nextGeneration` was wrong in a
   * way worth naming: if the row is gone by then, `nextGeneration` finds no row and no objects and restarts at
   * `0`, so the ledger read `fromGeneration: 0 → generation: 0` — the generation that *held* the bit named as
   * the one written *without* it, for an object that was never written.
   */
  const stage = async (): Promise<
    | EraseIdResult
    | { generation: number; key: GenKey; fingerprint: string; summary: RegistrySummary }
  > => {
    /** Set only once the object exists in the bucket — see the note above. */
    let written: number | undefined;
    // The row's summary of `from`, when it has one this call can use: the rewrite reads only the object it names, as a
    // live read does, so an object put under the number from outside the library is never published as the rewrite.
    const described = usableSummary(ref, record, aead);
    try {
      const reader = await read(() =>
        openGenerationReader(deps.storage, fromKey, cryptoAt(from), {}, described?.fingerprint),
      );
      const bytes = await read(() => reader.getChunk(chunkKey));
      // `return await`, not `return`: the sweep's rejection must land in the `catch` below, which is where a
      // `NotFoundError` is translated by re-reading the row. A bare `return` of the promise hands it past the `try`.
      if (bytes === null) return await notInCurrent();
      const target = codec.safeDeserialize(bytes, maxBytes);
      assertRemaindersInRange(target, chunkKey); // invariant 5, on the chunk we are about to re-encode
      if (!target.has(remainder)) return await notInCurrent();
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
      const tally = await writeCrbmGenerationStream(
        deps.storage,
        key,
        rewrite(reader, chunkKey, target, codec, maxBytes, read),
        { crypto: cryptoAt(generation), clock: deps.clock, metadata },
      );
      written = generation; // `putImmutable` commits atomically, so the object exists exactly now
      // Re-check the pointer before spending the verification read. The fence below is what makes the publish
      // correct; this only saves a round trip on the common race, which the catch reports either way.
      const beforeVerify = await deps.registry.get(ref);
      const early = rowVerdict(beforeVerify);
      if (early !== null) return refused(early, written);
      await read(() =>
        verifyGeneration(deps.storage, key, { ...tally, metadata }, cryptoAt(generation)),
      );
      // The row's summary is built from what was written, never copied from the row it replaces: whatever that one
      // held, a cached count or metadata that disagreed with the object it described goes with it.
      const summary = summaryOf(
        ref,
        generation,
        { cardinality: tally.cardinality, metadata, fingerprint: tally.fingerprint },
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
      const verdict = rowVerdict(now);
      if (verdict !== null) return refused(verdict, written);
      // The pointer still names the object, and it is missing or is another object than the row's summary names:
      // neither is a race, and nothing was published from it.
      throw err;
    }
  };

  /**
   * Delete the object a refused rewrite wrote, when it would otherwise outlive the winner above its pointer.
   *
   * Only one position needs it: the pointer moved forward past `from` and stopped **below** `written`. Two winners
   * leave it there: one whose object was already in the bucket when this call took its number (`nextGeneration`
   * numbers above everything present), and a load that numbered after it from its own row, which takes
   * `currentGen + 1` whenever no object holds that number, below this call's object. Either way the object is
   * above the winner's pointer, where no collection ever looks. The
   * object was derived from `from`, so when the winner was another erasure it still holds the id that erasure
   * has just reported gone, one `rollback({ allowForward: true })` from being served, and the newest superseded
   * generation once a later load raises the pointer past it, which is exactly what that load's `keep` retains.
   *
   * Under a tombstone it is deleted too, as a refused load deletes its own: every generation under one is garbage
   * (invariant 4's one exception), and a drop that landed while this rewrite streamed usually finished its sweep
   * before the object committed, so nothing else would take it. It is a copy of the dropped segment less one id.
   *
   * Everywhere else the object is left alone, as a refused load leaves its own once the row has changed. At or
   * above `written` the pointer either names it or belongs to a writer that numbered after it and whose
   * collection takes it; at or below `from` nothing replaced `from`; and a row that is gone or without a pointer
   * is not one this call can reason about. The position is read from a fresh row, just before the delete, and the
   * number still names this call's own object: a name re-created since would have had to lose this object and
   * then write that many generations of its own, and only its pointer landing on `written` could make the delete
   * unsafe, which the bound excludes.
   *
   * Returns the row it read, so a refused publish reports what that row says.
   */
  const discardRefused = async (written: number): Promise<RegistryRecord | null> => {
    const row = await deps.registry.get(ref);
    if (row !== null && row.status === 'destroyed') {
      await deps.storage.delete({ ...base, generation: written });
      return row;
    }
    if (row === null || row.status !== 'active' || row.currentGen === null) return row;
    if (row.currentGen <= from || row.currentGen >= written) return row;
    await deps.storage.delete({ ...base, generation: written });
    return row;
  };

  if (tombstoned) return await underTombstone();
  if (pointerless) return await unpublished();
  const staged = await stage();
  if ('erased' in staged) {
    if (!staged.erased && staged.generation !== undefined) await discardRefused(staged.generation);
    return staged;
  }
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
    summary,
    // The row then records that no generation below the new pointer is kept, as the collection below leaves it.
    keep: 0,
    // Every generation below the new pointer is deleted whatever a lease says, so the row drops its leases.
    clearLeases: true,
    // A write that ends without an answer is settled by reading the row, and a pointer at this number is this
    // rewrite's only over the object it wrote: the footer proves it, so another incarnation's cannot pass for it.
    holdsOwnObject: () => provesOwnObject(deps.storage, key, fingerprint),
    clock: deps.clock,
    rng: deps.rng ?? deps.readRetry?.rng,
  });
  if (!published) {
    // The publish refuses on the row's token before it looks at the row's status, so the row read here says why:
    // a concurrent `dropSegment` is `'destroyed'`, not a race a re-run would win.
    const now = await discardRefused(generation);
    return {
      ...base,
      erased: false,
      reason: rowVerdict(now) ?? 'superseded',
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
  // assuming.
  const collected = await gcOrphanGenerations(ref, deps, { keep: 0 });
  const left = await holderLeft(new Set([generation]));
  if (left !== undefined) throw cannotRemove(left);
  return { ...base, erased: true, fromGeneration: from, generation, collected };
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
 * Whether `now` is `held` with its `pointerId` renewed and nothing else changed but its leases: a write that names a
 * field a read resolves through at the value it had, as an erasure's fence does, landed after `held` was read.
 * The same incarnation is required ({@link onlyLeasesDiffer} checks it), so a row purged and made again is never taken
 * for one.
 */
function renewedSince(held: RegistryRecord, now: RegistryRecord): boolean {
  return now.pointerId !== held.pointerId && onlyLeasesDiffer(held, now, ['pointerId']);
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
  const keys = [...reader.chunkKeys()].sort((a, b) => a - b);
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
