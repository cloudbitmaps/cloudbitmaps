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
import { requireInteger } from './check';
import { type IAuditSink, NOOP_AUDIT, checkedAuditSink, safeAudit } from './audit';
import { incarnationField } from './token';
import { openRollbackTargetFrom, provesOwnObject, readRollbackTargetFooter } from './crbm-open';
import { describingKnown, rollbackKnown } from './known-generations';
import { aadFor } from './crypto';
import { generationsOf } from './generation-list';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  IntegrityError,
  KeyUnavailableError,
  NotFoundError,
  TransientError,
  ValidationError,
  isIntegrityError,
  isKeyUnavailableError,
  isNotFoundError,
  isTransientError,
  isWriteConflictError,
} from './errors';
import { type ChurnDeps, leaseChurn, onlyLeasesDiffer } from './leases';
import type {
  IStorageDriver,
  GenerationMetadata,
  IRegistryDriver,
  KnownGeneration,
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
   * row. Without it, a rollback of an encrypted segment to a generation below the pointer still works and leaves the
   * row with no summary of the generation it moves to, which a reader then takes from the object; one above the
   * pointer needs it, and is refused with `KeyUnavailableError`, or throws `TransientError` when the key service did not
   * answer in time (the keystore's own, or one whose `cause` is the timeout it threw).
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
  const seen = await generationsOf(deps.storage, ref);
  const described = record === null ? undefined : await currentDescription(ref, record, deps);
  return seen.map((generation) =>
    generation === current
      ? { generation, current: true, ...described }
      : { generation, current: false },
  );
}

/**
 * What the row's summary says of its current generation, or `undefined` when it says nothing usable. A key that
 * cannot be opened, for any reason, leaves it out: the entry is then listed without a description, since a listing is
 * what an operator reads when something is wrong, the key service included.
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
 * - a target **above the pointer of an encrypted segment** is refused with `KeyUnavailableError` when the store has no
 *   keystore, or its keystore holds none of the key's KEKs or one that does not unwrap the key: it is where objects live
 *   that no load published, one sealed under a key no row holds among them, and only opening it with the segment's key
 *   shows that it is one of the segment's. A key service that did not answer in time is thrown as `TransientError`, to
 *   retry;
 * - rolling to the generation **already current** is a no-op that reports itself, not an error, once one zero-byte
 *   read finds its object in the bucket. A pointer that names a missing object is refused with `NotFoundError`, as any
 *   missing target is.
 *
 * The same tail read opens the target when the segment's key is at hand, and the rollback writes the target's own id
 * count and metadata into the row, in the compare-and-swap that moves the pointer: a reader that sees the target as
 * current sees what describes it. (One tail read, and a range read as well when the target's index is longer than the
 * tail read: a target of very many chunks.) A store with no keystore, or whose keystore cannot open the segment's key
 * (it holds none of the key's KEKs, one it holds does not unwrap it, or it throws `TransientError` or times out as
 * `AbortSignal.timeout()` and the AWS SDK report a timeout), still rolls an encrypted segment back to a generation below
 * the pointer and leaves the row with no summary of the target; such a rollback opens nothing, so it can move onto an
 * object sealed under a key no row holds. Any other failure of the keystore is thrown. The undo of a rollback whose
 * target was collected meanwhile puts back the summary the row had, and so does the undo of an `allowForward` rollback
 * whose target was replaced meanwhile: an object above the pointer can be deleted by an erasure and its number taken by
 * a load, between the read and the swap, so after the swap such a target is read once more, and the pointer put back
 * unless it is the object whose summary was written.
 * A swap that gets no answer is settled by reading the row: one the row shows landed, the row being the one the swap
 * leaves, is checked as any swap is, and otherwise its `TransientError` is thrown, since it may have landed or may still
 * land, and a re-run finds the pointer where it is. A write by another writer is not taken for it, unless it leaves the
 * very row this swap would. On a cleartext segment two writes can: another rollback onto the same target, whatever row
 * it read, and a load that wrote under that number the very object the rollback read and carried the ledger the
 * rollback would (a load that carries a usable ledger, as one with a `keep` above 64 does; over a row with no usable
 * ledger the rollback writes none and a load seeds one, so those rows differ). On an encrypted segment a rollback with no
 * key at hand writes no summary, so another such rollback onto the same target can too. That call then reports and
 * audits the move as its own; the pointer is where it asked for it.
 *
 * What it does **not** do is delete anything. The generations above the new pointer stay in the bucket, which is
 * what makes the rollback reversible — roll forward again by naming one of them. They are also then *above*
 * `currentGen`, where generation collection never looks. They stay until loads pass them (the first load whose
 * number one of them holds numbers above them all, and collection then keeps `keep` of what is below its pointer, the
 * generation that load superseded first), `dropSegment` deletes them, or a subject erasure
 * deletes them: all of those present when it rewrites, and, when the current generation does not hold the id, only those
 * holding it and any no read of the segment can open, whatever the id.
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
  requireInteger(toGeneration, { min: 0, what: 'rollback: generation' });

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
    // A no-op only over an object that is there. A pointer that names a missing one (a collection that raced an earlier
    // move, or a swap that got no answer and landed, its target collected since) is what this call exists to repair, and
    // an operator who re-runs a rollback to the generation they want must not be told the segment is fine.
    await requirePresent(ref, toGeneration, deps.storage);
    return { fromGeneration: record.currentGen, generation: toGeneration };
  }

  // A first look, for the affordance rather than the safety: an operator who named a collected generation needs
  // to be told what IS available, and that is much nicer to produce before anything has moved.
  const present = await generationsOf(deps.storage, ref);
  if (!present.includes(toGeneration)) throw notInBucket(ref, toGeneration, present, false);
  // A row with no pointer has every generation above it: none was ever published.
  const forward = record.currentGen === null || toGeneration > record.currentGen;
  if (forward && options.allowForward !== true) {
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
  const keyed = isKeyed(record);
  // The row vouches for no target above its pointer, so one there has to be opened with the segment's key.
  const aead = await rollbackKey(
    ref,
    record,
    deps.keystore,
    forward
      ? {
          why:
            `generation ${toGeneration} of "${ref.segment}" is above the current pointer ` +
            `(${record.currentGen ?? 'none'})`,
        }
      : undefined,
  );
  const crypto: CrbmCrypto | undefined =
    aead === undefined ? undefined : { aead, aadFor: (scope) => aadFor(ref, toGeneration, scope) };
  // One tail read of the target, whose footer says whether it is encrypted and carries the checksum the ledger records,
  // and which the open below is answered from: the summary's size and tail and the ledger's checksum are of this one
  // object, never of two reads.
  const targetKey = { ...ref, generation: toGeneration };
  const footer = await readRollbackTargetFooter(deps.storage, targetKey);
  const reader = await openRollbackTargetFrom(footer, targetKey, crypto);
  if (footer.encrypted !== keyed) {
    throw new IntegrityError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is ${footer.encrypted ? 'encrypted' : 'cleartext'}, ` +
        `but the segment is ${keyed ? 'encrypted' : 'cleartext'}, so no read of the segment could use it; it was ` +
        'never one of its generations. Roll back to another generation.',
    );
  }
  // The target's own count, metadata, fingerprint and tail size, read from its object, in the same write that moves the
  // pointer, so a reader that sees it as current sees them, and holds the object it opens to the one read here. None when
  // the key was not at hand to open an encrypted target, and none for an object whose tail is more than a summary
  // records, which a reader accepts for an object this library did not write: the row is legal without one, and a read
  // opens the generation with the default tail.
  const summary: RegistrySummary | undefined =
    reader === undefined
      ? undefined
      : summaryOf(
          ref,
          toGeneration,
          {
            cardinality: reader.count(),
            metadata: reader.metadata,
            fingerprint: reader.fingerprint,
            tailBytes: reader.tailBytes,
          },
          aead,
        );
  // The ledger moves the target to the end, as the most recently current, with the checksum of the object just read.
  const known = rollbackKnown(record, { generation: toGeneration, footerCrc: footer.footerCrc });

  // Fenced on the row this decision was made against. A rollback is the most derived write there is — an
  // operator looked at a particular state and chose — so publishing it into a row that has moved since would
  // undo whatever moved it, which is the opposite of what they asked for.
  // A write of the row's leases alone, which readers make, is not another writer's: the swap goes on against the row
  // it finds, after a jittered wait, up to a bound. Any other change throws the conflict, as ever.
  const churn = leaseChurn(deps);
  let against = record.token;
  // What the swap wrote: the token it was given, which the row's pointerId then carries, and the token of the row the
  // undo below is fenced on, which a lease write after the swap moves.
  let swapped: { readonly pointerId: Token; readonly token: Token };
  for (;;) {
    try {
      const { token } = await deps.registry.compareAndSwap(ref, against, {
        currentGen: toGeneration,
        summary,
        ...(known === undefined ? {} : { knownGens: known }),
      });
      swapped = { pointerId: token, token };
      break;
    } catch (err) {
      if (isTransientError(err)) {
        // A swap that got no answer may have landed, and the check below has to run on one that did, or the pointer can
        // be left on a target collected meanwhile. The row says which.
        const landed = await swapLanded(
          ref,
          record,
          { toGeneration, summary, known },
          deps.registry,
          err,
        );
        swapped = { pointerId: landed.pointerId, token: landed.token };
        break;
      }
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
  // the object went. Re-pointing can itself be raced, which is why it is fenced on the token the swap returned (or
  // that of the row that showed a swap with no answer landed) and why failing to undo is reported rather than swallowed.
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
  // one that was read or is put back like a vanished one. A number below the pointer can be taken again too, by a load
  // that stalled before writing its object while collection freed the number, and is then refused its publish. A
  // target below the pointer is not read again for that: the load has to stall across a collection and land inside this
  // call's window, between its read of the target and its swap, and where the swap wrote a summary, every read that
  // opens the generation is held to the fingerprint of the object read here, and refuses another.
  let replaced = false;
  if (stillThere && reader !== undefined && forward) {
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
    let undoAgainst = swapped.token;
    for (;;) {
      try {
        // The target the rollback just found gone, or replaced, is not a generation the row knows any more.
        const restored = describingKnown(record, toGeneration)?.filter(
          (e) => e.generation !== toGeneration || e.generation === record.currentGen,
        );
        await deps.registry.compareAndSwap(ref, undoAgainst, {
          currentGen: record.currentGen,
          summary: describingSummary(record),
          ...(restored === undefined ? {} : { knownGens: restored }),
        });
        undone = true;
        break;
      } catch (err) {
        // Not proof the undo did not land: a swap can apply and still throw, as when its response is lost. Only a
        // read of the row says where the pointer is, so the message below says "may", not "does".
        //
        // A lost race is retried when the row is the one the swap wrote with only its leases changed: the pointer is
        // at the target, the row's pointerId is the one the swap set (its own token, so no other writer has renewed
        // what the row resolves to since), and every other field is the row's from before the swap, bar what the swap
        // itself moved.
        if (!isWriteConflictError(err)) break;
        let now: RegistryRecord | null;
        try {
          const seen = await deps.registry.get(ref);
          if (seen === null || seen.currentGen !== toGeneration) break;
          const settled = await churn.settle(
            record,
            seen,
            () => deps.registry.get(ref),
            SWAP_MOVES,
          );
          now = settled?.row ?? null;
        } catch {
          break;
        }
        if (
          now === null ||
          now.currentGen !== toGeneration ||
          now.pointerId !== swapped.pointerId ||
          !onlyLeasesDiffer(record, now, SWAP_MOVES)
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
  return 'sealed' in summary === isKeyed(record) ? summary : undefined;
}

/** The fields a rollback's swap moves: the pointer, its summary, the ledger and the pointerId. */
const SWAP_MOVES = ['currentGen', 'summary', 'knownGens', 'pointerId'] as const;

/** Whether the row is an encrypted segment's: it carries wrapped keys. */
function isKeyed(record: RegistryRecord): boolean {
  return record.wrappedDeks !== undefined && record.wrappedDeks.length > 0;
}

/** The refusal of a target whose object is not in the bucket, naming the generations that are. */
function notInBucket(
  ref: SegmentRef,
  generation: number,
  present: readonly number[],
  current: boolean,
): NotFoundError {
  return new NotFoundError(
    `rollback: generation ${generation} of "${ref.segment}" ` +
      (current ? 'is current, but its object is not in the bucket' : 'is not in the bucket') +
      (present.length === 0 ? ' (no generations remain)' : ` — present: ${present.join(', ')}`),
  );
}

/**
 * Throws {@link NotFoundError}, naming what the bucket holds, when the current generation's object is not there. One
 * zero-byte read, a metadata request on every shipped driver, and a listing only for the refusal. Any other fault of the
 * read is thrown as it is: a rollback that could not look reports nothing as done.
 */
async function requirePresent(
  ref: SegmentRef,
  generation: number,
  storage: IStorageDriver,
): Promise<void> {
  try {
    await storage.getTail({ ...ref, generation }, 0);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    throw notInBucket(ref, generation, await generationsOf(storage, ref), true);
  }
}

/**
 * The segment's data key for a rollback, or `undefined` when there is none to use: a cleartext segment, whose keystore
 * is not asked, or an encrypted one whose key is not at hand. Not at hand is no keystore, or a keystore that says it
 * cannot open the key ({@link keyNotHeld}) or did not answer in time ({@link keyServiceUnanswered}). Any other
 * failure of the keystore is a fault of its own, and is thrown.
 *
 * `mustOpen`, when given, says why the target has to be opened with the key: the row does not vouch for the target,
 * and an object sealed under a key no row holds passes every check that needs no key, so only opening the target with
 * the segment's key shows that it is one of the segment's. Then a key not at hand refuses the rollback with
 * {@link KeyUnavailableError}, before the target is read, and a key service that did not answer in time is thrown as
 * {@link TransientError} (its own, or one whose `cause` is the timeout): the call can succeed once it answers, which a
 * refusal would not say.
 */
async function rollbackKey(
  ref: SegmentRef,
  record: RegistryRecord,
  keystore: IKeystore | undefined,
  mustOpen: { readonly why: string } | undefined,
): Promise<Aead | undefined> {
  if (!isKeyed(record)) return undefined;
  let missing = 'the store has no keystore';
  if (keystore !== undefined) {
    try {
      return await keystore.openDek(record.wrappedDeks!);
    } catch (err) {
      if (keyServiceUnanswered(err)) {
        if (mustOpen === undefined) return undefined;
        // Retryable, so it reaches the caller as the class a retry keys on, whatever shape the timeout had.
        throw isTransientError(err)
          ? err
          : new TransientError('rollback: the key service did not answer in time', { cause: err });
      }
      if (!keyNotHeld(err)) throw err;
      if (mustOpen === undefined) return undefined;
      missing = `the keystore could not open the segment's key: ${
        isKeyUnavailableError(err)
          ? 'it holds none of the KEKs the key is wrapped under'
          : 'a KEK it holds does not unwrap the key'
      }`;
    }
  }
  if (mustOpen === undefined) return undefined;
  throw new KeyUnavailableError(
    `rollback: ${mustOpen.why}, and the segment is encrypted: only its key, opening the target, shows that it is one ` +
      `of the segment's generations and not an object sealed under another key, and no key is at hand (${missing}). ` +
      "Retry with a keystore that opens the segment's key.",
  );
}

/**
 * Whether a keystore's failure says it cannot open the key: it holds none of its KEKs (`KeyUnavailableError`), or one it
 * holds does not unwrap it (`IntegrityError`). Below the pointer a rollback goes on without the key, since this is the
 * call an operator reaches for when something is wrong.
 */
function keyNotHeld(err: unknown): boolean {
  return isKeyUnavailableError(err) || isIntegrityError(err);
}

/**
 * Whether a keystore's failure says the key service did not answer in time: a `TransientError`, as the port asks a
 * keystore to throw for a fault worth riding out, or an `Error` named exactly `TimeoutError`, which is what
 * `AbortSignal.timeout()` and the AWS SDK's request timeouts raise. A plain abort (`AbortError`) and any other network
 * error are not this, and neither is an error judged by its message. Below the pointer a rollback goes on without the
 * key, since the key service being down is often why an operator rolls back; above it the error reaches the caller as
 * `TransientError`.
 */
function keyServiceUnanswered(err: unknown): boolean {
  return isTransientError(err) || (err instanceof Error && err.name === 'TimeoutError');
}

/**
 * The row after a swap that got no answer, when it shows that the swap landed; otherwise `unanswered` is thrown.
 *
 * It shows it when it is the row the swap leaves: the row the rollback read, of the same incarnation, with the swap's
 * pointer, summary and ledger, and nothing else changed but its leases, which a reader can write the moment the target
 * is current, and its pointerId. Another writer's publish of the same number is not that row: a load records the
 * summary of its own object, and a ledger drawn from its window. A sealed summary
 * carries a fresh nonce, so on an encrypted segment only this call's own write matches, when it wrote one. Otherwise
 * other writes leave the very same row and are taken for this one: another rollback onto the same target, from
 * whatever row it read, that wrote the same summary and ledger or, like this one, no summary; and on a cleartext segment
 * a load that wrote under that number the very object this call read and carried the same ledger (a load that carries a
 * usable ledger; over a row with no usable ledger the rollback writes none and a load seeds one, so those rows differ). The pointer is then where this call asked for it, on the object it read, and the check
 * after the swap holds either way, but this call audits a move another writer made.
 *
 * The undo after a row taken this way is fenced on that row, so a write after the read back is another writer's, as
 * after a swap that got its answer. A write that renewed the pointerId between the swap and the read back cannot be
 * told from the swap: the undo, when the target went, then lands over it, and the renewing writer meets the moved
 * pointer at its next read of the row.
 *
 * Otherwise the swap's own error is thrown. On an unchanged row the write may still land; on a row that moved elsewhere
 * it never will; a row that cannot be read says neither. A re-run of the rollback finds the pointer where it is, and a
 * re-run onto a target the pointer already names checks that its object is there. A row that is not one the library
 * wrote is thrown as it is, since it says more than the lost answer does.
 */
async function swapLanded(
  ref: SegmentRef,
  record: RegistryRecord,
  swap: {
    readonly toGeneration: number;
    readonly summary: RegistrySummary | undefined;
    readonly known: readonly KnownGeneration[] | undefined;
  },
  registry: IRegistryDriver,
  unanswered: TransientError,
): Promise<RegistryRecord> {
  let now: RegistryRecord | null;
  try {
    now = await registry.get(ref);
  } catch (readErr) {
    if (isIntegrityError(readErr)) throw readErr;
    throw unanswered;
  }
  const left: RegistryRecord = {
    ...record,
    currentGen: swap.toGeneration,
    summary: swap.summary,
    knownGens: swap.known,
  };
  if (now === null || !onlyLeasesDiffer(left, now, ['pointerId'])) throw unanswered;
  return now;
}
