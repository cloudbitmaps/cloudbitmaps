/**
 * Lazy expiry — the half of retention that does not wait for a sweep.
 *
 * A read past `expiresAt` answers empty immediately: one integer compare against the injected clock, no I/O,
 * identical on every backend. That is what makes an expiry *correct* rather than *eventually correct* — a
 * Lambda-only reader has no sweep at all, so without this its data never stops being served.
 */
import { describe, expect, it, vi } from 'vitest';
import { MIN_EXPIRES_AT_MS } from '@/index';
import { ValidationError } from '@/core/errors';
import { collect, seededStore } from '../helpers/loaded';

const DAY = 86_400_000;
const T0 = 1_754_000_000_000;

/** A store over a seeded cold source and a hand-cranked clock — expiry is a clock question, so inject one. */
function harness(segments: Record<string, number[]> = {}, start = T0) {
  let t = start;
  const clock = { now: () => t, sleep: () => Promise.resolve() };
  const { store, cold } = seededStore(segments, { clock });
  return { store, cold, advance: (ms: number) => (t += ms) };
}

describe('lazy expiry — single-segment reads', () => {
  it('reads normally right up to the deadline, then empty from the instant it passes', async () => {
    const { store, advance } = harness({ 'd-2026-08-05': [1, 2, 3, 999_999] });
    const seg = store.segment('d-2026-08-05', { expiresAt: T0 + DAY });

    expect(await seg.count()).toBe(4);
    expect(await seg.has(2)).toBe(true);

    advance(DAY - 1); // one millisecond short
    expect(await seg.count()).toBe(4);

    advance(1); // exactly at the deadline — `>=`, so this is expired
    expect(await seg.count()).toBe(0);
    expect(await seg.has(2)).toBe(false);
    expect(await collect(seg.iterate())).toEqual([]);
  });

  it('the bytes are still there — expiry is a read rule, reclamation is the sweep', async () => {
    const { store, advance } = harness({ rolled: [7, 8, 9] });
    const expiresAt = T0 + DAY;
    advance(DAY);

    expect(await store.segment('rolled', { expiresAt }).count()).toBe(0);
    // A handle WITHOUT the deadline still sees the data: nothing has been reclaimed, and the deadline is a
    // property of the handle. This is the documented boundary, and the reason setRetention still matters.
    expect(await store.segment('rolled').count()).toBe(3);
  });

  it('costs no backend I/O once expired', async () => {
    const { store, cold, advance } = harness({ rolled: [1, 2, 3] });
    const seg = store.segment('rolled', { expiresAt: T0 + DAY });
    expect(await seg.count()).toBe(3); // live: the reads really do reach the cold source

    advance(DAY);
    const getChunk = vi.spyOn(cold, 'getChunk');
    const listChunkKeys = vi.spyOn(cold, 'listChunkKeys');
    await seg.count();
    await seg.has(1);
    await collect(seg.iterate());

    // The whole point: an expired read is a comparison, not a request — not even the free-looking shape read.
    expect(getChunk).not.toHaveBeenCalled();
    expect(listChunkKeys).not.toHaveBeenCalled();
  });

  it('a handle created before the deadline starts reading empty without being re-created', async () => {
    const { store, advance } = harness({ rolled: [1, 2] });
    const seg = store.segment('rolled', { expiresAt: T0 + DAY });
    expect(await seg.count()).toBe(2);

    advance(DAY + 1);

    // Same object. The check is per call, not cached at construction.
    expect(await seg.count()).toBe(0);
  });
});

describe('lazy expiry — set algebra stays coherent with count()', () => {
  it('an expired operand makes an intersection empty', async () => {
    const { store, advance } = harness({ live: [1, 2, 3], rolling: [2, 3, 4] });
    const live = store.segment('live');
    const rolling = store.segment('rolling', { expiresAt: T0 + DAY });

    expect(await collect(live.intersect([rolling]))).toEqual([2, 3]);

    advance(DAY);
    // A segment whose count() is 0 must not still contribute members to an AND — in either position.
    expect(await collect(live.intersect([rolling]))).toEqual([]);
    expect(await collect(rolling.intersect([live]))).toEqual([]);
  });

  it('an expired operand is dropped from a union, not treated as a failure', async () => {
    const { store, advance } = harness({ live: [1, 2], rolling: [8, 9] });
    const live = store.segment('live');
    const rolling = store.segment('rolling', { expiresAt: T0 + DAY });

    expect(await collect(live.union([rolling]))).toEqual([1, 2, 8, 9]);

    advance(DAY);
    expect(await collect(live.union([rolling]))).toEqual([1, 2]);
    expect(await collect(rolling.union([live]))).toEqual([1, 2]); // expired base, live operand
    expect(await collect(rolling.union([]))).toEqual([]); // everything expired
  });

  it('a union whose every operand expired still applies `exclude` — the suppression is not an operand', async () => {
    // `exclude` is not one of the things being unioned, it is a subtraction applied to the result, so it has to
    // survive the shortcut that fires when every operand has aged out: `(this ∪ nothing) \ exclude`.
    //
    // It did not. The all-expired branch returned a bare `iterate()`, which takes no options, so the opt-out
    // list silently did not apply — on a library whose headline is composable suppression, reached by nothing
    // more exotic than a rolling segment handle passing its deadline. 42 is in `optout` and in `aud`, so a
    // dropped suppression is visible rather than coincidentally empty.
    const { store, advance } = harness({ aud: [1, 42, 77], rolling: [8], optout: [42] });
    const aud = store.segment('aud');
    const optout = store.segment('optout');
    const rolling = store.segment('rolling', { expiresAt: T0 + DAY });

    expect(await collect(aud.union([rolling], { exclude: [optout] }))).toEqual([1, 8, 77]);

    advance(DAY); // now every operand of the union has expired
    expect(await collect(aud.union([rolling], { exclude: [optout] }))).toEqual([1, 77]);
    // The control: with no exclusion the same shortcut is just the base segment.
    expect(await collect(aud.union([rolling]))).toEqual([1, 42, 77]);
    // …and an expired exclusion still excludes nothing, even down this branch.
    const staleOptout = store.segment('optout', { expiresAt: T0 + DAY });
    expect(await collect(aud.union([rolling], { exclude: [staleOptout] }))).toEqual([1, 42, 77]);
  });

  it('an expired exclusion excludes nothing, and an expired base is empty', async () => {
    // 42 is in `suppress` and NOT in `base`, so the expired-base case below can actually fail: without the
    // guard, `suppress.andNot([base])` would yield [42]. With [2] alone both paths were empty and the
    // assertion proved nothing — mutation testing caught it.
    const { store, advance } = harness({ base: [1, 2, 3], suppress: [2, 42] });
    const base = store.segment('base');
    const suppress = store.segment('suppress', { expiresAt: T0 + DAY });

    expect(await collect(base.andNot([suppress]))).toEqual([1, 3]);

    advance(DAY);
    expect(await collect(base.andNot([suppress]))).toEqual([1, 2, 3]); // suppression is gone, so it suppresses nothing
    expect(await collect(suppress.andNot([base]))).toEqual([]); // expired base
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
    const { store, advance } = harness({ forever: [1, 2, 3] });
    const seg = store.segment('forever');
    advance(1000 * DAY);
    expect(await seg.count()).toBe(3);
    expect(seg.expiresAt).toBeUndefined();
  });
});
