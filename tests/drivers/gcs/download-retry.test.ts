import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryDownload } from '@/gcs/download-retry';

/**
 * The driver's download retry: three retries with full-jitter backoff, 100 ms doubling to a 1 s ceiling. The jitter
 * is pinned at its top (`Math.random` returns 1), so each wait is its ceiling and the timeline is exact.
 */
describe('retryDownload', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits up to 100, 200 and 400 ms before its three retries, and not before', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    let calls = 0;
    const p = retryDownload(() => {
      calls++;
      return Promise.reject(Object.assign(new Error('unavailable'), { code: 503 }));
    });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    for (const [wait, after] of [
      [100, 2],
      [200, 3],
      [400, 4],
    ] as const) {
      await vi.advanceTimersByTimeAsync(wait - 2);
      expect(calls).toBe(after - 1);
      await vi.advanceTimersByTimeAsync(2);
      expect(calls).toBe(after);
    }
    await expect(p).rejects.toMatchObject({ code: 503 });
    expect(calls).toBe(4);
  });

  it('does not wait at all when the jitter draws zero', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const p = retryDownload(() => {
      calls++;
      return Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    });
    p.catch(() => undefined);
    await vi.runAllTimersAsync();
    expect(calls).toBe(4);
    await expect(p).rejects.toMatchObject({ code: 'ECONNRESET' }); // as the last attempt raised it
  });

  it('returns the first success, and throws an answer it does not retry as raised', async () => {
    let calls = 0;
    await expect(
      retryDownload(() =>
        ++calls < 2
          ? Promise.reject(Object.assign(new Error('x'), { code: 429 }))
          : Promise.resolve('ok'),
      ),
    ).resolves.toBe('ok');
    const notFound = Object.assign(new Error('nf'), { code: 404 });
    await expect(retryDownload(() => Promise.reject(notFound))).rejects.toBe(notFound);
  });
});
