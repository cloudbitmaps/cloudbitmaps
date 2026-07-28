import { CloudRoaring, MemoryWarmDriver, MemoryColdChunkSource, TransientError } from '@/index';
import type { ChunkRef, IWarmDriver, SegmentRef, WarmRow } from '@/core/ports';
import { joinId } from '@/core/bit-route';

// The bounds have to hold through the DEFAULT wiring, not just against a bare engine.
//
// 0.3.0 bounded every enumeration and proved it — by constructing `SegmentEngine` directly. `CloudRoaring`
// wraps the warm driver in `RetryingWarmDriver`, and that wrapper used to drain the whole scan into an array
// before yielding a single row:
//
//     const rows = await withRetry(async () => { for await (…) out.push(row); return out; });
//     yield* rows;
//
// So the engine's per-row ceiling saw its first row only after the entire segment was already resident. The
// control it was protecting fired *after* the memory had been allocated. Measured on a 500-row segment under
// `budget: { maxRequests: 3 }`: **500 rows materialised with the default wiring, 4 with `retry: false`.**
//
// Both configurations threw the same `BudgetExceededError`, which is exactly why every existing test missed
// it — the error was never the distinguishing observable. **The row count is.** That is the whole design of
// this file, and the reason it goes through the facade rather than the engine: a bound that only holds in a
// wiring nobody uses is not a bound.
const ROWS = 500;

/** Counts rows the INNER driver was actually asked to produce — i.e. what really got materialised. */
class CountingWarm implements IWarmDriver {
  yielded = 0;
  constructor(readonly inner: MemoryWarmDriver = new MemoryWarmDriver()) {}
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

async function seeded(): Promise<CountingWarm> {
  const warm = new CountingWarm();
  const seed = new CloudRoaring({
    warm: warm as unknown as IWarmDriver,
    cold: new MemoryColdChunkSource(),
    budget: false,
    retry: false,
  } as never);
  for (let k = 0; k < ROWS; k++) await seed.segment('s').add(joinId(k, 1));
  warm.yielded = 0;
  return warm;
}

describe('the warm-scan bound survives the retry wrapper', () => {
  it('abandons the scan under the DEFAULT wiring, not just with retry disabled', async () => {
    const warm = await seeded();
    const store = new CloudRoaring({
      warm: warm as unknown as IWarmDriver,
      cold: new MemoryColdChunkSource(),
      budget: { maxRequests: 3 },
    } as never); // no `retry: false` — this is what an ordinary caller constructs

    await expect(store.segment('s').count()).rejects.toThrow();
    // 4, not 500. Before the fix this was 500 with an identical error.
    expect(warm.yielded).toBeLessThanOrEqual(4);
    expect(warm.yielded).toBeLessThan(ROWS);
  });

  it('bounds identically with and without the wrapper — the wiring must not matter', async () => {
    const wrapped = await seeded();
    await new CloudRoaring({
      warm: wrapped as unknown as IWarmDriver,
      cold: new MemoryColdChunkSource(),
      budget: { maxRequests: 3 },
    } as never)
      .segment('s')
      .count()
      .catch(() => undefined);

    const bare = await seeded();
    await new CloudRoaring({
      warm: bare as unknown as IWarmDriver,
      cold: new MemoryColdChunkSource(),
      budget: { maxRequests: 3 },
      retry: false,
    } as never)
      .segment('s')
      .count()
      .catch(() => undefined);

    expect(wrapped.yielded).toBe(bare.yielded);
  });

  it('still retries a transient failure while establishing the scan', async () => {
    // The fix keeps retry where it pays. Establishment is where transient connect/throttle faults land, and
    // retrying it is safe because each attempt builds a fresh iterator — no row can be yielded twice.
    let attempts = 0;
    const inner = new MemoryWarmDriver();
    const flaky = {
      listChunks: (seg: SegmentRef, ...rest: unknown[]) => {
        attempts += 1;
        const failFirst = attempts === 1;
        const rows = (inner.listChunks as (...a: unknown[]) => AsyncIterable<WarmRow>)(
          seg,
          ...rest,
        );
        return (async function* () {
          if (failFirst) throw new TransientError('backend blinked on connect');
          yield* rows;
        })();
      },
      get: (ref: ChunkRef) => inner.get(ref),
      putConditional: (...a: unknown[]) =>
        (inner.putConditional as (...x: unknown[]) => unknown)(...a),
      deleteConditional: (...a: unknown[]) =>
        (inner.deleteConditional as (...x: unknown[]) => unknown)(...a),
    };
    const store = new CloudRoaring({
      warm: flaky as unknown as IWarmDriver,
      cold: new MemoryColdChunkSource(),
      budget: false,
    } as never);
    await store.segment('s').add(joinId(1, 1));
    attempts = 0;
    await expect(store.segment('s').count()).resolves.toBe(1);
    expect(attempts).toBeGreaterThan(1); // it really did fail once and retry
  });
});
