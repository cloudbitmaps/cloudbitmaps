/**
 * What a combine's streams do against the real chunk source over a storage driver whose range reads are slow and
 * counted: how many range requests are launched ahead of a consumer that has stopped, how many are in flight at once,
 * that a `break` launches nothing more, and what the metrics report for a range that holds bytes nobody needed.
 *
 * The segments hold chunks of 4,000 ids (about 8 KB each), so a one-MiB range holds more than a hundred chunks and an
 * object of 600 chunks takes several ranges.
 */
import { describe, expect, it, vi } from 'vitest';
import { CloudRoaring, MemoryStorage } from '@/index';
import { brandAsBackend } from '@/core/ports';
import { CountingMetricsSink } from '@cloudbitmaps/core';
import { collect } from '../helpers/loaded';

const CHUNK = 65_536;
const PER_CHUNK = 4_000;
const chunkIds = (k: number): number[] =>
  Array.from({ length: PER_CHUNK }, (_, i) => k * CHUNK + i * 13 + 1);
const idsOf = (keys: Iterable<number>): number[] => [...keys].flatMap(chunkIds);
const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
/** Enough chunks for several one-MiB ranges per object. */
const CHUNKS = 300;
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A backend whose range reads take a few milliseconds and are counted, with the most in flight at once. */
function slow() {
  const backend = new MemoryStorage();
  const calls = { launched: 0, inFlight: 0, peak: 0, bytes: 0 };
  const storage = new Proxy(backend.storage, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop !== 'getRange' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        calls.launched += 1;
        calls.bytes += args[2] as number;
        calls.inFlight += 1;
        calls.peak = Math.max(calls.peak, calls.inFlight);
        try {
          await tick(3);
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          calls.inFlight -= 1;
        }
      };
    },
  });
  const loader = new CloudRoaring({ storage: backend, cache: { genTtlMs: 0 } });
  const metrics = new CountingMetricsSink();
  const reader = () => {
    calls.launched = calls.inFlight = calls.peak = calls.bytes = 0;
    return new CloudRoaring({
      storage: brandAsBackend({ storage, registry: backend.registry }),
      cache: { genTtlMs: 0 },
      metrics,
    });
  };
  return { loader, reader, calls, metrics };
}

// Loading the segments is most of the time these cases take, and slows under a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

async function twoSegments(keys: number[]) {
  const w = slow();
  await w.loader.load({ segment: 'a' }, idsOf(keys));
  await w.loader.load({ segment: 'b' }, idsOf(keys));
  return w;
}

describe('a stream reads ahead of its consumer by at most `concurrency` ranges per operand', () => {
  it.each([1, 2, 4])(
    'concurrency %i: a consumer that has taken one id has caused at most that many ranges per operand',
    async (concurrency) => {
      const w = await twoSegments(upTo(CHUNKS));
      const store = w.reader();
      const result = store.segment('a').intersect([store.segment('b')], { concurrency });
      const stream = result[Symbol.asyncIterator]();
      const first = await stream.next();
      expect(first.done).toBe(false);
      await tick(40); // every request the window allows has had time to land
      expect(w.calls.launched).toBeLessThanOrEqual(concurrency * 2);
      expect(w.calls.launched).toBeGreaterThanOrEqual(2); // and it did read ahead
      await stream.return?.();
    },
  );

  it('keeps at most `concurrency` requests in flight per operand while the whole read is consumed', async () => {
    const w = await twoSegments(upTo(CHUNKS));
    const store = w.reader();
    const got = await collect(
      store.segment('a').intersect([store.segment('b')], { concurrency: 2 }),
    );
    expect(got).toEqual(idsOf(upTo(CHUNKS)));
    expect(w.calls.peak).toBeLessThanOrEqual(2 * 2);
    expect(w.calls.launched).toBeGreaterThan(4); // several ranges, so the bound was exercised
  });

  it('does not clamp a `concurrency` above the default: 64 ranges are allowed', async () => {
    const w = await twoSegments(upTo(CHUNKS));
    const store = w.reader();
    const got = await collect(
      store.segment('a').intersect([store.segment('b')], { concurrency: 64 }),
    );
    expect(got).toEqual(idsOf(upTo(CHUNKS)));
  });
});

describe('a read that stops launches nothing more', () => {
  it.each(['intersect', 'union', 'iterate'] as const)('%s, after its first id', async (verb) => {
    const w = await twoSegments(upTo(CHUNKS));
    const store = w.reader();
    const a = store.segment('a');
    const stream =
      verb === 'iterate'
        ? a.iterate()
        : verb === 'union'
          ? a.union([store.segment('b')], { concurrency: 1 })
          : a.intersect([store.segment('b')], { concurrency: 1 });
    for await (const id of stream) {
      void id;
      break;
    }
    await tick(30);
    const launched = w.calls.launched;
    await tick(60);
    expect(w.calls.launched).toBe(launched);
    expect(launched).toBeLessThan(10); // not the read's full complement of ranges
  });

  it('a read abandoned while ranges are in flight leaves no unhandled rejection', async () => {
    const w = await twoSegments(upTo(CHUNKS));
    const store = w.reader();
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      for await (const id of store.segment('a').union([store.segment('b')])) {
        void id;
        break;
      }
      await tick(60);
    } finally {
      process.off('unhandledRejection', on);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('metrics for a range that holds bytes nobody asked for', () => {
  it('counts one storage.get per range, with the range`s bytes, gap chunks included', async () => {
    const w = slow();
    // Every other chunk is shared, so each range spans chunks the intersect does not need.
    await w.loader.load({ segment: 'a' }, idsOf(upTo(120)));
    await w.loader.load({ segment: 'b' }, idsOf(upTo(120).filter((k) => k % 2 === 0)));
    const store = w.reader();
    const got = await collect(store.segment('a').intersect([store.segment('b')]));
    expect(got).toEqual(idsOf(upTo(120).filter((k) => k % 2 === 0)));
    const snap = w.metrics.snapshot();
    // a: the 60 shared chunks, spread, in one range; b: all 60 of its chunks, in one range; plus pointer and tail reads.
    const rangeGets = w.calls.launched;
    expect(rangeGets).toBeGreaterThanOrEqual(2);
    expect(snap.storage.gets).toBeGreaterThanOrEqual(rangeGets);
    // The bytes include the gap chunks: more than the shared chunks' own payload (60 of a's 120 chunks).
    const needed = 60 * 2 * 8_000 * 0.9;
    expect(snap.storage.bytes).toBeGreaterThan(needed);
  });
});
