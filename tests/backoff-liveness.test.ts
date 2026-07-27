import { CloudRoaring, MemoryColdChunkSource, MemoryWarmDriver, WriteConflictError } from '@/index';
import type { IWarmDriver } from '@/index';

/**
 * Regression for the OCC-backoff *premature-exit* bug (found by the T4 hot-row contention stress).
 *
 * The default clock's `sleep` used to `unref()` its backoff timer. Because that `sleep` only ever backs a
 * caller-awaited, bounded retry (the engine's OCC read-modify-write and the driver `withRetry` loop), an
 * unref'd timer let a short-lived process — CLI, Lambda, a bare script — whose only remaining handle was that
 * backoff timer exit 0 *mid-retry*, silently dropping the awaited write (neither applied nor thrown).
 *
 * The failure is a property of process lifetime, so it cannot be observed from inside the test runner (Vitest's
 * own event loop keeps the process alive, so even an unref'd timer still fires). We therefore assert the
 * *mechanism* the fix guarantees — the default clock's backoff timer stays ref'd — by watching whether `unref`
 * is called on the timer the real backoff creates. The bare-process end-to-end guard (which reproduces the
 * exit-0 symptom itself) lands with the T4 stress PR; this unit test guards the mechanism the fix relies on.
 */
describe('OCC backoff liveness (default clock keeps a pending retry alive)', () => {
  it('does not unref the backoff timer created during a real OCC conflict', async () => {
    // A Warm driver that rejects the first conditional write with a conflict, then behaves normally — so the
    // engine performs exactly one real backoff on the default (SystemClock) clock before it succeeds.
    const inner = new MemoryWarmDriver();
    let injected = false;
    const flaky = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'putConditional') {
          return (...args: Parameters<IWarmDriver['putConditional']>) => {
            if (!injected) {
              injected = true;
              return Promise.reject(new WriteConflictError('injected conflict'));
            }
            return inner.putConditional(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as IWarmDriver;

    // Wrap every timer created while the write is in flight and record any `unref()` call on it.
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
        warm: flaky,
        cold: new MemoryColdChunkSource(),
        // Fixed jitter ⇒ a deterministic non-zero backoff delay, so a real timer is always created. The clock is
        // left as the default SystemClock on purpose — that is the code under test.
        rng: { next: () => 0.5 },
      });

      await store.segment('s').add(42);

      expect(injected).toBe(true); // the conflict path really fired…
      expect(timersCreated).toBeGreaterThan(0); // …so a backoff timer was created…
      expect(unrefCalls).toBe(0); // …and it must stay ref'd, or a bare process could exit mid-retry.
      // The awaited write also actually landed (no lost update).
      expect(await store.segment('s').has(42)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
