import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_RETRY_MS, retryDownload } from '@/gcs/download-retry';
import { readOnce } from '@/gcs/read-once';
import { Deadline, ReadTimedOut, startDeadline, withDeadline } from '@/gcs/read-timeout';

/**
 * One deadline bounds a whole driver read: every attempt `retryDownload` makes and the backoff between them. Fake
 * timers make the timeline exact; the jitter is pinned with `Math.random`.
 */

const unavailable = (): Error => Object.assign(new Error('unavailable'), { code: 503 });
type GcsFile = Parameters<typeof readOnce>[0];

/** A file whose every read opens a stream the test drives, recording when each was opened. */
class Reads {
  readonly streams: PassThrough[] = [];
  readonly openedAt: number[] = [];
  file(): GcsFile {
    return {
      interceptors: [],
      createReadStream: () => {
        const s = new PassThrough();
        this.streams.push(s);
        this.openedAt.push(performance.now());
        return s;
      },
    } as unknown as GcsFile;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a deadline across retryDownload', () => {
  it('sends nothing more once an attempt has timed out', async () => {
    let calls = 0;
    const deadline = new Deadline(100, 'range read of s.0');
    const err = await retryDownload(() => {
      calls++;
      return Promise.reject(deadline.expired());
    }, deadline).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadTimedOut);
    expect(calls).toBe(1);
  });

  it('gives a retry only what is left: a 503, then a stall, fails at the deadline, not a full timeout later', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // retry at once
    const reads = new Reads();
    const start = performance.now();
    const deadline = new Deadline(200, 'tail read of s.0');
    const outcome = retryDownload(
      () => readOnce(reads.file(), {}, 10, () => new Error('oversize'), deadline),
      deadline,
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    reads.streams[0]!.destroy(unavailable()); // the first attempt fails at 50 ms; the second never answers
    await vi.advanceTimersByTimeAsync(149);
    expect(reads.streams).toHaveLength(2);
    expect(await Promise.race([outcome, 'pending'])).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(ReadTimedOut);
    expect(performance.now() - start).toBe(200);
    expect(reads.openedAt[1]! - start).toBe(50);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads.streams).toHaveLength(2); // nothing sent after the deadline
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a backoff that would outlast the deadline when the deadline passes, with its error, leaving no timer', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1); // the first backoff is its full 100 ms
    let calls = 0;
    const start = performance.now();
    const deadline = new Deadline(130, 'registry read of r');
    const outcome = retryDownload(() => {
      calls++;
      return new Promise((_, reject) => setTimeout(() => reject(unavailable()), 80));
    }, deadline).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(129); // the 503 at 80 ms, then 49 ms of a 100 ms backoff
    expect(await Promise.race([outcome, 'pending'])).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(ReadTimedOut);
    expect(err).toMatchObject({
      message: 'GCS registry read of r timed out after 130 ms',
      cause: { code: 503 },
    });
    expect(performance.now() - start).toBe(130);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no attempt when an attempt fails just as the deadline passes', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const deadline = new Deadline(100, 'range read of s.0');
    const outcome = retryDownload(() => {
      calls++;
      return new Promise((_, reject) => setTimeout(() => reject(unavailable()), 100));
    }, deadline).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT', cause: { code: 503 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);
  });

  it.each([
    ['an attempt fails with less than that left', 95, 0],
    ['the backoff leaves less than that', 50, 0.45],
  ])(
    `sends no retry with less than MIN_RETRY_MS (${MIN_RETRY_MS} ms) left: %s`,
    async (_name, failsAt, jitter) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(jitter);
      let calls = 0;
      const deadline = new Deadline(100, 'range read of s.0');
      const outcome = retryDownload(() => {
        calls++;
        return new Promise((_, reject) => setTimeout(() => reject(unavailable()), failsAt));
      }, deadline).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toMatchObject({ code: 'ETIMEDOUT', cause: { code: 503 } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries within the deadline as it does without one', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const deadline = new Deadline(5_000, 'range read of s.0');
    const got = await retryDownload(
      () => (++calls < 3 ? Promise.reject(unavailable()) : Promise.resolve('ok')),
      deadline,
    );
    expect(got).toBe('ok');
    expect(calls).toBe(3);
  });
});

describe('Deadline', () => {
  it('counts down from when it is made, to 0 and no further', () => {
    vi.useFakeTimers();
    const d = new Deadline(100, 'tail read of s.0');
    vi.advanceTimersByTime(40);
    expect(d.remaining()).toBe(60);
    vi.advanceTimersByTime(100);
    expect(d.remaining()).toBe(0);
    expect(d.expired()).toMatchObject({ message: 'GCS tail read of s.0 timed out after 100 ms' });
  });

  it('is none at 0', () => {
    expect(startDeadline(0, 'tail read of s.0')).toBeUndefined();
    expect(startDeadline(1, 'tail read of s.0')).toBeInstanceOf(Deadline);
  });
});

describe('a deadline that has already passed', () => {
  it('readOnce opens no stream, so sends no request', async () => {
    vi.useFakeTimers();
    const reads = new Reads();
    const deadline = new Deadline(10, 'range read of s.0');
    await vi.advanceTimersByTimeAsync(10);
    const err = await readOnce(reads.file(), {}, 10, () => new Error('oversize'), deadline).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReadTimedOut);
    expect(reads.streams).toHaveLength(0);
  });

  it('withDeadline sends nothing', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve('ok'));
    const deadline = new Deadline(10, 'tail read of s.0');
    await vi.advanceTimersByTimeAsync(10);
    await expect(withDeadline(send, deadline)).rejects.toBeInstanceOf(ReadTimedOut);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('withDeadline', () => {
  it('rejects at the deadline, and drops what the request settles with afterwards', async () => {
    vi.useFakeTimers();
    const deadline = new Deadline(100, 'tail read of s.0');
    let fail: (e: Error) => void = () => undefined;
    const request = new Promise<never>((_, reject) => (fail = reject));
    const outcome = withDeadline(() => request, deadline).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(ReadTimedOut);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    fail(new Error('late 404'));
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeds', () => Promise.resolve('ok')],
    ['fails', () => Promise.reject(Object.assign(new Error('nf'), { code: 404 }))],
  ] as const)('clears its timer when the request %s', async (_name, request) => {
    vi.useFakeTimers();
    const outcome = withDeadline(request, new Deadline(60_000, 'tail read of s.0'));
    await outcome.catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets no timer without a deadline', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(() => new Promise(() => undefined), undefined);
    expect(vi.getTimerCount()).toBe(0);
    void pending;
  });
});
