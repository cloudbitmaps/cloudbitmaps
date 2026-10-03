/**
 * Subject erasure on a loaded segment (GDPR Art. 17): remove **one id** from a segment by rewriting its current
 * generation without that id.
 *
 * There is no per-id delete on an immutable object, and there is no mutable tier to hold a tombstone, so erasure
 * is what every other write in this library is: a new generation. The current generation is streamed chunk by
 * chunk through the ascending writer — every chunk decoded, range-checked and re-encoded, the one holding the id
 * with that bit cleared — then published fenced on the generation it streamed, and that generation is collected immediately
 * (`keep: 0`), so the bit is **physically gone from the bucket when this returns**. Constant memory: one chunk in
 * flight, never the whole segment.
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
 * `missing-storage-generation` state — and that throws, because no re-run fixes it. That `NotFoundError` is the only
 * signal of that state, so a faulting re-read rethrows it rather than replacing it with a transient-looking
 * registry error.
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
 * A load already in flight is the same case: it writes its object above the pointer before it publishes, and an
 * erasure that finds the id in that object deletes it as it does any holder there, so a load that then publishes
 * leaves the pointer naming a missing object.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { MAX_REMAINDER, splitId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';
import type { Yielder } from './cooperative';
import {
  openGenerationReader,
  provesOwnObject,
  publishGeneration,
  verifyGeneration,
  writeCrbmGenerationStream,
} from './crbm-storage-source';
import type { CrbmReader } from './crbm/reader';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  ValidationError,
  WriteConflictError,
  isNotFoundError,
} from './errors';
import { gcOrphanGenerations, nextGeneration } from './generation-gc';
import { assertRegistryCanWrite } from './ports';
import type { GenKey, IStorageDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';
import { type ReadRetry, retryRead } from './retry';
import { validateUserRef } from './validate';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20;

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
  /** Supplying a clock that can yield makes the rewrite cooperative, as it makes a load. */
  readonly clock?: Yielder;
  /** Per-chunk decode ceiling (invariant 5); defaults to 1 MiB. */
  readonly maxBitmapBytes?: number;
  /**
   * The store's read retry, for the reads the rewrite makes along the way: the generation it rewrites and each of its
   * chunks, the read-back that verifies the generation it wrote, and any other generation it checks for the id. A
   * transient fault on one is run again under it rather than failing the erasure. Absent, each read is made once.
   * The writes and deletes are never retried.
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
   * tombstone — already unreadable), `'no-generation'` (a row with no Storage data yet), `'not-member'` (no
   * generation in the bucket holds the id — the common case across a fleet scan), or `'superseded'`.
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
   * only when it is read up front — a concurrent `dropSegment` gives `'destroyed'`, a retention sweep that purges
   * the row gives `'absent'`. A caller branching on `reason` never has to care which it was.
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
   * because they are an operator's rollback targets. Empty when nothing was deleted.
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
   * — one an operator rolled the pointer onto while a rewrite was collecting, say.
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
 * compliance record exists the moment the generation without the id is authoritative.
 */
export async function eraseIdFromSegment(
  ref: SegmentRef,
  id: number,
  deps: EraseIdDeps,
  options: { audit?: IAuditSink } = {},
): Promise<EraseIdResult> {
  validateUserRef(ref);
  const { chunkKey, remainder } = splitId(id); // validates the u32 range
  const codec = requireCodec(deps.codec, 'eraseIdFromSegment');
  const maxBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
  const base = { segment: ref.segment, namespace: ref.namespace };
  /** A read this call makes, under the store's read retry when it was given one. */
  const read = <T>(op: () => Promise<T>): Promise<T> => retryRead(op, deps.readRetry);

  const record = await deps.registry.get(ref);
  if (record === null) return { ...base, erased: false, reason: 'absent', collected: [] };
  if (record.status === 'destroyed')
    return { ...base, erased: false, reason: 'destroyed', collected: [] };
  if (record.currentGen === null)
    return { ...base, erased: false, reason: 'no-generation', collected: [] };
  const from = record.currentGen;
  /**
   * The row this rewrite derives its content from, not just the number it points at. `nextGeneration` restarts
   * at `0` once a row is purged and the bucket emptied, so a retired-and-re-created name presents a *different*
   * segment at the *same* `currentGen` — which `expectFrom` alone matched, republishing one incarnation's
   * content over another's and reporting `erased: true`. The token is never reused across incarnations.
   */
  const fromToken = record.token;

  // The segment's DEK, reused across generations. Resolved before any object I/O so a slow keystore/KMS call
  // sits outside the read-write window; an encrypted row with no keystore is a lost key, not a cleartext segment.
  let aead: Aead | undefined;
  if (record.wrappedDeks !== undefined && record.wrappedDeks.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but eraseIdFromSegment has no keystore`,
      );
    }
    aead = await deps.keystore.openDek(record.wrappedDeks);
  } else if (deps.requireEncryption === true) {
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
   * (the pointer is exactly `from`, so nothing raced us), otherwise the reason to report.
   *
   * Each state gets the answer this function already gives when it reads that state *up front*, so a caller
   * branching on `reason` never has to care at which point in the call it was discovered: a tombstoned row is
   * `'destroyed'` (a concurrent `dropSegment` leaves `currentGen` where it was, so testing the pointer alone
   * would miss it and report an error for a segment the operator deliberately dropped), a vanished row is
   * `'absent'` (the retention sweep purged a tombstone while we worked), a row with no pointer is
   * `'no-generation'`, and a pointer that moved is `'superseded'`.
   */
  const rowVerdict = (
    row: RegistryRecord | null,
  ): 'superseded' | 'absent' | 'no-generation' | 'destroyed' | null => {
    if (row === null) return 'absent';
    if (row.status === 'destroyed') return 'destroyed';
    if (row.currentGen === null) return 'no-generation';
    // A different row is a different lineage even at the same pointer value — see `fromToken`.
    return row.currentGen === from && row.token === fromToken ? null : 'superseded';
  };

  /**
   * Whether `generation` still holds the id: its index is opened, and the id's chunk is fetched only if the index
   * lists it. `null` when the object is gone — a concurrent collector took it, which is not a failure of this call
   * but the outcome it wants. Any other fault propagates: it must never be swallowed into a clean receipt.
   */
  const holds = async (generation: number): Promise<boolean | null> => {
    try {
      const bytes = await read(async () => {
        const reader = await openGenerationReader(
          deps.storage,
          { ...base, generation },
          cryptoAt(generation),
        );
        return reader.getChunk(chunkKey);
      });
      return bytes !== null && codec.safeDeserialize(bytes, maxBytes).has(remainder);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
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
    for (const generation of [...present].sort((a, b) => b - a)) {
      if (!clean.has(generation) && (await holds(generation)) === true) return generation;
    }
    return undefined;
  };

  const cannotRemove = (generation: number): WriteConflictError =>
    new WriteConflictError(
      `erasure of segment ${ref.segment} could not remove generation ${generation}, which still holds the id and is still in the bucket; re-run`,
    );

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
   *    exactly as in collection's own loop: a rollback that lands inside it onto the generation being deleted
   *    leaves the pointer naming a missing object. The rollback's own move-then-verify catches every such landing
   *    except one whose check runs before the delete, and no storage port offers a conditional delete to close it.
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
   * it only until the first holder, since `keep: 0` takes the rest regardless — and not at all once a holder was
   * found above. `eraseSubject` fans this out across every registered segment, so the filter is what keeps a
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
    const holdersAbove: number[] = []; // newest first
    for (const generation of newestFirst.filter((g) => g > from)) {
      const held = await holds(generation);
      if (held === true) holdersAbove.push(generation);
      else if (held === false) clean.add(generation);
    }
    let holderBelow: number | undefined;
    if (holdersAbove.length === 0) {
      for (const generation of newestFirst.filter((g) => g < from)) {
        const held = await holds(generation);
        if (held === true) {
          holderBelow = generation;
          break;
        }
        if (held === false) clean.add(generation);
      }
    }
    const newest = holdersAbove[0] ?? holderBelow;
    if (newest === undefined) return notMember;

    const collected = [...(await gcOrphanGenerations(ref, deps, { keep: 0 }))];
    let moved: ReturnType<typeof rowVerdict> = null;
    for (const generation of holdersAbove) {
      moved = rowVerdict(await deps.registry.get(ref));
      if (moved !== null) break;
      await deps.storage.delete({ ...base, generation });
      collected.push(generation);
    }

    const left = await holderLeft(clean);
    if (left === undefined) return { ...base, erased: true, fromGeneration: newest, collected };
    if (moved !== null) {
      return { ...base, erased: false, reason: moved, fromGeneration: newest, collected };
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
   * `missing-storage-generation` state a failed publish leaves behind — and that **throws**, because it is an
   * integrity problem rather than a race and no re-run fixes it. A pointer that moved is `'superseded'`. The
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
    EraseIdResult | { generation: number; key: GenKey; fingerprint: string }
  > => {
    /** Set only once the object exists in the bucket — see the note above. */
    let written: number | undefined;
    try {
      const reader = await read(() => openGenerationReader(deps.storage, fromKey, cryptoAt(from)));
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
      const tally = await writeCrbmGenerationStream(
        deps.storage,
        key,
        rewrite(reader, chunkKey, target, codec, maxBytes, read),
        { crypto: cryptoAt(generation), clock: deps.clock },
      );
      written = generation; // `putImmutable` commits atomically, so the object exists exactly now
      // Re-check the pointer before spending the verification read. The fence below is what makes the publish
      // correct; this only saves a round trip on the common race, which the catch reports either way.
      const beforeVerify = await deps.registry.get(ref);
      const early = rowVerdict(beforeVerify);
      if (early !== null) return refused(early, written);
      await read(() => verifyGeneration(deps.storage, key, tally, cryptoAt(generation)));
      return { generation, key, fingerprint: tally.fingerprint };
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
      throw err; // the pointer still names the missing object: genuinely absent, not a race
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
   * Everywhere else the object is left alone, as a refused load leaves its own once the row has changed. At or
   * above `written` the pointer either names it or belongs to a writer that numbered after it and whose
   * collection takes it; at or below `from` nothing replaced `from`; and a row that is gone, tombstoned or
   * without a pointer is not one this call can reason about. The position is read from a fresh row, just before
   * the delete, and the number still names this call's own object: a name re-created since would have had to
   * lose this object and then write that many generations of its own, and only its pointer landing on `written`
   * could make the delete unsafe, which the bound excludes.
   */
  const discardRefused = async (written: number): Promise<void> => {
    const row = await deps.registry.get(ref);
    if (row === null || row.status !== 'active' || row.currentGen === null) return;
    if (row.currentGen <= from || row.currentGen >= written) return;
    await deps.storage.delete({ ...base, generation: written });
  };

  const staged = await stage();
  if ('erased' in staged) {
    if (!staged.erased && staged.generation !== undefined) await discardRefused(staged.generation);
    return staged;
  }
  const { generation, key, fingerprint } = staged;

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
    // A write that ends without an answer is settled by reading the row, and a pointer at this number is this
    // rewrite's only over the object it wrote: the footer proves it, so another incarnation's cannot pass for it.
    holdsOwnObject: () => provesOwnObject(deps.storage, key, fingerprint),
    clock: deps.clock,
    rng: deps.readRetry?.rng,
  });
  if (!published) {
    await discardRefused(generation);
    return {
      ...base,
      erased: false,
      reason: 'superseded',
      fromGeneration: from,
      generation,
      collected: [],
    };
  }
  safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
    kind: 'segment.rewrite',
    namespace: ref.namespace,
    segment: ref.segment,
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
 * The new generation's chunks, ascending: every chunk of the old generation decoded and passed through, except
 * `chunkKey`, which is replaced by `replacement` (already missing the id). Decoding rather than copying bytes is
 * deliberate — it puts every chunk through the **safe** deserializer and the size cap on the one path that
 * rewrites a whole segment, so a chunk that is not decodable, or is larger than the cap, stops the rewrite
 * instead of being copied forward — and the writer skips a chunk the removal emptied. One chunk is live at a
 * time.
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
  for (const k of keys) {
    if (k === chunkKey) {
      yield { chunkKey: k, bitmap: replacement };
      continue;
    }
    const bytes = await read(() => reader.getChunk(k));
    if (bytes === null) continue; // listed but absent: nothing to carry forward
    const bitmap = codec.safeDeserialize(bytes, maxBytes);
    assertRemaindersInRange(bitmap, k);
    yield { chunkKey: k, bitmap };
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
