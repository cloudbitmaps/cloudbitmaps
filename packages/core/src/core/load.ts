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
 * pointer), so a refused load deletes its own object before returning, while the segment's row is unchanged (or
 * differs only in its leases), gone or `destroyed`, or has key material when the load wrote cleartext. Under a row
 * that is gone or keyed, one read of the object's footer must match what the load wrote first: the footer carries the
 * write identity this load drew, so it keeps another writer's object, a re-created segment's load of the same cleartext
 * ids included. Once another write has otherwise changed the row, the object stays: its number may by then name another
 * writer's object, and the decision there comes from the row. It is an orphan until a
 * later load's collection takes it, and until then a rollback onto it is refused unless `allowUnknown` is passed, since the
 * row never recorded it.
 */
import { checkRequireEncryption, requireFiniteNumber, requireInteger } from './check';
import { type IAuditSink, NOOP_AUDIT, checkedAuditSink, safeAudit } from './audit';
import { incarnationField } from './token';
import { type CodecBitmap, type CodecInterface, requireCodec } from './codec';
import { bulkLoadAhead, cleartextUnderRequiredEncryption } from './bulk-load';
import { requireEntropy } from './crbm-write';
import { provenObject, openGenerationReader, provesOwnObject } from './crbm-open';
import { readSeed, wantsSeed } from './ledger-seed';
import { footerCrcOf } from './crbm/fingerprint';
import { publishGenerationKept, type PublishResult } from './publish';
import type { Clock, Entropy, Rng } from './determinism';
import { heldGenerations, onlyLeasesDiffer } from './leases';
import { aadFor } from './crypto';
import type { Aead, CrbmCrypto, IKeystore, WrappedDek } from './crypto';
import {
  KeyUnavailableError,
  ValidationError,
  isKeyUnavailableError,
  isNotFoundError,
  isValidationError,
  isWriteConflictError,
} from './errors';
import {
  collectAfterLoad,
  nextLoadGeneration,
  pointerOnDeletedError,
  watchDeletes,
} from './generation-gc';
import {
  ChunkLoadInput,
  type LoadInput,
  isSourceError,
  prepareLoadInput,
  sortedLoadInput,
  wantsSorted,
} from './load-input';
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
   * The source of the write's identity: 12 random bytes the new generation's footer carries (for a cleartext generation;
   * an encrypted one carries its index's AEAD nonce), so two loads of the same ids at the same number are two objects
   * and every check that a footer is "mine" names this write. Required: a load without one (a JavaScript caller can
   * leave it out) is refused with {@link ValidationError} before any read, keystore call or write.
   * `@cloudbitmaps/roaring` supplies Web Crypto's by default.
   */
  readonly entropy: Entropy;
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
 * `minCardinality` judges the new generation alone. `minRetained` and `maxGrowth` judge it against the **current**
 * generation's cardinality, which the load takes from the registry row's summary of it when the row has a usable one,
 * and otherwise from the `.crbm` index (one object-header read, never the payload), and only when a bound needs it.
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
 * Check a guard's bounds before any round trip, and copy them: the one check `load` and each output of
 * `materializeMany` share. The copy is what the load judges, so a guard object the caller reuses or changes while the
 * call runs cannot change the bound it is judged by. `where` prefixes each field's name in the message (`''`, or
 * `'outputs[3].'`).
 */
export function checkedGuard(guard: LoadGuard | undefined, where: string): LoadGuard | undefined {
  if (guard === undefined || guard === null) return undefined;
  // A value that is not a number is named by its type: `'2'` printed as "got 2" would read as a valid bound.
  const shown = (v: unknown): string =>
    typeof v === 'number' ? String(v) : Array.isArray(v) ? 'an array' : `a ${typeof v}`;
  // A guard of the wrong shape would destructure to no bounds at all, so `{ guard: 0.5 }` meant as a floor would publish
  // a load it was written to refuse.
  if (typeof guard !== 'object' || Array.isArray(guard)) {
    throw new ValidationError(
      `${where}guard must be an object of bounds, such as { minRetained: 0.5 }; got ${shown(guard)}`,
    );
  }
  // A misspelt bound (`minRetain`) would otherwise be no bound at all. A key whose value is `undefined` reads as absent,
  // so a spread of bounds keeps working.
  const bounds = guard as Record<string, unknown>;
  const unknown = Object.keys(bounds).filter(
    (k) =>
      k !== 'minCardinality' && k !== 'minRetained' && k !== 'maxGrowth' && bounds[k] !== undefined,
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `${where}guard: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}; ` +
        'it takes { minCardinality, minRetained, maxGrowth }',
    );
  }
  const { minCardinality, minRetained, maxGrowth } = guard;
  if (minCardinality !== undefined) {
    requireInteger(minCardinality, { min: 0, what: `${where}guard.minCardinality` });
  }
  if (minRetained !== undefined) {
    requireFiniteNumber(minRetained, { min: 0, max: 1, what: `${where}guard.minRetained` });
  }
  if (
    maxGrowth !== undefined &&
    (!Number.isFinite(maxGrowth) || (maxGrowth !== 0 && maxGrowth < 1))
  ) {
    throw new ValidationError(
      `${where}guard.maxGrowth must be 0 (no bound) or a factor of at least 1; got ${shown(maxGrowth)}`,
    );
  }
  return Object.freeze({
    ...(minCardinality === undefined ? {} : { minCardinality }),
    ...(minRetained === undefined ? {} : { minRetained }),
    ...(maxGrowth === undefined ? {} : { maxGrowth }),
  });
}

/**
 * Options of `store.load` and of core's `loadSegment`: what a load may publish (`allowEmpty`, `guard`), what it keeps
 * (`keep`) and what it records (`metadata`, `audit`).
 */
export interface LoadOptions {
  /**
   * Publish an empty generation over a non-empty one. Off by default: an empty result is far more often an
   * upstream failure than an intent, and the failure is indistinguishable from success once it lands.
   */
  readonly allowEmpty?: boolean;
  /**
   * Bounds a plausible result must meet, judged before the pointer moves; a load outside them is refused
   * (`published: false`), not thrown. See {@link LoadGuard}.
   */
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
   * The window is the `keep` most recently current generations below the one the load publishes, so the generation the
   * load superseded comes first. After a rollback that is the one the rollback restored, and it stays in the window of
   * every load after it, ahead of the generations the rollback moved away from, for as many loads as `keep` says.
   *
   * The segment's row records the generations a load keeps, up to 127.
   *
   * With a `keep` of at most 64, a load whose number one existence check found free deletes by name the generations
   * its publish pushed out of the window, and lists the segment's objects on every sixteenth generation to take
   * whatever that pass leaves, such as an object a crashed load left below the pointer.
   *
   * A load lists instead on every load when `keep` is above 64, when the row has a pointer and no usable record (the
   * load starts one from the bucket), when the row's record names more than 64 generations below the pointer that no
   * lease holds (as after a `keep` above 64, or `materializeMany`), or when the guard's read, or the zero-byte read
   * before a delete by name, finds the current generation's object missing. A publish that a read of the row settles
   * after its last attempt lists too. A `keep` at least the generation published collects nothing and asks for nothing.
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
  /** Audit sink for this load: it receives `segment.publish`, or `segment.load-refused` when the load is refused. */
  readonly audit?: IAuditSink;
  /**
   * The ids ascend: write them as they are read, one chunk at a time, while the object uploads, so the load holds one
   * chunk and the writer's index of the chunks written (up to about 7 MiB, about 8 MiB for an encrypted segment,
   * derived, at the 65,536 chunks a segment can have) rather than the whole generation, whatever the segment's size.
   * Repeats are fine (an id equal to the one before is skipped); an id lower than the one before throws
   * `ValidationError`, naming its position and never the id. The object is the same, byte for byte, as an unsorted load
   * of the same ids writes under the same write identity.
   *
   * For ids only (an iterable or an async iterable): with `{ serialized }`, `{ bitmap }` or a `RoaringBitmap32` of the
   * flavor's own `roaring` (one from another copy loads as its ids, and takes `sorted`), and on core's
   * `loadSegmentChunks`, it throws `ValidationError`, as does a value that is not a boolean, before any request.
   *
   * The ids are read after the segment's row is read and judged, and after its number and key are settled, so a load
   * that refuses a destroyed or keyless segment reads none of them. They are read while the object uploads: an error
   * they raise, or a refused id, fails the upload, and no object is committed, but the parts uploaded before it may
   * already have been billed (see the production guide). That error reaches the caller as the very object raised,
   * and the storage driver never sees it. The ids can be read once: a storage driver that runs its write again gets
   * `IntegrityError`, and nothing is written.
   */
  readonly sorted?: boolean;
}

/** The bounds a guard can refuse a generation for: every {@link LoadRefusal} but a lost race. */
export type GuardRefusal = Exclude<LoadRefusal, 'superseded'>;

/**
 * The bound a generation of `cardinality` ids breaks over a current one of `before` (`null`: none, or not read), in the
 * order a load checks them, or `undefined`. Pure: the one judgement a load and a dry run share.
 */
function guardRefusal(
  cardinality: number,
  before: number | null,
  guard: LoadGuard | undefined,
  allowEmpty: boolean | undefined,
): GuardRefusal | undefined {
  if (cardinality === 0 && allowEmpty !== true && (before ?? 0) > 0) return 'empty';
  if (guard?.minCardinality !== undefined && cardinality < guard.minCardinality) {
    return 'min-cardinality';
  }
  if (
    guard?.minRetained !== undefined &&
    before !== null &&
    cardinality < before * guard.minRetained
  ) {
    return 'min-retained';
  }
  // Last, so a load that breaks an older bound as well is refused for the same reason it always was. Not applied with
  // no current size, or a zero one: no ceiling is a multiple of nothing, and refusing a refill would wedge the repair.
  if (
    guard?.maxGrowth !== undefined &&
    guard.maxGrowth !== 0 &&
    before !== null &&
    before > 0 &&
    cardinality > before * guard.maxGrowth
  ) {
    return 'max-growth';
  }
  return undefined;
}

/** What a dry run learns about one write: the size it would replace, and the bound that would refuse it. */
export interface LoadJudgement {
  /**
   * The current generation's size: `null` when there is none or its object is gone, and, where no bound needs the size,
   * when its object could not be read, as the load would not read it. Always asked for.
   */
  readonly cardinalityBefore: number | null;
  /** The bound a load of this size would be refused for now, absent when it would publish. */
  readonly wouldRefuse?: GuardRefusal;
  /** The requests the judgement made: the row, and the object's index when the row had no usable summary. */
  readonly reads: number;
}

/**
 * Judge a write of `cardinality` ids into `ref` as a load would, and write nothing: read the row and the current size
 * as the load reads them, and apply the same bounds. A `destroyed` segment throws the `ValidationError` a load's write
 * would, and an encrypted one with no keystore the `KeyUnavailableError`. What it says holds for now only: a load
 * made later is judged against the segment as it is then.
 */
export async function judgeLoad(
  ref: SegmentRef,
  cardinality: number,
  deps: Omit<LoadDeps, 'entropy'>,
  options: Pick<LoadOptions, 'allowEmpty' | 'guard'> = {},
): Promise<LoadJudgement> {
  validateUserRef(ref, 'judgeLoad');
  requireInteger(cardinality, { min: 0, what: 'judgeLoad: cardinality' });
  const guard = checkedGuard(options.guard, '');
  // What a load refuses before its guard, in the order it refuses it.
  assertRegistryCanWrite(deps.registry, 'load');
  checkRequireEncryption(deps.requireEncryption);
  if (deps.requireEncryption === true && deps.keystore === undefined) {
    throw new ValidationError('requireEncryption: a load needs a keystore to write encrypted');
  }
  const row = await deps.registry.get(ref);
  if (row?.status === 'destroyed') {
    throw new ValidationError(
      `segment "${ref.segment}" is destroyed — refusing to write: no generation resolves through a destroyed row; ` +
        `use a new segment`,
    );
  }
  const cleartext = row?.wrappedDeks === undefined || row.wrappedDeks.length === 0;
  if (deps.requireEncryption === true && row !== null && row.currentGen !== null && cleartext) {
    throw cleartextUnderRequiredEncryption(ref, row.currentGen);
  }
  // The segment's key, asked for as the load asks for it: the load needs it to write, so a key it cannot have refuses
  // the judgement too, whether or not a bound reads the current object with it.
  const wrapped = row?.wrappedDeks;
  let aead: PromiseLike<Aead> | undefined;
  if (row !== null && wrapped !== undefined && wrapped.length > 0) {
    if (deps.keystore === undefined) {
      throw new KeyUnavailableError(
        `segment "${ref.segment}" is encrypted but load was given no keystore`,
      );
    }
    aead = Promise.resolve(await deps.keystore.openDek(wrapped));
  }
  // A load that no bound needs the size for never reads the current object, so nothing wrong with that object stops it
  // (damaged, gone, a newer format, a read that failed): the judgement reports the size it could not read as `null`
  // instead of failing where the load would publish.
  let current: CurrentSize;
  try {
    current = await currentCardinality(ref, deps, row, aead);
  } catch (err) {
    if (sizeNeeded(guard, options.allowEmpty)) throw err;
    current = { cardinality: null, fromSummary: false };
  }
  const wouldRefuse = guardRefusal(cardinality, current.cardinality, guard, options.allowEmpty);
  const openedObject = row !== null && row.currentGen !== null && !current.fromSummary;
  return {
    cardinalityBefore: current.cardinality,
    ...(wouldRefuse === undefined ? {} : { wouldRefuse }),
    reads: openedObject ? 2 : 1,
  };
}

/** Whether a load reads the current generation's size: for the empty refusal, or a ratio bound. */
function sizeNeeded(guard: LoadGuard | undefined, allowEmpty: boolean | undefined): boolean {
  return guard?.minRetained !== undefined || guard?.maxGrowth !== undefined || allowEmpty !== true;
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
   * writing: another load published, a retention change, a rollback or an erasure wrote the row, the row was
   * deleted, or a row appeared where the load found none. Once another write has changed the row, the object stays in
   * the bucket, still billed, until a later load's collection deletes it or the segment is dropped, because its
   * generation number may by then name another writer's object; until it goes, a rollback onto it needs
   * `allowUnknown`, as onto any generation the row does not know. Once the row is `destroyed` (crypto-shredded,
   * destroyed in the clear or dropped), the object is deleted; once the row is gone, so is an object whose footer
   * matches what this load wrote (another load's object of the same ids is not a match: the footer carries each write's
   * own identity), and so is a cleartext one under a row with key material.
   */
  | 'superseded';

/**
 * What a load did: the generation it wrote, whether that is now current (`published`, and `reason` when not), the
 * object it wrote and what it collected.
 */
export interface LoadResult {
  /**
   * The generation written. Present even when refused: a refusal deletes that object while the segment's row is
   * unchanged or `destroyed`, and, once one read of its footer matches what the load wrote, when the row is gone or,
   * for a cleartext object, has key material. Under any other row another write changed, the object stays in the
   * bucket, an orphan a later load's collection takes, and until then a rollback onto it needs `allowUnknown`. A load that lost its
   * generation number to another wrote nothing, and reports `size: 0`.
   */
  readonly generation: number;
  /** Whether this generation is now the segment's current one. */
  readonly published: boolean;
  /** Set only when `published` is false. */
  readonly reason?: LoadRefusal;
  /**
   * Bytes of the generation's object as stored, or 0 when another load took the generation number first and
   * nothing was written.
   */
  readonly size: number;
  /**
   * SHA-256 of the object as stored, or `''` when another load took the generation number first. The library neither
   * keeps nor checks it; reads are checked with CRC32C.
   */
  readonly sha256: string;
  /** Non-empty chunks in the generation written (at most 65,536), or 0 when nothing was written. */
  readonly chunkCount: number;
  /** Distinct ids in the generation that was written, post-dedup, or 0 when nothing was written. */
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

/**
 * Whether a write that threw `err` lost its number to another load: a write-once conflict the write raised. One the
 * load's input raised (a source reading another segment through a pin, say) is the source's, and is handed on as it is.
 */
function lostNumberRace(err: unknown): boolean {
  return isWriteConflictError(err) && !isSourceError(err);
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
 * it opens: anything else is no summary, and the tail is read. Using it
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
  deps: Omit<LoadDeps, 'entropy'>,
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
  return { cardinality: reader.count(), fromSummary: false };
}

/**
 * Replace a segment's contents with `input`, as one immutable generation, and make it current.
 *
 * `input` is ids, or a whole bitmap as `{ serialized }` portable Roaring bytes or a `{ bitmap }` with
 * `serialize('portable')` ({@link LoadInput}). A bitmap input is checked, decoded and serialized before the first
 * request, and is written from its own chunks; the generation holds chunk for chunk what its ids would write, and carries its own write
 * identity in the footer like any other.
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
  return runLoad(
    ref,
    (codec) => sortedLoadInput(prepareLoadInput(input, codec), options.sorted),
    deps,
    options,
  );
}

/**
 * Ask the keystore for the segment's data key now, when the row carries wrappings of one and the row is live: the
 * unwrap's round trip then overlaps the guard's read and the encoding. `undefined` when there is nothing to unwrap.
 */
function startUnwrap(
  row: RegistryRecord | null,
  keystore: IKeystore | undefined,
): { wrapped: readonly WrappedDek[]; aead: Promise<Aead> } | undefined {
  const wrappedKeys = row?.wrappedDeks;
  return row !== null &&
    row.status !== 'destroyed' &&
    wrappedKeys !== undefined &&
    wrappedKeys.length > 0 &&
    keystore !== undefined
    ? { wrapped: wrappedKeys, aead: settled((async () => keystore.openDek(wrappedKeys))()) }
    : undefined;
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
      if (wantsSorted(options.sorted)) {
        throw new ValidationError(
          'loadSegmentChunks takes no sorted: true: its chunks ascend by key already, and are written as they are',
        );
      }
      return new ChunkLoadInput(chunks);
    },
    deps,
    options,
  );
}

/** What a load writes from, as its input was checked before the first request. */
type PreparedLoadInput = ReturnType<typeof sortedLoadInput> | ChunkLoadInput;

async function runLoad(
  ref: SegmentRef,
  prepare: (codec: CodecInterface) => PreparedLoadInput,
  deps: LoadDeps,
  options: LoadOptions,
): Promise<LoadResult> {
  validateUserRef(ref, 'load');
  checkedAuditSink(options.audit, 'load');
  // Before any round trip: a core caller that forgot the codec learns it from this call's name, not the loader's.
  const codec = requireCodec(deps.codec, 'loadSegment');
  const entropy = requireEntropy(deps.entropy, 'a load');
  const keep = options.keep === undefined ? 1 : options.keep;
  requireInteger(keep, { min: 0, what: 'keep' });
  const guard = checkedGuard(options.guard, '');
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
  // the ids (before them, for sorted ids, which it reads during the write) when this read found none, or found key
  // material (see the `row` option of `bulkLoadCrbmGeneration`, whose write `bulkLoadAhead` shares).
  const row = await deps.registry.get(ref);
  const fromToken: Token | undefined = row?.token;
  const fromGeneration = row?.currentGen ?? undefined;

  // The segment's data key, asked for now so the keystore's round trip overlaps the guard's read and the encoding.
  // One unwrap serves both: the guard opens the current generation with it, and the write encrypts with it when the
  // row it reads again (after the ids, or before sorted ones) carries these same wrappings. Nothing is cached beyond this call. A failed unwrap
  // fails the load where the guard or the write awaits it, and `settled` keeps an abandoned one from rejecting
  // unobserved.
  const unwrapped = startUnwrap(row, deps.keystore);

  // Read the "before" cardinality ONLY when a bound needs it. The empty guard needs to know whether the current
  // generation is non-empty; `minRetained` and `maxGrowth` need its size. `minCardinality` compares against the new
  // generation alone, so it costs nothing extra.
  const needsBefore = sizeNeeded(guard, options.allowEmpty);
  const current: CurrentSize = needsBefore
    ? await currentCardinality(ref, deps, row, unwrapped?.aead)
    : { cardinality: null, fromSummary: false };
  const before = current.cardinality;

  // The existence check starts here and is joined where the write needs the number (after the ids are bucketed, or,
  // for sorted ids, before the first is read), so its round trip overlaps the encoding. It reads only the row already
  // in hand and the bucket, so nothing it learns depends on the guard or the ids, and the fences below are untouched:
  // the publish still waits on the row read the guard judged, and the write still reads the row again first.
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
        entropy,
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
    if (!lostNumberRace(err)) throw err;
    const { generation } = await numbering;
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      ...incarnationField(fromToken),
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
  const { generation, checked, listed } = await numbering;
  const key = { namespace: ref.namespace, segment: ref.segment, generation };

  /**
   * Reclaim this load's object after a DEFINITE refusal: a guard that said no before any publish, or a publish that
   * answered `false` or threw a refusal of its own. Never after an ambiguous outcome (a lost response, a timeout):
   * a publish that may still land must not find its object gone.
   *
   * The object is durable and sits above `currentGen`, where collection never looks until a generation above it is
   * current, so the refusal reclaims it here, and deletes only what the row it reads, or one read of the object's footer, says it wrote. A
   * generation number identifies a generation within one incarnation of a row, and nothing more (invariant 1): once the
   * row was purged, the object under this load's key can be another writer's, because a re-created name's numbering
   * restarts and its loads take numbers a drop or a collection freed, this one included. Deleting that would put a row
   * over a missing generation, the forbidden `missing-storage-generation` state; leaving an orphan behind is strictly
   * the better failure.
   *
   * - The same row (an unchanged token): nothing was written since this load read it, so the number is its own.
   * - A `destroyed` row: no reader resolves any of its generations, so whatever is under the key is garbage.
   * - No row, or a row with key material when this load wrote cleartext (a cleartext object has no place in an
   *   encrypted segment's bucket, where a rollback could point at it and a shred would attest its bytes unreadable):
   *   the object under the key must match what this load wrote, by its fingerprint, from one read of its footer. One
   *   that is gone, does not match, or cannot be read is kept. The delete passes the version that read reported, so on
   *   a storage driver that reports `conditionalDelete` it removes that object and no other: a number taken again
   *   between the read and the delete keeps the object put under it since, and the refused delete is a fault of the
   *   cleanup, which the refusal swallows. The fingerprint names one write, since the footer's checksum covers the write
   *   identity this load drew: under no row, a re-created name's load of the same cleartext ids writes the same chunks
   *   under another identity, so a refusal that straddles a purge keeps that load's generation.
   * - Any other row: the object stays, an orphan a later load's collection takes. Another write has
   *   changed the row, and the row does not say whether that write took this number: the object under it may be a
   *   generation another load published or still will, and keeping an orphan is the cheaper failure.
   *
   * The first two delete by number, with no condition: the decision comes from the row, and the object is this
   * load's own write, of which the write reports no version.
   *
   * One round trip remains between the read of the row and the delete, and a rollback that lands inside it onto this
   * object leaves the pointer on an object that is gone. So a delete under a row that is not `destroyed` is followed by
   * one more read of it ({@link watchDeletes}), and the generation it returns is the one that read found named and
   * gone; `undefined` otherwise. A row that is gone, or a tombstone, has no pointer a rollback moves.
   */
  const reclaim = async (): Promise<number | undefined> => {
    const watch = watchDeletes(deps, ref);
    const now = await deps.registry.get(ref);
    // A row that differs only in its leases is the row this load read: no write that took its number landed.
    if (
      now !== null &&
      (now.token === fromToken ||
        now.status === 'destroyed' ||
        (row !== null && onlyLeasesDiffer(row, now)))
    ) {
      await deps.storage.delete(key);
      watch.deleted(generation);
      return now.status === 'destroyed' ? undefined : watch.settle(now);
    }
    const keyed = now !== null && now.wrappedDeks !== undefined && now.wrappedDeks.length > 0;
    if (now !== null && !(keyed && !written.encrypted)) return undefined;
    const own = await provenObject(deps.storage, key, written.fingerprint);
    if (own === null) return undefined;
    await deps.storage.delete(key, { ifVersion: own.version });
    watch.deleted(generation);
    return now === null ? undefined : watch.settle(now);
  };

  // Set when a registry write of this load's publish ended without an answer, or in a conflict its registry marked as
  // one that may follow the write's own landing: a refusal after that cannot say whether the write landed first.
  let unanswered = false;

  // Best-effort, where it is called: the refusal or the publish's own error is the answer, and a fault in the cleanup
  // must not replace it. That holds for a fault of the read that proves the object its own too: it keeps the object,
  // and a fault is never taken for a delete. An object left behind is an orphan, which a later load's collection takes
  // once a generation above it is current. The one answer it gives is the generation the pointer names after the reclaim deleted it,
  // which a refusal turns into an error: the segment no longer reads.
  const tidy = (): Promise<number | undefined> => reclaim().catch(() => undefined);

  /** The error for a refusal whose reclaim left the pointer on the object it deleted, `refusal` saying which. */
  const refusedOverMissing = (refusal: string, missing: number): Error =>
    pointerOnDeletedError(ref, { kind: 'refused-load', refusal }, missing);

  const refuse = async (reason: LoadRefusal): Promise<LoadResult> => {
    const missing = await tidy();
    audit.onEvent({
      kind: 'segment.load-refused',
      segment: ref.segment,
      namespace: ref.namespace,
      ...incarnationField(fromToken),
      generation,
      reason,
      cardinality: written.cardinality,
      ...(unanswered ? { unanswered: true as const } : {}),
    });
    // After the refusal is on the record: what the caller is told is that the segment no longer reads.
    if (missing !== undefined) throw refusedOverMissing(reason, missing);
    // Constructed field by field, never spread from the write result. That result carries `wrappedDeks` —
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

  const refusal = guardRefusal(written.cardinality, before, guard, options.allowEmpty);
  if (refusal !== undefined) return refuse(refusal);

  // What judges a lease: the load's clock, when it has one. Without one it cannot tell a live lease from an ended
  // one, so it reads none, and its collection spares no leased generation.
  const leasesNow =
    deps.clock === undefined ? undefined : (): number => (deps.clock as Clock).now();

  // Fence the publish on what this load found: the row it read, or that there was none.
  //
  // `expectToken` goes on whenever there was a row. It is incarnation identity rather than a derivation fence, it costs
  // nothing legitimate (a token only changes when a row write lands: a policy write, a lease), and it is what stops
  // this call publishing into a segment that merely reuses the name it started with. A row that differs from the one
  // this load read only in its leases does not refuse it (`expectRow`): readers write those, and they say nothing
  // about what it derived.
  //
  // A guarded load also fences on the pointer it judged (`expectFrom`). It derived its decision from a particular
  // generation's cardinality, which makes it exactly the writer invariant 1 says must publish with `expectFrom`:
  // without that, anything published between the "before" read and this publish voids the guard's premise while the
  // guard still reports success. An unguarded load needs no fence on the pointer: its ids come from upstream, so a
  // newer generation costs nothing it knew about.
  // A publish over a row with no usable ledger starts one with the window a count keeps, read from the bucket.
  const currentObjectGone = needsBefore && before === null;
  let seed: Awaited<ReturnType<typeof readSeed>> | undefined;
  if (wantsSeed(row)) {
    try {
      // The leases the seed holds come from the row as it is now, one read at a birth: a lease taken while the object was
      // written is on it, and the first read, before the write, would miss it. A lease taken after this read, before the
      // publish's write, is not named, and stays in the bucket for its lease.
      const leased: ReadonlySet<number> =
        leasesNow === undefined
          ? new Set()
          : heldGenerations(await deps.registry.get(ref), leasesNow());
      seed = await readSeed(
        deps.storage,
        ref,
        row,
        generation,
        keep,
        listed,
        leased,
        deps.readRetry,
      );
    } catch (err) {
      // Nothing this load wrote was published, so its own object is reclaimed as a refused load's is (the reclaim re-reads the row).
      const missing = await tidy();
      if (missing !== undefined)
        throw refusedOverMissing(
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          missing,
        );
      throw err;
    }
  }
  let published: PublishResult;
  try {
    published = await publishGenerationKept(deps.registry, key, {
      ...(seed === undefined ? {} : { seed }),
      keep,
      leasesNow,
      row,
      wrappedDeks: written.wrappedDeks,
      summary: written.summary,
      footerCrc: footerCrcOf(written.fingerprint),
      cleartext: !written.encrypted,
      ...(fromToken === undefined ? {} : { expectToken: fromToken, expectRow: row }),
      ...(needsBefore && fromGeneration !== undefined ? { expectFrom: fromGeneration } : {}),
      // A load that found NO ROW fences on that absence, guarded or not, so a row that appeared since refuses it.
      // `expectFrom` and `expectToken` both compare against a value read from a row, so with no row both are omitted,
      // and the publish would otherwise be a bare forward-only advance over whatever appeared in between. For a guarded
      // load, `before` was `null` and its bounds passed vacuously, so an empty generation would land over the ids
      // another writer had just loaded. For an unguarded one, the pointer would move over another first load's
      // generation or onto a row `setRetention` made, and, where an erasure had already deleted this load's object
      // above that row's pointer, onto an object that is gone, so that every read of the segment would fail.
      ...(row === null ? { expectAbsent: true } : {}),
      // A registry write that fails without an answer, or meets a conflict, is reconciled by reading the row: a
      // registry that reports its writes' tokens settles it by the row's `pointerId`; any other takes the pointer at
      // this number for this load's publish only over an object whose footer, read once, matches what this load wrote.
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
    // `destroyed` row, new key material for a segment that already has a generation, and a cleartext object for a row
    // with key material. The fence a load carries (the row's token, or its absence) refuses each of those rows first,
    // so these are a second line rather than an answer a load expects. The registries raise a `ValidationError` only
    // from checks made before a write is sent (the ref, the record or patch, the row's size cap), or for a bucket or
    // container that does not exist, where nothing can land, and never a `KeyUnavailableError`. Anything else may
    // still land, and keeps the object: above all the `TransientError` of a registry write the publish could not
    // settle by reading the row back.
    if (isValidationError(err) || isKeyUnavailableError(err)) {
      const missing = await tidy();
      if (missing !== undefined) throw refusedOverMissing(`${err.name}: ${err.message}`, missing);
    }
    throw err;
  }
  if (!published.published) return refuse('superseded');

  audit.onEvent({
    kind: 'segment.publish',
    segment: ref.segment,
    namespace: ref.namespace,
    ...incarnationField(published.token),
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
  //
  // `previous` is the generation this publish superseded: the publish is fenced on the row this load read (its token,
  // or a row changed only in its leases since), so the pointer it moved was the one that row named. A window kept by
  // listing holds it first, which after a rollback is the generation the rollback restored.
  const collected = await collectAfterLoad(ref, deps, {
    generation,
    keep,
    byName: checked && deps.collectByListing !== true,
    currentGone: currentObjectGone,
    ...(leasesNow === undefined ? {} : { leases: { now: leasesNow } }),
    ...(fromGeneration === undefined ? {} : { previous: fromGeneration }),
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
