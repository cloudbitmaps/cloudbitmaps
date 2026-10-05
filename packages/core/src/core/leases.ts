/**
 * Leases: a bounded hold on one generation, recorded in the segment's registry row, that keeps the generation out of a
 * load's collection until the lease ends.
 *
 * The row holds a list of `{ holder, generation, until }`. A collector that honours leases reads the list from the row
 * it already has and spares a live entry; erasure, shred, drop and retention expiry never look at it. The entry names
 * no fingerprint: a collector holds a generation by number, a purge and re-create drops the list with the row, and
 * the row's token names the incarnation, so there is nothing a fingerprint could be compared with.
 *
 * Clocks. The holder ends a lease at `until` by its own clock. A collector holds it for {@link LEASE_SKEW_MS} longer, by
 * its own. The hold is safe while the two clocks differ by at most that margin, whichever way: a reader behind by `r`
 * serves until `until + r` of real time and a collector ahead by `c` stops holding at `until + margin - c`, so the
 * generation is there for every read the reader makes iff `r + c <= margin`. Pure orchestration over the registry port
 * and the injected clock and rng: no I/O, time or randomness of its own.
 */
import {
  LeaseLimitError,
  NotFoundError,
  WriteConflictError,
  isTransientError,
  isWriteConflictError,
} from './errors';
import type { Clock, Rng } from './determinism';
import type { IRegistryDriver, LeaseEntry, RegistryRecord, SegmentRef, Token } from './ports';

/** The longest lease: a `leaseUntil` further than this from the clock is refused. */
export const MAX_LEASE_MS = 14 * 86_400_000;

/**
 * How much longer than `until` a collector holds a lease, and the most a collector will believe a lease runs past
 * its own clock. It is the tolerated difference between the holder's clock and the collector's, in either direction.
 */
export const LEASE_SKEW_MS = 60_000;

/** The most live leases a writer records on one segment; the next one is refused with {@link LeaseLimitError}. */
export const MAX_LEASES_PER_SEGMENT = 64;

/** The most entries a stored row may hold: four times what a writer writes, so a release can raise the cap. */
export const MAX_STORED_LEASES = 256;

/** Read-modify-write attempts of one take or release before it reports contention. */
export const LEASE_CAS_ATTEMPTS = 8;

/** Fresh writes sent after one that got no answer and left the row as it was. */
const UNANSWERED_RESENDS = 3;
/** The upper bound of the first of those waits, in ms; each next one doubles it. */
const UNANSWERED_BASE_MS = 500;
/** The upper bound of the first wait after a lost race, in ms; each next doubles it, to the cap. */
const CONFLICT_BASE_MS = 50;
const CONFLICT_CAP_MS = 800;

/**
 * Whether an entry holds its generation against a collector reading `now`: it has not ended (`until` plus the margin
 * is ahead), and it does not run further past `now` than any honest holder with a clock inside the margin could have
 * written (`until` at most the longest lease plus the margin ahead). The second clause bounds a corrupt or forged
 * `until` without refusing the row: an entry past it is read and not honoured.
 */
export function isLive(entry: LeaseEntry, now: number): boolean {
  return now < entry.until + LEASE_SKEW_MS && entry.until <= now + MAX_LEASE_MS + LEASE_SKEW_MS;
}

/**
 * The generations a collector must spare, from the row it holds. With no `now` (a wiring with no clock) every entry
 * counts and none ever ends: the safe direction, a hold that is never released rather than a delete.
 */
export function heldGenerations(
  record: RegistryRecord | null,
  now: number | undefined,
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const e of record?.leases ?? [])
    if (now === undefined || isLive(e, now)) out.add(e.generation);
  return out;
}

/** The entries of a row that are live at `now`, in the row's order. */
export function liveLeases(record: RegistryRecord | null, now: number): readonly LeaseEntry[] {
  return (record?.leases ?? []).filter((e) => isLive(e, now));
}

/** A row's leases for a patch: the given entries, sorted by generation then holder, or `undefined` when none. */
function listOf(entries: readonly LeaseEntry[]): readonly LeaseEntry[] | undefined {
  if (entries.length === 0) return undefined;
  return [...entries].sort((a, b) =>
    a.generation !== b.generation
      ? a.generation - b.generation
      : a.holder < b.holder
        ? -1
        : a.holder > b.holder
          ? 1
          : 0,
  );
}

/** What the lease writers need: the registry, the clock that judges liveness and waits, and the rng that spreads waits. */
export interface LeaseDeps {
  readonly registry: IRegistryDriver;
  readonly clock: Clock;
  readonly rng?: Rng;
}

/** What a take asks for. */
export interface LeaseTake {
  /** Drawn once per pin call, outside any retry, so a write that landed unseen is found again and never duplicated. */
  readonly holder: string;
  /** The generation to hold. */
  readonly generation: number;
  /** Epoch-ms, already checked against the caller's clock. */
  readonly until: number;
  /** The row the caller read; the first write is made against it, with no row read of its own. */
  readonly row: RegistryRecord;
  /** The generation must still be the row's pointer on every attempt: a pin of the current generation. */
  readonly current: boolean;
}

/** A lease that landed: the token its write returned, and the row that write was made against. */
export interface TakenLease {
  readonly token: Token;
  readonly row: RegistryRecord;
}

const wait = (deps: LeaseDeps, bound: number): Promise<void> =>
  deps.clock.sleep(Math.floor((deps.rng?.next() ?? 1) * bound));

const heldBy = (row: RegistryRecord | null, take: LeaseTake): boolean =>
  (row?.leases ?? []).some(
    (e) => e.holder === take.holder && e.generation === take.generation && e.until === take.until,
  );

/**
 * Write a lease entry for `take.holder`, fenced on the row it was made against, so a lease that lands proves the row
 * was unchanged since the caller read it. Returns `'moved'` when `take.current` and the pointer is no longer at the
 * generation (the caller starts over from a fresh read). Throws {@link NotFoundError} for a row that is gone,
 * destroyed or has no such published generation, {@link LeaseLimitError} when the segment already has
 * {@link MAX_LEASES_PER_SEGMENT} live leases (nothing is written), `WriteConflictError` after
 * {@link LEASE_CAS_ATTEMPTS} lost races, and the registry's own `TransientError` for a write that stayed unanswered.
 *
 * Idempotent by holder: an entry for the holder is replaced, so a retry of a whole pin re-takes without duplicating,
 * and a write that got no answer is settled by reading the row for the holder's entry.
 */
export async function takeLease(
  ref: SegmentRef,
  deps: LeaseDeps,
  take: LeaseTake,
): Promise<TakenLease | 'moved'> {
  let row: RegistryRecord | null = take.row;
  let held = true; // whether `row` is the row the caller read: only then is it passed as the write's hint
  let resends = 0;
  let unanswered: unknown;
  for (let attempt = 0; attempt < LEASE_CAS_ATTEMPTS; attempt++) {
    if (row === null) row = await deps.registry.get(ref);
    if (row === null || row.status === 'destroyed' || row.currentGen === null) {
      throw new NotFoundError(`segment "${ref.segment}" has no generation to lease`);
    }
    if (take.generation > row.currentGen) {
      throw new NotFoundError(
        `segment "${ref.segment}" generation ${take.generation} cannot be leased: it is not a published generation`,
      );
    }
    if (take.current && row.currentGen !== take.generation) return 'moved';
    if (heldBy(row, take)) return { token: row.token, row };
    const live = liveLeases(row, deps.clock.now()).filter((e) => e.holder !== take.holder);
    if (live.length >= MAX_LEASES_PER_SEGMENT) {
      throw new LeaseLimitError(
        `segment "${ref.segment}" already has ${live.length} live leases, the most one segment records`,
      );
    }
    const leases = listOf([
      ...live,
      { holder: take.holder, generation: take.generation, until: take.until },
    ]);
    const against: RegistryRecord = row;
    try {
      const { token } = await deps.registry.compareAndSwap(
        ref,
        against.token,
        { leases },
        held ? { held: against } : undefined,
      );
      return { token, row: against };
    } catch (err) {
      if (isWriteConflictError(err)) {
        row = null;
        held = false;
        await wait(deps, Math.min(CONFLICT_BASE_MS * 2 ** attempt, CONFLICT_CAP_MS));
        continue;
      }
      if (!isTransientError(err)) throw err;
      // No answer: the write may have landed, or may still land. The row says which.
      const now = await deps.registry.get(ref);
      if (heldBy(now, take)) return { token: (now as RegistryRecord).token, row: against };
      if (now !== null && now.token === against.token) {
        if (resends >= UNANSWERED_RESENDS) throw err;
        await wait(deps, UNANSWERED_BASE_MS * 2 ** resends);
        resends += 1;
        unanswered = err;
      }
      row = now;
      held = false;
      if (row === null)
        throw new NotFoundError(`segment "${ref.segment}" has no generation to lease`);
    }
  }
  if (unanswered !== undefined) throw unanswered;
  throw new WriteConflictError(`lease: contention taking a lease on segment "${ref.segment}"`);
}

/**
 * Remove `holder`'s entry, and every entry that has ended, in one write. Idempotent: a row that is gone, destroyed or
 * has no entry for the holder is already released. Throws `WriteConflictError` after {@link LEASE_CAS_ATTEMPTS} lost
 * races and the registry's `TransientError` for a write that stayed unanswered over an unchanged row.
 */
export async function releaseLease(
  ref: SegmentRef,
  deps: LeaseDeps,
  holder: string,
): Promise<void> {
  let resends = 0;
  let unanswered: unknown;
  let row: RegistryRecord | null | undefined;
  for (let attempt = 0; attempt < LEASE_CAS_ATTEMPTS; attempt++) {
    if (row === undefined) row = await deps.registry.get(ref);
    if (row === null || row.status === 'destroyed') return;
    if (!(row.leases ?? []).some((e) => e.holder === holder)) return;
    const against: RegistryRecord = row;
    const keep = liveLeases(against, deps.clock.now()).filter((e) => e.holder !== holder);
    try {
      await deps.registry.compareAndSwap(ref, against.token, { leases: listOf(keep) });
      return;
    } catch (err) {
      if (isWriteConflictError(err)) {
        row = undefined;
        await wait(deps, Math.min(CONFLICT_BASE_MS * 2 ** attempt, CONFLICT_CAP_MS));
        continue;
      }
      if (!isTransientError(err)) throw err;
      const now = await deps.registry.get(ref);
      if (now === null || !(now.leases ?? []).some((e) => e.holder === holder)) return;
      if (now.token === against.token) {
        if (resends >= UNANSWERED_RESENDS) throw err;
        await wait(deps, UNANSWERED_BASE_MS * 2 ** resends);
        resends += 1;
        unanswered = err;
      }
      row = now;
    }
  }
  if (unanswered !== undefined) throw unanswered;
  throw new WriteConflictError(`lease: contention releasing a lease on segment "${ref.segment}"`);
}
