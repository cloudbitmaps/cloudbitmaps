/**
 * `loadSegment` — the loaded store's primary write path, as one call.
 *
 * A load is always the same four steps: take the next generation number, write one immutable object, move the
 * pointer, collect what the move superseded. Inside the library each is its own internal function, and the
 * step a hand-composed load leaves out is the last one, so a store that composed it would accumulate superseded
 * generations it keeps paying for.
 * Composing it here, once, is the point.
 *
 * The other reason it is one call is the **guard**. A load REPLACES a segment: whatever the stream contains is
 * what the segment contains afterwards. That makes an upstream query returning fewer rows than usual — or none —
 * a silent, successful-looking wipe, and nothing downstream can tell it from a legitimate shrink. The guard is
 * the place to say what a plausible result looks like, and it has to sit **between the write and the publish**,
 * because that is the only moment where the new content is known and the old one is still authoritative.
 *
 * Refusing therefore has to clean up after itself. The object is already durable at that point, and it sits
 * ABOVE `currentGen`, where generation collection deliberately never looks (it deletes strictly below the
 * pointer), so a refused load deletes its own object before returning, while the segment's row is unchanged, gone
 * or `destroyed`. Once another write has changed the row, the object's number may name a re-created segment's live
 * object, so it stays, and collection takes it like any other generation once one above it is current.
 */
import { type IAuditSink, NOOP_AUDIT, safeAudit } from './audit';
import { type CodecBitmap, type CodecInterface, requireCodec } from './codec';
import {
  bulkLoadAhead,
  holdsObject,
  openGenerationReader,
  provesOwnObject,
  publishGenerationKept,
  type PublishResult,
} from './crbm-storage-source';
import type { Clock, Rng } from './determinism';
import { onlyLeasesDiffer } from './leases';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore } from './crypto';
import {
  KeyUnavailableError,
  ValidationError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
} from './errors';
import { collectAfterLoad, nextLoadGeneration } from './generation-gc';
import { ChunkLoadInput, type LoadInput, prepareLoadInput } from './load-input';
import { copiedMetadata } from './metadata';
import { type ReadRetry, retryRead } from './retry';
import { assertRegistryCanWrite } from './ports';
import type {
  GenerationMetadata,
  IStorageDriver,
  IRegistryDriver,
  RegistryRecord,
  SegmentRef,
  Token,
} from './ports';
import { usableSummary } from './summary';
import { validateUserRef } from './validate';

/** What {@link loadSegment} needs: the objects, the pointer, the codec, and key material if encrypted. */
export interface LoadDeps {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  readonly codec?: CodecInterface;
  readonly keystore?: IKeystore;
  readonly requireEncryption?: boolean;
  readonly clock?: Clock;
  /**
   * The random source that spreads the waits between a publish's fresh compare-and-swaps (a random time under each
   * bound). Absent, the read retry's source is used if it has one, and otherwise each wait is its bound.
   */
  readonly rng?: Rng;
  /**
   * The store's read retry, for the read the guard makes of the current generation: a transient fault there is run
   * again under it rather than failing the load. Absent, the read is made once. It does not govern the write: a
   * registry write that gets no answer is settled by reading the row, and sent again only as a bounded fresh
   * compare-and-swap.
   */
  readonly readRetry?: ReadRetry;
  /**
   * Collect by listing the segment's objects after the publish, whatever `keep` is. Absent, a load whose row records
   * the generations it keeps and that found nothing above its pointer deletes by name the generations its publish
   * pushed out of the window, and lists every sixteenth generation to take what that leaves; the generations no list
   * names wait for that listing. Set it for a caller whose `keep` promises every generation below the new
   * one beyond the window is gone when the call returns: the `*Into` verbs, whose `keep` is how an operator clears
   * a destination that earlier materialisations kept in full.
   */
  readonly collectByListing?: boolean;
}

/**
 * What a plausible result looks like, so an implausible one is refused instead of published.
 *
 * Both bounds are compared against the **current** generation's cardinality, read from the `.crbm` index rather
 * than its payload — one object-header read, and only when a bound is actually set.
 */
export interface LoadGuard {
  /** Refuse a generation with fewer than this many ids. Use for "this segment is never legitimately tiny". */
  readonly minCardinality?: number;
  /**
   * Refuse a generation that retains less than this fraction of the current one — `0.5` means "at least half the
   * ids must survive". A *growing* load is never refused by this bound, and neither is the first load of a
   * segment, which has nothing to shrink from.
   *
   * Phrased as a floor rather than a ceiling on the loss so that `0` means the same thing here as it does on
   * `minCardinality` above: **no bound**. The inverse spelling (`maxShrink`) would make `0` mean "refuse any
   * shrink at all" — maximally strict — sitting in the same object literal as a field where `0` is maximally
   * permissive, which is where an inversion would eventually be written and not noticed.
   */
  readonly minRetained?: number;
  /**
   * Refuse a generation larger than this multiple of the current one — `1.5` means "at most half as large again".
   * The ceiling to `minRetained`'s floor: a source that lands duplicated or joined wrong grows a segment as quietly as
   * a partial one shrinks it. A shrinking load is never refused by this bound, and neither is the first load of a
   * segment nor one onto an empty segment, which have no size to multiply. `1` means "never grow".
   *
   * `0` means no bound, as on the two fields above. Setting it makes the load read the current size and fence its
   * publish on it, as `minRetained` does, `allowEmpty: true` or not. The comparison is in floating point, so do not
   * rely on the exact boundary: `100 × 1.15` is `114.99999999999999`.
   */
  readonly maxGrowth?: number;
}

/**
 * Check a guard's bounds, before any round trip: the one check `load` and each output of `materializeMany` share.
 * `where` prefixes each field's name in the message (`''`, or `'outputs[3].'`).
 */
export function validateGuardBounds(guard: LoadGuard | undefined, where: string): void {
  if (guard?.minCardinality !== undefined) {
    const m = guard.minCardinality;
    if (!Number.isInteger(m) || m < 0) {
      throw new ValidationError(
        `${where}guard.minCardinality must be a non-negative integer; got ${String(m)}`,
      );
    }
  }
  if (guard?.minRetained !== undefined) {
    const s = guard.minRetained;
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new ValidationError(
        `${where}guard.minRetained must be a fraction in 0..1; got ${String(s)}`,
      );
    }
  }
  if (guard?.maxGrowth !== undefined) {
    const g = guard.maxGrowth;
    if (!Number.isFinite(g) || (g !== 0 && g < 1)) {
      throw new ValidationError(
        `${where}guard.maxGrowth must be 0 (no bound) or a factor of at least 1; got ${String(g)}`,
      );
    }
  }
}

export interface LoadOptions {
  /**
   * Publish an empty generation over a non-empty one. Off by default: an empty result is far more often an
   * upstream failure than an intent, and the failure is indistinguishable from success once it lands.
   */
  readonly allowEmpty?: boolean;
  readonly guard?: LoadGuard;
  /**
   * Generations to keep below the new pointer as a grace window (default 1). A non-negative integer: anything
   * else (negative, fractional, `NaN`, infinite) throws `ValidationError` before anything is written. Keep at
   * least one: a read that is
   * still fetching chunks from the just-superseded generation would otherwise have it deleted out from under it
   * and pay a re-resolve. A wider window costs storage, and it is what a pinned handle needs: a pin is never
   * re-resolved, so a chunk a pinned read has not fetched fails with `NotFoundError` once its generation is
   * collected. Keep at least one generation for every one that can be written above the pinned one while your
   * longest pinned job runs, on every writer that loads the segment — see "Generations and `keep`" in the loading
   * guide.
   *
   * The segment's row records the generations a load keeps, up to 64, so a load that found nothing above the pointer
   * collects without listing: it deletes the generations its publish pushed out of the window, and lists the segment's
   * objects on every sixteenth generation to take whatever that pass leaves, such as an object a crashed load left
   * below the pointer. A `keep` above 64 records no list and lists on every load, and so does the first load of a
   * row that records none, which then records it; so does a load whose check found the current generation's object
   * gone: the guard's read of it, or, when the guard took the size from the row's summary, one zero-byte read made
   * before a `keep` of 1 or more takes a name. A `keep` at least the generation published collects nothing and asks
   * for nothing.
   */
  readonly keep?: number;
  /**
   * Small, immutable metadata of your own for this generation: what it was computed from, such as a definition's
   * version, the time its data landed, or a run id. A flat object of string keys and string or finite-number values,
   * at most 1,024 bytes as canonical JSON (keys sorted by UTF-16 code unit, no whitespace), and no key longer than 128
   * bytes. It is stored in the generation's object, and written to the segment's row by the write that makes the
   * generation current, so whoever sees this generation as current sees its metadata. It never changes once written:
   * a new generation is how it changes. `undefined` and the empty object store nothing. Anything else that breaks a
   * rule (a boolean, `null`, an array, nesting, `NaN`, a key that is not well-formed text) throws `ValidationError`
   * before a request is made. **Never put a subject's id in it**: an erasure rewrites the ids and carries the metadata
   * over as it is. Sealed under the segment's key when the segment is encrypted.
   */
  readonly metadata?: GenerationMetadata;
  readonly audit?: IAuditSink;
}

/** Why a load did not become current. */
export type LoadRefusal =
  | 'empty'
  | 'min-cardinality'
  | 'min-retained'
  | 'max-growth'
  /**
   * Another writer got there first. Either another load wrote the same generation number first, so the write-once
   * put refused this one and it wrote nothing (`size: 0`); or the segment's registry row changed while the load was
   * writing: another load published, a retention change, a rollback or an erasure wrote the row, or the row was
   * deleted. Once another write has changed the row, the object stays in the bucket, because its generation number
   * may by then name another incarnation's live object; once the row is `destroyed` (dropped or crypto-shredded),
   * the object is deleted, and once the row is gone, so is an object its footer proves this load's own.
   */
  | 'superseded';

export interface LoadResult {
  /**
   * The generation written. Present even when refused: a refusal deletes that object while the segment's row is
   * unchanged or `destroyed`, or gone once its footer proves it this load's own, and leaves it in the bucket once another write has changed the row. A load that lost its
   * generation number to another wrote nothing, and reports `size: 0`.
   */
  readonly generation: number;
  /** Whether this generation is now the segment's current one. */
  readonly published: boolean;
  /** Set only when `published` is false. */
  readonly reason?: LoadRefusal;
  readonly size: number;
  readonly sha256: string;
  readonly chunkCount: number;
  /** Distinct ids in the generation that was written, post-dedup. */
  readonly cardinality: number;
  /**
   * What the segment held when the guard judged it — `null` when there was no current generation, or when no
   * bound needed it. Returned because an alert on `reason: 'min-retained'` is useless without it: "refused" is a
   * page, "refused: 4 → 1" is a diagnosis, and re-reading the segment to find out costs a round trip and races
   * whatever happens next.
   */
  readonly cardinalityBefore: number | null;
  /**
   * The superseded generations collected after publishing. Empty when nothing was published.
   *
   * When collection deleted by name (see {@link LoadOptions.keep}) these are the names it deleted, and one
   * may have been gone already: a delete of an absent object succeeds on every backend and does not say so, so the
   * list names what the pass asked the bucket to delete, not what it found there. A listing pass names the
   * generations it found and deleted. Neither is a receipt, since a concurrent collector may have taken a generation
   * first.
   */
  readonly collected: readonly number[];
}

/** `promise`, marked as observed: a caller that abandons it (a load that failed elsewhere) leaves no unhandled rejection. */
function settled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** What the guard learned of the segment's current generation, and how it learned it. */
interface CurrentSize {
  /** The number of ids it holds, or `null` when there is no current generation to compare against, or its object is gone. */
  readonly cardinality: number | null;
  /** Whether the number came from the row's summary, so the object was not opened and nothing says it is there. */
  readonly fromSummary: boolean;
}

/**
 * Cardinality of the segment's current generation, from the row's summary of it when the row has one it can use, and
 * otherwise from the `.crbm` index rather than its payload. `null` when there is no current generation to compare
 * against.
 *
 * A summary is used only for the generation it names, in the shape the row's keys call for, and a sealed one only if
 * it opens: anything else is no summary, and the tail is read exactly as it was before rows carried one. Using it
 * opens nothing, so a row that names an object that is gone is judged by what it remembers of it, and a caller that
 * must know the object is there (the collection after the publish) looks for itself.
 *
 * The crypto is derived **here** rather than taken from the caller, and that is not a convenience. AAD is bound
 * to a specific generation, so a `CrbmCrypto` passed in from outside would have to be pre-bound to whichever
 * generation turns out to be current — which only this function learns, by reading the row. A caller cannot
 * satisfy that seam even in principle, so offering it would be offering a parameter nobody can fill correctly.
 */
async function currentCardinality(
  ref: SegmentRef,
  deps: LoadDeps,
  record: RegistryRecord | null,
  unwrapped: PromiseLike<Aead> | undefined,
): Promise<CurrentSize> {
  if (record === null || record.currentGen === null || record.status === 'destroyed') {
    return { cardinality: null, fromSummary: false };
  }
  const generation = record.currentGen;
  let aead: Aead | undefined;
  let crypto: CrbmCrypto | undefined;
  const wrapped = record.wrappedDeks;
  if (wrapped !== undefined && wrapped.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but load was given no keystore`,
      );
    }
    // The load already asked the keystore for this row's key (see `loadSegment`): one unwrap serves the guard and the write.
    aead = await (unwrapped ?? deps.keystore.openDek(wrapped));
    const opened = aead;
    crypto = { aead: opened, aadFor: (scope) => aadFor(ref, generation, scope) };
  }
  const described = usableSummary(ref, record, aead);
  if (described !== undefined) return { cardinality: described.cardinality, fromSummary: true };
  let reader;
  try {
    reader = await retryRead(
      () => openGenerationReader(deps.storage, { ...ref, generation }, crypto),
      deps.readRetry,
    );
  } catch (err) {
    // The row names a generation whose OBJECT is gone — the `missing-storage-generation` state a consistency
    // check reports, produced by a partial `dropSegment`, a bucket lifecycle rule, or a restore that brought
    // the registry back without the bucket.
    //
    // `null`, not a throw. The guard exists to protect ids that are still there, and these are already gone:
    // refusing to write would leave the segment unreadable AND unrepairable, which is the opposite of what a
    // guard is for. Writing over it is precisely the repair, and it is what this path did before the guard
    // reached it. A caller who wants to be told instead can run `checkConsistency()`, whose job that is.
    if (!isNotFoundError(err)) throw err;
    return { cardinality: null, fromSummary: false };
  }
  let total = 0;
  for (const n of reader.cardinalities().values()) total += n;
  return { cardinality: total, fromSummary: false };
}

/**
 * Replace a segment's contents with `input`, as one immutable generation, and make it current.
 *
 * `input` is ids, or a whole bitmap as `{ serialized }` portable Roaring bytes or a `{ bitmap }` with
 * `serialize('portable')` ({@link LoadInput}). A bitmap input is checked, decoded and serialized before the first
 * request, and is written from its own chunks; the generation is byte for byte the one its ids would write.
 *
 * Returns what was written and whether it became current. A refusal is **not** an exception: `published: false`
 * with a `reason` is a normal outcome a caller branches on, in the same shape as a successful load, because the
 * interesting cases (a guard tripped, a racing writer won) are operational facts rather than faults.
 */
export function loadSegment(
  ref: SegmentRef,
  input: LoadInput,
  deps: LoadDeps,
  options: LoadOptions = {},
): Promise<LoadResult> {
  return runLoad(ref, (codec) => prepareLoadInput(input, codec), deps, options);
}

/**
 * {@link loadSegment} for the result of a combine, as the chunks it is made of: each `{ chunkKey, bitmap }` is the
 * bitmap of one 16-bit chunk's remainders, and they ascend by key. The chunks are written as they are, so no id is built
 * for a value. What the `*Into` verbs call; the unwired form of them, as {@link loadSegment} is of `store.load`.
 *
 * Every chunk is checked before anything is written. Its bitmap must be one the `codec` made (`codec.owns`, so a codec
 * without it refuses every chunk), its key an integer in `[0, 65535]` above the one before, and its values 16-bit;
 * anything else is a {@link ValidationError}. An empty bitmap is left out, as no empty chunk is stored.
 *
 * **The load consumes the bitmaps it is given.** Writing a chunk may re-encode its bitmap in place for size, which
 * changes its representation and never its members, so pass bitmaps you made for this call and do not reuse them. A
 * bitmap the chunk cache holds, or one a caller still reads, is not one to pass.
 *
 * Everything else is `loadSegment`'s, the options, the result and the refusals included.
 */
export function loadSegmentChunks(
  ref: SegmentRef,
  chunks: AsyncIterable<{ readonly chunkKey: number; readonly bitmap: CodecBitmap }>,
  deps: LoadDeps,
  options: LoadOptions = {},
): Promise<LoadResult> {
  return runLoad(
    ref,
    () => {
      if (typeof chunks !== 'object' || chunks === null || !(Symbol.asyncIterator in chunks)) {
        throw new ValidationError(
          'loadSegmentChunks takes an async iterable of { chunkKey, bitmap }',
        );
      }
      return new ChunkLoadInput(chunks);
    },
    deps,
    options,
  );
}

async function runLoad(
  ref: SegmentRef,
  prepare: (codec: CodecInterface) => ReturnType<typeof prepareLoadInput> | ChunkLoadInput,
  deps: LoadDeps,
  options: LoadOptions,
): Promise<LoadResult> {
  validateUserRef(ref);
  // Before any round trip: a core caller that forgot the codec learns it from this call's name, not the loader's.
  const codec = requireCodec(deps.codec, 'loadSegment');
  const keep = options.keep ?? 1;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new ValidationError(`keep must be a non-negative integer; got ${String(keep)}`);
  }
  const guard = options.guard;
  validateGuardBounds(guard, '');
  // The metadata as of this call, checked and copied before any round trip: what is stored is what the caller passed
  // now, however long the load runs and whatever its object does meanwhile.
  const metadata = copiedMetadata(options.metadata, (message) => {
    throw new ValidationError(message);
  });
  const audit = safeAudit(options.audit ?? NOOP_AUDIT);
  // Still before any round trip: a malformed input costs none, and a `{ bitmap }` is the bitmap as of this call.
  const ids = prepare(codec);
  // Before the first request: the generation is written before the row, so a registry that cannot write a row
  // would leave it behind.
  assertRegistryCanWrite(deps.registry, 'load');

  // One row read, and on a cleartext segment the only one before the publish: the guard's "before", the incarnation
  // this call is acting on, the pointer it derived its decision from, the number it takes next, the write's
  // destroyed check, and the publish's first attempt all come from it. Reusing it is sound because the publish is
  // fenced on this row (its token, the pointer the guard judged, or its absence), so a row that changes before then
  // makes the publish lose rather than land on the strength of a stale read. The write reads the row again after
  // the ids when this read found none, or found key material (see the `row` option of `bulkLoadCrbmGeneration`, whose write `bulkLoadAhead` shares).
  const row = await deps.registry.get(ref);
  const fromToken: Token | undefined = row?.token;
  const fromGeneration = row?.currentGen ?? undefined;

  // The segment's data key, asked for now so the keystore's round trip overlaps the guard's read and the encoding.
  // One unwrap serves both: the guard opens the current generation with it, and the write encrypts with it when the
  // row it reads after the ids carries these same wrappings. Nothing is cached beyond this call. A failed unwrap
  // fails the load where the guard or the write awaits it, and `settled` keeps an abandoned one from rejecting
  // unobserved.
  const wrappedKeys = row?.wrappedDeks;
  const keystore = deps.keystore;
  const unwrapped =
    row !== null &&
    row.status !== 'destroyed' &&
    wrappedKeys !== undefined &&
    wrappedKeys.length > 0 &&
    keystore !== undefined
      ? { wrapped: wrappedKeys, aead: settled((async () => keystore.openDek(wrappedKeys))()) }
      : undefined;

  // Read the "before" cardinality ONLY when a bound needs it. The empty guard needs to know whether the current
  // generation is non-empty; `minRetained` and `maxGrowth` need its size. `minCardinality` compares against the new
  // generation alone, so it costs nothing extra.
  const needsBefore =
    guard?.minRetained !== undefined ||
    guard?.maxGrowth !== undefined ||
    options.allowEmpty !== true;
  const current: CurrentSize = needsBefore
    ? await currentCardinality(ref, deps, row, unwrapped?.aead)
    : { cardinality: null, fromSummary: false };
  const before = current.cardinality;

  // The existence check starts here and is joined where the write needs the number (after the ids are bucketed), so
  // its round trip overlaps the encoding. It reads only the row already in hand and the bucket, so nothing it learns
  // depends on the guard or the ids, and the fences below are untouched: the publish still waits on the row read
  // the guard judged, and the write still reads the row again after the ids.
  const numbering = settled(nextLoadGeneration(ref, deps, row));

  // `publish: false`, deliberately: the guard has to run while the old generation is still authoritative, so the
  // pointer moves below rather than here. The registry is still passed — it is where an existing encrypted
  // segment's DEK lives, and reusing that key is not optional — and the freshly minted one comes back on the
  // result so the deferred publish can store it.
  let written;
  try {
    written = await bulkLoadAhead(
      deps.storage,
      ref,
      { generation: settled(numbering.then((n) => n.generation)), unwrapped },
      ids,
      {
        registry: deps.registry,
        publish: false,
        keystore: deps.keystore,
        requireEncryption: deps.requireEncryption,
        codec: deps.codec,
        clock: deps.clock,
        metadata,
        row,
      },
    );
  } catch (err) {
    // Another loader took this generation number first — write-once refused the second put. That is a lost race,
    // and `LoadRefusal` documents a lost race as `'superseded'`; letting a `WriteConflictError` escape here would
    // make a caller who branches on `published` (as the doc-comment tells them to) miss the one outcome they were
    // told to expect. Nothing was written, so there is nothing to clean up; the refusal is still audited, as every
    // other one is, since a downstream reconciliation needs to know the replacement it asked for did not happen.
    if (!isWriteConflictError(err)) throw err;
    const { generation } = await numbering;
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      generation,
      reason: 'superseded',
      cardinality: 0,
    });
    return {
      generation,
      published: false,
      reason: 'superseded',
      size: 0,
      sha256: '',
      chunkCount: 0,
      cardinality: 0,
      cardinalityBefore: before,
      collected: [],
    };
  }

  // The write joined the number, so it has settled.
  const { generation, checked } = await numbering;
  const key = { namespace: ref.namespace, segment: ref.segment, generation };

  /**
   * Reclaim this load's object after a DEFINITE refusal: a guard that said no before any publish, or a publish that
   * answered `false` or threw a refusal of its own. Never after an ambiguous outcome (a lost response, a timeout):
   * a publish that may still land must not find its object gone.
   *
   * The object is durable and sits above `currentGen`, where collection never looks until a generation above it is
   * current, so the refusal reclaims it here, and deletes only what it can prove is its own. A generation number
   * identifies a generation within one incarnation of a row, and nothing more (invariant 1): once the row was
   * purged, the object under this load's key can be another writer's, because a re-created name's numbering restarts
   * and its loads take numbers a drop or a collection freed, this one included. Deleting that would put a row over a
   * missing generation, the forbidden `missing-storage-generation` state; leaving an orphan behind is strictly the
   * better failure.
   *
   * - The same row (an unchanged token): nothing was written since this load read it, so the number is its own.
   * - A `destroyed` row: no reader resolves any of its generations, so whatever is under the key is garbage.
   * - No row, or a row with key material when this load wrote cleartext (a cleartext object has no place in an
   *   encrypted segment's bucket, where a rollback could point at it and a shred would attest its bytes unreadable):
   *   the object under the key must be proved this load's by its fingerprint, from one read of its footer. One that
   *   is gone, is another object, or cannot be read is kept.
   */
  const reclaim = async (): Promise<void> => {
    const now = await deps.registry.get(ref);
    // A row that differs only in its leases is the row this load read: no write that took its number landed.
    if (
      now !== null &&
      (now.token === fromToken ||
        now.status === 'destroyed' ||
        (row !== null && onlyLeasesDiffer(row, now)))
    ) {
      await deps.storage.delete(key);
      return;
    }
    const keyed = now !== null && now.wrappedDeks !== undefined && now.wrappedDeks.length > 0;
    if (
      (now === null || (keyed && !written.encrypted)) &&
      (await holdsObject(deps.storage, key, written.fingerprint))
    ) {
      await deps.storage.delete(key);
    }
  };

  // Set when a registry write of this load's publish ended without an answer: a refusal after that cannot say whether
  // the write landed first.
  let unanswered = false;

  const refuse = async (reason: LoadRefusal): Promise<LoadResult> => {
    await reclaim();
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      generation,
      reason,
      cardinality: written.cardinality,
      ...(unanswered ? { unanswered: true as const } : {}),
    });
    // Constructed field by field, never spread from the write result. That result now carries `wrappedDeks` —
    // wrapped key material — and a spread would put it on a public, JSON-serialisable object that a load job
    // will reasonably `logger.info({ result })`. Declared shapes are not a filter at runtime.
    return {
      generation,
      published: false,
      reason,
      size: written.size,
      sha256: written.sha256,
      chunkCount: written.chunkCount,
      cardinality: written.cardinality,
      cardinalityBefore: before,
      collected: [],
    };
  };

  if (written.cardinality === 0 && options.allowEmpty !== true && (before ?? 0) > 0) {
    return refuse('empty');
  }
  if (guard?.minCardinality !== undefined && written.cardinality < guard.minCardinality) {
    return refuse('min-cardinality');
  }
  if (guard?.minRetained !== undefined && before !== null) {
    if (written.cardinality < before * guard.minRetained) return refuse('min-retained');
  }
  // Last, so a load that breaks an older bound as well is refused for the same reason it always was. Not applied with
  // no current size, or a zero one: no ceiling is a multiple of nothing, and refusing a refill would wedge the repair.
  if (guard?.maxGrowth !== undefined && guard.maxGrowth !== 0 && before !== null && before > 0) {
    if (written.cardinality > before * guard.maxGrowth) return refuse('max-growth');
  }

  // What judges a lease: the load's clock, when it has one. Without one a collection holds every lease.
  const leasesNow =
    deps.clock === undefined ? undefined : (): number => (deps.clock as Clock).now();

  // Fence the publish on the row the guard judged.
  //
  // Forward-only is right for an UNGUARDED load: its ids come from upstream, so losing a race costs nothing that
  // the winner did not also bring. A guarded load is a different animal — it derived its decision from a
  // particular generation's cardinality, which makes it exactly the writer invariant 1 says must publish with
  // `expectFrom`. Without that, anything published between the "before" read and this publish voids the guard's
  // premise while the guard still reports success: reproduced, two loaders on a fresh segment let an EMPTY
  // generation land over a thousand ids, under default options, because `before` was read as "no row".
  //
  // `expectToken` goes on regardless. It is incarnation identity rather than a derivation fence, it costs
  // nothing legitimate — a token only changes when a row write lands (a policy write, a lease) — and it is what stops this call publishing
  // into a segment that merely reuses the name it started with. A row that differs from the one this load read only
  // in its leases does not refuse it (`expectRow`): readers write those, and they say nothing about what it derived.
  let published: PublishResult;
  try {
    published = await publishGenerationKept(deps.registry, key, {
      keep,
      leasesNow,
      row,
      wrappedDeks: written.wrappedDeks,
      summary: written.summary,
      cleartext: !written.encrypted,
      ...(fromToken === undefined ? {} : { expectToken: fromToken, expectRow: row }),
      ...(needsBefore && fromGeneration !== undefined ? { expectFrom: fromGeneration } : {}),
      // The third case, and the one the two fences above structurally cannot cover: the guard judged a segment
      // that had NO ROW. Both `expectFrom` and `expectToken` compare against a value read from a row, so with no
      // row both are omitted and the publish becomes a bare forward-only advance — which lands over anything
      // that appeared in between. `before` was `null`, so the empty, `minRetained` and `maxGrowth` bounds had nothing
      // to judge and passed vacuously. Verified: an empty generation published over a thousand ids that a
      // concurrent writer had created meanwhile, reporting success. A guarded write therefore has to fence on
      // the ABSENCE it relied on, exactly as it fences on the pointer it relied on.
      ...(needsBefore && row === null ? { expectAbsent: true } : {}),
      // A registry write that fails without an answer is reconciled by reading the row: the pointer at this number
      // is this load's publish only over the object this load wrote, which one footer read proves.
      holdsOwnObject: () => provesOwnObject(deps.storage, key, written.fingerprint),
      // And the wait before a fresh write, when the first left the row as it was.
      clock: deps.clock,
      rng: deps.rng ?? deps.readRetry?.rng,
      onUnanswered: () => {
        unanswered = true;
      },
    });
  } catch (err) {
    // A refusal the publish states by throwing is as definite as a `false`: each of these is raised before that
    // attempt's compare-and-swap or create is sent, so nothing landed from it. `publishGeneration` raises three: a
    // `destroyed` row (no fence answered first, as for an unguarded load that found no row), new key material for a
    // segment that already has a generation, and a cleartext object for a row with key material. The registries raise
    // a `ValidationError` only from checks made before a write is sent (the ref, the record or patch, the row's size
    // cap), and never a `KeyUnavailableError`. Anything else may still land, and keeps the object: above all the
    // `TransientError` of a registry write the publish could not settle by reading the row back.
    if (isValidationError(err) || err instanceof KeyUnavailableError) await reclaim();
    throw err;
  }
  if (!published.published) return refuse('superseded');

  audit.onEvent({
    kind: 'segment.publish',
    segment: ref.segment,
    namespace: ref.namespace,
    generation,
  });

  // The guard's read of the current generation found its object gone: the row named a generation that is not in the
  // bucket, so the generation below the new one that a listing keeps as the window is the one a name would take.
  // This load repairs the gap, and lists. `before` is null for a row that names a generation only when its object was
  // not found (a row with no pointer numbers 0, which has nothing below it to take, and a destroyed row is refused
  // at its publish). A guard that took the size from the row's summary opened nothing, so it learned nothing about
  // the object: the collection looks for itself, with one zero-byte read of it, only if it is about to delete by name
  // a generation the window keeps. A load that made no read at all (`allowEmpty` with neither `minRetained` nor
  // `maxGrowth`) cannot tell.
  const currentObjectGone = needsBefore && before === null;
  const collected = await collectAfterLoad(ref, deps, {
    generation,
    keep,
    byName: checked && deps.collectByListing !== true,
    currentGone: currentObjectGone,
    ...(leasesNow === undefined ? {} : { leases: { now: leasesNow } }),
    kept: published.kept,
    ...(current.fromSummary && fromGeneration !== undefined
      ? { proveCurrent: { ...ref, generation: fromGeneration } }
      : {}),
  });
  return {
    generation,
    published: true,
    size: written.size,
    sha256: written.sha256,
    chunkCount: written.chunkCount,
    cardinality: written.cardinality,
    cardinalityBefore: before,
    collected,
  };
}
