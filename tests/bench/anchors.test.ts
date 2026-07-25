import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryWarmDriver,
  MemoryColdChunkSource,
  MemoryColdDriver,
  CrbmColdChunkSource,
  writeCrbmGeneration,
  SafeBitmap,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  type MetricsSnapshot,
  type PricingProfile,
} from '@/index';
import { splitId, joinId } from '@/core/bit-route';

/**
 * Benchmark-as-test anchors (Phase 5c). These are the **defensible-floor** cost/perf claims turned into CI
 * assertions, so marketing can never drift ahead of measured reality (the benchmark
 * acceptance criteria). They are deterministic + rate-independent — no wall-clock timing (that lives in the
 * offline `pnpm bench`, too noisy for shared CI runners). A failing anchor is a build failure.
 *
 * Anchors covered here: count() → 0 payload reads (cheap count), intersection byte-savings, at-rest ≤10% of
 * Redis-HA, write- and read-crossover vs the published rates, and the estimator within ±20% of the engine's
 * measured backend cost (K3).
 */

const SECONDS_PER_MONTH = 730 * 3600; // matches the estimator's convention

async function drain(it: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out;
}

/** Seed a segment's Cold tier from a flat id list, grouped by chunk; returns total bytes seeded. */
function seedCold(cold: MemoryColdChunkSource, segment: string, ids: number[]): number {
  const byChunk = new Map<number, number[]>();
  for (const id of ids) {
    const { chunkKey, remainder } = splitId(id);
    (byChunk.get(chunkKey) ?? byChunk.set(chunkKey, []).get(chunkKey)!).push(remainder);
  }
  let bytes = 0;
  for (const [chunkKey, rems] of byChunk) {
    const serialized = SafeBitmap.fromValues(rems).serialize();
    cold.seed({ segment, chunkKey }, serialized);
    bytes += serialized.length;
  }
  return bytes;
}

describe('bench-as-test anchors (Phase 5c)', () => {
  it('count() performs 0 payload reads on a warm-delta-free segment (the cheap-count claim)', async () => {
    // A cold-only, fully-compacted segment across several .crbm chunks — the Topology-A steady state.
    const driver = new MemoryColdDriver();
    await writeCrbmGeneration(driver, { segment: 'counted', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
      { chunkKey: 5, bitmap: SafeBitmap.fromValues([10, 20, 30, 40]) },
      { chunkKey: 12, bitmap: SafeBitmap.fromValues([7]) },
    ]);
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new CrbmColdChunkSource(driver),
      metrics,
    });
    const n = await store.segment('counted').count();
    const snap = metrics.snapshot();
    expect(n).toBe(8); // 3 + 4 + 1, summed straight from the .crbm index
    expect(snap.cold.gets).toBe(0); // ZERO payload reads — counting is nearly free
    expect(snap.ops.count.count).toBe(1);
  });

  it('intersection at ~5% chunk overlap fetches ≤10% of the full-download bytes', async () => {
    // 20 chunks per segment; exactly one shared chunk key (19) → 5% overlap.
    const aChunks = Array.from({ length: 20 }, (_, k) => k); // keys 0..19
    const bChunks = Array.from({ length: 20 }, (_, k) => k + 19); // keys 19..38 → shares only key 19
    const metrics = new CountingMetricsSink();
    const cold = new MemoryColdChunkSource();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold, metrics });

    // ~1000 ids per chunk so payloads are non-trivial and comparable in size.
    const idsFor = (keys: number[]): number[] =>
      keys.flatMap((k) => Array.from({ length: 1000 }, (_, r) => joinId(k, r)));
    const fullBytes = seedCold(cold, 'a', idsFor(aChunks)) + seedCold(cold, 'b', idsFor(bChunks));

    metrics.reset();
    await drain(store.segment('a').intersect([store.segment('b')]));
    const snap = metrics.snapshot();

    // Only the single shared key (19) survives the key-alignment: 1 common key, fetched from BOTH
    // operands → exactly 2 payload GETs of the 40 chunks; the other 38 are never fetched (the core saving).
    expect(snap.intersect.calls).toBe(1);
    expect(snap.intersect.fetchedChunks).toBe(1); // = common key count
    expect(snap.cold.gets).toBe(2); // one GET per operand for the shared key
    // Byte-savings anchor: fetched cold bytes ≤ 10% of a full two-segment download.
    expect(snap.cold.bytes).toBeLessThanOrEqual(fullBytes * 0.1);
  });

  it('at-rest, the reference set costs ≤10% of a flat Redis-HA node', () => {
    // Reference: ~1.2 GiB total at rest, no traffic.
    const report = estimateCost({
      segments: [{ sizeBytes: 1.2 * 1024 ** 3, count: 1 }],
    });
    expect(report.verdict).toBe('win-big');
    expect(report.monthlyUSD.total).toBeLessThanOrEqual(
      AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD * 0.1,
    );
    // Pin the exact storage cost too, so a units regression (GiB↔GB, a mispriced tier, a dropped /GIB) can't
    // hide under the generous 10% bar: 1.2 GiB × $0.023/GiB-mo.
    expect(report.monthlyUSD.total).toBeCloseTo(1.2 * 0.023, 4);
  });

  it('the modeled write crossover is ≥ the published ~26 writes/sec (we never understate the loss)', () => {
    const report = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { avgItemKiB: 8 },
    });
    expect(report.redisCrossover.writesPerSec).toBeGreaterThanOrEqual(26);
    expect(report.redisCrossover.writesPerSec).toBeLessThan(27); // sanity ceiling
  });

  it('the modeled read crossover (Topology-B) matches the published ~527 reads/sec, over the $346 baseline', () => {
    // The published chart plots BOTH crossovers and the flat baseline they cross — gate both (and the
    // baseline) so the benchmarks page's "every number is CI-asserted" promise actually holds.
    const report = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: { avgItemKiB: 8, cacheHitRate: 0 },
    });
    expect(AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD).toBe(346);
    expect(report.redisCrossover.readsPerSec).toBeGreaterThanOrEqual(526);
    expect(report.redisCrossover.readsPerSec).toBeLessThan(527);
  });

  it('K3: the estimator predicts the engine measured backend cost within ±20%', async () => {
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({
      warm: new MemoryWarmDriver(),
      cold: new MemoryColdChunkSource(),
      metrics,
    });
    const seg = store.segment('bench');

    const W = 500; // writes (add)
    const R = 2000; // reads (has)
    for (let i = 0; i < W; i++) await seg.add(i);
    for (let i = 0; i < R; i++) await seg.has(i % W);
    const snap = metrics.snapshot();

    const measuredUSD = priceSnapshot(snap, AWS_US_EAST_1_ONDEMAND);
    const avgWriteKiB = snap.warm.writes ? snap.warm.writeBytes / snap.warm.writes / 1024 : 1;
    const predicted = estimateCost({
      segments: [{ sizeBytes: 0 }],
      topology: 'B',
      workload: {
        readsPerSec: R / SECONDS_PER_MONTH,
        writesPerSec: W / SECONDS_PER_MONTH,
        avgItemKiB: avgWriteKiB,
        cacheHitRate: 0,
      },
    }).monthlyUSD.total;

    // The residual gap is the read-modify-write RRU the estimator's write model omits (one warm read per
    // add); here that's ~10% of ~$6.3e-4 — a known, bounded simplification well inside the ±20% budget.
    const relErr = Math.abs(predicted - measuredUSD) / measuredUSD;
    expect(measuredUSD).toBeGreaterThan(0);
    expect(predicted).toBeGreaterThan(0);
    expect(relErr).toBeLessThanOrEqual(0.2);
  });
});

/** Price the engine's actual backend requests (from the metrics snapshot) with a pricing profile. */
function priceSnapshot(snap: MetricsSnapshot, p: PricingProfile): number {
  const rru = p.warm.rruPerMillion / 1e6;
  const wru = p.warm.wruPerMillion / 1e6;
  const rruMult = p.warm.stronglyConsistent ? 1 : 0.5;
  const avgReadKiB = snap.warm.reads ? snap.warm.readBytes / snap.warm.reads / 1024 : 0;
  const avgWriteKiB = snap.warm.writes ? snap.warm.writeBytes / snap.warm.writes / 1024 : 0;
  const readUnits = Math.max(1, Math.ceil(avgReadKiB / p.warm.readUnitKiB));
  const writeUnits = Math.max(1, Math.ceil(avgWriteKiB / p.warm.writeUnitKiB));
  const coldGet = p.cold.getPerMillion / 1e6;
  return (
    snap.warm.reads * readUnits * rruMult * rru +
    snap.warm.writes * writeUnits * wru +
    snap.cold.gets * coldGet
  );
}
