/**
 * Subject erasure on a loaded segment (GDPR Art. 17): remove **one id** from a segment by rewriting its current
 * generation without that id.
 *
 * There is no per-id delete on an immutable object, and there is no mutable tier to hold a tombstone, so erasure
 * is what every other write in this library is: a new generation. The current generation is streamed chunk by
 * chunk through the ascending writer — every chunk copied through, the one chunk holding the id re-encoded with
 * that bit cleared — then published fenced on the generation it streamed, and that generation is collected immediately
 * (`keep: 0`), so the bit is **physically gone from the bucket when this returns**. Constant memory: one chunk in
 * flight, never the whole segment.
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
 * `missing-cold-generation` state — and that throws, because no re-run fixes it. That `NotFoundError` is the only
 * signal of that state, so a faulting re-read rethrows it rather than replacing it with a transient-looking
 * registry error.
 *
 * **No orphan is left behind by a refused rewrite**, and it is worth saying why, because nothing else collects
 * above the pointer: `putImmutable` commits atomically, so a rewrite whose stream throws leaves no object at all;
 * and if the write did complete, the winner's generation is necessarily higher, which puts ours below its pointer
 * where its `keep: 0` takes it. The two orderings are mutually exclusive.
 *
 * Without that fence the failure was silent and severe, and both halves were reproduced: `nextGeneration` picks a
 * number above everything in the bucket, so a forward-only publish here always won — discarding a concurrent
 * load's whole set, and letting two concurrent erasures each return `erased: true` while the second one's
 * generation put the first one's id back and collected the generation that had evidenced its removal. A false
 * Art. 17 receipt is the worst output this module can produce.
 *
 * Readers pinned to the collected generation re-resolve on their next read; that is the documented cost of
 * physical deletion on return. **Do not re-load the id while erasing it**: a load that lands after this rewrite
 * carries whatever its source held, and the library cannot know that source was meant to exclude the id.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { MAX_REMAINDER, splitId } from './bit-route';
import type { CodecBitmap, CodecInterface } from './codec';
import { requireCodec } from './codec';
import type { Yielder } from './cooperative';
import {
  openGenerationReader,
  publishGeneration,
  verifyGeneration,
  writeCrbmGenerationStream,
} from './crbm-cold-source';
import type { CrbmReader } from './crbm/reader';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import { IntegrityError, KeyUnavailableError, ValidationError, isNotFoundError } from './errors';
import { gcOrphanGenerations, nextGeneration } from './generation-gc';
import type { GenKey, IColdDriver, IRegistryDriver, RegistryRecord, SegmentRef } from './ports';
import { validateSegmentRef } from './validate';

const DEFAULT_MAX_BITMAP_BYTES = 1 << 20;

/** What {@link eraseIdFromSegment} needs: the objects, the pointer, the codec, and the key material if encrypted. */
export interface EraseIdDeps {
  readonly cold: IColdDriver;
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
  /** When true, refuse to rewrite a **cleartext** segment (the same guard the read path and bulk-load offer). */
  readonly requireEncryption?: boolean;
  /** Supplying a clock that can yield makes the rewrite cooperative — see `bulkLoadCrbmGeneration`. */
  readonly clock?: Yielder;
  /** Per-chunk decode ceiling (invariant 5); defaults to 1 MiB. */
  readonly maxBitmapBytes?: number;
}

export interface EraseIdResult {
  readonly segment: string;
  readonly namespace?: string;
  /**
   * True iff the id **was** a member and a generation without it is now the segment's current generation — and
   * the generation that held it has been deleted (see `collected`). This is the field an erasure ledger records.
   */
  readonly erased: boolean;
  /**
   * Why nothing was rewritten, when `erased` is false. `'absent'` (no registry row), `'destroyed'` (a crypto-shred
   * tombstone — already unreadable), `'no-generation'` (a row with no Cold data yet), `'not-member'` (the id is not
   * in the current generation — the common case across a fleet scan), or `'superseded'`.
   *
   * **`'superseded'` means this call did not erase the id, not that the id is still there.** Another writer — a
   * load, or another erasure — moved the pointer off the generation this rewrite was derived from, so the
   * rewrite is not a valid successor to what is now current. Re-run against the new generation: if the id is
   * still present it is erased then; if the racing writer was another erasure of the *same* id, the re-run
   * reports `'not-member'` because it is already gone. Either way the re-run settles it, which is why it is the
   * documented action for this reason and for no other.
   *
   * The first four reasons are also returned when the row changes *underneath* a rewrite already in flight,
   * not only when it is read up front — a concurrent `dropSegment` gives `'destroyed'`, a retention sweep that
   * purges the row gives `'absent'`. A caller branching on `reason` never has to care which it was.
   */
  readonly reason?: 'absent' | 'destroyed' | 'no-generation' | 'not-member' | 'superseded';
  /** The generation the id was found in (present whenever it was read). */
  readonly fromGeneration?: number;
  /** The generation written without the id (present whenever one was written, even if `superseded`). */
  readonly generation?: number;
  /**
   * Generations deleted after the publish — normally `[fromGeneration]`, plus any older orphans. Empty when nothing
   * was rewritten. A rewrite that published but could not collect (a Cold `delete` fault) throws instead of
   * reporting `erased: true` over bytes that are still there: the pointer has moved, so a re-run reads
   * `'not-member'` and the residual is left to `gcOrphanGenerations`/the retention sweep — which is why the throw
   * matters: it is the one signal that the physical half did not complete.
   */
  readonly collected: readonly number[];
}

/**
 * Remove `id` from `ref` by rewriting its current generation without it. See the module note for the contract.
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
  validateSegmentRef(ref);
  const { chunkKey, remainder } = splitId(id); // validates the u32 range
  const codec = requireCodec(deps.codec, 'eraseIdFromSegment');
  const maxBytes = deps.maxBitmapBytes ?? DEFAULT_MAX_BITMAP_BYTES;
  const base = { segment: ref.segment, namespace: ref.namespace };

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
   * `missing-cold-generation` state a failed publish leaves behind — and that **throws**, because it is an
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
  /**
   * The id is not in the current generation — which is **not** the same as not being in the bucket.
   *
   * A re-seed that simply stops including someone leaves their bit in the generation it dropped them from, and
   * the documented post-load call (`gcOrphanGenerations` with its default `keep: 1`) *retains* exactly that
   * generation as the reader grace window. So the ordinary lifecycle of a rotating audience leaves an
   * ex-member's bit sitting in a retained object — and the rewrite never looked there, returned `'not-member'`,
   * and `eraseSubject` filtered the segment out of the ledger entirely. A clean Art. 17 receipt over bytes
   * still in the bucket, for the one population most likely to be asking: people who already left.
   *
   * So look. If a superseded generation holds the bit, the only remedy is to delete those generations —
   * they cannot be rewritten, because a rewrite of a non-current generation would regress the pointer — and
   * that is exactly what `keep: 0` does. Deleting them is safe for the same reason it is safe on the rewrite
   * path: everything below `currentGen` is permanently unreachable, so no reader can be denied an answer it
   * could otherwise have had. It costs the segment its grace window, which is proportionate: only a segment
   * that genuinely held the subject pays it.
   *
   * **The cost is paid only where it is owed.** The cheap filter comes first: one `list`, and if the segment
   * has no superseded generations at all — true of any store that collects with `keep: 0`, and of a segment
   * loaded once — nothing else is read. Then per superseded generation, the index is opened and the chunk is
   * fetched only if the index says that chunk exists. `eraseSubject` fans this out across every registered
   * segment, so the filter is what keeps a fleet-wide subject scan from doubling its reads on segments that
   * never held the id.
   */
  const notInCurrent = async (): Promise<EraseIdResult> => {
    const superseded: number[] = [];
    for await (const key of deps.cold.list(ref)) {
      if (key.generation < from) superseded.push(key.generation);
    }
    if (superseded.length === 0) {
      return { ...base, erased: false, reason: 'not-member', fromGeneration: from, collected: [] };
    }
    superseded.sort((a, b) => b - a); // newest first: the likeliest holder of a just-dropped id
    for (const generation of superseded) {
      let held = false;
      try {
        const reader = await openGenerationReader(
          deps.cold,
          { ...base, generation },
          cryptoAt(generation),
        );
        const bytes = await reader.getChunk(chunkKey);
        if (bytes !== null) held = codec.safeDeserialize(bytes, maxBytes).has(remainder);
      } catch (err) {
        // A superseded generation swept by a concurrent collector is not a failure of this call — it is the
        // outcome this call wanted. Anything else is a real fault and must not be swallowed into a clean
        // receipt.
        if (!isNotFoundError(err)) throw err;
        continue;
      }
      if (!held) continue;
      // Found. Take every generation below the pointer; the current one keeps the id out by not having it.
      const collected = await gcOrphanGenerations(ref, deps, { keep: 0 });
      return { ...base, erased: true, fromGeneration: generation, collected };
    }
    return { ...base, erased: false, reason: 'not-member', fromGeneration: from, collected: [] };
  };

  const stage = async (): Promise<EraseIdResult | { generation: number; key: GenKey }> => {
    /** Set only once the object exists in the bucket — see the note above. */
    let written: number | undefined;
    try {
      const reader = await openGenerationReader(deps.cold, fromKey, cryptoAt(from));
      const bytes = await reader.getChunk(chunkKey);
      if (bytes === null) return notInCurrent();
      const target = codec.safeDeserialize(bytes, maxBytes);
      assertRemaindersInRange(target, chunkKey); // invariant 5, on the chunk we are about to re-encode
      if (!target.has(remainder)) return notInCurrent();
      target.remove(remainder);

      const generation = await nextGeneration(ref, deps);
      const key: GenKey = { ...base, generation };
      const tally = await writeCrbmGenerationStream(
        deps.cold,
        key,
        rewrite(reader, chunkKey, target, codec, maxBytes),
        { crypto: cryptoAt(generation), clock: deps.clock },
      );
      written = generation; // `putImmutable` commits atomically, so the object exists exactly now
      // Re-check the pointer before spending the verification read. The fence below is what makes the publish
      // correct; this only saves a round trip on the common race, which the catch reports either way.
      const beforeVerify = await deps.registry.get(ref);
      const early = rowVerdict(beforeVerify);
      if (early !== null) return refused(early, written);
      await verifyGeneration(deps.cold, key, tally, cryptoAt(generation));
      return { generation, key };
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

  const staged = await stage();
  if ('erased' in staged) return staged;
  const { generation, key } = staged;

  // Read-modify-write, not merely forward-only, and the distinction is the whole correctness of this function.
  //
  // The new generation's content is `from` minus one bit, so it is only a valid successor to `from`. Publishing
  // it forward-only would land it over ANY newer generation, because `nextGeneration` deliberately picks a number
  // above everything in the bucket — including an object a concurrent writer just published. Two ways that went
  // wrong, both reproduced: a load that published between our read and our publish had its whole set discarded
  // and its object collected; and two concurrent erasures each returned `erased: true` with a `segment.rewrite`
  // event while the second one's generation put the FIRST one's id back, deleting the generation that had
  // evidenced its removal. A false Art. 17 receipt is the worst output this module can produce.
  //
  // `expectFrom` makes the publish land only while the pointer is still exactly `from`. The predecessor
  // (the removed `compactSegment`) had the same fence as an explicit re-read; it was lost in the move to
  // `nextGeneration`.
  //
  // Reported, not thrown — the caller re-runs against the new generation, which may or may not still hold the id.
  const published = await publishGeneration(deps.registry, key, {
    expectFrom: from,
    expectToken: fromToken,
  });
  if (!published) {
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
  // generation below the new pointer is safe to take, and provably so now that the publish is fenced on `from`:
  // the CAS succeeded while the pointer was still at `from`, so nothing in `(from, generation)` had been
  // published before us, and the pointer only moves forward — so none of them can ever become current either.
  // They are permanently unreachable, which is exactly what makes deleting them the strongest form of the
  // "physically gone on return" claim rather than a risk to a load that is still in flight.
  const collected = await gcOrphanGenerations(ref, deps, { keep: 0 });
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
 * invariant costs nothing measurable on a path that is re-encoding every chunk anyway.
 */
async function* rewrite(
  reader: CrbmReader,
  chunkKey: number,
  replacement: CodecBitmap,
  codec: CodecInterface,
  maxBytes: number,
): AsyncGenerator<{ chunkKey: number; bitmap: CodecBitmap }> {
  const keys = [...reader.chunkKeys()].sort((a, b) => a - b);
  for (const k of keys) {
    if (k === chunkKey) {
      yield { chunkKey: k, bitmap: replacement };
      continue;
    }
    const bytes = await reader.getChunk(k);
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
