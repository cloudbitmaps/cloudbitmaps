import { MemoryColdDriver } from '@/index';
import { bulkLoadCrbmGeneration as coreBulkLoad } from '@/core/crbm-cold-source';
import { bulkLoadCrbmGeneration } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SystemClock } from '@/system-clock';
import { joinId } from '@/core/bit-route';

// Bulk-load must not hold Node's only thread for the duration of the load.
//
// It is the one operation in this library that legitimately occupies the CPU for hundreds of milliseconds — a
// 1M-id load touches ~62,000 chunks, and every one of them is serialized, CRC'd and framed. Measured before this
// fix: **442 ms wall, 450 ms during which the event loop did not turn once**. Wired to a request handler, that
// stalls every other request on the instance, health checks included, for the whole load. It is the difference
// between a slow endpoint and an instance that looks dead to its load balancer.
//
// WHAT THESE TESTS ASSERT is how many times the event loop actually turned during the load. That is deliberate
// and it is the whole design of the file. The two natural implementations of this fix — `await Promise.resolve()`
// and `await clock.sleep(0)` — both look right, both return promises, both get awaited in a loop, and both do
// **nothing**: they resolve on microtasks, and the microtask queue drains to empty before the loop advances a
// single phase. Measured, `sleep(0)` gave 555 ms of starvation against a 568 ms unyielded baseline. So a test
// that asserts "a clock was passed" or "a promise was awaited" passes against a fix that does not work, and only
// counting real loop turns can tell the two apart.
const KEY = { segment: 'coop', namespace: 'ns', generation: 1 } as const;

/**
 * Enough ids across enough distinct chunks that the unyielded load is comfortably longer than one loop turn,
 * while keeping the test fast. Chunk COUNT is what drives the cost — the per-chunk serialize/CRC/frame is ~4.5 µs
 * — so ids are spread one per chunk rather than piled into a few.
 */
const CHUNKS = 40_000;
const ids = Array.from({ length: CHUNKS }, (_, i) => joinId(i % 61_035, i % 65_536));

/** Run `load()` while a self-rescheduling `setImmediate` counts how many times the loop got to turn. */
async function loopTurnsDuring<T>(load: () => Promise<T>): Promise<{ turns: number; result: T }> {
  let turns = 0;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  await new Promise((r) => setImmediate(r)); // let the ticker start before the clock does
  turns = 0;
  const result = await load();
  stopped = true;
  return { turns, result };
}

describe('bulk-load is cooperative', () => {
  it('lets the event loop turn hundreds of times during a load that used to block it entirely', async () => {
    const { turns, result } = await loopTurnsDuring(() =>
      bulkLoadCrbmGeneration(new MemoryColdDriver() as never, KEY as never, ids),
    );
    // The flavor package pre-binds a real clock, so this is what an ordinary caller gets with no wiring at all.
    // The bound is loose on purpose — the exact count tracks machine speed — but it is orders of magnitude away
    // from the handful of turns a blocking load allows, which is the only distinction that matters.
    expect(turns).toBeGreaterThan(20);
    expect((result as { cardinality: number }).cardinality).toBe(new Set(ids).size);
  });

  it('blocks the loop when no clock is injected — the behaviour the clock opts out of', async () => {
    // Calling core directly, with a codec but no clock, is the pre-existing path. It must still work, and it must
    // still block: this fix is purely additive, and a core-only caller who never asked for yielding gets exactly
    // what they got before. This case is also the control for the one above — without it, a test asserting "many
    // turns" could be passing because the load is slow for some unrelated reason.
    const { turns } = await loopTurnsDuring(() =>
      coreBulkLoad(new MemoryColdDriver() as never, KEY as never, ids, { codec: roaringCodec }),
    );
    expect(turns).toBeLessThanOrEqual(2);
  });

  it('writes byte-identical output whether or not it yielded', async () => {
    // Yielding introduces await points into loops that mutate `pendingByChunk`, `byChunk` and the writer. If a
    // yield ever let interleaved work observe or disturb a half-built generation, the object would differ. The
    // sha256 the driver returns over the whole `.crbm` is the strongest available statement that it does not.
    const withClock = await bulkLoadCrbmGeneration(
      new MemoryColdDriver() as never,
      KEY as never,
      ids,
    );
    const without = await coreBulkLoad(new MemoryColdDriver() as never, KEY as never, ids, {
      codec: roaringCodec,
    });
    expect(withClock.sha256).toBe(without.sha256);
    expect(withClock.size).toBe(without.size);
    expect(withClock.chunkCount).toBe(without.chunkCount);
  });

  it('yields on an async source too, where the ingest loop is 20x more expensive per id', async () => {
    // The sync and async ingest loops are separate code paths — collapsing them into one `for await` over a
    // normalising wrapper costs 20x on sync input (224 ms vs 11 ms per 1M ids), which is why they are not
    // collapsed. Two paths means the yield has to be proven on both; only the sync one is covered above.
    async function* stream(): AsyncGenerator<number> {
      for (const id of ids) yield id;
    }
    const { turns, result } = await loopTurnsDuring(() =>
      bulkLoadCrbmGeneration(new MemoryColdDriver() as never, KEY as never, stream()),
    );
    expect(turns).toBeGreaterThan(20);
    expect((result as { cardinality: number }).cardinality).toBe(new Set(ids).size);
  });

  it('accepts an explicitly injected clock instead of the pre-bound one', async () => {
    // A simulation wires a virtual clock; the binding must fill an absent clock, never override a supplied one.
    let yields = 0;
    const counting = new SystemClock();
    const spy = {
      now: () => counting.now(),
      sleep: (ms: number) => counting.sleep(ms),
      yieldNow: () => {
        yields += 1;
        return counting.yieldNow();
      },
    };
    await bulkLoadCrbmGeneration(new MemoryColdDriver() as never, KEY as never, ids, {
      clock: spy,
    } as never);
    expect(yields).toBeGreaterThan(20);
  });
});
