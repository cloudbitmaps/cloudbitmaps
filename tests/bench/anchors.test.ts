import {
  CloudRoaring,
  CountingMetricsSink,
  MemoryColdDriver,
  CrbmColdChunkSource,
  SafeBitmap,
  writeCrbmGeneration,
  estimateCost,
  AWS_US_EAST_1_ONDEMAND,
  type MetricsSnapshot,
  type PricingProfile,
} from '@/index';
import { joinId } from '@/core/bit-route';
import { collect, loadedStore, seededStore } from '../helpers/loaded';

/**
 * Benchmark-as-test anchors. These are the **defensible-floor** cost/perf claims turned into CI
 * assertions, so marketing can never drift ahead of measured reality (the benchmark
 * acceptance criteria). They are deterministic + rate-independent — no wall-clock timing (that lives in the
 * offline `pnpm bench`, too noisy for shared CI runners). A failing anchor is a build failure.
 *
 * Anchors covered here: count() → 0 payload reads (cheap count), intersection byte-savings, at-rest ≤10% of
 * Redis-HA, the read-crossover vs the published rates, and the estimator never understating the cold requests
 * the engine actually issued (K3).
 */

const SECONDS_PER_MONTH = 730 * 3600; // matches the estimator's convention
const GIB = 1024 ** 3;

describe('bench-as-test anchors', () => {
  it('count() performs 0 payload reads on a loaded segment (the cheap-count claim)', async () => {
    // A loaded segment across several .crbm chunks — the steady state of every segment in this model.
    const driver = new MemoryColdDriver();
    await writeCrbmGeneration(driver, { segment: 'counted', generation: 0 }, [
      { chunkKey: 0, bitmap: SafeBitmap.fromValues([1, 2, 3]) },
      { chunkKey: 5, bitmap: SafeBitmap.fromValues([10, 20, 30, 40]) },
      { chunkKey: 12, bitmap: SafeBitmap.fromValues([7]) },
    ]);
    const metrics = new CountingMetricsSink();
    const store = new CloudRoaring({ cold: new CrbmColdChunkSource(driver), metrics });
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
    // ~1000 ids per chunk so payloads are non-trivial and comparable in size.
    const idsFor = (keys: number[]): number[] =>
      keys.flatMap((k) => Array.from({ length: 1000 }, (_, r) => joinId(k, r)));

    const metrics = new CountingMetricsSink();
    const { store, cold } = seededStore({ a: idsFor(aChunks), b: idsFor(bChunks) }, { metrics });
    const fullBytes =
      (await cold.sizeOf({ segment: 'a' }))!.sizeBytes +
      (await cold.sizeOf({ segment: 'b' }))!.sizeBytes;

    metrics.reset();
    await collect(store.segment('a').intersect([store.segment('b')]));
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

  it('the modeled read crossover matches the published ~329 reads/sec, over the $346 baseline', () => {
    // The published chart plots the read crossover and the flat baseline it crosses — gate both, so the
    // benchmarks page's "every number is CI-asserted" promise actually holds. 346 / (2,628,000 × $0.40/M).
    const report = estimateCost({
      segments: [{ sizeBytes: 0 }],
      workload: { cacheHitRate: 0 },
    });
    expect(AWS_US_EAST_1_ONDEMAND.redis.monthlyUSD).toBe(346);
    expect(report.redisCrossover.readsPerSec).toBeGreaterThanOrEqual(329);
    expect(report.redisCrossover.readsPerSec).toBeLessThan(330);
  });

  it('K3: the estimator never understates the cold requests the engine actually issued', async () => {
    // The engine's only billable request on a read path is a cold GET of one chunk, and the sink counts them.
    // So the anchor is: price what the sink OBSERVED, then check the model — fed the same read rate and the
    // same observed cache posture — lands on it from above. That is what keeps the published crossover
    // honest: a units slip (per-request vs per-million, a wrong seconds-per-month) shows up here as a gap.
    const CHUNKS = 64;
    const IDS_PER_CHUNK = 4;
    const ids = Array.from({ length: CHUNKS }, (_, k) =>
      Array.from({ length: IDS_PER_CHUNK }, (_, r) => joinId(k, r)),
    );
    const metrics = new CountingMetricsSink();
    const { store, load } = await loadedStore({}, { metrics });
    const { size } = await load('bench', ids.flat());

    metrics.reset();
    const seg = store.segment('bench');
    for (const chunk of ids) for (const id of chunk) expect(await seg.has(id)).toBe(true);
    const snap = metrics.snapshot();

    const reads = CHUNKS * IDS_PER_CHUNK;
    // One GET per chunk; the other three reads of each chunk are served by the HOT cache.
    expect(snap.cold.gets).toBe(CHUNKS);
    expect(snap.cache.hits).toBe(reads - CHUNKS);
    const observedHitRate = snap.cache.hits / (snap.cache.hits + snap.cache.misses);

    const measuredUSD = priceSnapshot(snap, AWS_US_EAST_1_ONDEMAND, size);
    const predicted = (
      await seg.costReport({
        workload: { readsPerSec: reads / SECONDS_PER_MONTH, cacheHitRate: observedHitRate },
      })
    ).monthlyUSD.total;

    expect(measuredUSD).toBeGreaterThan(0);
    expect(predicted).toBeGreaterThan(0);
    // Direction first (the claim that matters: we never quote a cheaper bill than the engine incurs), then a
    // ±20% band so an over-statement can't drift unbounded either.
    expect(predicted).toBeGreaterThanOrEqual(measuredUSD);
    expect(Math.abs(predicted - measuredUSD) / measuredUSD).toBeLessThanOrEqual(0.2);
  });
});

/**
 * Price the engine's actual backend requests (from the metrics snapshot) with a pricing profile: cold GETs at
 * the published rate, plus the real generation bytes at rest. Reads are the only per-request charge a loaded
 * store's read path can incur.
 */
function priceSnapshot(snap: MetricsSnapshot, p: PricingProfile, coldBytes: number): number {
  return (
    snap.cold.gets * (p.cold.getPerMillion / 1e6) + (coldBytes / GIB) * p.cold.storagePerGiBMonth
  );
}
