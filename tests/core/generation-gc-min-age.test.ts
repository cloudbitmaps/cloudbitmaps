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

describe('an orphan the pointer skipped cannot back-date the generation beneath it', () => {
  it('keeps a generation superseded seconds ago even with a week-old orphan above it', async () => {
    // The defect that made the floor a no-op. A load writes its object and crashes before publishing; the
    // next publish numbers past it. That orphan then sits BELOW the pointer looking exactly like a successor,
    // and dating generation 2 by it says "a week old" when generation 2 stopped being current this instant.
    //
    //   gen 0,1,2 published        gen 2 current, readers on it
    //   object 3 written, crashed  ← never current
    //   a week later: publish 4    ← gen 2 superseded HERE
    const w = world();
    await w.load([1]); // 0
    await w.load([2]); // 1
    await w.load([3]); // 2 — current
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 3 }, [4]); // orphan: no registry publish
    w.at(T0 + 7 * 24 * HOUR);
    await w.load([5]); // 4 — current; gen 2 superseded now

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 1,
      minAgeMs: HOUR,
      now: T0 + 7 * 24 * HOUR + 1000,
    });
    expect(deleted).not.toContain(2); // the generation a reader is on
    expect(await generations(w.cold)).toContain(2);
  });

  it('collects the orphan itself immediately — it was never current, so no reader was ever on it', async () => {
    // The other half: a skipped generation needs no grace window at all, and holding one would just bill for
    // an object nobody can ever have resolved.
    const w = world();
    await w.load([1]); // 0
    await w.load([2]); // 1 — current
    await bulkLoadCrbmGeneration(w.cold, { ...SEG, generation: 2 }, [3]); // orphan
    w.at(T0 + HOUR);
    await w.load([4]); // 3 — current

    const deleted = await gcOrphanGenerations(SEG, w.deps, {
      keep: 0,
      minAgeMs: 999 * HOUR,
      now: T0 + HOUR,
    });
    expect(deleted).toContain(2); // the orphan goes despite a floor nothing else clears
    expect(deleted).not.toContain(1); // the generation actually superseded an hour ago stays
  });
});

describe('contradictory object timestamps are discarded, not believed', () => {
  it('keeps a generation whose successor claims to predate it', async () => {
    // Out-of-order evidence: the listing says generation 2's object was written BEFORE generation 1's, which
    // cannot be true for generations published in sequence. Believing it dates generation 1 far too early and
    // deletes it. One of the two instants must be wrong and there is no way to tell which, so neither is used.
    const w = world();
    await w.load([1]); // 0 @ T0
    w.at(T0 + HOUR);
    await w.load([2]); // 1 @ T0+1h
    w.at(T0 + 2 * HOUR);
    await w.load([3]); // 2 @ T0+2h
    w.at(T0 + 3 * HOUR);
    await w.load([4]); // 3 @ T0+3h — current

    const scrambled = new Proxy(w.cold, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef) {
          for await (const key of w.cold.list(ref)) {
            if (key.generation === 2) yield { ...key, createdAt: T0 + HOUR / 2 };
            else if (key.generation === 1) yield { ...key, createdAt: T0 + 2.5 * HOUR };
            else yield key;
          }
        };
      },
    }) as typeof w.cold;

    // Generation 1 was really superseded at T0+2h, one hour before `now`. With a 2.5h floor it must stay.
    expect(
      await gcOrphanGenerations(
        SEG,
        { cold: scrambled, registry: w.registry },
        { keep: 0, minAgeMs: 2.5 * HOUR, now: T0 + 3 * HOUR },
      ),
    ).not.toContain(1);
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
    // Clock skew with no attacker: the object store's clock runs behind the registry's. The instant the
    // skewed object reports lands before the row itself existed, which is not a late timestamp but a
    // broken one, so it is discarded as unknown and the generation is kept.
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
    // The instant the skewed object claims falls before the row itself existed, so it is not a late
    // timestamp — it is a broken one, and it is discarded as unknown rather than used. Without that check it
    // would age generation 0 past the floor and delete it. The positive control below runs the identical
    // shape with an in-window offset and shows the same generation IS collected, so this test's expected
    // value depends on the skew rather than being `[]` whatever happens.
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

    // The positive control: identical shape, but the offset keeps the instant inside the row's window, so it
    // is believed and generation 0 IS collected. Without this the assertion above would be satisfied by any
    // implementation that never collects anything.
    const believable = new Proxy(w.cold, {
      get(target, prop, rx) {
        if (prop !== 'list') return Reflect.get(target, prop, rx) as unknown;
        return async function* (ref: SegmentRef) {
          for await (const key of w.cold.list(ref)) yield key; // honest timestamps
        };
      },
    }) as typeof w.cold;
    expect(
      await gcOrphanGenerations(
        SEG,
        { cold: believable, registry: w.registry },
        { keep: 0, minAgeMs: HOUR / 2, now: T0 + 3 * HOUR },
      ),
    ).toContain(0);
  });
});

describe('a corrupt currentGenSince disables dating without bricking the row', () => {
  // The dangerous value is one that reads as OLD: a stored `0` is ~55 years ago and would age every
  // generation past any floor a caller could set. It must not delete anything — and it must not make the row
  // unreadable either. `updatedAt` is re-stamped by whichever host writes next, and nothing orders that
  // host's clock against the one that moved the pointer, so an out-of-range instant is reachable from plain
  // NTP skew between two writers. Rejecting the record at the read boundary would brick it for `get`,
  // `create`, `compareAndSwap` and `delete` alike — and take whole-namespace `list()` down with it.
  it.each([
    ['zero — ~55 years ago, the value that defeats a floor', 0],
    ['before the row existed', T0 - 1],
    ['after the row was last written', T0 + 999 * HOUR],
  ])('treats an instant %s as unknown and keeps the generation', async (_label, since) => {
    const w = world();
    await w.load([1]);
    w.at(T0 + HOUR);
    await w.load([2]);

    const row = (await w.registry.get(SEG))!;
    const corrupt = { ...row, currentGenSince: since };
    const registry = {
      ...w.registry,
      get: async () => corrupt,
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

  it('a row whose clock skewed backwards is still fully usable', async () => {
    // The regression this replaced a stricter check to avoid. One writer moves the pointer; a second writer
    // with a slightly lagging clock patches something unrelated, leaving `currentGenSince > updatedAt`. Every
    // later operation must still work — there is no repair path through the library if it does not, because
    // every write path reads the row first.
    const cold = new MemoryColdDriver({ now: () => T0 });
    let clock = T0 + HOUR;
    const registry = new MemoryRegistryDriver({ now: () => clock });
    await bulkLoadCrbmGeneration(cold, { ...SEG, generation: 0 }, [1], { registry });
    clock = T0; // the second writer's clock is an hour behind
    const row = (await registry.get(SEG))!;
    await registry.compareAndSwap(SEG, row.token, { retention: { expiresAt: T0 + 99 * HOUR } });

    const after = await registry.get(SEG);
    expect(after!.currentGenSince!).toBeGreaterThan(after!.updatedAt); // the skewed row, as written
    // …and it still reads, lists, and can be written again.
    const listed = [];
    for await (const r of registry.list()) listed.push(r);
    expect(listed).toHaveLength(1);
    await registry.compareAndSwap(SEG, after!.token, { status: 'active' });
    expect((await registry.get(SEG))?.segment).toBe('s');
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
    // Exact, not a bound. Every clock here is injected, so these numbers are deterministic — and a bound is
    // too weak to be worth writing: at `> 40` a floor wrong by two hours still passes, which is exactly the
    // kind of near-miss a liveness test exists to catch.
    expect(collected).toBe(47);
    const left = await generations(w.cold);
    expect(left).toEqual(Array.from({ length: 25 }, (_v, i) => 47 + i)); // 47…71, and nothing else
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
