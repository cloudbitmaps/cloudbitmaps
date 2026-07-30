import {
  RetryingColdChunkSource,
  RetryingColdDriver,
  RetryingWarmDriver,
} from '@/drivers/retry/retrying-drivers';
import type { RetryingOptions } from '@/drivers/retry/retrying-drivers';
import { TransientError, WriteConflictError } from '@/core/errors';
import { NO_ROW } from '@/core/ports';
import type {
  ChunkRef,
  ColdChunkSource,
  GenKey,
  IColdDriver,
  IWarmDriver,
  SegmentRef,
  WarmRow,
} from '@/core/ports';
import type { Clock, Rng } from '@/core/determinism';

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
const zeroRng: Rng = { next: () => 0 };
// 5 attempts so a couple of transient failures are comfortably ridden out; no real waiting (instant clock).
const opts = (clock: Clock): RetryingOptions => ({
  clock,
  rng: zeroRng,
  policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4, backoffFactor: 2, jitter: 'none' },
});

const ref: ChunkRef = { segment: 's', chunkKey: 1 };
const seg: SegmentRef = { segment: 's' };

/** Returns a function that rejects `fails` times with `err`, then resolves to `value`. */
function flaky<T>(fails: number, err: unknown, value: T): () => Promise<T> {
  let n = 0;
  return () => (++n <= fails ? Promise.reject(err) : Promise.resolve(value));
}

describe('RetryingWarmDriver', () => {
  it('retries a transient get and returns the eventual value, on the exact backoff schedule', async () => {
    const clock = recordingClock();
    const row: WarmRow = { token: '1', bytes: Uint8Array.of(7) };
    const get = flaky(2, new TransientError('blip'), row);
    const inner = { get: () => get() } as unknown as IWarmDriver;
    const d = new RetryingWarmDriver(inner, opts(clock));
    expect(await d.get(ref)).toBe(row);
    // policy: base 1, factor 2, jitter 'none' ⇒ exact delays [1, 2] (catches a wrong-delay/index mutation).
    expect(clock.sleeps).toEqual([1, 2]);
  });

  it('does NOT retry a WriteConflictError (OCC is the engine loop’s job)', async () => {
    const clock = recordingClock();
    let calls = 0;
    const inner = {
      putConditional: () => {
        calls++;
        return Promise.reject(new WriteConflictError('conflict'));
      },
    } as unknown as IWarmDriver;
    const d = new RetryingWarmDriver(inner, opts(clock));
    await expect(d.putConditional(ref, Uint8Array.of(1), NO_ROW)).rejects.toBeInstanceOf(
      WriteConflictError,
    );
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('re-enumerates listChunks from the start on a transient fault while establishing the scan', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const rows: Array<{ chunkKey: number } & WarmRow> = [
      { chunkKey: 1, token: '1', bytes: Uint8Array.of(1) },
      { chunkKey: 2, token: '1', bytes: Uint8Array.of(2) },
    ];
    const inner: Pick<IWarmDriver, 'listChunks'> = {
      async *listChunks() {
        attempts++;
        if (attempts === 1) throw new TransientError('mid-list blip'); // fails before any yield
        yield* rows;
      },
    };
    const d = new RetryingWarmDriver(inner as IWarmDriver, opts(clock));
    const out: number[] = [];
    for await (const r of d.listChunks(seg)) out.push(r.chunkKey);
    expect(out).toEqual([1, 2]); // no duplicates — full re-enumeration on retry
    expect(attempts).toBe(2);
  });

  // Both of these pin the same fix. `listChunks` is the only wrapper that drives its inner iterator by hand
  // (deliberately — buffering it would defeat the engine's resident-memory bound), so it is the only one where
  // abandonment has to be cleaned up explicitly. Without the `finally`, the inner generator stays suspended at
  // its `yield` forever, holding whatever it had open: a Mongo cursor, a Cassandra stream.
  //
  // Two exits, because the engine uses the second one. `collectWarm` throws `BudgetExceededError` from INSIDE
  // its `for await` over this method, so the throw path is the one that actually fires in production.
  const abandonable = (): { inner: IWarmDriver; closed: () => boolean } => {
    let closed = false;
    const inner: Pick<IWarmDriver, 'listChunks'> = {
      async *listChunks() {
        try {
          yield { chunkKey: 1, token: '1', bytes: Uint8Array.of(1) };
          yield { chunkKey: 2, token: '1', bytes: Uint8Array.of(2) };
        } finally {
          closed = true; // stands in for a real driver releasing its cursor
        }
      },
    };
    return { inner: inner as IWarmDriver, closed: () => closed };
  };

  it('closes the inner scan when the consumer breaks out early', async () => {
    const { inner, closed } = abandonable();
    const d = new RetryingWarmDriver(inner, opts(recordingClock()));
    for await (const row of d.listChunks(seg)) {
      expect(row.chunkKey).toBe(1);
      break;
    }
    expect(closed()).toBe(true);
  });

  it('closes the inner scan when the consumer throws mid-stream (the engine’s ceiling path)', async () => {
    const { inner, closed } = abandonable();
    const d = new RetryingWarmDriver(inner, opts(recordingClock()));
    await expect(
      (async () => {
        for await (const row of d.listChunks(seg)) {
          void row;
          throw new Error('maxWarmScanBytes exceeded');
        }
      })(),
    ).rejects.toThrow('maxWarmScanBytes exceeded');
    expect(closed()).toBe(true);
  });
});

describe('RetryingColdChunkSource', () => {
  it('retries a transient getChunk', async () => {
    const clock = recordingClock();
    const bytes = Uint8Array.of(9);
    const getChunk = flaky(1, new TransientError('blip'), bytes);
    const inner = { getChunk: () => getChunk() } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.getChunk(ref)).toBe(bytes);
    expect(clock.sleeps).toHaveLength(1);
  });

  it('does not retry a successful absent (null) chunk', async () => {
    const clock = recordingClock();
    let calls = 0;
    const inner = {
      getChunk: () => {
        calls++;
        return Promise.resolve(null);
      },
    } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.getChunk(ref)).toBeNull();
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a transient listChunkKeys', async () => {
    const clock = recordingClock();
    const keys = flaky(1, new TransientError('blip'), [1, 2, 3]);
    const inner = { listChunkKeys: () => keys() } as unknown as ColdChunkSource;
    const d = new RetryingColdChunkSource(inner, opts(clock));
    expect(await d.listChunkKeys(seg)).toEqual([1, 2, 3]);
    expect(clock.sleeps).toHaveLength(1);
  });
});

describe('RetryingColdDriver', () => {
  it('retries a transient getRange and leaves capabilities() un-wrapped', async () => {
    const clock = recordingClock();
    const bytes = Uint8Array.of(1, 2, 3);
    const getRange = flaky(2, new TransientError('blip'), bytes);
    const caps = { rangeRead: true as const, maxObjectBytes: 10 };
    const inner = {
      capabilities: () => caps,
      getRange: () => getRange(),
    } as unknown as IColdDriver;
    const d = new RetryingColdDriver(inner, opts(clock));
    expect(d.capabilities()).toBe(caps);
    const key: GenKey = { segment: 's', generation: 0 };
    expect(await d.getRange(key, 0, 3)).toBe(bytes);
    expect(clock.sleeps).toHaveLength(2);
  });

  it('does NOT retry a WriteConflictError from putImmutable (write-once collision)', async () => {
    const clock = recordingClock();
    let calls = 0;
    const inner = {
      putImmutable: () => {
        calls++;
        return Promise.reject(new WriteConflictError('exists'));
      },
    } as unknown as IColdDriver;
    const d = new RetryingColdDriver(inner, opts(clock));
    const key: GenKey = { segment: 's', generation: 0 };
    await expect(d.putImmutable(key, async () => {})).rejects.toBeInstanceOf(WriteConflictError);
    expect(calls).toBe(1);
  });

  it('re-enumerates list() from the start on a transient fault (buffered, no duplicates)', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const gens: GenKey[] = [
      { segment: 's', generation: 0 },
      { segment: 's', generation: 1 },
    ];
    const inner: Pick<IColdDriver, 'list'> = {
      async *list() {
        attempts++;
        if (attempts === 1) {
          yield gens[0]!; // yields one item INTERNALLY, then faults — must not leak to the consumer
          throw new TransientError('mid-list blip');
        }
        yield* gens;
      },
    };
    const d = new RetryingColdDriver(inner as IColdDriver, opts(clock));
    const out: number[] = [];
    for await (const g of d.list(seg)) out.push(g.generation);
    expect(out).toEqual([0, 1]); // no duplicate gen-0 despite the first attempt yielding it before faulting
    expect(attempts).toBe(2);
  });
});
