/**
 * `listGenerations` and `rollbackSegment` — see what a segment has been, and put it back.
 *
 * Immutable generations mean the previous version of a segment is usually still sitting in the bucket: a load
 * that replaced it did not overwrite anything, it wrote a new object and moved a pointer. So recovering from a
 * bad load is, in principle, moving the pointer back — and until now there was no way to do it, because every
 * write path in the library is deliberately **forward-only** and refuses a regression.
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
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { NotFoundError, ValidationError } from './errors';
import type { IColdDriver, IRegistryDriver, SegmentRef } from './ports';
import { validateSegmentRef } from './validate';

/** What the generation helpers need: the objects, and the pointer that says which one is current. */
export interface GenerationListDeps {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
}

/** One generation present in the bucket. */
export interface GenerationEntry {
  readonly generation: number;
  /** Whether the registry pointer currently names this generation. */
  readonly current: boolean;
}

/**
 * Every generation still present for a segment, ascending, with the current one marked.
 *
 * This is what the bucket holds, not what the segment has ever been: generation collection deletes superseded
 * objects, so the list is the grace window plus whatever has not been collected yet. It is the set a
 * {@link rollbackSegment} can choose from, which is the reason to look at it.
 *
 * One `list` call. It does not open the objects, so it costs nothing per generation and tells you nothing about
 * their contents — read the sizes through the store's own report if you need them.
 */
export async function listGenerations(
  ref: SegmentRef,
  deps: GenerationListDeps,
): Promise<GenerationEntry[]> {
  validateSegmentRef(ref);
  const record = await deps.registry.get(ref);
  const current = record?.currentGen ?? null;
  const seen = new Set<number>();
  for await (const key of deps.cold.list(ref)) seen.add(key.generation);
  return [...seen]
    .sort((a, b) => a - b)
    .map((generation) => ({ generation, current: generation === current }));
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
 * - rolling to the generation **already current** is a no-op that reports itself, not an error.
 *
 * What it does **not** do is delete anything. The generations above the new pointer stay in the bucket, which is
 * what makes the rollback reversible — roll forward again by naming one of them. They are also then *above*
 * `currentGen`, where generation collection never looks, so they will sit there until a later load raises the
 * pointer past them or they are deleted deliberately. That is a deliberate trade: an operator who has just
 * undone a bad load should not have the evidence collected out from under them.
 */
export async function rollbackSegment(
  ref: SegmentRef,
  toGeneration: number,
  deps: GenerationListDeps,
  options: { audit?: IAuditSink; allowForward?: boolean } = {},
): Promise<RollbackResult> {
  validateSegmentRef(ref);
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
  for await (const key of deps.cold.list(ref)) present.add(key.generation);
  if (!present.has(toGeneration)) {
    const available = [...present].sort((a, b) => a - b);
    throw new NotFoundError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is not in the bucket` +
        (available.length === 0
          ? ' (no generations remain)'
          : ` — present: ${available.join(', ')}`),
    );
  }
  if (
    record.currentGen !== null &&
    toGeneration > record.currentGen &&
    options.allowForward !== true
  ) {
    // Above the pointer is not "a later version of this segment". It is where objects live that were never
    // authoritative: a load that wrote its object and died before publishing, and a guard-refused load whose
    // cleanup was skipped because the row had changed. Rolling onto one of those makes current the very
    // generation a guard refused — an empty one, typically. The legitimate above-pointer case is undoing a
    // rollback, which is what the opt-in is for.
    throw new ValidationError(
      `rollback: generation ${toGeneration} of "${ref.segment}" is above the current pointer ` +
        `(${record.currentGen}) — it may never have been published. Pass { allowForward: true } if you are ` +
        `undoing an earlier rollback.`,
    );
  }

  // Fenced on the row this decision was made against. A rollback is the most derived write there is — an
  // operator looked at a particular state and chose — so publishing it into a row that has moved since would
  // undo whatever moved it, which is the opposite of what they asked for.
  const { token } = await deps.registry.compareAndSwap(ref, record.token, {
    currentGen: toGeneration,
  });

  // THE check, and it has to be here rather than above. The target is by construction at or below the old
  // pointer, which is precisely generation collection's range — and a collector never writes the row, so the
  // token fence above cannot see it coming. A listing taken before the swap therefore proves nothing: the object
  // can be collected between that listing and this swap, leaving the pointer naming a missing object.
  //
  // Once the swap lands, the target is safe — collection only ever takes what is strictly below `currentGen`,
  // and the target now IS `currentGen`. So the ordering is: move first, then verify, and put the pointer back if
  // the object went. Re-pointing can itself be raced, which is why it is fenced on the token the swap returned
  // and why failing to undo is reported rather than swallowed.
  let stillThere = false;
  for await (const key of deps.cold.list(ref)) {
    if (key.generation === toGeneration) {
      stillThere = true;
      break;
    }
  }
  if (!stillThere) {
    let undone = false;
    try {
      await deps.registry.compareAndSwap(ref, token, { currentGen: record.currentGen });
      undone = true;
    } catch {
      /* the row moved again; the throw below says the pointer was left where it is */
    }
    throw new NotFoundError(
      `rollback: generation ${toGeneration} of "${ref.segment}" was collected while the pointer was moving` +
        (undone
          ? ' — the pointer was put back'
          : `, and the pointer could NOT be put back: it still names ${toGeneration}. Re-run a rollback to a ` +
            'generation that exists, or restore the object.'),
    );
  }

  safeAudit(options.audit ?? NOOP_AUDIT).onEvent({
    kind: 'segment.rollback',
    segment: ref.segment,
    namespace: ref.namespace,
    fromGeneration: record.currentGen,
    generation: toGeneration,
  });

  return { fromGeneration: record.currentGen, generation: toGeneration };
}
