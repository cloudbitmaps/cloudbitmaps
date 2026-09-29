import { CloudRoaring, MemoryStorageChunkSource, TransientError } from '@/index';
import type { ChunkRef, StorageChunkSource, SegmentRef } from '@/core/ports';
import { seedSegment } from './helpers/loaded';

/**
 * Pins that a pending backoff keeps the process alive — the *premature-exit* failure. Many writers contending
 * for one registry row are what make the backoff path run long enough to be the last handle standing.
 *
 * The default clock's `sleep` only ever backs a caller-awaited, bounded retry, so its timer must stay ref'd. An
 * `unref()`'d backoff timer lets a short-lived process — CLI, Lambda, a bare script — whose only remaining handle
 * is that timer exit 0 *mid-retry*, silently dropping the awaited operation (neither a result nor a thrown
 * error).
 *
 * The failure is a property of process lifetime, so it cannot be observed from inside the test runner (Vitest's
 * own event loop keeps the process alive, so even an unref'd timer still fires). We therefore assert the
 * *mechanism* that prevents it — the default clock's backoff timer stays ref'd — by watching whether `unref`
 * is called on the timer the real backoff creates.
 *
 * WHAT DRIVES THE BACKOFF. The user of `Clock.sleep` is the driver transient-retry loop (`withRetry`, wrapped
 * around the storage source by default), so the fault injected here is a transient storage read. The reason it
 * matters is sharp: a Lambda whose only pending handle is a retry of the one GET its whole invocation depends on.
 */

/** A storage source whose first `getChunk` fails transiently, then behaves normally. */
class FlakyOnce implements StorageChunkSource {
  readonly inner = new MemoryStorageChunkSource();
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
    const storage = new FlakyOnce();
    seedSegment(storage.inner, 's', [42]);

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
        storage,
        // Fixed jitter ⇒ a deterministic non-zero backoff delay, so a real timer is always created. The clock is
        // left as the default SystemClock on purpose — that is the code under test.
        seams: { rng: { next: () => 0.5 } },
      });

      // The awaited read survives the blink AND returns the right answer (no swallowed fault).
      expect(await store.segment('s').has(42)).toBe(true);

      expect(storage.failed).toBe(true); // the transient path really fired…
      expect(timersCreated).toBeGreaterThan(0); // …so a backoff timer was created…
      expect(unrefCalls).toBe(0); // …and it must stay ref'd, or a bare process could exit mid-retry.
    } finally {
      spy.mockRestore();
    }
  });
});
