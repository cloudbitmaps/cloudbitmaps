import { checkedRetryPolicy, withRetry, DEFAULT_RETRY_POLICY } from '@/core/retry';
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

  it('refuses a fractional maxAttempts before the operation runs', async () => {
    let called = 0;
    await expect(
      withRetry(
        () => {
          called++;
          return Promise.reject(new Error('boom'));
        },
        { ...DEFAULT_RETRY_POLICY, maxAttempts: 2.7 },
        deps,
      ),
    ).rejects.toThrow('retry.maxAttempts must be an integer of at least 1; got 2.7');
    expect(called).toBe(0);
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

describe('checkedRetryPolicy', () => {
  const refused = (patch: Record<string, unknown>): string => {
    try {
      checkedRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...patch } as never);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      return (err as Error).message;
    }
    throw new Error('did not throw');
  };

  it('takes the default policy', () => {
    expect(checkedRetryPolicy(DEFAULT_RETRY_POLICY)).toBe(DEFAULT_RETRY_POLICY);
  });

  it('refuses a maxAttempts that is not a whole number of at least 1', () => {
    expect(refused({ maxAttempts: 2.5 })).toBe(
      'retry.maxAttempts must be an integer of at least 1; got 2.5',
    );
    expect(refused({ maxAttempts: 0 })).toContain('retry.maxAttempts must be an integer');
    expect(refused({ maxAttempts: 2 ** 53 })).toContain('retry.maxAttempts must be an integer');
    expect(refused({ maxAttempts: '3' })).toContain('got "3"');
  });

  it('refuses a maxDelayMs below baseDelayMs and takes one equal to it', () => {
    expect(refused({ baseDelayMs: 500, maxDelayMs: 100 })).toBe(
      'retry.maxDelayMs must be a finite number of at least 500 (retry.baseDelayMs); got 100',
    );
    expect(
      checkedRetryPolicy({ ...DEFAULT_RETRY_POLICY, baseDelayMs: 500, maxDelayMs: 500 }),
    ).toBeDefined();
  });

  it('refuses a delay or factor that is not finite or is out of range', () => {
    expect(refused({ baseDelayMs: -1 })).toContain(
      'retry.baseDelayMs must be a finite number of at least 0',
    );
    expect(refused({ baseDelayMs: Number.NaN })).toContain('retry.baseDelayMs');
    expect(refused({ maxDelayMs: Number.POSITIVE_INFINITY })).toContain('retry.maxDelayMs');
    expect(refused({ backoffFactor: 0.5 })).toBe(
      'retry.backoffFactor must be a finite number of at least 1; got 0.5',
    );
  });
});

describe('a store built with a retry policy', () => {
  it('refuses a fractional maxAttempts and a given maxDelayMs below baseDelayMs, and takes a baseDelayMs alone', async () => {
    const { CloudRoaring, MemoryStorage } = await import('@/index');
    const build = (retry: Record<string, number>) =>
      new CloudRoaring({ storage: new MemoryStorage(), retry });
    expect(() => build({ maxAttempts: 2.5 })).toThrow(
      'retry.maxAttempts must be an integer of at least 1; got 2.5',
    );
    expect(() => build({ baseDelayMs: 5000 })).not.toThrow();
    expect(() => build({ baseDelayMs: 500, maxDelayMs: 100 })).toThrow(
      'retry.maxDelayMs must be a finite number of at least 500 (retry.baseDelayMs); got 100',
    );
    expect(() => build({ baseDelayMs: 5000, maxDelayMs: 9000 })).not.toThrow();
  });
});
