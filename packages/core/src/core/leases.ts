/**
 * Leases: a bounded hold on one generation, recorded in the segment's registry row, that keeps the generation out of a
 * load's collection until the lease ends.
 *
 * The row holds a list of `{ holder, generation, until }`. A collector that honours leases reads the list from the row
 * it already has and spares a live entry; erasure, shred, drop and retention expiry never look at it. The entry names
 * no fingerprint: a collector spares a generation by number and cannot compare an object without reading it, a purge
 * and re-create drops the list with the row, and the row's token names the incarnation. The pin's own fingerprint,
 * which its reads check, is what stops a number retaken after a rollback and an erasure being read as the leased
 * object; the entry then spares a different object from collection until it ends, at most the longest lease.
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
import { sameIncarnation } from './token';
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

/**
 * Read-modify-write attempts of one take or release before it reports contention. Takers of one row serialise: each
 * round exactly one write lands, so the slowest of `k` simultaneous takers needs `k` attempts. The bound is the cap
 * plus a few, so that the most a segment can hold, all arriving at once, can all land.
 */
export const LEASE_CAS_ATTEMPTS = MAX_LEASES_PER_SEGMENT + 8;

/** Fresh writes sent after one that got no answer and left the row as it was. */
const UNANSWERED_RESENDS = 3;
/** The upper bound of the first of those waits, in ms; each next one doubles it. */
const UNANSWERED_BASE_MS = 500;
/** The upper bound of the first wait after a lost race, in ms; each next doubles it, to the cap. */
const CONFLICT_BASE_MS = 25;
const CONFLICT_CAP_MS = 400;

/**
 * Whether an entry holds its generation against a collector reading `now`: it has not ended (`until` plus the margin
 * is ahead), and it does not run further past `now` than any honest holder with a clock inside the margin could have
 * written (`until` at most the longest lease plus the margin ahead). The second clause bounds a corrupt or forged
 * `until` without refusing the row: an entry past it is read and not honoured.
 */
export function isLive(entry: LeaseEntry, now: number): boolean {
  return now < entry.until + LEASE_SKEW_MS && entry.until <= now + MAX_LEASE_MS + LEASE_SKEW_MS;
}

/** The generations a collector reading `now` must spare, from the row it holds. */
export function heldGenerations(record: RegistryRecord | null, now: number): ReadonlySet<number> {
  const out = new Set<number>();
  for (const e of record?.leases ?? []) if (isLive(e, now)) out.add(e.generation);
  return out;
}

/** The entries of a row that are live at `now`, in the row's order. */
export function liveLeases(record: RegistryRecord | null, now: number): readonly LeaseEntry[] {
  return (record?.leases ?? []).filter((e) => isLive(e, now));
}

/**
 * What a writer that fences on the row's token needs to wait out lease churn: a sleep, and the rng that spreads it.
 * Both are optional; without a sleep a retry follows at once.
 */
export interface ChurnDeps {
  readonly clock?: { readonly sleep?: (ms: number) => Promise<void> } | undefined;
  readonly rng?: Rng | undefined;
}

/**
 * How many times one writer retries after meeting a row that differs from the one it read only in its leases. Takers of
 * one row serialise: each round exactly one write lands, so a writer racing `k` holders needs up to `k + 1` rounds, and a
 * holder can take and release inside one job, so the bound covers a take and a release by every holder the row can
 * hold, with a few to spare: 2 * {@link MAX_LEASES_PER_SEGMENT} + 8. At waits of up to 25 ms growing to up to 400 ms it is a
 * minute at the very most before the writer reports the conflict it had, and a lease writer that goes on beyond
 * that has stopped being a lease writer and become a flood.
 */
export const LEASE_ONLY_RETRIES = 2 * MAX_LEASES_PER_SEGMENT + 8;

/** The fields of a row that a lease write moves without changing what the row says, and the ones that name it. */
const BOOKKEEPING: ReadonlySet<string> = new Set(['token', 'updatedAt', 'leases']);

/** A stable text of a value: object keys in order, `undefined` as absent, so two equal rows compare equal. */
function stable(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/**
 * Whether `now` is `held` with nothing changed but its leases: the same incarnation, and every other field equal,
 * `updatedAt` and the token (which every write moves) aside. `alsoIgnore` names fields the caller's own earlier write
 * changed, so a writer comparing against a row it has itself written does not take its own change for another's.
 *
 * This is the one test that lets a writer fenced on the row's token go on after a lease write: a lease is written by
 * readers, in numbers no operator controls, and it says nothing about the content the writer derived, the pointer it
 * judged or the key it holds. Any other difference is another writer's, and the fence refuses as it always has.
 */
export function onlyLeasesDiffer(
  held: RegistryRecord,
  now: RegistryRecord,
  alsoIgnore: readonly (keyof RegistryRecord)[] = [],
): boolean {
  if (!sameIncarnation(held, now)) return false;
  const skip = new Set<string>([...BOOKKEEPING, ...alsoIgnore]);
  const keys = new Set([...Object.keys(held), ...Object.keys(now)]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (
      stable((held as unknown as Record<string, unknown>)[k]) !==
      stable((now as unknown as Record<string, unknown>)[k])
    ) {
      return false;
    }
  }
  return true;
}

/** A writer's count of the lease-only changes it has waited out, and the wait. One per call of the writer. */
export interface LeaseChurn {
  /**
   * When `now` is `held` changed only in its leases and the bound is not spent: wait, then read the row again with
   * `reread`, and return what it found. The wait comes before the read, so the writer's next write is made against a row
   * as fresh as one round trip, not one as stale as the wait. The caller checks that row against `held` once more (a
   * write may have landed during the wait) and goes on against it, without redoing its work. `undefined` otherwise, and
   * the caller does what it always did.
   *
   * The wait is uniform in `[0, bound)`, the bound starting at 25 ms and doubling to 400 ms, taken on the injected
   * clock's `sleep` and spread by its `rng`. With no `sleep` there is no wait, and the retries follow one another at
   * once; with no `rng` the wait is exactly the bound, so contenders stay in step. The store always supplies both.
   */
  settle(
    held: RegistryRecord | null | undefined,
    now: RegistryRecord | null,
    reread: () => Promise<RegistryRecord | null>,
    alsoIgnore?: readonly (keyof RegistryRecord)[],
  ): Promise<{ readonly row: RegistryRecord | null } | undefined>;
}

export function leaseChurn(deps: ChurnDeps): LeaseChurn {
  let used = 0;
  return {
    async settle(held, now, reread, alsoIgnore) {
      if (held === null || held === undefined || now === null) return undefined;
      if (used >= LEASE_ONLY_RETRIES || !onlyLeasesDiffer(held, now, alsoIgnore)) return undefined;
      const bound = Math.min(CONFLICT_BASE_MS * 2 ** Math.min(used, 4), CONFLICT_CAP_MS);
      used += 1;
      const sleep = deps.clock?.sleep;
      if (sleep !== undefined) {
        await sleep.call(deps.clock, Math.floor((deps.rng?.next() ?? 1) * bound));
      }
      return { row: await reread() };
    },
  };
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
