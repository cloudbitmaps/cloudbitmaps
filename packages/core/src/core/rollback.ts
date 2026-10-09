/**
 * `listGenerations` and `rollbackSegment` — see what a segment has been, and put it back.
 *
 * Immutable generations mean the previous version of a segment is usually still sitting in the bucket: a load
 * that replaced it did not overwrite anything, it wrote a new object and moved a pointer. So recovering from a
 * bad load is, in principle, moving the pointer back, which no load, publish or sweep can do, because every other
 * write path in the library only ever advances the pointer, and refuses a move that would lower it.
 *
 * That refusal is right for a *writer*: a load whose ids came from upstream loses nothing by being out-raced, and
 * letting it regress the pointer would let a slow loader silently undo a fast one. It is wrong for an *operator*,
 * who has looked at the segment, decided the current generation is wrong, and knows which one they want. So
 * rollback is the one call that moves the pointer backwards, and it is deliberately not reachable from any
 * automatic path — no sweep, no retry, no reconciliation calls it.
 *
 * It is audited for the same reason. Every other pointer move can be reconstructed from "a load happened"; this
 * one is a human overriding the ordering rule the rest of the system relies on, which is exactly the event an
 * Art. 30 record or an incident review wants to find.
 */
import { type IAuditSink, NOOP_AUDIT, checkedAuditSink, safeAudit } from './audit';
import { incarnationField } from './token';
import { openRollbackTarget, provesOwnObject } from './crbm-storage-source';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  IntegrityError,
  NotFoundError,
  ValidationError,
  isIntegrityError,
  isWriteConflictError,
} from './errors';
import { type ChurnDeps, leaseChurn, onlyLeasesDiffer } from './leases';
import type {
  IStorageDriver,
  GenerationMetadata,
  IRegistryDriver,
  RegistryRecord,
  RegistrySummary,
  SegmentRef,
  Token,
} from './ports';
import { summaryOf, usableSummary } from './summary';
import { validateUserRef } from './validate';

/** What the generation helpers need: the objects, and the pointer that says which one is current. */
export interface GenerationListDeps extends ChurnDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /**
   * The key of an encrypted segment, so a rollback can read its target's count and metadata and seal them into the
   * row. Without it, a rollback of an encrypted segment still works and leaves the row with no summary of the
   * generation it moves to, which a reader then takes from the object.
   */
  readonly keystore?: IKeystore;
}

/** One generation present in the bucket. */
export interface GenerationEntry {
  readonly generation: number;
  /** Whether the registry pointer currently names this generation. */
  readonly current: boolean;
  /**
   * The current generation's id count, from its registry row, with no read of the object. Present only on the current
   * entry, and only when the row's summary can be used: for an encrypted segment that takes a keystore that opens the
   * segment's key. It is the row's word, not confirmed against the object.
   */
  readonly cardinality?: number;
  /** The metadata the current generation was loaded with, from the same row; absent when it has none. */
  readonly metadata?: GenerationMetadata;
}

/**
 * Every generation still present for a segment, ascending, with the current one marked.
 *
 * This is what the bucket holds, not what the segment has ever been: generation collection deletes superseded
 * objects, so the list is the grace window plus whatever has not been collected yet. It is the set a
 * {@link rollbackSegment} can choose from, which is the reason to look at it.
 *
 * One registry read and one `list` call, whether or not the segment has a registry row, so it also finds the
 * objects a purged row left behind. It does not open the objects, so it costs nothing per generation and tells you
 * nothing about their contents — read the sizes through the store's own report if you need them. The current entry
 * carries the id count and metadata its row records, from the same read.
 */
export async function listGenerations(
  ref: SegmentRef,
  deps: GenerationListDeps,
): Promise<GenerationEntry[]> {
  validateUserRef(ref);
  const record = await deps.registry.get(ref);
  const current = record?.currentGen ?? null;
  const seen = new Set<number>();
  for await (const key of deps.storage.list(ref)) seen.add(key.generation);
  const described = record === null ? undefined : await currentDescription(ref, record, deps);
  return [...seen]
    .sort((a, b) => a - b)
    .map((generation) =>
      generation === current
        ? { generation, current: true, ...described }
        : { generation, current: false },
    );
}

/**
 * What the row's summary says of its current generation, or `undefined` when it says nothing usable. A key that
 * cannot be opened leaves it out, as a rollback does: the entry is then listed without a description.
 */
async function currentDescription(
  ref: SegmentRef,
  record: RegistryRecord,
  deps: GenerationListDeps,
): Promise<{ cardinality: number; metadata?: GenerationMetadata } | undefined> {
  if (record.summary === undefined) return undefined;
  let aead: Aead | undefined;
  if (
    'sealed' in record.summary &&
    record.wrappedDeks !== undefined &&
    deps.keystore !== undefined
  ) {
    try {
      aead = await deps.keystore.openDek(record.wrappedDeks);
    } catch {
      return undefined;
    }
  }
  const usable = usableSummary(ref, record, aead);
  if (usable === undefined) return undefined;
  const metadata = usable.metadata;
  return metadata === undefined || Object.keys(metadata).length === 0
    ? { cardinality: usable.cardinality }
    : { cardinality: usable.cardinality, metadata: Object.freeze({ ...metadata }) };
}

export interface RollbackResult {
  /** The generation the pointer named before the rollback. `null` when the segment had no current generation. */
  readonly fromGeneration: number | null;
  /** The generation the pointer names now. */
  readonly generation: number;
}

/**
 * Move a segment's pointer **back** to a generation that is still in the bucket.
 *
 * The only non-forward-only publish in the library, and the only one an operator has to ask for by name. It
 * refuses rather than guesses:
 *
 * - a generation whose object is **not in the bucket** — collected, or never written — is refused with
 *   `NotFoundError` rather than pointed at, because a pointer naming a missing object is the one state the whole
 *   design exists to avoid;
 * - a **crypto-shredded** segment is refused: every generation of it is unreadable, so a rollback would produce a
 *   segment that resolves and then fails;
 * - a target that is **not what the row says the segment is** is refused with `IntegrityError`: a cleartext object
 *   under a row with keys, or an encrypted one under a row with none, either of which every read would then refuse.
 *   One tail read of the target decides it, as does a footer that fails its own checks;
 * - rolling to the generation **already current** is a no-op that reports itself, not an error.
 *
 * The same tail read opens the target when the segment's key is at hand, and the rollback writes the target's own id
 * count and metadata into the row, in the compare-and-swap that moves the pointer: a reader that sees the target as
 * current sees what describes it. (One tail read, and a range read as well when the target's index is longer than the
 * tail read: a target of very many chunks.) A store with no keystore, or one that cannot open the segment's key for any
 * reason, a keystore that is unreachable or timed out included, still rolls an encrypted segment back and leaves the
 * row with no summary of the target. The undo of a rollback whose target was collected meanwhile puts back the summary
 * the row had, and so does the undo of an `allowForward` rollback whose target was replaced meanwhile: an object above
 * the pointer can be deleted by an erasure and its number taken by a load, between the read and the swap, so after the
 * swap such a target is read once more, and the pointer put back unless it is the object whose summary was written.
 *
 * What it does **not** do is delete anything. The generations above the new pointer stay in the bucket, which is
 * what makes the rollback reversible — roll forward again by naming one of them. They are also then *above*
 * `currentGen`, where generation collection never looks. They stay until loads pass them (the first load whose
 * number one of them holds numbers above them all, and collection then keeps the newest `keep` of what is below its
 * pointer), `dropSegment` deletes them, or a subject erasure
 * deletes them: all of those present when it rewrites, and only those holding the id when the current generation does not.
 * Not collecting them is a deliberate trade: an operator who has just undone a bad load should not have the
 * evidence collected out from under them, while a rollback target that still holds erased data would make the
 * erasure undoable by an ordinary operator action.
 */
export async function rollbackSegment(
  ref: SegmentRef,
  toGeneration: number,
  deps: GenerationListDeps,
  options: { audit?: IAuditSink; allowForward?: boolean } = {},
): Promise<RollbackResult> {
  validateUserRef(ref);
  checkedAuditSink(options.audit, 'rollback');
  if (!Number.isInteger(toGeneration) || toGeneration < 0) {
    throw new ValidationError(
      `rollback: generation must be a non-negative integer; got ${String(toGeneration)}`,
    );
  }

  const record = await deps.registry.get(ref);
  if (record === null) {
    throw new NotFoundError(`rollback: no registry row for segment "${ref.segment}"`);
  }
  if (record.status === 'destroyed') {
    throw new ValidationError(
      `rollback: segment "${ref.segment}" is destroyed (crypto-shredded) — every generation of it is unreadable`,
    );
  }
  if (record.currentGen === toGeneration) {
    return { fromGeneration: record.currentGen, generation: toGeneration };
  }

  // A first look, for the affordance rather than the safety: an operator who named a collected generation needs
  // to be told what IS available, and that is much nicer to produce before anything has moved.
  const present = new Set<number>();
  for await (const key of deps.storage.list(ref)) present.add(key.generation);
  if (!present.has(toGeneration)) {
    const available = [...present].sort((a, b) => a - b);
    throw new NotFoundError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is not in the bucket` +
        (available.length === 0
          ? ' (no generations remain)'
          : ` — present: ${available.join(', ')}`),
    );
  }
  // A row with no pointer has every generation above it: none was ever published.
  if (
    (record.currentGen === null || toGeneration > record.currentGen) &&
    options.allowForward !== true
  ) {
    // Above the pointer is not "a later version of this segment". It is where objects live that were never
    // authoritative: a load that wrote its object and died before publishing, and a guard-refused load whose
    // cleanup was skipped because the row had changed. Rolling onto one of those makes current the very
    // generation a guard refused — an empty one, typically. The legitimate above-pointer case is undoing a
    // rollback, which is what the opt-in is for.
    throw new ValidationError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is above the current pointer ` +
        `(${record.currentGen ?? 'none'}) — it may never have been published. Pass { allowForward: true } if you are ` +
        `undoing an earlier rollback.`,
    );
  }

  // The target must be what the row says the segment is, encrypted under its key or cleartext, or every read of the
  // segment would refuse it once the pointer names it. One tail read of it says which it is, with no key needed for that:
  // a cleartext target under a row with keys is a write that never published, from before the segment's key was made,
  // and an encrypted one under a row with none was sealed under a key no row holds. The same read opens the target when
  // the key is at hand, which gives the count and metadata the row's summary of it says, so nothing is read twice. A
  // target whose footer, index or metadata does not open is refused: the pointer is not moved onto what no read opens.
  const keyed = record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
  let aead: Aead | undefined;
  if (keyed && deps.keystore !== undefined) {
    try {
      aead = await deps.keystore.openDek(record.wrappedDeks!);
    } catch {
      // A key the store cannot open, for any reason (it holds none of the segment's KEKs, one that does not unwrap it, a
      // keystore that is unreachable or timed out) is no key at hand, and the rollback still happens, as it could
      // before it touched the keystore: this is the call an operator reaches for when something is wrong, and the key
      // service being down is often it. The row then carries no summary of the target.
    }
  }
  const crypto: CrbmCrypto | undefined =
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, toGeneration, scope) };
  const { encrypted, reader } = await openRollbackTarget(
    deps.storage,
    { ...ref, generation: toGeneration },
    crypto,
  );
  if (encrypted !== keyed) {
    throw new IntegrityError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is ${encrypted ? 'encrypted' : 'cleartext'}, ` +
        `but the segment is ${keyed ? 'encrypted' : 'cleartext'}, so no read of the segment could use it; it was ` +
        'never one of its generations. Roll back to another generation.',
    );
  }
  // The target's own count and metadata, read from its object, in the same write that moves the pointer, so a reader that
  // sees it as current sees them. None when the key was not at hand to open an encrypted target.
  const summary: RegistrySummary | undefined =
    reader === undefined
      ? undefined
      : summaryOf(
          ref,
          toGeneration,
          { cardinality: reader.count(), metadata: reader.metadata },
          aead,
        );

  // Fenced on the row this decision was made against. A rollback is the most derived write there is — an
  // operator looked at a particular state and chose — so publishing it into a row that has moved since would
  // undo whatever moved it, which is the opposite of what they asked for.
  // A write of the row's leases alone, which readers make, is not another writer's: the swap goes on against the row
  // it finds, after a jittered wait, up to a bound. Any other change throws the conflict, as ever.
  const churn = leaseChurn(deps);
  let against = record.token;
  let token: Token;
  for (;;) {
    try {
      ({ token } = await deps.registry.compareAndSwap(ref, against, {
        currentGen: toGeneration,
        summary,
      }));
      break;
    } catch (err) {
      if (!isWriteConflictError(err)) throw err;
      const seen = await deps.registry.get(ref);
      const settled = await churn.settle(record, seen, () => deps.registry.get(ref));
      const now = settled?.row ?? null;
      // The row after the wait is the one the swap goes on against, if it is still the one read with only leases changed.
      if (settled === undefined || now === null || !onlyLeasesDiffer(record, now)) throw err;
      against = now.token;
    }
  }

  // THE check, and it has to be here rather than above. Every target but an `allowForward` one is below the old
  // pointer, which is precisely generation collection's range — and a collector never writes the row, so the
  // token fence above cannot see it coming. A listing taken before the swap therefore proves nothing: the object
  // can be collected between that listing and this swap, leaving the pointer naming a missing object.
  //
  // Once the swap lands, the target is safe — collection only ever takes what is strictly below `currentGen`,
  // and the target now IS `currentGen`. So the ordering is: move first, then verify, and put the pointer back if
  // the object went. Re-pointing can itself be raced, which is why it is fenced on the token the swap returned
  // and why failing to undo is reported rather than swallowed.
  let stillThere = false;
  for await (const key of deps.storage.list(ref)) {
    if (key.generation === toGeneration) {
      stillThere = true;
      break;
    }
  }
  // An object above the old pointer is where collection never looks, but an erasure can delete one and a load can then
  // take its number, between the read of the target and the swap: the number is there, and it is another object than the
  // one the summary just written describes. So a target above the pointer is read once more, by its footer, and is the
  // one that was read or is put back like a vanished one. Below the pointer a number cannot be taken again.
  let replaced = false;
  if (stillThere && reader !== undefined && toGeneration > (record.currentGen ?? -1)) {
    try {
      replaced = !(await provesOwnObject(
        deps.storage,
        { ...ref, generation: toGeneration },
        reader.fingerprint,
      ));
    } catch (err) {
      if (!isIntegrityError(err)) throw err;
      replaced = true; // a footer that no longer checks is not the object that was read
    }
  }
  if (!stillThere || replaced) {
    let undone = false;
    let undoAgainst = token;
    for (;;) {
      try {
        await deps.registry.compareAndSwap(ref, undoAgainst, {
          currentGen: record.currentGen,
          summary: describingSummary(record),
        });
        undone = true;
        break;
      } catch (err) {
        // Not proof the undo did not land: a swap can apply and still throw, as when its response is lost. Only a
        // read of the row says where the pointer is, so the message below says "may", not "does".
        //
        // A lost race is retried when the row is the one the swap wrote with only its leases changed: the pointer is
        // at the target and every other field is the row's from before the swap, bar what the swap itself moved.
        if (!isWriteConflictError(err)) break;
        const moved = ['currentGen', 'summary', 'keptGens'] as const;
        let now: RegistryRecord | null;
        try {
          const seen = await deps.registry.get(ref);
          if (seen === null || seen.currentGen !== toGeneration) break;
          const settled = await churn.settle(record, seen, () => deps.registry.get(ref), moved);
          now = settled?.row ?? null;
        } catch {
          break;
        }
        if (
          now === null ||
          now.currentGen !== toGeneration ||
          !onlyLeasesDiffer(record, now, moved)
        )
          break;
        undoAgainst = now.token;
      }
    }
    throw new NotFoundError(
      `rollback: generation ${toGeneration} of "${ref.segment}" was ${replaced ? 'replaced' : 'collected'} while the pointer was moving` +
        (undone
          ? ' — the pointer was put back'
          : `, and the move back failed, so the pointer may still name ${toGeneration} (a write that landed and lost ` +
            'its response reads as a failure here). Check which generation is current, then re-run a rollback to a ' +
            'generation that exists, or restore the object.'),
    );
  }

  safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
    kind: 'segment.rollback',
    segment: ref.segment,
    namespace: ref.namespace,
    ...incarnationField(record.token),
    fromGeneration: record.currentGen,
    generation: toGeneration,
  });

  return { fromGeneration: record.currentGen, generation: toGeneration };
}

/**
 * The summary a row had, for a write that puts the row back as it was: the one the row carried if it described the
 * generation the row named and had the shape its keys called for, and none otherwise, since a registry refuses to write
 * a summary that does not. A row a rollback is undone onto carries what it carried before the rollback moved it.
 */
function describingSummary(record: RegistryRecord): RegistrySummary | undefined {
  const { summary } = record;
  if (summary === undefined || summary.generation !== record.currentGen) return undefined;
  const keyed = record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
  return 'sealed' in summary === keyed ? summary : undefined;
}
