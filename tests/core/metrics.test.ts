import { CountingMetricsSink, NOOP_METRICS, type IMetricsSink, type MetricEvent } from '@/index';
import { safeMetrics } from '@/core/metrics';

describe('CountingMetricsSink', () => {
  it('tallies each event kind into the snapshot', () => {
    const c = new CountingMetricsSink();
    const events: MetricEvent[] = [
      { kind: 'cold.get', segment: 's', bytes: 100, ms: 5 },
      { kind: 'cold.get', segment: 's', bytes: 50, ms: 3 },
      { kind: 'cache', hit: true },
      { kind: 'cache', hit: false },
      { kind: 'cache', hit: false },
      { kind: 'warm.read', segment: 's', bytes: 10 },
      { kind: 'warm.write', segment: 's', bytes: 20 },
      { kind: 'retry', reason: 'occ', attempt: 1, delayMs: 5 },
      { kind: 'retry', reason: 'transient', attempt: 2, delayMs: 8 },
      { kind: 'retry', reason: 'transient', attempt: 3, delayMs: 8 },
      { kind: 'intersect', operands: 2, fetchedChunks: 3, skippedChunks: 7 },
      { kind: 'op', name: 'add', ms: 2 },
      { kind: 'op', name: 'add', ms: 4 },
      { kind: 'op', name: 'count', ms: 9 },
    ];
    for (const e of events) c.onEvent(e);

    const s = c.snapshot();
    expect(s.cold).toEqual({ gets: 2, bytes: 150, totalMs: 8 });
    expect(s.cache).toEqual({ hits: 1, misses: 2 });
    expect(s.warm).toEqual({ reads: 1, readBytes: 10, writes: 1, writeBytes: 20 });
    expect(s.retries).toEqual({ occ: 1, transient: 2 });
    expect(s.intersect).toEqual({ calls: 1, fetchedChunks: 3, skippedChunks: 7 });
    expect(s.ops.add).toEqual({ count: 2, totalMs: 6 });
    expect(s.ops.count).toEqual({ count: 1, totalMs: 9 });
    expect(s.ops.has).toEqual({ count: 0, totalMs: 0 }); // untouched ops are present and zero
  });

  it('snapshot() returns an independent copy (later events do not mutate it)', () => {
    const c = new CountingMetricsSink();
    c.onEvent({ kind: 'cache', hit: true });
    const first = c.snapshot();
    c.onEvent({ kind: 'cache', hit: true });
    expect(first.cache.hits).toBe(1);
    expect(c.snapshot().cache.hits).toBe(2);
  });

  it('reset() zeroes all counters', () => {
    const c = new CountingMetricsSink();
    c.onEvent({ kind: 'warm.write', segment: 's', bytes: 5 });
    c.onEvent({ kind: 'op', name: 'add', ms: 1 });
    c.reset();
    const s = c.snapshot();
    expect(s.warm.writes).toBe(0);
    expect(s.ops.add).toEqual({ count: 0, totalMs: 0 });
  });
});

describe('NOOP_METRICS', () => {
  it('accepts any event without throwing', () => {
    expect(() => NOOP_METRICS.onEvent({ kind: 'cache', hit: true })).not.toThrow();
  });
});

describe('safeMetrics', () => {
  it('swallows exceptions from a throwing sink', () => {
    const boom: IMetricsSink = {
      onEvent() {
        throw new Error('boom');
      },
    };
    const safe = safeMetrics(boom);
    expect(() => safe.onEvent({ kind: 'cache', hit: true })).not.toThrow();
  });

  it('passes events through to a well-behaved sink', () => {
    const c = new CountingMetricsSink();
    safeMetrics(c).onEvent({ kind: 'cache', hit: true });
    expect(c.snapshot().cache.hits).toBe(1);
  });

  it('returns the no-op sink unchanged (no needless wrapper)', () => {
    expect(safeMetrics(NOOP_METRICS)).toBe(NOOP_METRICS);
  });
});
