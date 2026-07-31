import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource } from '@/index';
import { SafeBitmap } from '@/roaring-codec';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';

// The intersection window's MEMORY bound, proven on the real `intersect` path.
//
// engine.ts documents it precisely: "the Cold payload footprint is bounded by the window
// (`concurrency × operands × chunk`), not by segment size — that's the Lambda-friendly property." That sentence
// is the reason anyone would run this on Lambda at all, and until this file it was the one load-bearing claim in
// the project with nothing asserting it.
//
// What DID exist, and why none of it covered this:
//
//   - `tests/core/concurrency.test.ts` proves `mapWithConcurrency` never exceeds its limit. That is the generic
//     primitive — and `combine` does not use it. It hand-rolls its own sliding window (engine.ts ~539), so the
//     primitive being correct says nothing about the path that matters.
//   - `intersect.test.ts` proves chunk *skipping* ("NEVER fetches chunks for non-overlapping keys") and that the
//     RESULT is identical across concurrency values. Both are about which bytes are fetched and what comes out,
//     never about how many are held at once.
//   - `bench/soak.cjs` issues no `intersect` calls at all, so the RSS gate that claims to bound the
//     "intersection window" cannot observe it. (Fixed separately; the site already disclosed this honestly.)
//
// So the bound was documented, depended upon, and unproven. A deterministic test is also strictly better
// evidence than an RSS ceiling: RSS infers boundedness from a process not dying, while this counts the actual
// concurrent payload reads and fails with a number.

/**
 * A cold source that tracks how many `getChunk` calls are in flight *simultaneously*, not just how many happen.
 *
 * The delay is load-bearing rather than incidental. `MemoryColdChunkSource.getChunk` resolves on the next
 * microtask, so without a real suspension point the window can drain almost as fast as it fills and `peak`
 * reads 1 or 2 — a test that would then "pass" against a completely unbounded implementation. Forcing every
 * fetch to park on a timer makes the window's true width observable, which is the difference between measuring
 * the bound and measuring the scheduler.
 */
class ConcurrencyTrackingCold implements ColdChunkSource {
  private readonly inner = new MemoryColdChunkSource();
  private inFlight = 0;
  peak = 0;
  calls = 0;

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    this.calls++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await this.inner.getChunk(ref);
    } finally {
      this.inFlight--;
    }
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
  seedChunk(ref: ChunkRef, remainders: number[]): void {
    this.inner.seed(ref, SafeBitmap.fromValues(remainders).serialize());
  }
}

/**
 * Seed two segments that share every one of `chunks` chunk keys, so the intersection has to fetch all of them
 * and the window is the only thing limiting how many are resident.
 */
function seedOverlapping(cold: ConcurrencyTrackingCold, chunks: number): void {
  for (let key = 0; key < chunks; key++) {
    cold.seedChunk({ segment: 'a', chunkKey: key }, [1, 2, 3]);
    cold.seedChunk({ segment: 'b', chunkKey: key }, [2, 3, 4]);
  }
}

async function drain(it: AsyncIterable<number>): Promise<number> {
  const out: number[] = [];
  for await (const id of it) out.push(id);
  return out.length;
}

async function peakFor(chunks: number, concurrency?: number) {
  const cold = new ConcurrencyTrackingCold();
  const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
  seedOverlapping(cold, chunks);
  const yielded = await drain(
    store.segment('a').intersect([store.segment('b')], concurrency ? { concurrency } : undefined),
  );
  return { peak: cold.peak, calls: cold.calls, yielded };
}

const OPERANDS = 2;
const DEFAULT_WINDOW = 8; // engine.ts DEFAULT_INTERSECT_CONCURRENCY

describe('intersection window is bounded (memory, not just fetch count)', () => {
  it('holds at most `concurrency × operands` chunk payloads in flight', async () => {
    const { peak, calls, yielded } = await peakFor(200);

    // Both operands of a key are fetched in parallel inside one `combineChunk`, so the ceiling is
    // window × operands — exactly what the docstring claims.
    expect(peak).toBeLessThanOrEqual(DEFAULT_WINDOW * OPERANDS);

    // Sanity, and the reason this test can fail: the window must actually have overlapped. Were `combine`
    // rewritten to await each key serially, `peak` would collapse to OPERANDS and the assertion above would
    // still pass — a bound that holds because nothing is concurrent proves nothing about the bound.
    expect(peak).toBeGreaterThan(OPERANDS);

    // And it really did traverse the whole fleet, so the ceiling above was not achieved by doing less work.
    expect(calls).toBe(200 * OPERANDS);
    expect(yielded).toBe(200 * 2); // remainders {2,3} shared per chunk
  });

  it('does NOT scale with segment size — 8× the chunks, same peak', async () => {
    // This is the actual claim: bounded by the window, NOT by segment size. A regression that buffered every
    // chunk would sail through the ceiling assertion above on a small fleet and only show up here.
    const small = await peakFor(64);
    const large = await peakFor(512);

    expect(large.calls).toBe(small.calls * 8); // 8× the work…

    // …and no more residency. Deliberately `<=` rather than strict equality: both runs saturate the same
    // ceiling, but pinning them equal would make the test fail on a 15-vs-16 scheduling margin, and a gate that
    // cries wolf gets ignored. `<=` still catches the regression this exists for — an unbounded window would put
    // `large.peak` at roughly 8× `small.peak`, not one below it.
    expect(large.peak).toBeLessThanOrEqual(small.peak);
    expect(large.peak).toBeLessThanOrEqual(DEFAULT_WINDOW * OPERANDS);
    expect(small.peak).toBeGreaterThan(OPERANDS); // both runs really did overlap
  });

  it('tracks an explicit concurrency option', async () => {
    // A caller narrowing the window for a memory-constrained runtime (the Lambda case) must actually get the
    // narrower window, not merely a correct result — `intersect.test.ts` already covers the result.
    const narrow = await peakFor(200, 2);
    const wide = await peakFor(200, 16);

    expect(narrow.peak).toBeLessThanOrEqual(2 * OPERANDS);
    expect(wide.peak).toBeLessThanOrEqual(16 * OPERANDS);
    expect(narrow.peak).toBeLessThan(wide.peak); // the option is doing something, not being ignored
    expect(narrow.yielded).toBe(wide.yielded); // and it costs nothing in correctness
  });

  it('bounds the window across three operands too', async () => {
    // The ceiling is `concurrency × operands`, so it must move with operand count in the way documented —
    // a bound that only holds for the two-segment case would be a bound on the test, not the code.
    const cold = new ConcurrencyTrackingCold();
    const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
    for (let key = 0; key < 120; key++) {
      for (const seg of ['a', 'b', 'c']) cold.seedChunk({ segment: seg, chunkKey: key }, [1, 2, 3]);
    }
    await drain(store.segment('a').intersect([store.segment('b'), store.segment('c')]));

    expect(cold.peak).toBeLessThanOrEqual(DEFAULT_WINDOW * 3);
    expect(cold.peak).toBeGreaterThan(3);
    expect(cold.calls).toBe(120 * 3);
  });

  it('bounds the window on andNot and union as well', async () => {
    // All three stream through the same `combine`, so all three inherit the bound — worth pinning, because the
    // suppression case (`andNot` against a large opt-out list) is precisely where an unbounded window would
    // hurt most in production.
    for (const op of ['andNot', 'union'] as const) {
      const cold = new ConcurrencyTrackingCold();
      const store = new CloudRoaring({ warm: new MemoryWarmDriver(), cold });
      seedOverlapping(cold, 150);
      const a = store.segment('a');
      const b = store.segment('b');
      await drain(op === 'andNot' ? a.andNot([b]) : a.union([b]));

      expect(cold.peak, `${op} exceeded the window`).toBeLessThanOrEqual(DEFAULT_WINDOW * OPERANDS);
      expect(cold.peak, `${op} never overlapped — the bound is vacuous`).toBeGreaterThan(1);
    }
  });
});
