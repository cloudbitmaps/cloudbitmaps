/**
 * The forward-only pointer advance every write ends with: `publishGeneration` and `publishGenerationKept`, and the settling
 * of a registry write that got no answer.
 */
import {
  KeyUnavailableError,
  TransientError,
  ValidationError,
  WriteConflictError,
  isIntegrityError,
  isTransientError,
  isWriteConflictError,
} from './errors';
import type { Yielder } from './cooperative';
import type { Rng } from './determinism';
import { sameIncarnation } from './token';
import { nextKnown } from './known-generations';
import {
  UNANSWERED_BASE_MS,
  UNANSWERED_RESENDS,
  heldGenerations,
  isLive,
  leaseChurn,
  onlyLeasesDiffer,
} from './leases';
import { jitteredWait } from './retry';
import type { KnownAfter } from './known-generations';
import type { PublishedKept } from './generation-gc';
import type { WrappedDek } from './crypto';
import type {
  GenKey,
  IRegistryDriver,
  KnownGeneration,
  LeaseEntry,
  RegistryRecord,
  RegistryWriteOptions,
  RegistrySummary,
  Token,
} from './ports';

/**
 * Refuses, with {@link KeyUnavailableError}, to point a row that carries key material at a generation written in
 * cleartext. The writer decided its key from the row it read before the write; another writer that created the
 * segment encrypted meanwhile leaves this one holding a cleartext object that no reader of the segment can open.
 */
function refuseCleartextOntoKey(
  key: GenKey,
  record: RegistryRecord,
  cleartext: boolean | undefined,
): void {
  if (cleartext !== true || record.wrappedDeks === undefined || record.wrappedDeks.length === 0) {
    return;
  }
  throw new KeyUnavailableError(
    `segment "${key.segment}" is encrypted, and generation ${key.generation} was written in cleartext: another ` +
      `writer created the segment with a key while this one was writing. Nothing was published. Re-run the ` +
      `write with the keystore that holds the segment's key.`,
  );
}

/**
 * What a publish over an existing row says about its leases: nothing, or the list with the ended entries dropped, or
 * (for a caller that deletes every generation below the pointer) none. Ended entries are ignored by every collector
 * whether or not they are pruned; pruning here costs no request, since the write is made anyway.
 */
function leasesPatch(
  record: RegistryRecord,
  options: { leasesNow?: () => number; clearLeases?: boolean },
): { leases?: readonly LeaseEntry[] | undefined } {
  const held = record.leases;
  if (held === undefined) return {};
  if (options.clearLeases === true) return { leases: undefined };
  if (options.leasesNow === undefined) return {};
  const now = options.leasesNow();
  const live = held.filter((e) => isLive(e, now));
  if (live.length === held.length) return {};
  return { leases: live.length === 0 ? undefined : live };
}

/**
 * What a publish of `key.generation` over `prev` records: the ledger and the window ({@link nextKnown}). With no
 * `footerCrc` there is no entry to write for the generation, so no ledger and no window: the row then has none, and the
 * next load lists.
 */
function nextKnownOf(
  prev: RegistryRecord | null,
  key: GenKey,
  options: {
    readonly keep?: number;
    readonly footerCrc: number;
    readonly clearLeases?: boolean;
    readonly seed?: readonly KnownGeneration[];
    readonly leasesNow?: () => number;
  },
): KnownAfter {
  // The generations a live lease holds stay in the ledger: the same ones this publish's collection spares. Without a
  // clock a publish reads no leases, and its collection spares none either.
  const leased =
    options.leasesNow === undefined || options.clearLeases === true
      ? undefined
      : heldGenerations(prev, options.leasesNow());
  return nextKnown(prev, key.generation, options.footerCrc, options.keep, {
    clearsLeases: options.clearLeases === true,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(leased === undefined ? {} : { leased }),
  });
}

/** The fields of a write that record `next`: the ledger, when there is one. */
function ledgerPatch(next: KnownAfter): { knownGens: readonly KnownGeneration[] } {
  return { knownGens: next.known };
}

/** `next` as the publish reports it, with the token of the row the write made when it is known. */
function keptOf(next: KnownAfter | undefined, token: Token | undefined): PublishedKept {
  return {
    list: next?.list,
    evict: next?.evict ?? [],
    ...(next === undefined ? {} : { known: next.known }),
    token,
  };
}

/** What a publish is told, beyond the registry and the generation key. */
interface PublishOptions {
  wrappedDeks?: readonly WrappedDek[];
  expectFrom?: number;
  expectToken?: Token;
  /**
   * The row `expectToken` names, as the caller read it. With it, a row whose token has moved but which differs from
   * this one only in its leases (a reader took or released one) does not refuse the publish: it goes on against the
   * fresh row, after a jittered wait and without the caller redoing its work, up to a bound. Any other difference
   * refuses as ever. Without it, a moved token refuses.
   */
  expectRow?: RegistryRecord | null;
  /**
   * Publish only while the segment still has **no registry row**.
   *
   * The fence for a caller whose decision rests on the row being ABSENT: every load that found no row sets it,
   * guarded or not. `expectFrom` and `expectToken` cannot express it: both compare against a value read from a
   * row, so when there was no row there is nothing to compare and both are simply omitted — leaving the publish a
   * bare forward-only advance that happily lands over whatever appeared in the meantime.
   *
   * Without it, a guarded load into a segment that did not exist yet would judge "no row", pass its empty and
   * `minRetained` bounds vacuously, and land an EMPTY generation over the ids a concurrent writer had just loaded,
   * reporting `published: true`. An unguarded load would move the pointer over another first load's generation or
   * onto a row `setRetention` made, and, where an erasure had deleted its object above that row's pointer, onto an
   * object that is gone. Materialising into a destination that does not exist yet is the ordinary first run of a
   * pipeline, so the `*Into` verbs reach this as often as `loadSegment` does.
   */
  expectAbsent?: boolean;
  /**
   * The generation's summary (see {@link RegistrySummary}), written by the write that moves the pointer to it. It
   * names `key.generation`. Absent, the row is left with none for this generation.
   */
  summary?: RegistrySummary;
  /**
   * The segment's row as the caller already read it (`null`: it found none). The first attempt acts on it
   * instead of reading the row again, which is sound because that attempt writes only under the row's own
   * fence: its compare-and-swap carries this row's token, and with no row it creates create-only, so a row
   * that changed or appeared since makes the write lose and the next attempt reads the row afresh. Only the
   * idempotent "already current" answer writes nothing, so a reused row never gives it.
   */
  row?: RegistryRecord | null;
  /**
   * The object was written without encryption. Its publish is refused, with {@link KeyUnavailableError}, onto a row
   * that carries key material: a reader of that segment opens every generation with its key, and a later
   * `destroySegment` would attest that shredding it made a readable object unreadable. A caller decides its key
   * from the row it read before the write, so this closes the window in which another writer creates the
   * segment encrypted meanwhile.
   */
  cleartext?: boolean;
  /**
   * Whether the object under `key` is the one the caller wrote, and throws when it cannot tell. Asked only when a
   * registry write failed and the row then names `key.generation`, to tell this publish's write from another
   * writer's at the same number. Every caller that writes the object passes it. Without it, a write that ended
   * without an answer over a row that names `key.generation` cannot be settled: the publish throws
   * {@link TransientError} and the caller keeps its object.
   */
  holdsOwnObject?: () => Promise<boolean>;
  /**
   * What a publish waits on before it sends a fresh compare-and-swap, after a write that ended without an answer and
   * left the row as it was. Without a `sleep`, such a write throws at once instead of being sent again.
   */
  clock?: Yielder;
  /** Spreads that wait (full jitter) so concurrent publishers do not retry together. Without it the wait is the bound. */
  rng?: Rng;
  /**
   * Called once for each registry write that ended without an answer, before the row is read back. A caller whose
   * publish then answers `false` can say that it cannot tell whether its own write landed first: the row may have
   * held its generation for a while before another writer moved on.
   */
  onUnanswered?: () => void;
  /**
   * The clock that judges whether a lease has ended. With it, a publish over a row that holds ended leases drops
   * them in the write that moves the pointer, which rewrites the row anyway. Without it, leases are left as they are.
   */
  leasesNow?: () => number;
  /**
   * Clear the row's leases in the write that moves the pointer: the caller's collection deletes every generation
   * below the new pointer whatever a lease says, as a subject erasure's does.
   */
  clearLeases?: boolean;
  /**
   * How many generations below the new pointer the caller keeps. With it, the write that moves the pointer also
   * records the window in the row (the entries of `knownGens`: the `keep` most recently current of the generations
   * below the new one, and the ones a live lease holds), derived from the very row the write is made against, and the
   * result names the generations the window dropped. Without it, or above the most a row collects by name, the result
   * names no window, and a collection lists.
   */
  keep?: number;
  /**
   * The footer checksum of the object under `key` (the second half of its fingerprint), which the write that moves the
   * pointer records in the row's `knownGens` beside the generation. It comes from the object the caller wrote or opened,
   * the same one its `summary` describes.
   */
  footerCrc: number;
  /**
   * The window a ledger starts with, over a row that has no usable one ({@link readSeed}): the generations a count by
   * `keep` keeps, which the write records as the ledger's entries before the new generation.
   */
  seed?: readonly KnownGeneration[];
}

/**
 * Point a segment's registry `currentGen` at `key.generation` — the publish step that makes a freshly-written
 * generation the authoritative latest (so registry-aware readers see it). **Forward-only and idempotent:**
 * if the registry has no row it creates one; if it's already at/ahead of `key.generation` it's a no-op (an
 * out-of-order/duplicate publish never regresses the pointer); otherwise it advances via compare-and-swap,
 * retrying a few times under contention. Separated from the Storage write so callers can publish atomically
 * after the immutable object is durable (write-then-publish).
 *
 * **Throws** rather than returning, in two cases, because each would otherwise create a state no reader can
 * recover from: a `destroyed` (crypto-shredded) row, where advancing the pointer would name an object encrypted
 * under a shredded key; and an advance carrying **new** `wrappedDeks`, which would either strand that key or make
 * the row advertise encryption over cleartext generations. Contention that never clears throws
 * {@link WriteConflictError} after the retries.
 *
 * **`expectFrom` turns forward-only into read-modify-write.** Forward-only is the right rule for a writer whose
 * content does not depend on what was current — a load computes its ids upstream, so publishing over a newer
 * generation loses nothing the loader knew about. It is the WRONG rule for a writer that *derived* its content
 * from a particular generation: the erasure rewrite streams generation `from` and clears one bit, so publishing
 * it over a newer generation silently discards whatever that generation added. Passing `expectFrom` makes the
 * publish land only while the pointer is still exactly there, and return `false` otherwise, so the caller can
 * report `superseded` and re-derive. The compare-and-swap itself carries the token read in the same iteration,
 * so the check and the write see the same row.
 *
 * **`expectToken` fences the LINEAGE, and a derived writer needs both.** A generation number identifies a
 * generation only within one incarnation of a name: the numbering restarts at `0` once the row is purged and
 * the bucket empty, so a name that is retired and re-created has a *different* segment wearing the *same*
 * `currentGen`. `expectFrom` alone matched it — and an erasure rewrite then published one incarnation's content
 * over another's, deleted the live objects with its `keep: 0` collection, and returned `erased: true`. The row's
 * OCC token is the identity that survives this: a shipped registry's later `create` gets a token never issued before
 * under that name, but for a collision of probability 2^-128 per pair of incarnations, so no token is reused across them.
 *
 * Pass the token read alongside `expectFrom` and the publish lands only on the same row it was derived from.
 * The check is deliberately **conservative**: the token also changes on writes that are not supersessions at
 * all (a `setRetention`, a due-index reindex), so such a write makes a derived publish report `superseded` and
 * the caller re-derive. That costs a re-run on a rare, unrelated write; the alternative costs a segment.
 *
 * **The driver sends a registry write once, and an unanswered one is reconciled by its effect.** A `create` or
 * `compareAndSwap` that fails with {@link TransientError} (a throttle, a lost response, a timeout) may or may not
 * have landed, and may still be in flight. The publish reads the row once more and decides from what it holds:
 *
 * - the pointer names `key.generation`, on the incarnation the write was made against (the row's `createdAt`), and
 *   `holdsOwnObject` finds the caller's bytes under it: the write is taken to have landed, and the publish returns
 *   `true`. Only the writer of a write-once object publishes its number, and a number is never taken while an object
 *   holds it, but it is taken again once its object is deleted, and a load of the same cleartext ids writes the same
 *   bytes, so another writer's identical object under the number passes for the caller's;
 * - the row is still the one the write was made against (the same token, or still no row): the write may land yet. The
 *   publish then waits, on the injected clock, and sends a **new** write from the row it just read: a request of its
 *   own, not a replay of the driver's, carrying the same version, so under the registry's fence at most one of the two
 *   lands and the other meets a conflict, which the next read settles. At most {@link UNANSWERED_RESENDS} follow, after
 *   a wait under 500 ms, then 1 s, then 2 s (full jitter when an `rng` is given); each is settled the same way. Still
 *   unanswered, or with no clock to wait on, this throws the registry's own `TransientError` and writes nothing more.
 *   A caller must not delete its object on it;
 * - anything else: the row has moved past the state the write was conditioned on, so that write can never land, and
 *   the publish goes on as after a lost race, from the row it just read. A pointer at `key.generation` that is not over
 *   the caller's own object, or is on another incarnation, is a lost race too and answers `false`, never an already
 *   current re-publish.
 *
 * A failed read throws `TransientError` too. The same check of the pointer runs after a {@link WriteConflictError},
 * so a write that landed and then met itself (a registry whose client re-sent it) is not taken for a lost race.
 *
 * **A `summary` goes in the same write that moves the pointer**, so a reader that sees this generation as current
 * sees the count and metadata that describe it, and every attempt sends the same one. It must be the shape the row's
 * keys call for: sealed for an object written with a key, clear for one written without.
 */
export async function publishGenerationKept(
  registry: IRegistryDriver,
  key: GenKey,
  options: PublishOptions,
): Promise<PublishResult> {
  // A row read after a write that failed, which the next attempt acts on instead of reading it again.
  let fresh: RegistryRecord | null | undefined;
  // The row a failed write was made against. The next attempt first checks its row for that write's effect.
  let failedOn: RegistryRecord | null | undefined;
  // The error of the last attempt, while it ended without an answer over an unchanged row; and how many fresh writes
  // such answers have bought so far.
  let unanswered: TransientError | undefined;
  let resends = 0;
  // The lease-only changes this publish has waited out: a lease write moves the token and nothing the publish derived.
  const churn = leaseChurn({ clock: options.clock, rng: options.rng });
  // Whether this attempt went on past a token that only lease writes had moved; losing its race then costs no attempt.
  let throughChurn = false;
  // The row the last wait for lease churn read, which the next attempt acts on without waiting again.
  let waited: RegistryRecord | null | undefined;
  // Whether any write of this call ended without an answer: what the pointer then says about this number is not
  // taken for the caller's own write without the proof.
  let sawUnanswered = false;
  // The row the last attempt acted on, which its write was made against: where the incarnation is read from when the
  // attempts run out.
  let lastRecord: RegistryRecord | null | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const reused = attempt === 0 && options.row !== undefined;
    // The row a write is made against is passed to the registry as `held`, so that it need not read the row again for
    // the version its write is fenced on: the caller's own row on the first attempt, or the one this attempt read.
    // Never a row read to settle a write that got no answer: that one is read again by the write that follows it.
    const holdsRow = fresh === undefined;
    const record =
      fresh !== undefined ? fresh : reused ? (options.row ?? null) : await registry.get(key);
    const write: RegistryWriteOptions | undefined = holdsRow ? { held: record } : undefined;
    fresh = undefined;
    unanswered = undefined;
    lastRecord = record;
    // What this attempt's write records, and the token it is given: set by the write, read when it lands.
    let next: KnownAfter | undefined;
    let wrote: Token | undefined;
    if (failedOn !== undefined) {
      let landed: boolean;
      try {
        landed = await landedHere(record, failedOn, key, options.holdsOwnObject);
      } catch (proofErr) {
        throw outcomeUnknown(key, proofErr);
      }
      if (landed)
        return {
          published: true,
          kept: keptOf(nextKnownOf(failedOn, key, options), undefined),
          token: record?.token,
        };
      // The pointer names this number, but not over this publish's write: another writer's object under it, or
      // another incarnation of the name. That is not an already-current re-publish, which the branch below would
      // answer `true`: nothing this call wrote is published.
      if (record !== null && record.status === 'active' && record.currentGen === key.generation) {
        return REFUSED;
      }
      failedOn = undefined;
    }
    try {
      if (options.expectFrom !== undefined && record?.currentGen !== options.expectFrom) {
        // The pointer is no longer where the caller derived its content from — including the cases where the row
        // has vanished or has no generation at all. Not an error: the caller re-reads and re-derives.
        return REFUSED;
      }
      if (options.expectAbsent === true && record !== null) {
        // A row appeared since the caller looked. Whatever it decided from "this segment does not exist" no
        // longer holds — most importantly "there is nothing here to overwrite".
        return REFUSED;
      }
      throughChurn = false;
      if (options.expectToken !== undefined && record?.token !== options.expectToken) {
        const held = options.expectRow;
        if (
          record !== null &&
          held != null &&
          record === waited &&
          onlyLeasesDiffer(held, record)
        ) {
          // Only leases changed since the caller read the row, and the wait is done: the fence holds, on this fresh row.
          throughChurn = true;
        } else {
          // Waited out first and read again, so the write is made against a row one round trip old.
          const settled =
            record === waited
              ? undefined
              : await churn.settle(held, record, () => registry.get(key));
          if (settled !== undefined) {
            waited = settled.row;
            fresh = settled.row;
            attempt -= 1; // the wait is the churn's, and costs no attempt
            continue;
          }
          // Same pointer VALUE, different row. Either the row was written since (harmless, and we re-derive
          // anyway) or the name was retired and re-created, in which case `currentGen` matching means nothing:
          // it is a different segment that restarted its generation counter at the same number.
          return REFUSED;
        }
      }
      if (
        record === null &&
        options.summary !== undefined &&
        'sealed' in options.summary &&
        options.wrappedDeks === undefined
      ) {
        // An object sealed under a key that a row held when the object was written (it carries no new key of its own),
        // with no row now: a row made from nothing would hold no key to open it with. A row passed in is the one the
        // caller read before it wrote, which another writer may have created since, so this reads again. A row still
        // absent then is a purged one, and the object cannot be published.
        if (reused) continue;
        return REFUSED;
      }
      if (record === null) {
        // First publish for the segment — carry the wrapped DEK(s) so encrypted reads can resolve the key.
        next = nextKnownOf(null, key, options);
        wrote = (
          await registry.create(
            key,
            {
              currentGen: key.generation,
              wrappedDeks: options.wrappedDeks,
              ...(options.summary === undefined ? {} : { summary: options.summary }),
              ...ledgerPatch(next),
            },
            write,
          )
        ).token;
      } else if (record.status === 'destroyed') {
        // Closes the window between a writer's own destroyed-check and its publish.
        //
        // `bulkLoadCrbmGeneration` reads the registry record once, refuses if it is already destroyed, and then
        // spends a KMS call plus a whole object write before getting here — seconds to minutes on a large load.
        // A check of `currentGen` alone cannot see a `destroySegment` landing inside that window: it would
        // advance the pointer on a destroyed record, leaving an object encrypted with the DEK that destroy had
        // just shredded — permanently unreadable, still paid for, and attached to a segment the registry says
        // was erased.
        //
        // Checking here rather than at the caller is what makes it a fence instead of a second guess: this
        // record was re-read moments ago inside the retry loop, so the check and the CAS that follows it see the
        // same state. This is the publish step's half of coupling the write path to destruction.
        throw new ValidationError(
          `segment "${key.segment}" was destroyed (crypto-shredded) while generation ${key.generation} was ` +
            `being written — refusing to publish it; the written object is unreadable. Use a new segment.`,
        );
      } else if (record.currentGen === null) {
        // The row exists with no Storage generation yet (a retention policy recorded ahead of the first load). There
        // is no pointer to regress past, so this publish advances it — and carries the wrapped
        // DEK(s) exactly like a first publish onto no row, since no generation is encrypted under the row's
        // current wrappings (there is no generation at all).
        //
        // `wrappedDeks` is spread in ONLY when there is something to store. A registry patch clears an optional
        // field by *mentioning* it (`'wrappedDeks' in patch`), so passing `wrappedDeks: undefined` unconditionally
        // would wipe key material off the row whenever a cleartext generation is published onto it — a divergence
        // from the branch below, which never touches the field.
        refuseCleartextOntoKey(key, record, options.cleartext);
        next = nextKnownOf(record, key, options);
        wrote = (
          await registry.compareAndSwap(
            key,
            record.token,
            {
              currentGen: key.generation,
              ...(options.wrappedDeks === undefined ? {} : { wrappedDeks: options.wrappedDeks }),
              ...(options.summary === undefined ? {} : { summary: options.summary }),
              ...ledgerPatch(next),
            },
            write,
          )
        ).token;
      } else if (record.currentGen > key.generation) {
        return REFUSED; // a newer generation is already current — forward-only, never regress
      } else if (record.currentGen === key.generation) {
        if (reused) continue; // only a fresh read can show the pointer already there
        // Already exactly current (an idempotent re-publish): nothing to advance.
        return { published: true, token: record.token };
      } else {
        // Advancing over an existing generation. `wrappedDeks` is deliberately NOT carried here, and a caller
        // that supplies it is refused rather than served.
        //
        // Reaching this branch with a freshly minted DEK means an encrypted generation is being published onto a
        // lineage whose current generation the row already describes — i.e. onto a segment whose existing
        // generations are cleartext. Both ways of resolving that silently are damaging: dropping the wrapping
        // advances the pointer to an object encrypted under a key that exists
        // nowhere, so the data is unrecoverable the moment the call returns; carrying it makes the row advertise
        // encryption over a lineage that still holds readable cleartext objects, which is what makes
        // `destroySegment` emit `segment.erase` — "unreadable everywhere, backups included" — over plaintext.
        // Two entry points reach it with no race: a re-load with a keystore newly wired, and an `*Into` on a
        // keystore-wired store whose destination is cleartext. So the state is refused before the pointer moves;
        // the object stays an orphan.
        if (options.wrappedDeks !== undefined && options.wrappedDeks.length > 0) {
          throw new ValidationError(
            `publishGeneration: refusing to publish generation ${key.generation} of "${key.segment}" with new ` +
              `key material onto a segment that already has generation ${record.currentGen}: its generations ` +
              `are not encrypted under this key, and nothing was published. If another writer published to the ` +
              `segment while this one was writing, re-run the write, which then uses the segment's own key; ` +
              `if the segment's generations are cleartext, encrypt a new segment and load into that instead.`,
          );
        }
        refuseCleartextOntoKey(key, record, options.cleartext);
        next = nextKnownOf(record, key, options);
        wrote = (
          await registry.compareAndSwap(
            key,
            record.token,
            {
              currentGen: key.generation,
              ...(options.summary === undefined ? {} : { summary: options.summary }),
              ...ledgerPatch(next),
              ...leasesPatch(record, options),
            },
            write,
          )
        ).token;
      }
      return {
        published: true,
        kept: keptOf(next, wrote),
        token: wrote,
      }; // created or advanced the pointer to key.generation → it is now current
    } catch (err) {
      if (isWriteConflictError(err)) {
        failedOn = record; // lost the race, or met its own landed write: the next read says which
        if (throughChurn) attempt -= 1; // a lease write won it; the bound on those is the churn's
        continue;
      }
      // Only the write itself raises a transient fault in here, and it is the one outcome that is not an answer.
      if (!isTransientError(err)) throw err;
      options.onUnanswered?.();
      sawUnanswered = true;
      let now: RegistryRecord | null;
      try {
        now = await registry.get(key);
      } catch (readErr) {
        // A row that is not one the library wrote says more than a throttle does, and the next call would raise it
        // anyway. It is not a refusal either, so the caller keeps its object. Any other fault leaves the outcome unknown.
        if (isIntegrityError(readErr)) throw readErr;
        throw outcomeUnknown(key, err);
      }
      if (sameRow(now, record)) {
        // The write did not land, or is still on its way. Send a new one from the row just read, a bounded number of
        // times; the registry's fence lets at most one of the two copies land.
        if (options.clock?.sleep === undefined || resends >= UNANSWERED_RESENDS)
          throw outcomeUnknown(key, err);
        const bound = UNANSWERED_BASE_MS * 2 ** resends;
        resends += 1;
        await jitteredWait(options.clock, options.rng, bound);
        unanswered = outcomeUnknown(key, err);
        fresh = now;
        continue;
      }
      failedOn = record;
      fresh = now;
    }
  }
  // Exhausted: only possible if competing writers kept advancing currentGen — which likely already satisfies
  // the forward-only goal. Confirm before reporting failure, so a lost-every-race-but-already-current case
  // isn't a spurious error. Whether *this* generation is the current one decides the returned flag.
  const final = await registry.get(key);
  // `currentGen === null` after exhausting the retries is a genuine failure, not an already-current case: nothing
  // is published, so it falls through to the conflict below rather than being read as "a newer gen won".
  if (final !== null && final.currentGen !== null && final.currentGen >= key.generation) {
    if (final.currentGen !== key.generation) return REFUSED;
    if (!sawUnanswered) return { published: true, token: final.token };
    // A write that went unanswered may have landed during the last wait, or the number may be another writer's, or
    // another incarnation's: the incarnation and the object under it decide, as after any unanswered write.
    try {
      const published = await landedHere(final, lastRecord ?? null, key, options.holdsOwnObject);
      return published ? { published, token: final.token } : REFUSED;
    } catch (proofErr) {
      throw outcomeUnknown(key, proofErr);
    }
  }
  // The attempts ran out on writes that went unanswered, not on contention: say so.
  if (unanswered !== undefined) throw unanswered;
  throw new WriteConflictError(
    `publishGeneration: contention setting currentGen for ${key.segment}`,
  );
}

/** What a publish did: whether the pointer is at the generation, and what the write recorded in the row. */
export interface PublishResult {
  readonly published: boolean;
  /**
   * What the write that moved the pointer recorded: the list, the generations the window dropped, and the new row's
   * token. Absent when no write of this call is known to have landed (the pointer was already there, or the outcome
   * was settled without knowing which write it was), and a collection then lists.
   */
  readonly kept?: PublishedKept;
  /**
   * A token of the row whose pointer is at the generation, when it is published: the one the write was given, or the
   * row read that showed the pointer there. Every write of a row keeps its incarnation, so this names the incarnation
   * the publish landed in, for the audit event.
   */
  readonly token?: Token;
}

const REFUSED: PublishResult = { published: false };

/**
 * {@link publishGenerationKept}'s answer to "did the pointer move", for a caller with no use for what it recorded:
 * a publish with no `keep` leaves the row recording no list.
 */
export async function publishGeneration(
  registry: IRegistryDriver,
  key: GenKey,
  options: PublishOptions,
): Promise<boolean> {
  return (await publishGenerationKept(registry, key, options)).published;
}

/**
 * Whether `now` shows the effect of a publish's write that was made against `before`: an active row, on the same
 * incarnation (a `create` has none to compare), whose pointer names `key.generation`, over an object the caller's
 * `holdsOwnObject` accepts.
 *
 * The incarnation is the one in the row's token ({@link sameIncarnation}): exact, and no clock. A row with no id in its
 * token (from a registry of someone else's whose tokens carry none) is compared by its creation stamp, a clock reading that two
 * incarnations can share. So the object is always checked too, never assumed: the pointer and the incarnation alone
 * cannot say whose write this is. A load's check reads the footer, which names bytes, so another writer's identical
 * object under the number passes it. With no proof to ask for, the answer cannot be given, and that is an unknown outcome,
 * never a guess.
 */
async function landedHere(
  now: RegistryRecord | null,
  before: RegistryRecord | null,
  key: GenKey,
  holdsOwnObject: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (now === null || now.status === 'destroyed' || now.currentGen !== key.generation) return false;
  if (before !== null && !sameIncarnation(before, now)) return false;
  if (holdsOwnObject === undefined) {
    throw new TransientError(
      `publish of "${key.segment}" generation ${key.generation}: whether its registry write landed could not be ` +
        `settled, since the caller gave no way to tell its own object from another's. Its object is kept; re-run the ` +
        `write, which numbers past it.`,
    );
  }
  return holdsOwnObject();
}

/**
 * Whether two reads of a row saw it unwritten in between: the same token, or no row both times. The settling never
 * compares `pointerId`: an unchanged token already proves that no write landed, and a write that did land is judged by
 * the object it names, through the caller's `holdsOwnObject` ({@link landedHere}).
 */
function sameRow(a: RegistryRecord | null, b: RegistryRecord | null): boolean {
  return a === null ? b === null : b !== null && a.token === b.token;
}

/**
 * The error for a publish that cannot tell whether its registry write landed: always a {@link TransientError}, so no
 * caller treats it as a refusal and deletes the object the write may yet point the row at; a re-run numbers past that
 * object. A cause that is already one (the registry's own error, whose `cause` is the SDK's) is thrown as it is, so
 * what a caller reads from it does not move; any other is wrapped.
 */
function outcomeUnknown(key: GenKey, cause: unknown): TransientError {
  if (isTransientError(cause)) return cause;
  return new TransientError(
    `publish of "${key.segment}" generation ${key.generation}: whether its registry write landed could not be ` +
      `settled (${(cause as { name?: string } | null)?.name ?? 'error'} while checking its object). Its object is ` +
      `kept, since the write may still land; re-run the write, which numbers past it.`,
    { cause },
  );
}
