import { MemoryColdChunkSource, MemoryWarmDriver, BudgetExceededError } from '@/index';
import { roaringCodec } from '@/roaring-codec';
import { SegmentEngine } from '@/core/engine';
import type { ChunkRef, IWarmDriver, SegmentRef, WarmRow } from '@/core/ports';
import { joinId } from '@/core/bit-route';

// A memory ceiling that is SEPARATE from the budget, and that `budget: false` cannot switch off.
//
// The budget bounds cost — billable requests. Memory is a different axis, and treating one as the other caused
// two distinct bugs: a segment materialising ~12 MB before a `maxRequests: 2` budget could refuse it, and then
// a first attempt at the fix that applied the budget's row count to `intersect`, whose budget is
// `common keys × operands` — a product a single wide operand can legitimately exceed while staying in contract.
// An existing budget test caught that one.
//
// So there are two controls, and this file pins the property the budget cannot express: resident warm bytes are
// capped for EVERY read op, including intersect, and remain capped when the budget is disabled.
const SEG: SegmentRef = { namespace: 'ns', segment: 'wide' };

class CountingWarm implements IWarmDriver {
  yielded = 0;
  constructor(private readonly inner: MemoryWarmDriver = new MemoryWarmDriver()) {}
  listChunks = ((seg: SegmentRef, ...rest: unknown[]) => {
    const inner = (this.inner.listChunks as (...a: unknown[]) => AsyncIterable<WarmRow>)(
      seg,
      ...rest,
    );
    const bump = (): void => {
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

const mkEngine = (warm: IWarmDriver, extra: Record<string, unknown>) =>
  new SegmentEngine({
    warm,
    cold: new MemoryColdChunkSource(),
    codec: roaringCodec,
    ...extra,
  } as unknown as ConstructorParameters<typeof SegmentEngine>[0]);

/** Seed `rows` chunks through the engine, then hand back an engine configured however the case needs. */
async function seeded(rows: number, extra: Record<string, unknown>) {
  const warm = new CountingWarm();
  const seeder = mkEngine(warm as unknown as IWarmDriver, { budget: false });
  for (let k = 0; k < rows; k++) await seeder.add(SEG, joinId(k, 1));
  warm.yielded = 0;
  return { warm, engine: mkEngine(warm as unknown as IWarmDriver, extra) };
}

describe('warm-scan memory ceiling', () => {
  it('still applies when budget is disabled — which is exactly when it is needed', async () => {
    // `budget: false` is a legitimate choice ("I know my fan-out, do not limit it"). It must not silently also
    // mean "unbounded memory", or the opt-out becomes a footgun.
    const { warm, engine } = await seeded(400, { budget: false, maxWarmScanBytes: 200 });
    await expect(engine.count(SEG)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(warm.yielded).toBeLessThan(400); // abandoned, not drained
  });

  it('bounds intersect, the one read path the budget provably cannot', async () => {
    // intersect's budget is a product over the keys COMMON to all operands, so one wide operand can hold far
    // more rows than the product while remaining legal. Only a byte ceiling can bound it.
    const { engine } = await seeded(400, { budget: false, maxWarmScanBytes: 200 });
    // intersect streams, so the ceiling fires while consuming rather than on the call itself.
    const drain = async (): Promise<void> => {
      for await (const _ of engine.intersect([SEG, SEG])) void _;
    };
    await expect(drain()).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('does not disturb a scan that fits', async () => {
    // The inverse mistake: a ceiling set too eagerly would break ordinary reads.
    const { engine } = await seeded(3, { budget: false, maxWarmScanBytes: 64 * 1024 * 1024 });
    await expect(engine.count(SEG)).resolves.toBe(3);
  });

  it('names the ceiling and says it is independent of the budget', async () => {
    // Whoever hits this needs to know which knob to reach for — and that raising `budget` will not help.
    const { engine } = await seeded(400, { budget: false, maxWarmScanBytes: 200 });
    const err = (await engine.count(SEG).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('maxWarmScanBytes');
    expect(err.message).toContain('budget: false');
  });

  it('rejects a nonsensical ceiling at construction rather than at read time', async () => {
    // Fail fast at wiring time: a misconfigured ceiling discovered on the first read is discovered in
    // production. NaN is the reachable case — `Number(process.env.X)` with the variable unset.
    for (const bad of [0, -1, Number.NaN]) {
      expect(() =>
        mkEngine(new CountingWarm() as unknown as IWarmDriver, { maxWarmScanBytes: bad }),
      ).toThrow(/maxWarmScanBytes/);
    }
  });
});
