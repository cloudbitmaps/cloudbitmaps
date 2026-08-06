/**
 * Lazy expiry — the half of retention that does not wait for a sweep (ADR 83 decision 1).
 *
 * A read past `expiresAt` answers empty immediately: one integer compare against the injected clock, no I/O,
 * identical on every backend. That is what makes an expiry *correct* rather than *eventually correct* — a
 * Lambda-only reader has no sweep at all, so without this its data never stops being served.
 */
import { describe, expect, it } from 'vitest';
import { CloudRoaring, MemoryColdChunkSource, MemoryWarmDriver, MIN_EXPIRES_AT_MS } from '@/index';
import { ValidationError } from '@/core/errors';

const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

function harness(start = T0) {
  let t = start;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const store = new CloudRoaring({
    warm: new MemoryWarmDriver(),
    cold: new MemoryColdChunkSource(),
    clock,
  });
  return { store, advance: (ms: number) => (t += ms) };
}

async function drain(source: AsyncIterable<number>): Promise<number[]> {
  const out: number[] = [];
  for await (const id of source) out.push(id);
  return out;
}

describe('lazy expiry — single-segment reads', () => {
  it('reads normally right up to the deadline, then empty from the instant it passes', async () => {
    const { store, advance } = harness();
    const seg = store.segment('d-2026-08-05', { namespace: 'dedup', expiresAt: T0 + DAY });
    await seg.addMany([1, 2, 3, 999_999]);

    expect(await seg.count()).toBe(4);
    expect(await seg.has(2)).toBe(true);

    advance(DAY - 1); // one millisecond short
    expect(await seg.count()).toBe(4);

    advance(1); // exactly at the deadline — `>=`, so this is expired
    expect(await seg.count()).toBe(0);
    expect(await seg.has(2)).toBe(false);
    expect(await drain(seg.iterate())).toEqual([]);
  });

  it('the bytes are still there — expiry is a read rule, reclamation is the sweep', async () => {
    const { store, advance } = harness();
    const expiresAt = T0 + DAY;
    await store.segment('rolled', { expiresAt }).addMany([7, 8, 9]);
    advance(DAY);

    expect(await store.segment('rolled', { expiresAt }).count()).toBe(0);
    // A handle WITHOUT the deadline still sees the data: nothing has been reclaimed, and the deadline is a
    // property of the handle. This is the documented boundary, and the reason setRetention still matters.
    expect(await store.segment('rolled').count()).toBe(3);
  });

  it('costs no backend I/O once expired', async () => {
    const warm = new MemoryWarmDriver();
    let t = T0;
    const reads: string[] = [];
    const countingWarm = {
      get: (...args: Parameters<typeof warm.get>) => {
        reads.push('get');
        return warm.get(...args);
      },
      putConditional: warm.putConditional.bind(warm),
      deleteConditional: warm.deleteConditional.bind(warm),
      listChunks: (...args: Parameters<typeof warm.listChunks>) => {
        reads.push('listChunks');
        return warm.listChunks(...args);
      },
    } as unknown as MemoryWarmDriver;

    const store = new CloudRoaring({
      warm: countingWarm,
      cold: new MemoryColdChunkSource(),
      clock: { now: () => t, sleep: () => Promise.resolve() },
    });
    const seg = store.segment('rolled', { expiresAt: T0 + DAY });
    await seg.addMany([1, 2, 3]);

    t += DAY;
    reads.length = 0;
    await seg.count();
    await seg.has(1);
    await drain(seg.iterate());

    expect(reads).toEqual([]); // the whole point: an expired read is a comparison, not a request
  });

  it('a handle created before the deadline starts reading empty without being re-created', async () => {
    const { store, advance } = harness();
    const seg = store.segment('rolled', { expiresAt: T0 + DAY });
    await seg.addMany([1, 2]);
    expect(await seg.count()).toBe(2);

    advance(DAY + 1);

    // Same object. The check is per call, not cached at construction.
    expect(await seg.count()).toBe(0);
  });
});

describe('lazy expiry — set algebra stays coherent with count()', () => {
  it('an expired operand makes an intersection empty', async () => {
    const { store, advance } = harness();
    const live = store.segment('live');
    const rolling = store.segment('rolling', { expiresAt: T0 + DAY });
    await live.addMany([1, 2, 3]);
    await rolling.addMany([2, 3, 4]);

    expect(await drain(live.intersect([rolling]))).toEqual([2, 3]);

    advance(DAY);
    // A segment whose count() is 0 must not still contribute members to an AND — in either position.
    expect(await drain(live.intersect([rolling]))).toEqual([]);
    expect(await drain(rolling.intersect([live]))).toEqual([]);
  });

  it('an expired operand is dropped from a union, not treated as a failure', async () => {
    const { store, advance } = harness();
    const live = store.segment('live');
    const rolling = store.segment('rolling', { expiresAt: T0 + DAY });
    await live.addMany([1, 2]);
    await rolling.addMany([8, 9]);

    expect(await drain(live.union([rolling]))).toEqual([1, 2, 8, 9]);

    advance(DAY);
    expect(await drain(live.union([rolling]))).toEqual([1, 2]);
    expect(await drain(rolling.union([live]))).toEqual([1, 2]); // expired base, live operand
    expect(await drain(rolling.union([]))).toEqual([]); // everything expired
  });

  it('an expired exclusion excludes nothing, and an expired base is empty', async () => {
    const { store, advance } = harness();
    const base = store.segment('base');
    const suppress = store.segment('suppress', { expiresAt: T0 + DAY });
    await base.addMany([1, 2, 3]);
    // 42 is in `suppress` and NOT in `base`, so the expired-base case below can actually fail: without the
    // guard, `suppress.andNot([base])` would yield [42]. With [2] alone both paths were empty and the
    // assertion proved nothing — mutation testing caught it.
    await suppress.addMany([2, 42]);

    expect(await drain(base.andNot([suppress]))).toEqual([1, 3]);

    advance(DAY);
    expect(await drain(base.andNot([suppress]))).toEqual([1, 2, 3]); // suppression is gone, so it suppresses nothing
    expect(await drain(suppress.andNot([base]))).toEqual([]); // expired base
  });
});

describe('lazy expiry — validation', () => {
  it('refuses a seconds-shaped deadline at the handle, not at the first silent empty read', () => {
    const { store } = harness();
    expect(() => store.segment('x', { expiresAt: Math.floor(T0 / 1000) })).toThrow(ValidationError);
    expect(() => store.segment('x', { expiresAt: MIN_EXPIRES_AT_MS - 1 })).toThrow(ValidationError);
  });

  it('refuses a non-integer or non-finite deadline', () => {
    const { store } = harness();
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.segment('x', { expiresAt: bad })).toThrow(ValidationError);
    }
  });

  it('a handle with no deadline is unaffected', async () => {
    const { store, advance } = harness();
    const seg = store.segment('forever');
    await seg.addMany([1, 2, 3]);
    advance(1000 * DAY);
    expect(await seg.count()).toBe(3);
    expect(seg.expiresAt).toBeUndefined();
  });
});
