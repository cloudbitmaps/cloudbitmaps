import { withRetry, DEFAULT_RETRY_POLICY } from '@/core/retry';
import { ValidationError } from '@/core/errors';
import type { Clock } from '@/core/determinism';

// `Math.max(1, x)` guards 0 and negatives but NOT NaN: `Math.max(1, NaN)` is NaN and `1 <= NaN` is false, so
// a loop guarded that way never runs its body. `op()` is never called, and the function rejects with the
// literal `undefined` — a silent no-op write plus a non-Error in every caller's catch. Reachable from
// ordinary wiring: `maxAttempts: Number(process.env.CR_RETRY_ATTEMPTS)` is NaN when the variable is unset.
const clock: Clock = {
  now: () => 0,
  sleep: () => Promise.resolve(),
} as unknown as Clock;

const rng = { next: () => 0.5 };
const deps = { clock, rng } as unknown as Parameters<typeof withRetry>[2];

describe('withRetry — policy validation', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -3],
  ])('rejects maxAttempts = %s instead of silently skipping the operation', async (_label, v) => {
    let called = 0;
    const op = () => {
      called++;
      return Promise.resolve('ok');
    };
    await expect(
      withRetry(op, { ...DEFAULT_RETRY_POLICY, maxAttempts: v as number }, deps),
    ).rejects.toBeInstanceOf(ValidationError);
    // The part that matters: a loop that never runs resolves or rejects without ever calling the operation.
    expect(called).toBe(0);
  });

  it('never rejects with a non-Error', async () => {
    // A loop that never runs throws `lastErr` while it is still `undefined` — so `err instanceof Error` is
    // false and every typed-error branch in the stack falls through to its default.
    const err = await withRetry(
      () => Promise.resolve('x'),
      { ...DEFAULT_RETRY_POLICY, maxAttempts: Number.NaN },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/maxAttempts/);
  });

  it('floors a fractional maxAttempts rather than sleeping toward an attempt that never runs', async () => {
    let called = 0;
    const slept: number[] = [];
    const countingClock = {
      now: () => 0,
      sleep: (ms: number) => (slept.push(ms), Promise.resolve()),
    };
    await expect(
      withRetry(
        () => {
          called++;
          return Promise.reject(new Error('boom'));
        },
        { ...DEFAULT_RETRY_POLICY, maxAttempts: 2.7 },
        { clock: countingClock, rng, isRetryable: () => true } as unknown as Parameters<
          typeof withRetry
        >[2],
      ),
    ).rejects.toThrow('boom');
    expect(called).toBe(2); // floor(2.7)
    expect(slept).toHaveLength(1); // and no sleep after the final attempt
  });

  it('still runs the normal path', async () => {
    let called = 0;
    const out = await withRetry(
      () => {
        called++;
        return Promise.resolve('fine');
      },
      DEFAULT_RETRY_POLICY,
      deps,
    );
    expect(out).toBe('fine');
    expect(called).toBe(1);
  });
});
