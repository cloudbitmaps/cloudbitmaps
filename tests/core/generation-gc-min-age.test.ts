import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
import { MemoryColdDriver, MemoryRegistryDriver, bulkLoadCrbmGeneration } from '@/index';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * The TIME half of the GC grace window.
 *
 * `keep` counts generations, and counting cannot protect a reader: a reader resolves `currentGen` once and then
 * fetches from it, so what endangers it is publishes happening underneath, not how many objects exist. With
 * `keep: 1`, two publishes in quick succession make the generation a reader resolved seconds ago the
 * third-newest — outside the window, and collected while it is still being read. That burst is the whole reason
 * `minAgeMs` exists, so it is the case these tests are built around.
 *
 * The clock is `currentGenSince` — when the POINTER last moved — not the age of the stored object. Object age
 * is the intuitive choice and fails the same burst: a generation written a week ago and superseded one second
 * ago reads as a week old. The final describe pins that distinction directly, because it is the one thing a
 * future refactor toward "just stat the object" would quietly break.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = 1_760_000_000_000; // a plain epoch-ms instant; every test moves relative to it
const HOUR = 3_600_000;

/** A world whose registry clock is ours to move, which is the only way to test a time window honestly. */
function world() {
  let clock = T0;
  const cold = new MemoryColdDriver();
  const registry = new MemoryRegistryDriver({ now: () => clock });
  const deps = { cold, registry };
  return {
    cold,
    registry,
    deps,
    at: (t: number) => {
      clock = t;
    },
    /** The production write path: next number, write the object, advance the pointer. */
    load: async (ids: number[] = [1]) => {
      const generation = await nextGeneration(SEG, deps);
      return bulkLoadCrbmGeneration(cold, { ...SEG, generation }, ids, { registry });
    },
  };
}

async function generations(cold: IColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const key of cold.list(SEG)) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

describe('currentGenSince — the supersession clock', () => {
  it('is stamped when the first generation is published', async () => {
    const w = world();
    await w.load();
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0);
  });

  it('moves only when the pointer moves', async () => {
    const w = world();
    await w.load();
    w.at(T0 + HOUR);
    await w.load();
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0 + HOUR);
  });

  it('is NOT disturbed by an unrelated patch — a retention policy is not a publish', async () => {
    // The distinction between this field and `updatedAt`, and the reason it exists. If setting a policy reset
    // the clock, a segment whose retention is touched on a schedule would never become collectable.
    const w = world();
    await w.load();
    w.at(T0 + HOUR);
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + 90 * 24 * HOUR });
    const row = await w.registry.get(SEG);
    expect(row?.currentGenSince).toBe(T0); // the pointer has not moved
    expect(row?.updatedAt).toBe(T0 + HOUR); // but the row has
  });

  it('is absent on a row minted before any generation exists', async () => {
    const w = world();
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + HOUR });
    const row = await w.registry.get(SEG);
    expect(row?.currentGen).toBeNull();
    expect(row?.currentGenSince).toBeUndefined();
  });

  it('is stamped when that row later gets its first generation', async () => {
    const w = world();
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + 90 * 24 * HOUR });
    w.at(T0 + HOUR);
    await w.load();
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0 + HOUR);
  });

  it('survives a round-trip through the registry rather than living only in memory', async () => {
    const w = world();
    await w.load();
    // `get` re-reads the stored row; a driver that dropped the field on write would fail here.
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0);
  });
});

describe('gcOrphanGenerations — minAgeMs', () => {
  it('collects nothing while the pointer has moved more recently than the floor', async () => {
    const w = world();
    await w.load();
    w.at(T0 + HOUR);
    await w.load();
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 24 * HOUR,
      now: T0 + HOUR,
    });
    expect(deleted).toEqual([]);
    expect(await generations(w.cold)).toEqual([0, 1]);
  });

  it('collects once the pointer has been still for the floor', async () => {
    const w = world();
    await w.load();
    w.at(T0 + HOUR);
    await w.load();
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 24 * HOUR,
      now: T0 + HOUR + 24 * HOUR,
    });
    expect(deleted).toEqual([0]);
    expect(await generations(w.cold)).toEqual([1]);
  });

  it('is exactly at the boundary: equal to the floor collects, one ms short does not', async () => {
    for (const [elapsed, expected] of [
      [24 * HOUR - 1, []],
      [24 * HOUR, [0]],
    ] as const) {
      const w = world();
      await w.load();
      w.at(T0 + HOUR);
      await w.load();
      expect(
        await gcOrphanGenerations(SEG, w.deps, {
          keep: 0,
          minAgeMs: 24 * HOUR,
          now: T0 + HOUR + elapsed,
        }),
      ).toEqual(expected);
    }
  });

  it('THE BURST: two rapid publishes cannot walk a generation out of the window', async () => {
    // Without `minAgeMs` this is the defect. A reader resolved generation 0; two publishes land within a
    // second; `keep: 1` now protects only generation 1, so generation 0 is collected while it is being read.
    const w = world();
    await w.load(); // gen 0 — the one our reader is on
    w.at(T0 + 500);
    await w.load(); // gen 1
    w.at(T0 + 1000);
    await w.load(); // gen 2 — gen 0 is now outside keep:1

    const countOnly = await gcOrphanGenerations(SEG, { ...w.deps }, { keep: 1 });
    expect(countOnly).toEqual([0]); // the bug, reproduced

    // Same fleet state, with the time window: nothing goes.
    const w2 = world();
    await w2.load();
    w2.at(T0 + 500);
    await w2.load();
    w2.at(T0 + 1000);
    await w2.load();
    expect(
      await gcOrphanGenerations(SEG, w2.deps, { keep: 1, minAgeMs: HOUR, now: T0 + 1000 }),
    ).toEqual([]);
    expect(await generations(w2.cold)).toEqual([0, 1, 2]);
  });

  it('a generation younger than the floor survives even at keep: 0', async () => {
    // `keep: 0` is the erasure path's setting. The floor still wins when one is supplied, so the two compose
    // rather than one overriding the other.
    const w = world();
    await w.load();
    w.at(T0 + 60_000);
    await w.load();
    expect(
      await gcOrphanGenerations(SEG, w.deps, { keep: 0, minAgeMs: HOUR, now: T0 + 60_000 }),
    ).toEqual([]);
  });

  it('keep still applies once the floor is cleared — both must be satisfied', async () => {
    const w = world();
    await w.load(); // 0
    await w.load(); // 1
    await w.load(); // 2
    await w.load(); // 3 (current)
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 2,
      minAgeMs: HOUR,
      now: T0 + 2 * HOUR,
    });
    expect(deleted).toEqual([0]); // 1 and 2 held by keep; 3 is current
    expect(await generations(w.cold)).toEqual([1, 2, 3]);
  });

  it('a rerun is a no-op', async () => {
    const w = world();
    await w.load();
    await w.load();
    const opts = { keep: 0, minAgeMs: HOUR, now: T0 + 2 * HOUR };
    expect(await gcOrphanGenerations(SEG, w.deps, opts)).toEqual([0]);
    expect(await gcOrphanGenerations(SEG, w.deps, opts)).toEqual([]);
    expect(await generations(w.cold)).toEqual([1]);
  });

  it('behaves exactly as before when no minAgeMs is given', async () => {
    const w = world();
    await w.load();
    await w.load();
    expect(await gcOrphanGenerations(SEG, w.deps, { keep: 0 })).toEqual([0]);
  });
});

describe('gcOrphanGenerations — minAgeMs on a row that cannot answer', () => {
  it('treats a missing currentGenSince as UNKNOWN age and collects nothing', async () => {
    // A row written before the field existed, or by a third-party driver that does not carry it. The unsafe
    // reading is "absent ⇒ infinitely old ⇒ collect"; that would delete a just-superseded generation on the
    // first run after an upgrade, which is the exact opposite of what the knob was set for.
    const w = world();
    await w.load();
    await w.load();
    const row = (await w.registry.get(SEG))!;
    const { currentGenSince: _dropped, ...legacy } = row;
    void _dropped;
    const stale: typeof row = legacy;
    const registry = {
      ...w.registry,
      get: async () => stale,
      list: w.registry.list.bind(w.registry),
      capabilities: w.registry.capabilities.bind(w.registry),
    } as unknown as typeof w.registry;

    expect(
      await gcOrphanGenerations(
        SEG,
        { cold: w.cold, registry },
        { keep: 0, minAgeMs: HOUR, now: T0 + 999 * HOUR },
      ),
    ).toEqual([]);
    expect(await generations(w.cold)).toEqual([0, 1]);
  });

  it('resumes on its own once a publish stamps the field', async () => {
    // The recovery story for that row: no migration, no admin step — the next publish stamps it.
    const w = world();
    await w.load();
    await w.load();
    w.at(T0 + HOUR);
    await w.load();
    expect(
      await gcOrphanGenerations(SEG, w.deps, { keep: 0, minAgeMs: HOUR, now: T0 + 3 * HOUR }),
    ).toEqual([1, 0]);
  });

  it('a wrong-units clock (seconds, not ms) keeps everything rather than deleting it', async () => {
    // The units mistake that destroys data is the one that makes things look OLD. Here it makes them look
    // impossibly young, so the guard fails closed.
    const w = world();
    await w.load();
    await w.load();
    expect(
      await gcOrphanGenerations(SEG, w.deps, {
        keep: 0,
        minAgeMs: HOUR,
        now: Math.floor((T0 + 99 * HOUR) / 1000), // seconds
      }),
    ).toEqual([]);
  });
});

describe('gcOrphanGenerations — minAgeMs and a destroyed segment', () => {
  it('collects every generation regardless of the floor', async () => {
    // A tombstoned segment resolves no generation, so no reader is or can become pinned to one. Applying the
    // window here would only keep paying storage for objects nobody can read.
    const w = world();
    await w.load();
    await w.load();
    const rec = (await w.registry.get(SEG))!;
    await w.registry.compareAndSwap(SEG, rec.token, { status: 'destroyed' });
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 5,
      minAgeMs: 999 * HOUR,
      now: T0, // no time has passed at all, and it still collects
    });
    expect([...deleted].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await generations(w.cold)).toEqual([]);
  });
});

describe('gcOrphanGenerations — minAgeMs validation', () => {
  it('refuses minAgeMs without a clock, rather than defaulting it to 0', async () => {
    // Defaulting `now` would silently disable the guard — the one failure mode a durability knob must not have,
    // because it looks identical to a working one until a reader breaks.
    const w = world();
    await w.load();
    await expect(gcOrphanGenerations(SEG, w.deps, { minAgeMs: HOUR })).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s minAgeMs', async (_label, minAgeMs) => {
    const w = world();
    await w.load();
    await expect(gcOrphanGenerations(SEG, w.deps, { minAgeMs, now: T0 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses a non-finite now', async () => {
    const w = world();
    await w.load();
    await expect(
      gcOrphanGenerations(SEG, w.deps, { minAgeMs: HOUR, now: Number.NaN }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts minAgeMs: 0 as "no floor", distinct from omitting it', async () => {
    const w = world();
    await w.load();
    await w.load();
    expect(await gcOrphanGenerations(SEG, w.deps, { keep: 0, minAgeMs: 0, now: T0 })).toEqual([0]);
  });
});
