import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/core/errors';
import { timedRead } from '@/azure-blob/read-timeout';

/**
 * `timedRead` on a fake clock: when its timer fires, what it throws, what it aborts and what it leaves behind, to the
 * millisecond and with no socket. `read-timeout.test.ts` holds the same behaviour once per kind of stall through a real
 * `@azure/storage-blob` client against a stub of the Blob service.
 */

const TIMEOUT = 200;

afterEach(() => {
  vi.useRealTimers();
});

describe('Azure Blob: timedRead on a fake clock', () => {
  it.each(['download', 'getProperties'] as const)(
    'ends a %s still running at the timeout, to the millisecond, naming it, and aborts its request',
    async (operation) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const outcome = timedRead(operation, TIMEOUT, (abortSignal) => {
        signal = abortSignal;
        return new Promise<never>(() => {});
      }).then(
        () => 'settled',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(TransientError);
      expect((error as Error).message).toBe(
        `Azure Blob ${operation} timed out after ${TIMEOUT} ms`,
      );
      expect(signal?.aborted).toBe(true);
    },
  );

  it('keeps the timeout error when the abort makes the read itself reject', async () => {
    vi.useFakeTimers();
    const outcome = timedRead(
      'download',
      TIMEOUT,
      (abortSignal) =>
        new Promise<never>((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(await outcome).toMatchObject({
      message: `Azure Blob download timed out after ${TIMEOUT} ms`,
    });
  });

  it('lets go of the request of a read that fails on its own, and not of one that succeeds', async () => {
    vi.useFakeTimers();
    for (const timeoutMs of [0, TIMEOUT]) {
      let failed: AbortSignal | undefined;
      await expect(
        timedRead('download', timeoutMs, (abortSignal) => {
          failed = abortSignal;
          return Promise.reject(new RangeError('no ETag'));
        }),
      ).rejects.toThrow(RangeError);
      expect(failed?.aborted, `timeout ${timeoutMs}`).toBe(true);

      let succeeded: AbortSignal | undefined;
      await timedRead('download', timeoutMs, (abortSignal) => {
        succeeded = abortSignal;
        return Promise.resolve('bytes');
      });
      expect(succeeded?.aborted, `timeout ${timeoutMs}`).toBe(false);
    }
  });

  it('runs a read with no timeout for as long as it takes', async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => undefined;
    const outcome = timedRead(
      'download',
      0,
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    finish('late');
    expect(await outcome).toBe('late');
  });

  it('gives each read its own timer: a second read starts a full timeout after a first that took most of one', async () => {
    vi.useFakeTimers();
    const first = timedRead(
      'getProperties',
      TIMEOUT,
      () => new Promise<string>((r) => setTimeout(() => r('head'), 150)),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(await first).toBe('head');
    let signal: AbortSignal | undefined;
    const second = timedRead('download', TIMEOUT, (abortSignal) => {
      signal = abortSignal;
      return new Promise<string>((r) => setTimeout(() => r('body'), 150));
    });
    // 300 ms in all, past one timeout.
    await vi.advanceTimersByTimeAsync(150);
    expect(await second).toBe('body');
    expect(signal?.aborted).toBe(false);
  });

  it('leaves no timer behind once the read settles, and sets none when the timeout is off', async () => {
    vi.useFakeTimers();
    expect(await timedRead('download', TIMEOUT, () => Promise.resolve('done'))).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      timedRead('getProperties', TIMEOUT, () => Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(await timedRead('download', 0, () => Promise.resolve('untimed'))).toBe('untimed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
