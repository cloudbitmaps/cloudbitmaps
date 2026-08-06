/**
 * Partition leases — how N processes share the fleet's lifecycle work with **no coordinator and no
 * per-process configuration**. Every process runs the identical call; the leases decide who does what.
 *
 * This is the Kinesis Client Library's lease-table algorithm on our registry's OCC: one row per partition,
 * claimed and renewed by conditional write, stolen when a holder stops renewing. Three properties are
 * load-bearing and must not be "simplified" later:
 *
 * 1. **Liveness is decided by the token, never by the clock.** Asking `leaseExpiresAt <= myNow()` compares one
 *    machine's wall clock against another's — a host 40 s fast steals live leases continuously, and clock skew
 *    becomes a correctness bug that only appears in production. We instead ask *"has this row's OCC token changed
 *    since I last looked, one TTL ago?"*, which compares **my clock to my clock** (elapsed time only). The token
 *    is contractually never reused ({@link Token}), so an unchanged token proves no write landed. `leaseExpiresAt`
 *    is still written, as diagnostics for a human reading the row — never as the decision input.
 * 2. **A lease only chooses who *works*; the CAS at the resource decides who *commits*.** A holder can be paused
 *    (GC, VM freeze) between checking its lease and writing, so the lease alone is not safety. Compaction's SWAP
 *    is already a CAS on the token it acquired, which is what makes a woken-up straggler harmless. Any work
 *    gated by a lease must keep that discipline.
 * 3. **One steal per cycle, toward `ceil(P/W)`.** Convergence is slower and monotone instead of fast and
 *    oscillating, which is the failure mode a greedy rebalance produces under churn.
 *
 * The rows are ordinary registry records in a reserved namespace with `currentGen: null` — the same nullable
 * pointer that made warm-only accumulators enumerable. So this needs **no driver change and no new capability**:
 * `create` / `compareAndSwap` / `list` are the operations all drivers already implement and are conformance-held
 * on.
 */
import { isWriteConflictError, ValidationError } from './errors';
import type { Clock } from './determinism';
import type { IRegistryDriver, RegistryRecord, SegmentRef, Token } from './ports';

/**
 * Reserved namespace holding one row per partition. It must be excluded from every **unscoped** fleet-wide
 * enumeration — a lease is not a segment (see `registry-scan.ts`). The name obeys the locked grammar (a leading
 * alphanumeric), which is why it is not the more obvious `__cbm`.
 */
export const LEASE_NAMESPACE = 'cbm.leases';

/** Default lease TTL. A holder renews at a third of this, so two renewals may be missed before it looks dead. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** Renew this often, as a fraction of the TTL. Three attempts per TTL tolerates one lost round trip. */
export const LEASE_RENEW_DIVISOR = 3;

/**
 * Default partition count. **One**, deliberately: the registry scan is not partitioned, so N workers each still
 * list the fleet — partitions buy work throughput, not scan cost. Raise it when per-segment work dominates.
 */
export const DEFAULT_PARTITIONS = 1;

/** Upper bound on partitions — a cycle reads one row per partition, so this bounds a cycle's read cost. */
export const MAX_PARTITIONS = 1024;

/** Lower bound on a lease TTL. Below this, ordinary GC pauses and retries read as death. */
export const MIN_LEASE_TTL_MS = 1_000;

const PARTITION_PREFIX = 'p';

/** The registry ref holding partition `n`'s lease. */
export function leaseRef(partition: number): SegmentRef {
  return { namespace: LEASE_NAMESPACE, segment: `${PARTITION_PREFIX}${partition}` };
}

/** Inverse of {@link leaseRef}; `null` for any name we did not write (a foreign row is ignored, never trusted). */
export function partitionOfLeaseRow(segment: string): number | null {
  if (!segment.startsWith(PARTITION_PREFIX)) return null;
  const rest = segment.slice(PARTITION_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) ? n : null;
}

/** What we saw the last time we looked at a partition we do not hold — the input to the staleness decision. */
interface Sighting {
  /** The row's OCC token at `at`. Unchanged since then ⇒ nothing has written the row ⇒ the holder is gone. */
  readonly token: Token;
  /** **Our own** clock when we observed it. Never compared against another machine's time. */
  readonly at: number;
}

/**
 * Everything a worker remembers between cycles. Deliberately plain data with no I/O and no timers, so a whole
 * multi-worker interleaving can be driven deterministically in a test by advancing an injected {@link Clock}.
 */
export interface LeaseState {
  /** Partitions we hold → the token our last write returned. Renewing with it is what detects a steal. */
  readonly held: ReadonlyMap<number, Token>;
  /** Partitions we do not hold → what we last saw, for staleness. */
  readonly seen: ReadonlyMap<number, Sighting>;
}

export function emptyLeaseState(): LeaseState {
  return { held: new Map(), seen: new Map() };
}

export interface LeaseOptions {
  /** This worker's identity. Stable per process (a hostname, task id, or uuid); two live processes must differ. */
  readonly owner: string;
  /** How many ways to split the fleet. Default {@link DEFAULT_PARTITIONS}. */
  readonly partitions?: number;
  /** Lease TTL. Default {@link DEFAULT_LEASE_TTL_MS}. */
  readonly ttlMs?: number;
}

export interface LeaseDeps {
  readonly registry: IRegistryDriver;
  readonly clock: Clock;
}

export interface LeaseCycleResult {
  /** Carry this into the next cycle. */
  readonly state: LeaseState;
  /** Partitions we hold **after** this cycle, ascending. This is the worker's slice of the fleet. */
  readonly held: readonly number[];
  /** Newly acquired this cycle (free or dead rows). */
  readonly claimed: readonly number[];
  /** Held at the start of the cycle and lost during it — stolen, or our renew raced. Stop work on these now. */
  readonly lost: readonly number[];
  /** Taken from a live owner to rebalance. At most one per cycle. */
  readonly stolen: readonly number[];
  /** Distinct owners observed, including us. The denominator of the fair share. */
  readonly workers: number;
  /** `ceil(partitions / workers)` — how many this worker is entitled to. */
  readonly target: number;
}

/** How long to wait between cycles: a third of the TTL, so a holder renews well inside it. */
export function leaseRenewIntervalMs(ttlMs: number = DEFAULT_LEASE_TTL_MS): number {
  return Math.max(1, Math.floor(ttlMs / LEASE_RENEW_DIVISOR));
}

function validate(options: LeaseOptions): { owner: string; partitions: number; ttlMs: number } {
  const { owner } = options;
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new ValidationError(
      `lease owner must be a non-empty string: got ${JSON.stringify(owner)}`,
    );
  }
  const partitions = options.partitions ?? DEFAULT_PARTITIONS;
  if (!Number.isSafeInteger(partitions) || partitions < 1 || partitions > MAX_PARTITIONS) {
    throw new ValidationError(
      `partitions must be an integer in [1, ${MAX_PARTITIONS}]: got ${partitions}`,
    );
  }
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS) {
    throw new ValidationError(
      `lease ttlMs must be an integer >= ${MIN_LEASE_TTL_MS}: got ${ttlMs}`,
    );
  }
  return { owner, partitions, ttlMs };
}

/**
 * Run one lease cycle: renew what we hold, claim what is free or dead, and take at most one partition from an
 * over-share owner. Idempotent, bounded (one `list` plus at most one write per partition), and safe to call from
 * every process concurrently — the losers of every race get a `WriteConflictError` and simply try again next
 * cycle.
 */
export async function runLeaseCycle(
  state: LeaseState,
  deps: LeaseDeps,
  options: LeaseOptions,
): Promise<LeaseCycleResult> {
  const { owner, partitions, ttlMs } = validate(options);
  const now = deps.clock.now();

  const rows = new Map<number, RegistryRecord>();
  for await (const record of deps.registry.list(LEASE_NAMESPACE)) {
    const partition = partitionOfLeaseRow(record.segment);
    // A row outside the configured range is left alone: shrinking `partitions` must not delete another
    // deployment's leases, and a foreign row in our namespace is ignored rather than adopted.
    if (partition !== null && partition < partitions) rows.set(partition, record);
  }

  const held = new Map<number, Token>();
  const lost: number[] = [];
  const claimed: number[] = [];
  const stolen: number[] = [];

  // ── 1. Renew what we hold. A conflict means we no longer hold it; the caller must stop that work at once. ──
  for (const [partition, token] of state.held) {
    if (partition >= partitions) {
      // The deployment shrank. Release rather than keep renewing a partition nobody assigns work to.
      await release(deps, partition, token);
      lost.push(partition);
      continue;
    }
    const renewed = await write(deps, partition, token, {
      leaseOwner: owner,
      leaseExpiresAt: now + ttlMs,
    });
    if (renewed === null) lost.push(partition);
    else held.set(partition, renewed);
  }

  // ── 2. Classify everything we do not hold. ──
  const seen = new Map<number, Sighting>();
  const free: number[] = [];
  const dead: number[] = [];
  const liveByOwner = new Map<string, number[]>();

  for (let partition = 0; partition < partitions; partition++) {
    if (held.has(partition)) continue;
    const row = rows.get(partition);
    if (row === undefined || row.leaseOwner === undefined || row.leaseOwner === owner) {
      // No row, nobody's, or a lease our own owner id abandoned across a restart — take it without waiting.
      free.push(partition);
      continue;
    }
    const previous = state.seen.get(partition);
    if (previous !== undefined && previous.token === row.token && now - previous.at >= ttlMs) {
      // The token has not moved for a whole TTL by OUR clock: the holder is not renewing.
      dead.push(partition);
      seen.set(partition, previous);
      continue;
    }
    // Alive, or newly observed. Re-arm the sighting whenever the token moved.
    seen.set(
      partition,
      previous !== undefined && previous.token === row.token
        ? previous
        : { token: row.token, at: now },
    );
    const owned = liveByOwner.get(row.leaseOwner);
    if (owned === undefined) liveByOwner.set(row.leaseOwner, [partition]);
    else owned.push(partition);
  }

  // ── 3. Fair share. Workers = distinct live owners, plus us. ──
  const workers = liveByOwner.size + 1;
  const target = Math.ceil(partitions / workers);

  // ── 4. Claim free rows first, then dead ones, up to our share. ──
  for (const partition of [...free, ...dead]) {
    if (held.size >= target) break;
    const token = await claim(deps, partition, rows.get(partition), owner, now + ttlMs);
    if (token === null) continue; // someone beat us; next cycle will see their token
    held.set(partition, token);
    claimed.push(partition);
    seen.delete(partition);
  }

  // ── 5. Still short? Take ONE partition from the most-loaded owner that is over its share. ──
  if (held.size < target) {
    let victim: { partition: number; count: number } | null = null;
    for (const owned of liveByOwner.values()) {
      if (owned.length <= target) continue;
      if (victim === null || owned.length > victim.count) {
        victim = { partition: owned[0] as number, count: owned.length };
      }
    }
    if (victim !== null) {
      const row = rows.get(victim.partition);
      if (row !== undefined) {
        const token = await write(deps, victim.partition, row.token, {
          leaseOwner: owner,
          leaseExpiresAt: now + ttlMs,
        });
        if (token !== null) {
          held.set(victim.partition, token);
          stolen.push(victim.partition);
          seen.delete(victim.partition);
        }
      }
    }
  }

  return {
    state: { held, seen },
    held: [...held.keys()].sort((a, b) => a - b),
    claimed,
    lost,
    stolen,
    workers,
    target,
  };
}

/**
 * Release every held lease. Called on a graceful stop: the next worker picks the partition up on its next cycle
 * instead of waiting out the whole TTL. Best-effort by design — a failed release is not an error, because the
 * TTL is the backstop and a process that is shutting down has nothing useful to do with the failure.
 */
export async function releaseAll(state: LeaseState, deps: LeaseDeps): Promise<number[]> {
  const released: number[] = [];
  for (const [partition, token] of state.held) {
    if (await release(deps, partition, token)) released.push(partition);
  }
  return released;
}

async function release(deps: LeaseDeps, partition: number, token: Token): Promise<boolean> {
  const result = await write(deps, partition, token, {
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  });
  return result !== null;
}

/** A CAS that maps "someone else got there first" to `null` and re-throws everything else. */
async function write(
  deps: LeaseDeps,
  partition: number,
  expected: Token,
  patch: { leaseOwner?: string; leaseExpiresAt?: number },
): Promise<Token | null> {
  try {
    const { token } = await deps.registry.compareAndSwap(leaseRef(partition), expected, patch);
    return token;
  } catch (err) {
    if (isWriteConflictError(err)) return null;
    throw err;
  }
}

/** Take a partition whose row is free, dead, or absent. Creating the row and owning it are separate steps. */
async function claim(
  deps: LeaseDeps,
  partition: number,
  row: RegistryRecord | undefined,
  owner: string,
  expiresAt: number,
): Promise<Token | null> {
  let expected: Token;
  if (row === undefined) {
    try {
      // `currentGen: null` — a lease row has no Cold generation and never will.
      const created = await deps.registry.create(leaseRef(partition), { currentGen: null });
      expected = created.token;
    } catch (err) {
      if (isWriteConflictError(err)) return null; // another worker created it; claim it next cycle
      throw err;
    }
  } else {
    expected = row.token;
  }
  return write(deps, partition, expected, { leaseOwner: owner, leaseExpiresAt: expiresAt });
}
