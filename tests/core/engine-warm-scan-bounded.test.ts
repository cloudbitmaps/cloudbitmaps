import { MemoryColdChunkSource, MemoryWarmDriver, BudgetExceededError } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import type { ChunkRef, IWarmDriver, SegmentRef, WarmRow } from '@/core/ports';
import { joinId } from '@/core/bit-route';

// The READ path's warm scan is bounded by the budget, per row — not after the whole segment is in memory.
//
// `count`, `iterate` and `intersect` all begin by draining every warm delta row for the segment into a Map, and
// used to check the budget only once that Map was complete. A segment can hold up to 65,536 chunks; each row is
// individually capped by `decodeDelta`, but the aggregate was capped nowhere. So `budget.maxRequests` — the
// documented denial-of-wallet control — could only refuse the work *after* paying its full memory cost.
// Measured before the fix: 3,000 rows / ~12 MB materialised under `budget: { maxRequests: 2 }`.
//
// `intersect` is the worst case, because it pays this per operand.
//
// AS ABOVE, the load-bearing assertion is how far the driver was consumed, not that an error was thrown. The
// pre-fix code threw the same error after enumerating everything, so an error-only test cannot tell them apart.
const SEG: SegmentRef = { namespace: 'ns', segment: 'wide' };

/** Wraps a warm driver and counts how many chunk rows `listChunks` was actually asked to yield. */
class CountingWarm implements IWarmDriver {
  yielded = 0;
  constructor(private readonly inner: MemoryWarmDriver = new MemoryWarmDriver()) {}

  listChunks = ((seg: SegmentRef, ...rest: unknown[]) => {
    const inner = (this.inner.listChunks as (...a: unknown[]) => AsyncIterable<WarmRow>)(
      seg,
      ...rest,
    );
    const bump = () => {
      this.yielded += 1;
    };
    return (async function* () {
      for await (const row of inner) {
        bump();
        yield row;
      }
    })();
  }) as never;

  get = (ref: ChunkRef): Promise<WarmRow | null> => this.inner.get(ref);
  putConditional = ((...a: unknown[]) =>
    (this.inner.putConditional as (...x: unknown[]) => unknown)(...a)) as never;
  deleteConditional = ((...a: unknown[]) =>
    (this.inner.deleteConditional as (...x: unknown[]) => unknown)(...a)) as never;
}

const mkEngine = (warm: IWarmDriver, budget: { maxRequests: number } | false) =>
  new SegmentEngine({
    warm,
    cold: new MemoryColdChunkSource(),
    codec: roaringCodec,
    budget,
  } as unknown as ConstructorParameters<typeof SegmentEngine>[0]);

/**
 * Seed `rows` distinct chunks through the ENGINE (not by poking the driver's OCC), so the fixture exercises the
 * same write path a real caller would and cannot drift from the driver's token semantics.
 */
async function engineWithBudget(rows: number, maxRequests: number) {
  const warm = new CountingWarm();
  const seeder = mkEngine(warm as unknown as IWarmDriver, false);
  for (let k = 0; k < rows; k++) await seeder.add(SEG, joinId(k, 1));
  warm.yielded = 0; // only count what the ASSERTED operation reads
  return { warm, engine: mkEngine(warm as unknown as IWarmDriver, { maxRequests }) };
}

describe('warm scan is bounded by the budget, per row', () => {
  it.each([
    ['count', (e: SegmentEngine) => e.count(SEG)],
    [
      'iterate',
      async (e: SegmentEngine) => {
        for await (const _ of e.iterate(SEG)) void _;
      },
    ],
  ])('%s abandons the warm scan at the ceiling', async (_label, run) => {
    const { warm, engine } = await engineWithBudget(500, 3);
    await expect(run(engine)).rejects.toBeInstanceOf(BudgetExceededError);
    // 4, not 500: three rows admitted, the fourth trips the ceiling. Before the fix this was 500 — the entire
    // segment resident in memory before the budget was consulted.
    expect(warm.yielded).toBeLessThanOrEqual(4);
    expect(warm.yielded).toBeLessThan(500);
  });

  it('does not fire when the segment fits inside the budget', async () => {
    // Guards the inverse mistake: a per-row check that is too eager would break legitimate reads.
    const { warm, engine } = await engineWithBudget(3, 10);
    await expect(engine.count(SEG)).resolves.toBe(3);
    expect(warm.yielded).toBe(3);
  });

  it('reports the operation that was refused', async () => {
    const { engine } = await engineWithBudget(500, 3);
    const err = (await engine.count(SEG).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('count');
    expect(err.message).toContain('warm chunk rows');
  });
});
