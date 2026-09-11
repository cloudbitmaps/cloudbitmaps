import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
import { MAX_SUPERSEDED_TRACKED } from '@/drivers/_shared/registry';
import { MemoryColdDriver, MemoryRegistryDriver, bulkLoadCrbmGeneration } from '@/index';
import type { IColdDriver, SegmentRef } from '@/index';

/**
 * The TIME half of the GC grace window.
 *
 * `keep` counts generations, and counting cannot protect a reader: a reader resolves `currentGen` once and
 * then fetches from it, so what endangers it is publishes landing underneath, not how many objects exist.
 * With `keep: 1`, two publishes in quick succession make the generation a reader resolved seconds ago the
 * third-newest — outside the window, and collected while it is still being read.
 *
 * Every deletion is dated by the REGISTRY, which records each generation that was current and when it
 * stopped being. Two earlier designs tried to date generations from the bucket instead and both were unsound
 * in the same way, so the cases that killed them are kept here as regressions: `an orphan …` below.
 *
 * The last describe is a liveness test. Every other assertion here is "nothing was collected", which is also
 * what a guard that refuses everything produces.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

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
    /** An object with no publish behind it — what a crashed load leaves. */
    orphan: (generation: number) => bulkLoadCrbmGeneration(cold, { ...SEG, generation }, [99]),
  };
}

async function generations(cold: IColdDriver): Promise<number[]> {
  const out: number[] = [];
  for await (const key of cold.list(SEG)) out.push(key.generation);
  return out.sort((a, b) => a - b);
}

describe('a generation is dated by the registry, exactly or not at all', () => {
  it('keeps a generation that stopped being current moments ago', async () => {
    const w = world();
    await w.load([1]); // gen 0, current for a week
    w.at(T0 + 7 * 24 * HOUR);
    await w.load([2]); // gen 1 — gen 0 superseded HERE
    expect(
      await gcOrphanGenerations(SEG, w.deps, {
        keep: 0,
        minAgeMs: 24 * HOUR,
        now: T0 + 7 * 24 * HOUR + 1000,
      }),
    ).toEqual([]);
  });

  it('collects it once the floor has passed', async () => {
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);
    expect(
      await gcOrphanGenerations(SEG, w.deps, {
        keep: 0,
        minAgeMs: 24 * HOUR,
        now: T0 + HOUR + 24 * HOUR,
      }),
    ).toEqual([0]);
  });

  it('dates each generation separately, so old ones go while young ones stay', async () => {
    const w = world();
    await w.load([1]); // 0
    w.at(T0 + HOUR);
    await w.load([2]); // 1 — retires 0 at T0+1h
    w.at(T0 + 2 * HOUR);
    await w.load([3]); // 2 — retires 1 at T0+2h
    w.at(T0 + 100 * HOUR);
    await w.load([4]); // 3 — retires 2 at T0+100h
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 50 * HOUR,
      now: T0 + 101 * HOUR,
    });
    expect([...deleted].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await generations(w.cold)).toEqual([2, 3]);
  });

  it('THE BURST: rapid publishes cannot walk a generation out of the window', async () => {
    const w = world();
    await w.load([1]);
    w.at(T0 + 500);
    await w.load([2]);
    w.at(T0 + 1000);
    await w.load([3]);
    expect(await gcOrphanGenerations(SEG, w.deps, { keep: 1 })).toEqual([0]); // count-only: the bug
    const w2 = world();
    await w2.load([1]);
    w2.at(T0 + 500);
    await w2.load([2]);
    w2.at(T0 + 1000);
    await w2.load([3]);
    expect(
      await gcOrphanGenerations(SEG, w2.deps, { keep: 1, minAgeMs: HOUR, now: T0 + 1000 }),
    ).toEqual([]);
  });

  it('keep and the floor compose — both must be satisfied', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) {
      w.at(T0 + i * HOUR);
      await w.load([i]);
    }
    expect(
      await gcOrphanGenerations(SEG, w.deps, { keep: 2, minAgeMs: HOUR, now: T0 + 100 * HOUR }),
    ).toEqual([0]);
  });
});

describe('an orphan the pointer skipped', () => {
  // Both earlier designs dated a generation by the object above it in the bucket, and both died here: a load
  // that writes its object and crashes leaves an orphan the next publish numbers past, and from a listing
  // that orphan is indistinguishable from a real successor.

  it('does not back-date the generation beneath it — even after later publishes', async () => {
    // The shape that broke the second design. The orphan sinks BELOW the most recent pointer move, where a
    // one-step history could no longer recognise it.
    const w = world();
    await w.load([1]); // gen 0, current
    await w.orphan(1); // object 1: written, never published
    w.at(T0 + 73 * HOUR);
    await w.load([2]); // gen 2 — gen 0 retired HERE
    w.at(T0 + 73 * HOUR + 60_000);
    await w.load([3]); // gen 3 — gen 2 retired; the orphan is now well below the newest move

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 1,
      minAgeMs: 24 * HOUR,
      now: T0 + 73 * HOUR + 120_000,
    });
    expect(deleted).not.toContain(0); // retired 2 minutes ago, under a 24h floor
    expect(await generations(w.cold)).toContain(0);
  });

  it('is collected without waiting out the floor — no reader can ever have resolved it', async () => {
    const w = world();
    await w.load([1]); // 0
    await w.load([2]); // 1 — current
    await w.orphan(2); // never published
    w.at(T0 + HOUR);
    await w.load([4]); // 3 — current
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 999 * HOUR,
      now: T0 + HOUR,
    });
    expect(deleted).toContain(2); // the orphan goes despite a floor nothing else clears
    expect(deleted).not.toContain(1); // the generation actually retired an hour ago stays
  });
});

describe('undatable is kept, never collected', () => {
  it('a row written before this existed collects nothing', async () => {
    const w = world();
    await w.load([1]);
    await w.load([2]);
    const row = (await w.registry.get(SEG))!;
    const { supersededGens: _dropped, ...legacy } = row;
    void _dropped;
    const registry = {
      ...w.registry,
      get: async () => legacy as typeof row,
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
  });

  it('a malformed entry costs its own generation its date, not the whole row', async () => {
    const w = world();
    await w.load([1]); // 0
    await w.load([2]); // 1
    await w.load([3]); // 2 — current
    const row = (await w.registry.get(SEG))!;
    const corrupt = {
      ...row,
      supersededGens: [
        { gen: 1, at: Number.NaN }, // unusable
        row.supersededGens![1]!, // gen 0, honest and long past
      ],
    };
    const registry = {
      ...w.registry,
      get: async () => corrupt as typeof row,
      list: w.registry.list.bind(w.registry),
      capabilities: w.registry.capabilities.bind(w.registry),
    } as unknown as typeof w.registry;
    const deleted = await gcOrphanGenerations(
      SEG,
      { cold: w.cold, registry },
      { keep: 0, minAgeMs: HOUR, now: T0 + 999 * HOUR },
    );
    expect(deleted).toEqual([0]); // the honest entry still works
    expect(deleted).not.toContain(1); // the unusable one keeps its generation
  });

  it('a junk entry does not hide the good entries after it', async () => {
    // The list is read as independent facts, not as a record that is valid or invalid as a whole: one
    // unparseable entry must cost its own generation, not every entry behind it. Abandoning the scan would
    // make the rest of the history undatable, and undatable means kept — a storage leak triggered by one bad
    // row rather than a deletion bug, but a silent one.
    const w = world();
    await w.load([1]); // 0
    await w.load([2]); // 1
    await w.load([3]); // 2 — current
    const row = (await w.registry.get(SEG))!;
    const corrupt = {
      ...row,
      supersededGens: [{ gen: 'nonsense', at: 1 }, ...row.supersededGens!],
    };
    const registry = {
      ...w.registry,
      get: async () => corrupt as unknown as typeof row,
      list: w.registry.list.bind(w.registry),
      capabilities: w.registry.capabilities.bind(w.registry),
    } as unknown as typeof w.registry;
    expect(
      [
        ...(await gcOrphanGenerations(
          SEG,
          { cold: w.cold, registry },
          { keep: 0, minAgeMs: HOUR, now: T0 + 999 * HOUR },
        )),
      ].sort((a, b) => a - b),
    ).toEqual([0, 1]); // both real entries still read
  });

  it('behaves exactly as before when no minAgeMs is given', async () => {
    const w = world();
    await w.load([1]);
    await w.load([2]);
    expect(await gcOrphanGenerations(SEG, w.deps, { keep: 0 })).toEqual([0]);
  });

  it('a wrong-units clock keeps everything rather than deleting it', async () => {
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);
    expect(
      await gcOrphanGenerations(SEG, w.deps, {
        keep: 0,
        minAgeMs: HOUR,
        now: Math.floor((T0 + 99 * HOUR) / 1000), // seconds
      }),
    ).toEqual([]);
  });

  it('a generation whose entry has aged out of the capped list is kept, not assumed to be an orphan', async () => {
    // The cap's safe direction. "We stopped tracking it" is not evidence that it was never current — treating
    // it as a skipped generation would collect it immediately, ignoring the floor entirely.
    const w = world();
    for (let i = 0; i <= MAX_SUPERSEDED_TRACKED + 1; i++) {
      w.at(T0 + i * 1000);
      await w.load([i]);
    }
    const row = (await w.registry.get(SEG))!;
    expect(row.supersededGens).toHaveLength(MAX_SUPERSEDED_TRACKED);
    const tracked = Math.min(...row.supersededGens!.map((e) => e.gen));
    // Everything is far inside a huge floor, so nothing may be collected — least of all the generations that
    // fell off the end of the list.
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 999 * HOUR,
      now: T0 + MAX_SUPERSEDED_TRACKED * 1000,
    });
    expect(deleted).toEqual([]);
    expect(await generations(w.cold)).toContain(tracked - 1); // the untracked one survives
  });
});

describe('supersededGens is written only by a pointer move', () => {
  it('records the generation retired and when', async () => {
    const w = world();
    await w.load([1]);
    expect((await w.registry.get(SEG))?.supersededGens ?? []).toEqual([]);
    w.at(T0 + HOUR);
    await w.load([2]);
    expect((await w.registry.get(SEG))?.supersededGens).toEqual([{ gen: 0, at: T0 + HOUR }]);
  });

  it('is untouched by a retention write — that is the whole difference from updatedAt', async () => {
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);
    w.at(T0 + 2 * HOUR);
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + 90 * 24 * HOUR });
    const row = await w.registry.get(SEG);
    expect(row?.supersededGens).toEqual([{ gen: 0, at: T0 + HOUR }]);
    expect(row?.updatedAt).toBe(T0 + 2 * HOUR); // the row moved; the history did not
  });

  it('keeps a history, newest first, and caps it', async () => {
    const w = world();
    for (let i = 0; i <= MAX_SUPERSEDED_TRACKED + 3; i++) {
      w.at(T0 + i * 1000);
      await w.load([i]);
    }
    const list = (await w.registry.get(SEG))!.supersededGens!;
    expect(list).toHaveLength(MAX_SUPERSEDED_TRACKED);
    expect(list[0]!.gen).toBeGreaterThan(list[1]!.gen); // newest first
    expect(list[0]!.at).toBeGreaterThan(list[1]!.at);
  });
});

describe('validation', () => {
  it('refuses minAgeMs without a clock rather than defaulting it to 0', async () => {
    const w = world();
    await w.load([1]);
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
    await w.load([1]);
    await expect(gcOrphanGenerations(SEG, w.deps, { minAgeMs, now: T0 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses a non-finite now', async () => {
    const w = world();
    await w.load([1]);
    await expect(
      gcOrphanGenerations(SEG, w.deps, { minAgeMs: HOUR, now: Number.NaN }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a NaN keep, which would silently disable the grace window', async () => {
    // `Math.max(0, NaN)` is `NaN` and `slice(NaN)` is `slice(0)`. A negative `keep` clamping to 0 is
    // long-standing documented behaviour and stays; this is the value that lies about what it does.
    const w = world();
    await w.load([1]);
    await expect(gcOrphanGenerations(SEG, w.deps, { keep: Number.NaN })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('LIVENESS — a segment on a publish cadence still collects', () => {
  it('collects steadily under an hourly publisher with a 24h floor', async () => {
    // The test the first design did not have, and the one that would have caught it: it collected 0 here,
    // forever, and no assertion in its suite noticed. Exact counts, because every clock here is injected.
    const w = world();
    let collected = 0;
    for (let h = 0; h < 72; h++) {
      w.at(T0 + h * HOUR);
      await w.load([h]);
      collected += (
        await gcOrphanGenerations(SEG, w.deps, { keep: 1, minAgeMs: 24 * HOUR, now: T0 + h * HOUR })
      ).length;
    }
    expect(collected).toBe(47);
    expect(await generations(w.cold)).toEqual(Array.from({ length: 25 }, (_v, i) => 47 + i));
  });

  it('a 12h re-seed cadence against a 24h floor still collects', async () => {
    // The real consumer's shape, and the case the first design was inert for.
    const w = world();
    let collected = 0;
    for (let i = 0; i < 20; i++) {
      w.at(T0 + i * 12 * HOUR);
      await w.load([i]);
      collected += (
        await gcOrphanGenerations(SEG, w.deps, {
          keep: 3,
          minAgeMs: 24 * HOUR,
          now: T0 + i * 12 * HOUR,
        })
      ).length;
    }
    expect(collected).toBe(16);
    expect(await generations(w.cold)).toEqual([16, 17, 18, 19]);
  });
});
