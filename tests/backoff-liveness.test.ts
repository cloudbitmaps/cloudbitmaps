import { CloudRoaring, MemoryColdChunkSource, TransientError } from '@/index';
import type { ChunkRef, ColdChunkSource, SegmentRef } from '@/core/ports';
import { seedSegment } from './helpers/loaded';

/**
 * Regression for the backoff *premature-exit* bug (found by the T4 hot-row contention stress).
 *
 * The default clock's `sleep` used to `unref()` its backoff timer. Because that `sleep` only ever backs a
 * caller-awaited, bounded retry, an unref'd timer let a short-lived process — CLI, Lambda, a bare script —
 * whose only remaining handle was that backoff timer exit 0 *mid-retry*, silently dropping the awaited
 * operation (neither a result nor a thrown error).
 *
 * The failure is a property of process lifetime, so it cannot be observed from inside the test runner (Vitest's
 * own event loop keeps the process alive, so even an unref'd timer still fires). We therefore assert the
 * *mechanism* the fix guarantees — the default clock's backoff timer stays ref'd — by watching whether `unref`
 * is called on the timer the real backoff creates.
 *
 * WHAT DRIVES THE BACKOFF NOW. This used to inject an optimistic-concurrency conflict on a warm write, because
 * that was the retry loop everyone hit. With the warm tier gone the surviving user of `Clock.sleep` is the
 * driver transient-retry loop (`withRetry`, wrapped around the cold source by default), so the fault injected
 * here is a transient cold read. The mechanism under test is unchanged — it is the same `SystemClock.sleep` —
 * and the reason it matters is if anything sharper: a Lambda whose only pending handle is a retry of the one
 * GET its whole invocation depends on.
 */

/** A cold source whose first `getChunk` fails transiently, then behaves normally. */
class FlakyOnce implements ColdChunkSource {
  readonly inner = new MemoryColdChunkSource();
  failed = false;

  async getChunk(ref: ChunkRef): Promise<Uint8Array | null> {
    if (!this.failed) {
      this.failed = true;
      throw new TransientError('backend blinked');
    }
    return this.inner.getChunk(ref);
  }
  listChunkKeys(ref: SegmentRef): Promise<number[]> {
    return this.inner.listChunkKeys(ref);
  }
}

describe('transient-retry backoff liveness (the default clock keeps a pending retry alive)', () => {
  it('does not unref the backoff timer created during a real transient retry', async () => {
    const cold = new FlakyOnce();
    seedSegment(cold.inner, 's', [42]);

    // Wrap every timer created while the read is in flight and record any `unref()` call on it.
    const realSetTimeout = globalThis.setTimeout;
    let timersCreated = 0;
    let unrefCalls = 0;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...rest: unknown[]
    ) => {
      const timer = realSetTimeout(handler, timeout, ...(rest as [])) as ReturnType<
        typeof setTimeout
      >;
      timersCreated += 1;
      const originalUnref = timer.unref?.bind(timer);
      timer.unref = () => {
        unrefCalls += 1;
        return originalUnref ? originalUnref() : timer;
      };
      return timer;
    }) as typeof setTimeout);

    try {
      const store = new CloudRoaring({
        cold,
        // Fixed jitter ⇒ a deterministic non-zero backoff delay, so a real timer is always created. The clock is
        // left as the default SystemClock on purpose — that is the code under test.
        rng: { next: () => 0.5 },
      });

      // The awaited read survives the blink AND returns the right answer (no swallowed fault).
      expect(await store.segment('s').has(42)).toBe(true);

      expect(cold.failed).toBe(true); // the transient path really fired…
      expect(timersCreated).toBeGreaterThan(0); // …so a backoff timer was created…
      expect(unrefCalls).toBe(0); // …and it must stay ref'd, or a bare process could exit mid-retry.
    } finally {
      spy.mockRestore();
    }
  });
});
