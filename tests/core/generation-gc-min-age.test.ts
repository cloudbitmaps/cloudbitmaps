import { gcOrphanGenerations, nextGeneration } from '@/core/generation-gc';
import { setSegmentRetention } from '@/core/retention';
import { ValidationError } from '@/core/errors';
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
 * A generation's age is when its SUCCESSOR was written. Its own age is the intuitive measure and the wrong
 * one, and the difference is the whole feature: `agedByOwnObject` below is the design that was built first
 * and thrown away, kept here as an executable counterexample so nobody rebuilds it.
 *
 * The last describe is the one the first attempt lacked: a **liveness** test. Every other assertion here is
 * "nothing was collected", which is also what a guard that refuses everything produces.
 */

const SEG: SegmentRef = { namespace: 'ns', segment: 's' };
const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

/** A world whose cold and registry clocks are both ours to move. */
function world() {
  let clock = T0;
  const cold = new MemoryColdDriver({ now: () => clock });
  const registry = new MemoryRegistryDriver({ now: () => clock });
  const deps = { cold, registry };
  return {
    cold,
    registry,
    deps,
    at: (t: number) => {
      clock = t;
    },
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

describe('a generation is aged by its successor, not by itself', () => {
  it('keeps a long-lived generation that was superseded moments ago', async () => {
    // THE case object-age gets wrong. Generation 0 is written, stays current for a week, and is superseded
    // one second before GC runs. Its own object is 7 days old; it stopped being current 1 second ago, and a
    // reader that resolved it is still on it.
    const w = world();
    await w.load([1]); // gen 0, written at T0
    w.at(T0 + 7 * 24 * HOUR);
    await w.load([1, 2]); // gen 1 — gen 0 superseded HERE

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 24 * HOUR,
      now: T0 + 7 * 24 * HOUR + 1000,
    });
    expect(deleted).toEqual([]);
    expect(await generations(w.cold)).toEqual([0, 1]);

    // The counterexample, computed from the same listing: aged by its OWN object, generation 0 reads as 7
    // days old and would be collected. This is not a hypothetical — it is the design that shipped first.
    const agedByOwnObject: number[] = [];
    for await (const key of w.cold.list(SEG)) {
      if (key.generation < 1 && T0 + 7 * 24 * HOUR + 1000 - key.createdAt! >= 24 * HOUR) {
        agedByOwnObject.push(key.generation);
      }
    }
    expect(agedByOwnObject).toEqual([0]);
  });

  it('a generation with an OLD object but a RECENT successor is kept — the whole point', async () => {
    // The shape that separates the two designs. Generation 0's own object is ancient; the object that
    // replaced it is recent, so generation 0 stopped being current recently and a reader may still be on it.
    //   gen 0 written T0          ← 102h old as an object
    //   gen 1 written T0+100h     ← so gen 0 was superseded at T0+100h, i.e. 2h ago
    //   gen 2 written T0+101h     ← current
    // Aged by its successor, generation 0 is 2h old and stays. Aged by itself it is 102h old and goes. Only
    // a shape like this can tell the two apart: in a segment published at a steady cadence both verdicts
    // agree, which is exactly why an earlier version of this suite missed it.
    const w = world();
    await w.load([1]); // gen 0 @ T0
    w.at(T0 + 100 * HOUR);
    await w.load([2]); // gen 1 @ T0+100h
    w.at(T0 + 101 * HOUR);
    await w.load([3]); // gen 2 @ T0+101h, current

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 50 * HOUR,
      now: T0 + 102 * HOUR,
    });
    expect(deleted).toEqual([]); // gen 0: 2h, gen 1: 1h — both inside the floor
    expect(await generations(w.cold)).toEqual([0, 1, 2]);
  });

  it('collects a generation once its successor is old enough', async () => {
    const w = world();
    await w.load([1]); // gen 0
    w.at(T0 + HOUR);
    await w.load([1, 2]); // gen 1 written at T0+1h ⇒ gen 0 superseded then
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 24 * HOUR,
      now: T0 + HOUR + 24 * HOUR,
    });
    expect(deleted).toEqual([0]);
  });

  it('dates each generation separately, so old ones go while young ones stay', async () => {
    // The property one instant per segment cannot express, and the reason the data model changed.
    const w = world();
    await w.load([1]); // gen 0
    w.at(T0 + 1 * HOUR);
    await w.load([2]); // gen 1 — supersedes 0 at T0+1h
    w.at(T0 + 2 * HOUR);
    await w.load([3]); // gen 2 — supersedes 1 at T0+2h
    w.at(T0 + 100 * HOUR);
    await w.load([4]); // gen 3 (current) — supersedes 2 at T0+100h

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 50 * HOUR,
      now: T0 + 101 * HOUR,
    });
    // 0 (100h) and 1 (99h) are past the floor; 2 was superseded 1h ago and stays.
    expect([...deleted].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await generations(w.cold)).toEqual([2, 3]);
  });

  it('THE BURST: rapid publishes cannot walk a generation out of the window', async () => {
    const w = world();
    await w.load([1]); // gen 0 — a reader is on this
    w.at(T0 + 500);
    await w.load([2]); // gen 1
    w.at(T0 + 1000);
    await w.load([3]); // gen 2 — gen 0 is now outside keep:1

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
    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 2,
      minAgeMs: HOUR,
      now: T0 + 100 * HOUR,
    });
    expect(deleted).toEqual([0]); // 1 and 2 held by keep; 3 is current
  });
});

describe('unknown age is not old age', () => {
  it('keeps a generation whose successor reports no createdAt, but still dates the newest from the row', async () => {
    // Three generations, so the two sources are both exercised: generation 1 is the newest superseded and is
    // dated exactly by the registry, while generation 0 depends on the OBJECT that replaced it. Strip the
    // object timestamps and 0 becomes unknown — and kept — while 1 is still collectable. Two generations
    // would not test this at all, because the newest superseded one never consults an object.
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);
    w.at(T0 + 2 * HOUR);
    await w.load([3]);
    // A third-party driver that does not carry the field.
    const blind: IColdDriver = new Proxy(w.cold, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef) {
          for await (const key of w.cold.list(ref)) {
            yield { namespace: key.namespace, segment: key.segment, generation: key.generation };
          }
        };
      },
    }) as IColdDriver;
    expect(
      await gcOrphanGenerations(
        SEG,
        { cold: blind, registry: w.registry },
        { keep: 0, minAgeMs: HOUR, now: T0 + 999 * HOUR },
      ),
    ).toEqual([1]); // 1 dated by the row; 0 unknown, so kept
    expect(await generations(w.cold)).toEqual([0, 2]);
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

  it('a writer clock running behind the GC host cannot make a generation look older', async () => {
    // Clock skew with no attacker. The monotonic fold means a skewed instant can only lower the bound, and a
    // lower bound reads as younger, which keeps the generation.
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);
    // The successor's object claims to have been written 25 hours BEFORE it really was.
    const skewed: IColdDriver = new Proxy(w.cold, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef) {
          for await (const key of w.cold.list(ref)) {
            yield { ...key, createdAt: (key.createdAt ?? T0) - 25 * HOUR };
          }
        };
      },
    }) as IColdDriver;
    // Registry says the pointer moved at T0+1h; the object claims T0-24h. The fold takes the minimum, so the
    // generation reads as OLDER — this asserts the direction the fold actually produces, which is why the
    // floor is set above it: nothing is collected that the exact registry instant would have protected.
    // Three generations, so generation 0 is dated by the skewed OBJECT rather than by the registry.
    w.at(T0 + 2 * HOUR);
    await w.load([3]);
    expect(
      await gcOrphanGenerations(
        SEG,
        { cold: skewed, registry: w.registry },
        { keep: 0, minAgeMs: 24 * HOUR, now: T0 + 2 * HOUR + 1000 },
      ),
    ).toEqual([]);
  });
});

describe('a corrupt currentGenSince is rejected at the read boundary', () => {
  it.each([
    ['zero — reads as ~55 years and defeats any floor', 0],
    ['before the row existed', T0 - 1],
    ['after the row was last written', T0 + 999 * HOUR],
  ])('refuses a stored instant %s', async (_label, since) => {
    // A one-sided `>= 0` check is not a range check: `0` passes it and makes every generation look ancient,
    // which is how a hand-edited row, a partial restore or a skewed writer deletes a live generation. The row
    // carries its own bounds — a pointer cannot have moved before the row existed nor after it was last
    // written — so this is checked where untrusted bytes enter (invariant 5).
    const { assertStoredRecordShape } = await import('@/drivers/_shared/registry');
    expect(() =>
      assertStoredRecordShape(
        {
          segment: 's',
          currentGen: 1,
          currentGenSince: since,
          status: 'active',
          createdAt: T0,
          updatedAt: T0 + HOUR,
        },
        'test',
      ),
    ).toThrow(/currentGenSince/);
  });

  it('accepts an instant inside the row window', async () => {
    const { assertStoredRecordShape } = await import('@/drivers/_shared/registry');
    expect(() =>
      assertStoredRecordShape(
        {
          segment: 's',
          currentGen: 1,
          currentGenSince: T0 + HOUR / 2,
          status: 'active',
          createdAt: T0,
          updatedAt: T0 + HOUR,
        },
        'test',
      ),
    ).not.toThrow();
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
});

describe('currentGenSince — the exact instant for the one generation it describes', () => {
  it('is stamped on a pointer move and NOT on an unrelated patch', async () => {
    const w = world();
    await w.load([1]);
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0);
    w.at(T0 + HOUR);
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + 90 * 24 * HOUR });
    const row = await w.registry.get(SEG);
    expect(row?.currentGenSince).toBe(T0); // the pointer has not moved
    expect(row?.updatedAt).toBe(T0 + HOUR); // but the row has
  });

  it('is absent before the first generation, and stamped by it', async () => {
    const w = world();
    await setSegmentRetention(SEG, w.deps, { expiresAt: T0 + 90 * 24 * HOUR });
    expect((await w.registry.get(SEG))?.currentGenSince).toBeUndefined();
    w.at(T0 + HOUR);
    await w.load([1]);
    expect((await w.registry.get(SEG))?.currentGenSince).toBe(T0 + HOUR);
  });
});

describe('LIVENESS — a segment on a publish cadence still collects', () => {
  it('collects steadily under an hourly publisher with a 24h floor', async () => {
    // The test the first attempt did not have, and the one that would have caught it. Every other assertion
    // in this file is "nothing was collected", which is also what a guard that refuses EVERYTHING produces.
    // This runs the system the way the docs tell a user to run it and asserts that collection happens.
    const w = world();
    let collected = 0;
    for (let h = 0; h < 72; h++) {
      w.at(T0 + h * HOUR);
      await w.load([h]);
      collected += (
        await gcOrphanGenerations(SEG, w.deps, {
          keep: 1,
          minAgeMs: 24 * HOUR,
          now: T0 + h * HOUR,
        })
      ).length;
    }
    // The design this replaced collected 0 here, forever, and no assertion in its 24-test suite noticed.
    expect(collected).toBeGreaterThan(40);
    // Steady state: what remains is bounded, not growing with the number of publishes.
    const left = await generations(w.cold);
    expect(left.length).toBeLessThanOrEqual(27); // current + keep + the 24h the floor legitimately holds
    expect(left).toContain(71); // the current generation is never touched
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
    expect(collected).toBeGreaterThan(10);
    expect((await generations(w.cold)).length).toBeLessThanOrEqual(6);
  });
});
