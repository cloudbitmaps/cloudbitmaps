import {
  withRetry,
  backoffDelayMs,
  applyJitter,
  isTransient,
  DEFAULT_RETRY_POLICY,
} from '@/core/retry';
import type { RetryPolicy } from '@/core/retry';
import { IntegrityError, TimeoutError, TransientError, ValidationError } from '@/core/errors';
import type { Clock, Rng } from '@/core/determinism';

/** A clock that records every requested sleep and resolves instantly (no real waiting in tests). */
function recordingClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    sleeps,
  };
}
/** A deterministic RNG cycling through the given values. */
const rngOf = (...vals: number[]): Rng => {
  let i = 0;
  return { next: () => vals[i++ % vals.length]! };
};
const policy = (over?: Partial<RetryPolicy>): RetryPolicy => ({ ...DEFAULT_RETRY_POLICY, ...over });

/** An op that fails `fails` times with `err`, then resolves to `value`. Records its call count. */
function flaky<T>(
  fails: number,
  err: unknown,
  value: T,
): { op: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    op: () => {
      calls++;
      return calls <= fails ? Promise.reject(err) : Promise.resolve(value);
    },
  };
}

describe('backoffDelayMs', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const p = policy({ baseDelayMs: 50, backoffFactor: 2, maxDelayMs: 2_000 });
    expect(backoffDelayMs(p, 1)).toBe(50);
    expect(backoffDelayMs(p, 2)).toBe(100);
    expect(backoffDelayMs(p, 3)).toBe(200);
    expect(backoffDelayMs(p, 10)).toBe(2_000); // capped
  });
});

describe('applyJitter', () => {
  it("'none' returns the delay unchanged", () => {
    expect(applyJitter(policy({ jitter: 'none' }), 100, rngOf(0.5))).toBe(100);
  });
  it("'full' returns a value in [0, delay) scaled by the RNG", () => {
    expect(applyJitter(policy({ jitter: 'full' }), 100, rngOf(0))).toBe(0);
    expect(applyJitter(policy({ jitter: 'full' }), 100, rngOf(0.5))).toBe(50);
    // Upper region: rng → ~1 stays strictly under the delay (never exceeds maxDelay), and scales linearly.
    expect(applyJitter(policy({ jitter: 'full' }), 100, rngOf(0.99))).toBeCloseTo(99);
    const hi = applyJitter(policy({ jitter: 'full' }), 100, rngOf(0.999999));
    expect(hi).toBeLessThan(100);
    expect(hi).toBeGreaterThan(99);
  });
});

describe('isTransient', () => {
  it('is true only for TransientError (incl. TimeoutError subclass)', () => {
    expect(isTransient(new TransientError('x'))).toBe(true);
    expect(isTransient(new TimeoutError('x'))).toBe(true);
    expect(isTransient(new ValidationError('x'))).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns immediately on success, with no sleeps', async () => {
    const clock = recordingClock();
    const { op, calls } = flaky(0, new TransientError('n/a'), 'ok');
    expect(await withRetry(op, policy(), { clock, rng: rngOf(0) })).toBe('ok');
    expect(calls()).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a transient error then succeeds, sleeping between attempts', async () => {
    const clock = recordingClock();
    const { op, calls } = flaky(2, new TransientError('blip'), 42);
    const result = await withRetry(op, policy({ jitter: 'none', maxAttempts: 4 }), {
      clock,
      rng: rngOf(0),
    });
    expect(result).toBe(42);
    expect(calls()).toBe(3); // 2 failures + 1 success
    expect(clock.sleeps).toEqual([50, 100]); // one sleep before each retry, exponential, no jitter
  });

  it('throws the operation error (unwrapped) once attempts are exhausted', async () => {
    const clock = recordingClock();
    const boom = new TransientError('still down');
    const { op, calls } = flaky(99, boom, 'never');
    await expect(withRetry(op, policy({ maxAttempts: 3 }), { clock, rng: rngOf(0) })).rejects.toBe(
      boom,
    );
    expect(calls()).toBe(3); // exactly maxAttempts
    expect(clock.sleeps).toHaveLength(2); // slept before each of the 2 retries
  });

  it('does not retry a non-transient (deterministic) error', async () => {
    const clock = recordingClock();
    const bad = new ValidationError('bad input');
    const { op, calls } = flaky(99, bad, 'never');
    await expect(withRetry(op, policy(), { clock, rng: rngOf(0) })).rejects.toBe(bad);
    expect(calls()).toBe(1); // tried once, gave up
    expect(clock.sleeps).toEqual([]);
  });

  it('honors a custom isRetryable classifier', async () => {
    const clock = recordingClock();
    const { op, calls } = flaky(1, new IntegrityError('corrupt'), 'recovered');
    const result = await withRetry(op, policy({ jitter: 'none' }), {
      clock,
      rng: rngOf(0),
      isRetryable: (e) => e instanceof IntegrityError, // unusual, but the seam allows it
    });
    expect(result).toBe('recovered');
    expect(calls()).toBe(2);
  });

  it('fires onRetry before each backoff wait', async () => {
    const clock = recordingClock();
    const calls: Array<{ attempt: number; delayMs: number }> = [];
    const { op } = flaky(2, new TransientError('x'), 1);
    await withRetry(op, policy({ jitter: 'none', maxAttempts: 5 }), {
      clock,
      rng: rngOf(0),
      onRetry: ({ attempt, delayMs }) => calls.push({ attempt, delayMs }),
    });
    expect(calls).toEqual([
      { attempt: 1, delayMs: 50 },
      { attempt: 2, delayMs: 100 },
    ]);
  });
});
