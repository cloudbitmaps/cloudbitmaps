import { simulate, SimulationError } from '@/testing/simulator';

// These sweeps run many seeded simulations per test (the combined-fault one runs 25 seeds × 2 replays under
// every fault at once). Give them headroom so a loaded CI box can't turn a slow-but-correct run into a spurious
// timeout. Determinism means a genuine hang would hang forever (not flake), so a generous ceiling only guards
// against load — it never masks a bug.
vi.setConfig({ testTimeout: 30_000 });

describe('deterministic simulation vs Set oracle (V2, V3, V16)', () => {
  it('matches the oracle across a sweep of seeds', async () => {
    // The core property: under every seeded interleaving + injected conflict, the real engine's
    // effective set equals the oracle at every quiescent point. A failure throws SimulationError(seed).
    const histories = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const result = await simulate(seed);
      expect(result.seed).toBe(seed);
      expect(result.opsApplied).toBeGreaterThan(0);
      expect(result.maxConcurrency).toBeGreaterThan(1); // ops genuinely overlapped (not serialized)
      // Drops shrink coverage silently — keep them a small minority of the attempted ops.
      expect(result.droppedOps).toBeLessThan(result.opsApplied);
      histories.add(result.history.join('|'));
    }
    // The harness must actually EXPLORE: a degenerate RNG / FIFO scheduler would collapse every seed to
    // the same interleaving. Distinct histories across the sweep prove it doesn't (testing-rigor GAP).
    expect(histories.size).toBeGreaterThan(1);
  });

  it('is reproducible: the same seed replays an identical run (V16)', async () => {
    const a = await simulate(7);
    const b = await simulate(7);
    expect(b.history).toEqual(a.history);
    expect(b.finalCounts).toEqual(a.finalCounts);
    expect(b.steps).toBe(a.steps);
    expect(b.maxConcurrency).toBe(a.maxConcurrency);
    expect(b.injectedConflicts).toBe(a.injectedConflicts);
    expect(b.droppedOps).toBe(a.droppedOps);
  });

  it('converges under heavy single-row contention (OCC retry loop, D4)', async () => {
    // All ids funnel into one chunk key, so every concurrent op contends on the SAME Warm row, plus a
    // high spurious-conflict rate — the engine's bounded OCC retry must still land every write.
    for (let seed = 0; seed < 30; seed++) {
      const result = await simulate(seed, {
        segments: 1,
        chunkSpace: 1,
        opsPerBatch: 8,
        batches: 10,
        conflictRate: 0.5,
        maxConflictsPerKey: 2,
      });
      expect(result.opsApplied).toBeGreaterThan(0);
      expect(result.maxConcurrency).toBeGreaterThan(1); // real overlap on the one row
      // This test's whole point is OCC-under-spurious-conflict — assert the fault actually fired, so a
      // dead injection path can't let it pass green while testing nothing but plain contention.
      expect(result.injectedConflicts).toBeGreaterThan(0);
    }
  });

  it('actually injects spurious conflicts under a high rate', async () => {
    let totalInjected = 0;
    for (let seed = 0; seed < 10; seed++) {
      const result = await simulate(seed, { conflictRate: 0.8, maxConflictsPerKey: 3 });
      totalInjected += result.injectedConflicts;
    }
    expect(totalInjected).toBeGreaterThan(0); // the fault path is exercised, not dead
  });

  it('survives injected transient faults with no data loss (Phase 4b resilience)', async () => {
    // With a non-zero transientRate, warm reads/writes AND cold reads (getTail/getRange) intermittently throw
    // TransientError. The retry decorator the store wraps its drivers in must ride them out so the engine's
    // effective set still equals the oracle at every quiescent point — a transient blip never loses or corrupts
    // a write/read. Combined with spurious conflicts, this exercises both recovery loops at once (decorator for
    // transients, OCC loop for conflicts).
    let totalTransients = 0;
    let totalColdTransients = 0;
    for (let seed = 0; seed < 40; seed++) {
      const result = await simulate(seed, {
        conflictRate: 0.3,
        maxConflictsPerKey: 2,
        transientRate: 0.4,
        maxTransientPerKey: 2,
      });
      expect(result.opsApplied).toBeGreaterThan(0);
      totalTransients += result.injectedTransients;
      totalColdTransients += result.coldTransients;
    }
    expect(totalTransients).toBeGreaterThan(0); // the transient-fault path actually fired, not dead
    expect(totalColdTransients).toBeGreaterThan(0); // ...and the COLD-read retry path specifically, not warm alone
  });

  it('replays identically with transient faults enabled (V16 determinism holds)', async () => {
    const opts = { transientRate: 0.5, maxTransientPerKey: 2 };
    const a = await simulate(7, opts);
    const b = await simulate(7, opts);
    expect(b.history).toEqual(a.history);
    expect(b.finalCounts).toEqual(a.finalCounts);
    expect(b.injectedTransients).toBe(a.injectedTransients);
    expect(b.coldTransients).toBe(a.coldTransients); // the added cold-read stream replays byte-identically too
    expect(b.injectedConflicts).toBe(a.injectedConflicts);
  });

  it('survives compaction racing the live write path with no data loss (I2/I3/I4)', async () => {
    // A compaction runs concurrently with each batch's add/remove ops on the SAME segment, so its 2-phase
    // commit (merge cold∪warm → swap currentGen → version-fenced purge) interleaves with live writes. The
    // oracle equivalence at every quiescent point proves no write was lost to the fenced purge (I4) and no
    // merge was torn (I2/I3). We also assert compactions actually COMMITTED — a dead/no-op compaction path
    // would pass green while testing nothing.
    let run = 0;
    let committed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const result = await simulate(seed, {
        segments: 1,
        chunkSpace: 3,
        opsPerBatch: 6,
        batches: 12,
        conflictRate: 0.2,
        compactionRate: 0.9,
      });
      expect(result.opsApplied).toBeGreaterThan(0);
      expect(result.maxConcurrency).toBeGreaterThan(1); // ops + compaction genuinely overlapped
      run += result.compactionsRun;
      committed += result.compactionsCommitted;
    }
    expect(run).toBeGreaterThan(0); // the compaction path actually fired
    expect(committed).toBeGreaterThan(0); // ...and compactions genuinely committed new generations
  });

  it('replays identically with compaction enabled (V16 determinism holds)', async () => {
    const opts = { segments: 1, compactionRate: 0.9, conflictRate: 0.2, batches: 12 };
    const a = await simulate(7, opts);
    const b = await simulate(7, opts);
    expect(b.history).toEqual(a.history);
    expect(b.finalCounts).toEqual(a.finalCounts);
    expect(b.compactionsRun).toBe(a.compactionsRun);
    expect(b.compactionsCommitted).toBe(a.compactionsCommitted);
  });

  it('intersect matches the oracle intersection under concurrent compaction (crown jewel)', async () => {
    // Two segments, a compaction racing each batch. The quiescent-point intersect check inside simulate
    // asserts intersect(a, [b]) === oracle(a) ∩ oracle(b) on segments a compaction may have just rewritten;
    // a divergence throws SimulationError(seed). A deliberately SMALL id space makes the two segments routinely
    // share members, so the check verifies real, NON-EMPTY intersections — not a vacuous empty ∩ empty that
    // would pass no matter what intersect returned. `intersectionMatches > 0` proves those teeth actually bit.
    let committed = 0;
    let matches = 0;
    for (let seed = 0; seed < 40; seed++) {
      const result = await simulate(seed, {
        segments: 2,
        chunkSpace: 3,
        remainderSpace: 64, // 3 × 64 = 192-id space ⇒ two ~50-id segments overlap ~13 ids/batch
        coldSeedSize: 50,
        opsPerBatch: 6,
        batches: 12,
        compactionRate: 0.9,
      });
      committed += result.compactionsCommitted;
      matches += result.intersectionMatches;
    }
    expect(committed).toBeGreaterThan(0); // compactions genuinely committed, so intersect ran post-rewrite
    expect(matches).toBeGreaterThan(0); // ...and the intersect check verified real, non-empty overlaps
  });

  it('serves no torn read of a segment being compacted (generation-pinning, check 3)', async () => {
    // While a WRITE-FREE segment is compacted, concurrent count() reads must each equal the oracle exactly —
    // compaction is a membership no-op, so any divergence is a half-applied generation swap/purge observed
    // mid-flight. assertReadStable inside simulate throws SimulationError on a torn read.
    let tornReadCommits = 0;
    for (let seed = 0; seed < 40; seed++) {
      const result = await simulate(seed, {
        segments: 2,
        chunkSpace: 3,
        opsPerBatch: 5,
        batches: 12,
        compactionRate: 0.5,
        readsUnderCompaction: 3,
      });
      // Per-seed: the reads genuinely overlapped the compaction (a serialized scheduler would never exceed 1).
      expect(result.maxConcurrency).toBeGreaterThan(1);
      tornReadCommits += result.tornReadCommits;
    }
    // Guard against a vacuous pass: the VICTIM's compaction must actually commit a new generation WHILE the
    // reads race it (not just any compaction elsewhere — a write-target commit wouldn't touch the victim the
    // reads observe). Otherwise the probe ran against a never-changing generation and could never see a tear.
    // `tornReadCommits` isolates exactly that interleaving.
    expect(tornReadCommits).toBeGreaterThan(0);
  });

  it('survives a compaction crashed mid-2PC under concurrency (crash-safe recovery, I3/I4/I5)', async () => {
    // A compaction is crashed AFTER a durable partial commit (a staged generation, or the currentGen swap)
    // while add/remove ops race it. The 2PC is crash-safe, so the post-batch oracle must still hold and a
    // later compaction must still make progress — a divergence or an unexpected reject is a real
    // crash-recovery data-loss bug. Assert crashes actually fired (the path isn't dead).
    let crashes = 0;
    let committed = 0;
    for (let seed = 0; seed < 60; seed++) {
      const result = await simulate(seed, {
        segments: 1,
        chunkSpace: 3,
        opsPerBatch: 5,
        batches: 14,
        conflictRate: 0.2,
        compactionRate: 0.9,
        crashRate: 0.5,
      });
      crashes += result.crashesInjected;
      committed += result.compactionsCommitted;
    }
    expect(crashes).toBeGreaterThan(0); // compactions were actually crashed mid-2PC
    expect(committed).toBeGreaterThan(0); // ...and compaction still made progress across the crashes (recovery)
  });

  it('replays identically with crashes enabled (V16 determinism holds)', async () => {
    const opts = {
      segments: 1,
      compactionRate: 0.9,
      crashRate: 0.5,
      conflictRate: 0.2,
      batches: 14,
    };
    const a = await simulate(99, opts);
    const b = await simulate(99, opts);
    expect(b.history).toEqual(a.history);
    expect(b.finalCounts).toEqual(a.finalCounts);
    expect(b.crashesInjected).toBe(a.crashesInjected);
    expect(b.compactionsCommitted).toBe(a.compactionsCommitted);
  });

  it('replays identically under ALL faults combined, holding the oracle (stream independence)', async () => {
    // The strongest determinism + correctness check: every fault on at once — spurious conflicts, warm+cold
    // transients, compaction racing the writes, torn-read probes, and mid-2PC crashes. Across the sweep the
    // oracle must hold under the combined interleaving (no fault *interaction* loses data — e.g. a transient
    // aborting a compaction that a crash then re-attempts), and each seed must replay byte-identically —
    // proving the five seeded streams stay independent even when all are consumed heavily in one run.
    const opts = {
      segments: 2,
      chunkSpace: 3,
      opsPerBatch: 6,
      batches: 12,
      conflictRate: 0.3,
      maxConflictsPerKey: 2,
      transientRate: 0.3,
      maxTransientPerKey: 2,
      compactionRate: 0.8,
      readsUnderCompaction: 2,
      crashRate: 0.4,
    };
    let exercised = 0;
    for (let seed = 0; seed < 25; seed++) {
      const a = await simulate(seed, opts); // reaching here at all = the oracle held across the whole run
      const b = await simulate(seed, opts);
      expect(b.history).toEqual(a.history);
      expect(b.finalCounts).toEqual(a.finalCounts);
      expect(b.injectedConflicts).toBe(a.injectedConflicts);
      expect(b.injectedTransients).toBe(a.injectedTransients);
      expect(b.coldTransients).toBe(a.coldTransients);
      expect(b.compactionsCommitted).toBe(a.compactionsCommitted);
      expect(b.crashesInjected).toBe(a.crashesInjected);
      exercised +=
        a.injectedConflicts + a.injectedTransients + a.crashesInjected + a.compactionsCommitted;
    }
    expect(exercised).toBeGreaterThan(0); // the combined-fault run genuinely drove the fault machinery
  });

  it('passes the committed regression-seed corpus', async () => {
    // Every past failure becomes a permanent seed here (spec 09 §Reproducibility). Currently the
    // hand-picked corpus that shook out the harness during bring-up; grows as real failures surface.
    const corpus = [0, 1, 42, 1337, 2024, 65_535, 999_999, 2_147_483_647];
    for (const seed of corpus) {
      await expect(simulate(seed)).resolves.toMatchObject({ seed });
    }
  });

  it('handles a many-segment, many-batch run', async () => {
    const result = await simulate(2024, { segments: 4, batches: 25, opsPerBatch: 10 });
    expect(Object.keys(result.finalCounts)).toHaveLength(4);
  });

  it('surfaces retry-exhaustion as a SimulationError, not a fatal unhandledRejection', async () => {
    // If an op rejects *during* drain(), its handler must already be attached (allSettled at launch) so the
    // rejection is never an unobserved promise across the macrotask boundary — which Node would turn into a
    // process-killing unhandledRejection, defeating the seed-replay guarantee. Force exhaustion with a
    // spurious-conflict budget above the engine's retry ceiling on a single op.
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => void unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        simulate(12_345, {
          segments: 1,
          chunkSpace: 1,
          opsPerBatch: 1,
          batches: 1,
          conflictRate: 1.0,
          maxConflictsPerKey: 20,
        }),
      ).rejects.toBeInstanceOf(SimulationError);
      await new Promise((r) => setImmediate(r)); // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('validates options and seed', async () => {
    await expect(simulate(1.5)).rejects.toThrow(TypeError);
    await expect(simulate(1, { chunkSpace: 0 })).rejects.toThrow(RangeError);
    await expect(simulate(1, { remainderSpace: 70_000 })).rejects.toThrow(RangeError);
    await expect(simulate(1, { coldSeedSize: -1 })).rejects.toThrow(RangeError);
    // Rates must be probabilities.
    await expect(simulate(1, { conflictRate: 1.5 })).rejects.toThrow(RangeError);
    await expect(simulate(1, { crashRate: -0.1 })).rejects.toThrow(RangeError);
    // Cross-option guards: a fault that would silently never fire is rejected up front, not run as a no-op.
    await expect(simulate(1, { crashRate: 0.5, compactionRate: 0 })).rejects.toThrow(RangeError);
    await expect(simulate(1, { readsUnderCompaction: 2, segments: 1 })).rejects.toThrow(RangeError);
  });

  it('SimulationError carries the seed for replay', () => {
    const err = new SimulationError(123, 'boom');
    expect(err.seed).toBe(123);
    expect(err.message).toContain('[seed 123]');
    expect(err).toBeInstanceOf(Error);
  });
});
