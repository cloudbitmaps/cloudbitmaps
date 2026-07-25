/**
 * The deterministic simulation runner (findings V2/V3/V16).
 *
 * Runs the **real** engine (`CloudRoaring`, via the public API) against the fault-injecting fakes under the
 * seeded {@link Scheduler}, and checks the result against a trivial `Set<number>` **oracle**. Everything is
 * a pure function of the `seed`: a failure prints the seed and `simulate(seed)` reproduces the exact
 * interleaving + injected faults byte-for-byte (V16).
 *
 * Concurrency model (per batch):
 *  - Ops within a batch operate on **disjoint ids**, so they commute — the oracle is well-defined no matter
 *    how the scheduler interleaves them. This makes the "no lost acknowledged writes" check reduce
 *    to check 1 ("final set == oracle"): a dropped write surfaces as a missing/extra id. The sharper
 *    same-cell race (concurrent `add(X)` vs `remove(X)`, where the winner depends on commit order) needs a
 *    history-ordered oracle rather than the commutative `Set` here, and stays a documented deferral (below).
 *  - Ids are routed into a **small chunk-key space**, so disjoint ids routinely share a chunk and contend
 *    on the *same* Warm row — exercising the OCC read-modify-write retry loop under real contention (D4).
 *  - Between batches we reach a **quiescent point** and assert effective-set equivalence (count + full
 *    iterate + has spot-checks) against the oracle — the live-merge sense of I2/I3/I6.
 *
 * In scope (all under one seeded scheduler): the live-merge checks 1 ("final set == oracle") and 2 ("no lost
 * acknowledged writes"), plus the full compaction cluster — torn-read / generation-pinning (determinism check 3),
 * fenced-purge / no-lost-write (I4), torn-merge (I2/I3), intersection-under-compaction, crash-at-any-2PC-step
 * recovery, and warm + cold transient-fault retry. Still deferred (documented, not silently missing): the
 * same-cell add/remove race (needs a history-ordered oracle, above); and eventual-consistency reads +
 * cross-owner lease-steal recovery (need faults these in-memory, strongly-consistent fakes don't model).
 *
 * Reproducibility (V16): five **independent** seeded streams are derived from `seed` — op generation,
 * scheduling, fault injection (warm + cold), crash injection, and backoff jitter — so each concern can be
 * reasoned about and replayed without one shifting the others. The whole run is a pure function of `seed`.
 *
 * Test infrastructure — lives under `src/testing/`, never imported by the library entry point.
 */
import { CloudRoaring, bulkLoadCrbmGeneration, compactSegment } from '../../index';
import type { CompactionDeps, Segment } from '../../index';
import { isTransientError } from '@cloudbitmaps/core';
import { joinId } from '@cloudbitmaps/core';
import { SeededRng } from './rng';
import { SimClock } from './clock';
import { Scheduler } from './scheduler';
import {
  CrashInjector,
  ScheduledColdDriver,
  ScheduledRegistryDriver,
  ScheduledWarmDriver,
  SimCrash,
} from './fakes';
import type { FaultOptions } from './fakes';

export interface SimOptions {
  /** Number of independent segments. Each batch targets one (chosen by seed). */
  readonly segments?: number;
  /** Size of the chunk-key space ids route into — smaller ⇒ more Warm-row contention. */
  readonly chunkSpace?: number;
  /** Remainder space within a chunk (id = chunkKey·65536 + remainder). */
  readonly remainderSpace?: number;
  /** Ids pre-seeded into each segment's immutable Cold tier. */
  readonly coldSeedSize?: number;
  /** Number of concurrent batches to run. */
  readonly batches?: number;
  /** Concurrent ops per batch (all with disjoint ids). */
  readonly opsPerBatch?: number;
  /** Max ids touched by an addMany/removeMany op. */
  readonly maxManyLen?: number;
  /** Probability a `putConditional` is hit by a spurious (retryable) conflict. */
  readonly conflictRate?: number;
  /** Hard cap on injected spurious conflicts per chunk key (keeps retries bounded). */
  readonly maxConflictsPerKey?: number;
  /** Probability a warm/cold call is hit by a transient fault (ridden out by the retry decorator). 0 = off. */
  readonly transientRate?: number;
  /** Hard cap on injected transient faults per chunk key (keeps decorator retries bounded). */
  readonly maxTransientPerKey?: number;
  /**
   * Probability a batch also runs a **compaction concurrently with its ops** (0 = off). This races the
   * daemon's 2-phase commit (pin → merge `cold ∪ warm` → stage → swap `currentGen` → version-fenced purge)
   * against the live add/remove ops on the same segment — the fenced-purge / no-lost-write (I4) and
   * torn-merge (I2/I3) cluster. Off by default so the existing regression seeds stay byte-for-byte stable.
   */
  readonly compactionRate?: number;
  /**
   * Number of concurrent reads issued against a **write-free** segment while it is being compacted (0 = off).
   * Compaction is a membership no-op and the segment takes no writes that batch, so every read must equal the
   * oracle exactly — the torn-read / generation-pinning check (determinism check 3): a half-applied generation
   * swap or purge would be observed as a divergence. Needs `segments ≥ 2`; off by default.
   */
  readonly readsUnderCompaction?: number;
  /**
   * Probability a running compaction is **crashed mid-2PC** (0 = off), thrown *after* a durable partial commit
   * (a staged generation, or the `currentGen` swap). The 2PC is crash-safe by design, so the post-batch oracle
   * must still hold — a divergence is a real crash-recovery data-loss bug. At most one crash per batch; needs
   * `compactionRate > 0` (there must be a compaction to crash). Off by default.
   */
  readonly crashRate?: number;
}

type ResolvedOptions = Required<SimOptions>;

const DEFAULTS: ResolvedOptions = {
  segments: 2,
  chunkSpace: 3,
  remainderSpace: 4096,
  coldSeedSize: 40,
  batches: 12,
  opsPerBatch: 8,
  maxManyLen: 4,
  conflictRate: 0.25,
  maxConflictsPerKey: 2,
  transientRate: 0, // off by default: the regression corpus + existing seeds stay byte-for-byte stable
  maxTransientPerKey: 2,
  compactionRate: 0, // off by default (same reason): a compaction actor shifts the interleaving/streams
  readsUnderCompaction: 0, // off by default: the torn-read probe adds concurrent reads → shifts interleavings
  crashRate: 0, // off by default: crashing a compaction shifts the interleaving/streams
};

/**
 * The store's `currentGen`-cache TTL in the sim (ms). Between batches the SimClock advances past it so the
 * quiescent check re-resolves the current generation rather than serving a stale cache — the Phase-B #4
 * bounded-staleness re-resolve that a compaction commit relies on (gap #4). Explicit (not the production
 * default) so the sim owns its own staleness window and stays robust if that default changes.
 */
const GEN_TTL_MS = 1000;

export interface SimResult {
  readonly seed: number;
  readonly batches: number;
  readonly opsApplied: number;
  /** Ops the generator couldn't fill with distinct ids and dropped (coverage shrinks if this is high). */
  readonly droppedOps: number;
  readonly injectedConflicts: number;
  /** Transient faults injected across warm + cold (the retry-decorator path); 0 unless `transientRate > 0`. */
  readonly injectedTransients: number;
  /**
   * The **cold-read** subset of {@link injectedTransients} (`getTail`/`getRange`). Surfaced separately so a
   * test can prove the cold-read retry path fired rather than passing on warm transients alone (a dead cold
   * injector would leave this 0 while `injectedTransients` stayed positive — the exact vacuity to rule out).
   */
  readonly coldTransients: number;
  /** Compactions launched concurrently with a batch (0 unless `compactionRate > 0`). */
  readonly compactionsRun: number;
  /** Of those, how many committed a new generation (vs a clean no-op because nothing was dirty). */
  readonly compactionsCommitted: number;
  /**
   * Torn-read races that actually happened: a WRITE-FREE victim segment's compaction that **committed a new
   * generation** while concurrent reads (`readsUnderCompaction`) were racing it — the only interleaving in which
   * a generation-pinning tear could be observed. A test asserts this `> 0` so the torn-read check can't pass
   * vacuously against a never-changing generation (0 unless `readsUnderCompaction > 0` and a victim committed).
   */
  readonly tornReadCommits: number;
  /** Compactions crashed mid-2PC (0 unless `crashRate > 0`); the oracle proves each left a consistent state. */
  readonly crashesInjected: number;
  /**
   * Total common ids the intersection check verified across all batches (0 if the two segments never shared a
   * member). A positive value proves the `intersect` oracle-check saw real overlaps, not a vacuous empty ∩ empty.
   */
  readonly intersectionMatches: number;
  /** Scheduler steps (gates released). */
  readonly steps: number;
  /**
   * Max gates pending simultaneously — the realized concurrency width. `> 1` proves ops genuinely
   * overlapped (a serialized / no-op scheduler would never exceed 1), so a broken scheduler can't masquerade
   * as a passing concurrency test (the testing-rigor lens's "FIFO scheduler is invisible" gap).
   */
  readonly maxConcurrency: number;
  /** The scheduler release-order trace — identical across runs of the same seed. */
  readonly history: string[];
  /** Final effective-set size per segment, by segment name. */
  readonly finalCounts: Record<string, number>;
}

/** A simulation failure, tagged with the seed so it can be replayed exactly. */
export class SimulationError extends Error {
  constructor(
    readonly seed: number,
    message: string,
  ) {
    super(`[seed ${seed}] ${message}`);
    this.name = 'SimulationError';
  }
}

type Op =
  | { readonly kind: 'add'; readonly id: number }
  | { readonly kind: 'remove'; readonly id: number }
  | { readonly kind: 'addMany'; readonly ids: number[] }
  | { readonly kind: 'removeMany'; readonly ids: number[] };

/**
 * Run one simulation. Returns a {@link SimResult} on success; throws {@link SimulationError} (carrying the
 * seed) if the engine ever diverges from the oracle or an op fails unexpectedly.
 */
export async function simulate(seed: number, options: SimOptions = {}): Promise<SimResult> {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };
  validate(seed, opts);

  // Independent streams derived from the one seed (see header): generation / scheduling / warm-fault /
  // crash-injection / backoff-jitter. Decoupling them means adding a consumer to one concern doesn't perturb
  // the others' replay.
  const genRng = new SeededRng(seed);
  const schedRng = new SeededRng(seed ^ 0x9e37_79b9);
  const faultRng = new SeededRng(seed ^ 0x85eb_ca6b);
  const crashRng = new SeededRng(seed ^ 0xc2b2_ae35);
  const jitterRng = new SeededRng(seed ^ 0x27d4_eb2f);

  const scheduler = new Scheduler(schedRng);
  const clock = new SimClock();
  // One fault config, shared (via the shared `faultRng`) by the warm + cold fakes: warm injects spurious
  // conflicts + read/write transients, cold injects read transients. Separate per-driver budgets, one stream.
  const faults: FaultOptions = {
    conflictRate: opts.conflictRate,
    maxConflictsPerKey: opts.maxConflictsPerKey,
    transientRate: opts.transientRate,
    maxTransientPerKey: opts.maxTransientPerKey,
  };
  const warm = new ScheduledWarmDriver(scheduler, faultRng, faults);
  // The REAL `.crbm` + registry path (not the simplified chunk source): the engine resolves `currentGen`
  // through the registry and the compaction actor drives real generation writes/swaps — both sharing these
  // scheduled drivers, so every call interleaves through the one scheduler. The crash injector (shared across
  // cold + registry, ≤ one crash per batch) aborts a compaction mid-2PC after a durable partial commit.
  const crashInjector = new CrashInjector(crashRng, opts.crashRate, 1);
  const cold = new ScheduledColdDriver(scheduler, faultRng, faults, crashInjector);
  const registry = new ScheduledRegistryDriver(scheduler, () => clock.now(), crashInjector);

  // No TTL ⇒ the SimClock value never affects behavior; SimClock.sleep is instant so backoff doesn't slow
  // the sim. A seeded RNG (not the default Math.random) keeps backoff jitter — and thus replay — deterministic.
  const client = new CloudRoaring({
    warm,
    cold,
    registry,
    clock,
    rng: jitterRng,
    coldGenTtlMs: GEN_TTL_MS,
  });

  const segNames = Array.from({ length: opts.segments }, (_v, i) => `seg-${i}`);
  const oracles = new Map<string, Set<number>>();
  for (const name of segNames) {
    oracles.set(name, await seedCold(cold, registry, name, genRng, opts));
  }

  // Compaction shares the engine's scheduled drivers, so its 2PC steps interleave through the same scheduler.
  const deps: CompactionDeps = { cold, warm, registry, clock };
  let opsApplied = 0;
  let droppedOps = 0;
  let compactionsRun = 0;
  let compactionsCommitted = 0;
  let intersectionMatches = 0;
  let tornReadCommits = 0;
  // Run a compaction on `seg`, tolerating the two *injected* faults that are expected aborts (not bugs); any
  // other error propagates and surfaces via the batch's settled-results check. Returns whether it committed a
  // NEW generation, so the caller can tell a real generation swap apart from a no-op (clean/contention/abort).
  const runCompaction = async (seg: string): Promise<boolean> => {
    compactionsRun += 1;
    try {
      const r = await compactSegment({ segment: seg }, deps, { owner: 'sim' });
      if (r.compacted) compactionsCommitted += 1;
      return r.compacted;
    } catch (e) {
      // Expected injected aborts: a SimCrash (mid-2PC process death after a durable partial commit) and a
      // TransientError (a cold-read blip — compaction reads with the RAW driver, no retry by design, so it
      // surfaces here; the daemon would re-run next cycle). Both leave NO data lost — nothing is destructive
      // before the atomic swap — and the post-batch oracle equivalence proves the tier state stayed consistent.
      // `compactSegment` never *throws* a WriteConflictError (it reports contention via `reason`), so anything
      // else here is a real failure and must surface via the settled-results check.
      if (e instanceof SimCrash || isTransientError(e)) return false;
      throw e;
    }
  };
  for (let b = 0; b < opts.batches; b++) {
    const segName = genRng.pick(segNames);
    const oracle = oracles.get(segName)!;
    const segment = client.segment(segName);

    const ops = generateBatch(genRng, oracle, opts);
    droppedOps += opts.opsPerBatch - ops.length;
    // Apply to the oracle up front: disjoint ids ⇒ the batch commutes, so oracle state is
    // interleaving-independent and we can compare against it after the real ops settle.
    for (const op of ops) applyToOracle(oracle, op);

    // Refresh the per-key fault budgets each batch so the fault paths stay alive for the whole run
    // (otherwise they're exhausted in the first batches and later contention runs fault-free).
    warm.resetFaultBudget();
    cold.resetFaultBudget();
    crashInjector.reset();

    const doCompact = opts.compactionRate > 0 && genRng.bool(opts.compactionRate);
    // Torn-read probe targets a WRITE-FREE segment (any but this batch's write target), so its membership is
    // stable and a concurrent compaction is a pure no-op the reads must not observe half-applied.
    const victim =
      opts.readsUnderCompaction > 0 && segNames.length >= 2
        ? segNames.find((n) => n !== segName)!
        : null;

    scheduler.arm();
    const running = ops.map((op) => execOp(segment, op));
    // Extra actors sharing the armed window, so their driver calls interleave with the live ops:
    //  (1) a compaction racing this batch's writes on the SAME segment — its 2-phase commit (pin → merge
    //      cold∪warm → stage → swap currentGen → version-fenced purge) vs live writes → fenced-purge /
    //      no-lost-write (I4) + torn-merge (I2/I3), proven by the post-batch oracle equivalence;
    //  (2) the torn-read check — a compaction on a WRITE-FREE victim + concurrent reads of it, which must
    //      each equal the (stable) oracle since compaction is a membership no-op (generation-pinning, check 3).
    const extra: Promise<void>[] = [];
    if (doCompact) extra.push(runCompaction(segName).then(() => undefined));
    if (victim) {
      const victimSeg = client.segment(victim);
      const victimOracle = oracles.get(victim)!;
      // Count victim compactions that COMMIT a new generation while the reads below race them — the only
      // interleaving in which a torn read could actually be observed. This is what makes the probe provably
      // non-vacuous: `compactionsCommitted` alone can't, since it also counts the write-target's own commits.
      extra.push(
        runCompaction(victim).then((committed) => {
          if (committed) tornReadCommits += 1;
        }),
      );
      for (let r = 0; r < opts.readsUnderCompaction; r++) {
        extra.push(assertReadStable(seed, victimSeg, victimOracle, victim, b));
      }
    }
    // Attach the settle handlers *synchronously at launch* (Promise.allSettled, not a post-drain
    // Promise.all): a rejection during drain() must never be an unobserved rejection across the macrotask
    // boundary, which Node would surface as a fatal unhandledRejection — defeating the seed-replay guarantee.
    // We await the settled results after drain and re-throw the first failure.
    const settled = Promise.allSettled([...running, ...extra]);
    await scheduler.drain();
    const results = await settled;
    const failure = results.find((r) => r.status === 'rejected');
    if (failure && failure.status === 'rejected') {
      throw new SimulationError(
        seed,
        `batch ${b} on ${segName}: an op, compaction, or read rejected unexpectedly: ${(failure.reason as Error)?.message}`,
      );
    }
    opsApplied += ops.length;

    // Advance logical time past the currentGen TTL so the quiescent check re-resolves the (possibly newly
    // compacted) generation instead of serving a stale cache — models real time passing between reads and
    // exercises the Phase-B #4 bounded-staleness re-resolve (gap #4). Deterministic ⇒ replay stays identical.
    clock.advance(GEN_TTL_MS * 2);
    await assertEquivalent(seed, segment, oracle, segName, b, opts);

    // Intersection-under-compaction (the crown jewel): the ids common to two segments must equal the oracle
    // intersection — on segments a compaction may have just rewritten. A quiescent read (unarmed ⇒ no gates,
    // no rng), so it adds coverage without perturbing any seed's interleaving. Tally the matched ids so a
    // test can assert the check saw real overlaps (not a vacuous empty ∩ empty).
    if (segNames.length >= 2) {
      const other = segNames.find((n) => n !== segName)!;
      intersectionMatches += await assertIntersection(seed, client, oracles, segName, other, b);
    }
  }

  const finalCounts: Record<string, number> = {};
  for (const [name, oracle] of oracles) finalCounts[name] = oracle.size;

  return {
    seed,
    batches: opts.batches,
    opsApplied,
    droppedOps,
    injectedConflicts: warm.injectedConflicts,
    injectedTransients: warm.injectedTransients + cold.injectedTransients,
    coldTransients: cold.injectedTransients,
    compactionsRun,
    compactionsCommitted,
    crashesInjected: crashInjector.injected,
    intersectionMatches,
    tornReadCommits,
    steps: scheduler.steps,
    maxConcurrency: scheduler.maxConcurrency,
    history: scheduler.history(),
    finalCounts,
  };
}

function validate(seed: number, o: ResolvedOptions): void {
  if (!Number.isInteger(seed)) throw new TypeError(`seed must be an integer; got ${seed}`);
  const positives: Array<[string, number]> = [
    ['segments', o.segments],
    ['chunkSpace', o.chunkSpace],
    ['remainderSpace', o.remainderSpace],
    ['batches', o.batches],
    ['opsPerBatch', o.opsPerBatch],
    ['maxManyLen', o.maxManyLen],
  ];
  for (const [name, v] of positives) {
    if (!Number.isInteger(v) || v < 1)
      throw new RangeError(`${name} must be a positive integer; got ${v}`);
  }
  if (o.chunkSpace > 0x1_0000)
    throw new RangeError(`chunkSpace must be <= 65536; got ${o.chunkSpace}`);
  if (o.remainderSpace > 0x1_0000) {
    throw new RangeError(`remainderSpace must be <= 65536; got ${o.remainderSpace}`);
  }
  if (o.coldSeedSize < 0) throw new RangeError(`coldSeedSize must be >= 0; got ${o.coldSeedSize}`);

  // Probabilities in [0, 1] (also rejects NaN/Infinity, which would make `rng.bool` degenerate).
  const rates: Array<[string, number]> = [
    ['conflictRate', o.conflictRate],
    ['transientRate', o.transientRate],
    ['compactionRate', o.compactionRate],
    ['crashRate', o.crashRate],
  ];
  for (const [name, v] of rates) {
    if (!(v >= 0 && v <= 1)) throw new RangeError(`${name} must be in [0, 1]; got ${v}`);
  }
  const counts: Array<[string, number]> = [
    ['maxConflictsPerKey', o.maxConflictsPerKey],
    ['maxTransientPerKey', o.maxTransientPerKey],
    ['readsUnderCompaction', o.readsUnderCompaction],
  ];
  for (const [name, v] of counts) {
    if (!Number.isInteger(v) || v < 0)
      throw new RangeError(`${name} must be a non-negative integer; got ${v}`);
  }
  // Cross-option guards: reject a combination that reads as "fault enabled" but would silently never fire —
  // exactly the false-confidence trap the harness must avoid (a green test that exercised nothing).
  if (o.crashRate > 0 && o.compactionRate <= 0) {
    throw new RangeError(
      'crashRate > 0 requires compactionRate > 0 (a crash only fires mid-compaction)',
    );
  }
  if (o.readsUnderCompaction > 0 && o.segments < 2) {
    throw new RangeError(
      'readsUnderCompaction > 0 requires segments >= 2 (the torn-read probe needs a write-free victim segment)',
    );
  }
}

/**
 * Seed a segment's Cold tier with `coldSeedSize` random ids as a real generation-0 `.crbm`; returns the
 * matching oracle set. Runs before the scheduler is armed, so these driver calls are pass-through (un-gated).
 */
async function seedCold(
  cold: ScheduledColdDriver,
  registry: ScheduledRegistryDriver,
  segment: string,
  rng: SeededRng,
  o: ResolvedOptions,
): Promise<Set<number>> {
  const oracle = new Set<number>();
  const ids: number[] = [];
  for (let i = 0; i < o.coldSeedSize; i++) {
    const id = makeId(rng, o);
    if (oracle.has(id)) continue;
    oracle.add(id);
    ids.push(id);
  }
  // The REAL bulk-loader: writes a `.crbm` generation 0 and creates the registry row, exactly as production
  // seeds cold — so the engine reads it through `CrbmColdChunkSource` and the compaction actor can fold it.
  await bulkLoadCrbmGeneration(cold, { segment, generation: 0 }, ids, { registry });
  return oracle;
}

function makeId(rng: SeededRng, o: ResolvedOptions): number {
  return joinId(rng.nextInt(o.chunkSpace), rng.nextInt(o.remainderSpace));
}

/**
 * Build one batch of ops with globally-disjoint ids (so the batch commutes). `remove`/`removeMany` draw
 * from current oracle members; `add`/`addMany` draw fresh ids. An op that can't find enough distinct ids
 * is dropped (kept simple — the id space is sized so this is rare).
 */
function generateBatch(rng: SeededRng, oracle: Set<number>, o: ResolvedOptions): Op[] {
  const used = new Set<number>();
  const liveSnapshot = [...oracle];
  const ops: Op[] = [];

  for (let i = 0; i < o.opsPerBatch; i++) {
    const kind = rng.pick(['add', 'remove', 'addMany', 'removeMany'] as const);
    const isMany = kind === 'addMany' || kind === 'removeMany';
    const count = isMany ? 1 + rng.nextInt(o.maxManyLen) : 1;
    const wantFresh = kind === 'add' || kind === 'addMany';
    const ids = wantFresh
      ? drawFresh(rng, used, o, count)
      : drawLive(rng, liveSnapshot, used, count);
    if (ids.length === 0) continue; // nothing available this batch — drop the op

    if (kind === 'add') ops.push({ kind: 'add', id: ids[0]! });
    else if (kind === 'remove') ops.push({ kind: 'remove', id: ids[0]! });
    else if (kind === 'addMany') ops.push({ kind: 'addMany', ids });
    else ops.push({ kind: 'removeMany', ids });
  }
  return ops;
}

/**
 * Draw up to `count` ids not yet used *this batch* (the disjointness the commutativity argument needs).
 * "Fresh" means distinct-within-the-batch, not necessarily a non-member — re-adding an existing member is
 * a harmless idempotent op the oracle handles; what matters is that no two ops in a batch share an id.
 */
function drawFresh(rng: SeededRng, used: Set<number>, o: ResolvedOptions, count: number): number[] {
  const out: number[] = [];
  const maxAttempts = count * 16;
  for (let a = 0; a < maxAttempts && out.length < count; a++) {
    const id = makeId(rng, o);
    if (used.has(id)) continue;
    used.add(id);
    out.push(id);
  }
  return out;
}

/** Draw up to `count` ids from the live snapshot, skipping any already used this batch. */
function drawLive(rng: SeededRng, live: number[], used: Set<number>, count: number): number[] {
  const out: number[] = [];
  const maxAttempts = count * 16;
  for (let a = 0; a < maxAttempts && out.length < count && live.length > 0; a++) {
    const id = live[rng.nextInt(live.length)]!;
    if (used.has(id)) continue;
    used.add(id);
    out.push(id);
  }
  return out;
}

function applyToOracle(oracle: Set<number>, op: Op): void {
  switch (op.kind) {
    case 'add':
      oracle.add(op.id);
      break;
    case 'remove':
      oracle.delete(op.id);
      break;
    case 'addMany':
      for (const id of op.ids) oracle.add(id);
      break;
    case 'removeMany':
      for (const id of op.ids) oracle.delete(id);
      break;
  }
}

function execOp(segment: Segment, op: Op): Promise<void> {
  switch (op.kind) {
    case 'add':
      return segment.add(op.id);
    case 'remove':
      return segment.remove(op.id);
    case 'addMany':
      return segment.addMany(op.ids);
    case 'removeMany':
      return segment.removeMany(op.ids);
  }
}

/** Assert the engine's effective set for `segment` equals the oracle (count + full iterate + has). */
async function assertEquivalent(
  seed: number,
  segment: Segment,
  oracle: Set<number>,
  segName: string,
  batch: number,
  o: ResolvedOptions,
): Promise<void> {
  const count = await segment.count();
  if (count !== oracle.size) {
    throw new SimulationError(
      seed,
      `batch ${batch} on ${segName}: count ${count} != oracle ${oracle.size}`,
    );
  }

  const got: number[] = [];
  for await (const id of segment.iterate()) got.push(id);
  const want = [...oracle].sort((a, b) => a - b);
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
    throw new SimulationError(
      seed,
      `batch ${batch} on ${segName}: iterate() diverged from the oracle (${got.length} vs ${want.length})`,
    );
  }

  // has() spot-checks the *separate* warm.get read path (count/iterate use listChunks). A few members
  // must be present; a few non-members must be absent.
  for (const id of want.slice(0, 5)) {
    if (!(await segment.has(id))) {
      throw new SimulationError(
        seed,
        `batch ${batch} on ${segName}: has(${id}) false for a member`,
      );
    }
  }
  // Non-members drawn from *within* the routed id space (enumerated, not via joinId(chunkSpace+i,…) which
  // would wrap at chunkSpace=65536) — so we also probe absent/tombstoned cells inside populated chunks,
  // catching a has() false-positive that a missing id in iterate() wouldn't pinpoint.
  let negChecked = 0;
  for (let ck = 0; ck < o.chunkSpace && negChecked < 5; ck++) {
    for (let r = 0; r < o.remainderSpace && negChecked < 5; r++) {
      const cand = joinId(ck, r);
      if (oracle.has(cand)) continue;
      if (await segment.has(cand)) {
        throw new SimulationError(
          seed,
          `batch ${batch} on ${segName}: has(${cand}) true for a non-member`,
        );
      }
      negChecked++;
    }
  }
}

/**
 * Assert the engine's chunk-skipping `intersect(a, [b])` equals the oracle intersection — the crown-jewel
 * read path, exercised on segments a compaction may have just rewritten. `intersect` streams ascending, so a
 * divergence in size or order is a real defect (a torn/stale generation, a mis-skipped chunk, a lost id).
 * Returns the number of common ids found (== the verified intersection size), so a caller can prove across a
 * sweep that the check actually saw overlaps rather than trivially matching empty against empty.
 */
async function assertIntersection(
  seed: number,
  client: CloudRoaring,
  oracles: Map<string, Set<number>>,
  aName: string,
  bName: string,
  batch: number,
): Promise<number> {
  const got: number[] = [];
  for await (const id of client.segment(aName).intersect([client.segment(bName)])) got.push(id);
  const oa = oracles.get(aName)!;
  const ob = oracles.get(bName)!;
  const want = [...oa].filter((id) => ob.has(id)).sort((x, y) => x - y);
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
    throw new SimulationError(
      seed,
      `batch ${batch}: intersect(${aName}, [${bName}]) diverged from the oracle (${got.length} vs ${want.length})`,
    );
  }
  return want.length;
}

/**
 * Torn-read / generation-pinning probe (determinism check 3): a read of a WRITE-FREE segment issued *while it is
 * being compacted* must equal the oracle exactly. The segment takes no writes this batch and compaction is a
 * membership no-op, so the only way `count()` can diverge is by observing a half-applied generation swap /
 * purge — i.e. a torn read. Runs inside the armed window, so it interleaves with the compaction's 2PC steps.
 */
async function assertReadStable(
  seed: number,
  segment: Segment,
  oracle: Set<number>,
  name: string,
  batch: number,
): Promise<void> {
  const count = await segment.count();
  if (count !== oracle.size) {
    throw new SimulationError(
      seed,
      `batch ${batch}: torn read of write-free ${name} during compaction: count ${count} != oracle ${oracle.size}`,
    );
  }
}
