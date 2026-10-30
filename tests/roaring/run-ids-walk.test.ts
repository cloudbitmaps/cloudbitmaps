import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsBitmap, groupPath } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  Container,
  RUN,
  appendIds,
  containerOr,
  expandsRunArray,
  expandsRunSteps,
  fromSortedIds,
  orRunArrayWalk,
  orRunIdsWalk,
  walksRunIds,
} from '@/ts-roaring/containers';

/**
 * A group of five or more ids that the size rule sends to the merge walk, written into a run container, is merged by a walk that reads the ids where they are,
 * with no container built for the group. The result is, container for container, what the merge of the run container
 * with a container of the group gives, and the size rule that picks the walk is the one the container merge uses.
 */
const CAP = 1 << 27;
const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s;
  };
}

/** `n` runs from 0 up: run i starts at `i * gap` and holds 1 to `maxLen` values. */
function runList(n: number, gap: number, maxLen: number, seed: number): number[] {
  const next = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + (next() % maxLen);
    if (i * gap + len > 65_536) break; // a low half is below 65,536
    for (let k = 0; k < len; k++) out.push(i * gap + k);
  }
  return out;
}

function runs(lows: readonly number[], pad = 0, shared = true): Container {
  const pairs: number[] = [];
  for (let i = 0; i < lows.length;) {
    let j = i;
    while (j + 1 < lows.length && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length + pad);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, lows.length, shared);
}

function valuesOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return Array.from(out);
}

/** Ascending low halves, `count` of them (duplicates kept): inside, between, bridging and extending runs, 0 and 65,535, and random. */
function idsFor(held: readonly number[], count: number, seed: number): number[] {
  const next = lcg(seed);
  const out: number[] = [0, 65_535, 0];
  while (out.length < count) {
    const pick = held[next() % held.length] as number;
    switch (next() % 6) {
      case 0:
        out.push(pick); // inside a run, or at its edge
        break;
      case 1:
        out.push(Math.min(65_535, pick + 1)); // extends, or bridges a gap of one
        break;
      case 2:
        out.push(Math.max(0, pick - 1));
        break;
      case 3:
        out.push(Math.min(65_535, pick + 2), Math.min(65_535, pick + 3)); // between runs, or joins
        break;
      case 4:
        out.push(pick, pick); // already present, twice
        break;
      default:
        out.push(next() & 0xffff);
    }
  }
  return out.slice(0, count).sort((a, b) => a - b);
}

const ids32 = (lows: readonly number[], hi = 0): Uint32Array =>
  Uint32Array.from(lows, (l) => hi * 65_536 + l);

/** What the walk must equal: the container merge of the run container with a container of the group. */
function today(run: Container, ids: Uint32Array): Container {
  return containerOr(run, fromSortedIds(ids, 0, ids.length), true);
}

function sameContainer(got: Container, want: Container, label: string): void {
  expect(got.kind, label).toBe(want.kind);
  expect(got.card, label).toBe(want.card);
  expect(valuesOf(got), label).toEqual(valuesOf(want));
  if (got.kind === RUN) {
    expect(got.len, label).toBe(want.len);
    expect(
      Array.from((got.data as Uint16Array).subarray(got.off, got.off + 2 * got.len)),
      label,
    ).toEqual(Array.from((want.data as Uint16Array).subarray(want.off, want.off + 2 * want.len)));
  }
}

describe('orRunIdsWalk: the walk over ids equals the container merge', () => {
  const groupSizes = [5, 6, 4_095, 4_096];
  const runCounts = [1, 150, 2_000];

  for (const n of runCounts) {
    for (const g of groupSizes) {
      it(`${g} ids into ${n} run${n === 1 ? '' : 's'}`, () => {
        const held =
          n === 1 ? Array.from({ length: 30_000 }, (_, i) => 100 + i) : runList(n, 30, 12, n);
        const lows = idsFor(held, g, 7 * g + n);
        const ids = ids32(lows);
        const run = runs(held, 2, true);
        const before = Array.from(run.data as Uint16Array);
        const want = today(run, ids);
        const union = sortedUnique([...held, ...lows]);
        expect(valuesOf(want)).toEqual(union);
        if (!walksRunIds(run, g)) {
          // Sent through words by the size rule: the walk is not used, and it must still agree when called.
          expect(expandsRunArray(run, fromSortedIds(ids, 0, ids.length))).toBe(true);
        }
        const got = orRunIdsWalk(run, ids, 0, ids.length);
        sameContainer(got, want, `${g} into ${n}`);
        expect(got.card).toBe(union.length);
        // A shared run container is never written.
        expect(Array.from(run.data as Uint16Array)).toEqual(before);
      });
    }
  }

  it('the walk is refused above the group sizes the size rule computes, and for 4,097 or more', () => {
    const held = runList(150, 30, 12, 1);
    expect(walksRunIds(runs(held), 5)).toBe(true);
    expect(walksRunIds(runs(held), 800)).toBe(true);
    expect(walksRunIds(runs(held), 4_097)).toBe(false);
    expect(walksRunIds(runs(held), 65_536)).toBe(false);
  });

  it('the band edges follow from the rule: 2 + 4 * (runs + ids) under the 8,192-byte body, or 1,024 steps for a small result', () => {
    const spaced = (n: number, len: number) =>
      Array.from({ length: n }, (_, i) =>
        Array.from({ length: len }, (_, k) => i * (len + 1) + k),
      ).flat();
    // A large result: the plain body is a bitset, so the walk takes ids while runs + ids <= 2,047.
    const big: Array<[number, number]> = [
      [1, 30_000],
      [150, 30],
      [1_000, 5],
      [2_000, 5],
    ];
    for (const [n, len] of big) {
      const run =
        n === 1 ? runs(Array.from({ length: 30_000 }, (_, i) => 100 + i)) : runs(spaced(n, len));
      const top = 2_047 - run.len;
      expect(walksRunIds(run, top), `${n} runs, ${top} ids`).toBe(true);
      expect(walksRunIds(run, top + 1), `${n} runs, ${top + 1} ids`).toBe(false);
    }
    // One run of many values holds at most 2,046 ids.
    expect(2_047 - runs(Array.from({ length: 30_000 }, (_, i) => 100 + i)).len).toBe(2_046);
    // A small result (an array is its plain body): a rule that refuses at 1,024 steps.
    const small = runs(spaced(150, 1));
    expect(walksRunIds(small, 1_023 - small.len)).toBe(true);
    expect(walksRunIds(small, 1_024 - small.len)).toBe(false);
  });

  it('addMany chooses its path by the group size and the container: few, walk or merge', () => {
    const run = runs(runList(150, 30, 12, 1));
    expect(groupPath(run, 4)).toBe('few');
    expect(groupPath(run, 5)).toBe('walk');
    expect(groupPath(run, 800)).toBe('walk');
    expect(groupPath(run, 4_097)).toBe('merge');
    const array = new Container(ARRAY, Uint16Array.of(1, 5, 9), 0, 3, 3, false);
    expect(groupPath(array, 5)).toBe('merge');
    expect(groupPath(array, 4)).toBe('few');
  });

  // Budget 6 s (the default is 5 s): the slowest measured time was 1.8 s, on a Node 22 CI runner. Rule: that time times
  // three, rounded up to the next whole second.
  it(
    'property: the two walks return the same container for the same values',
    { timeout: 6000 },
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 2_000 }),
          fc.integer({ min: 1, max: 40 }),
          fc.integer({ min: 1, max: 25 }),
          fc.oneof(
            fc.integer({ min: 1, max: 4_096 }),
            fc.constantFrom(1, 5, 1_023, 1_024, 2_045, 2_046, 2_047, 2_048, 4_096),
          ),
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 0, max: 3 }),
          (n, gap, maxLen, g, seed, pad) => {
            const held = runList(n, Math.max(gap, maxLen + 1), maxLen, seed);
            const run = runs(held, pad);
            const lows = sortedUnique(idsFor(held, g, seed + 1));
            const ids = ids32(lows);
            const array = fromSortedIds(ids, 0, ids.length);
            const fromIds = orRunIdsWalk(run, ids, 0, ids.length);
            const fromArray = orRunArrayWalk(run, array, true);
            sameContainer(fromIds, fromArray, 'two walks');
            expect(fromIds === run, 'two walks: same object when nothing is added').toBe(
              fromArray === run,
            );
          },
        ),
        { numRuns: 400 },
      );
    },
  );

  it('a non-run container never takes the walk', () => {
    const c = new Container(ARRAY, Uint16Array.of(1, 5, 9), 0, 3, 3, false);
    expect(walksRunIds(c, 10)).toBe(false);
  });

  it('the size rule is one rule: the container form and the numeric form agree', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_500 }),
        fc.integer({ min: 1, max: 4_096 }),
        fc.integer({ min: 1, max: 20 }),
        (n, g, maxLen) => {
          const run = runs(runList(n, 20, maxLen, n + g));
          const array = fromSortedIds(ids32(Array.from({ length: g }, (_, i) => i * 3)), 0, g);
          expect(expandsRunSteps(run, g)).toBe(expandsRunArray(run, array));
          expect(walksRunIds(run, g)).toBe(!expandsRunArray(run, array));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('ids already present return the run container itself', () => {
    const held = runList(150, 30, 12, 3);
    const run = runs(held);
    const inside = held.filter((_, i) => i % 7 === 0).slice(0, 40);
    const ids = ids32(inside);
    expect(orRunIdsWalk(run, ids, 0, ids.length)).toBe(run);
    const dup = ids32([
      held[0] as number,
      held[0] as number,
      held[3] as number,
      held[3] as number,
      held[9] as number,
    ]);
    expect(orRunIdsWalk(run, dup, 0, dup.length)).toBe(run);
  });

  it('values at 0 and 65,535, bridging two runs, extending both ends, ids from a window of a longer list', () => {
    const held = [10, 11, 12, 20, 21, 65_534];
    const run = runs(held, 1);
    const lows = [0, 9, 13, 14, 15, 16, 17, 18, 19, 65_535];
    const all = Uint32Array.of(1, 2, ...lows.map((l) => 3 * 65_536 + l), 4 * 65_536);
    const got = orRunIdsWalk(run, all, 2, 2 + lows.length);
    expect(valuesOf(got)).toEqual(sortedUnique([...held, ...lows]));
    expect(got.kind).toBe(RUN);
    expect(got.len).toBe(3);
  });

  it('a result that leaves the run form: an array when runs are many and short', () => {
    const held = Array.from({ length: 1_000 }, (_, i) => i * 3);
    const run = runs(held);
    expect(walksRunIds(run, 5)).toBe(true);
    const lows = [1, 4, 7, 10, 13];
    const got = orRunIdsWalk(run, ids32(lows), 0, 5);
    expect(got.kind).toBe(ARRAY);
    sameContainer(got, today(run, ids32(lows)), 'array result');
    expect(valuesOf(got)).toEqual(sortedUnique([...held, ...lows]));
  });

  it('a group that would leave a bitset is sent through words by the size rule, not the walk', () => {
    // 1,500 runs of 3, then a group of 600 isolated values: 2,100 steps, so 2 + 8,400 is not under 8,192 bytes.
    const held = Array.from({ length: 1_500 }, (_, i) => i * 20).flatMap((s) => [s, s + 1, s + 2]);
    const run = runs(held);
    const lows = Array.from({ length: 600 }, (_, i) => 30_001 + i * 7);
    expect(walksRunIds(run, lows.length)).toBe(false);
    expect(expandsRunSteps(run, lows.length)).toBe(true);
    expect(groupPath(run, lows.length)).toBe('merge');
  });

  it('fuzz: any run container and any group of 5 to 4,096 ids that the rule sends to the walk, against the container merge and a set', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 5, max: 4_096 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 3 }),
        (n, gap, maxLen, g, seed, pad) => {
          const held = runList(n, Math.max(gap, maxLen + 1), maxLen, seed);
          const run = runs(held, pad);
          const lows = idsFor(held, g, seed + 1);
          if (!walksRunIds(run, lows.length)) return;
          const ids = ids32(lows);
          const got = orRunIdsWalk(run, ids, 0, ids.length);
          sameContainer(got, today(run, ids), 'fuzz');
          expect(valuesOf(got)).toEqual(sortedUnique([...held, ...lows]));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('addMany reaches the walk', () => {
  const stored = (ids: number[]) => {
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    return TsBitmap.safeDeserialize(m.serialize(), CAP);
  };

  it('a group of 1,000 sparse ids into a key of 150 runs: the union, the size, a clone left alone', () => {
    const held = runList(150, 400, 200, 11);
    const base = stored(held);
    const twin = base.clone();
    const twinBytes = Buffer.from(twin.serialize());
    const next = lcg(33);
    const more = Array.from({ length: 1_000 }, () => next() & 0xffff);
    const m = base.clone();
    m.addMany(more);
    const want = sortedUnique([...held, ...more]);
    expect(m.size).toBe(want.length);
    expect([...m]).toEqual(want);
    expect(Buffer.from(base.serialize()).equals(twinBytes)).toBe(true);
    // The same bitmap built the other way round holds the same bytes once both are optimized.
    const direct = TsBitmap.fromValues(want);
    direct.optimize();
    m.optimize();
    expect(Buffer.from(m.serialize()).equals(Buffer.from(direct.serialize()))).toBe(true);
  });

  it.each([5, 6, 4_095, 4_096, 4_097])('%i ids into runs of key 1, beside another key', (g) => {
    const held = [...runList(150, 30, 12, 5).map((l) => 65_536 + l), 7, 8, 9];
    const base = stored(held);
    const next = lcg(g);
    const more = Array.from({ length: g }, () => 65_536 + (next() & 0xffff));
    const m = base.clone();
    m.addMany([...more, 3, 4]);
    const want = sortedUnique([...held, ...more, 3, 4]);
    expect([...m]).toEqual(want);
    expect(m.size).toBe(want.length);
  });

  it('ids all inside the runs change nothing', () => {
    const held = runList(150, 30, 12, 9);
    const m = stored(held);
    const before = Buffer.from(m.serialize());
    m.addMany(held.filter((_, i) => i % 5 === 0).slice(0, 300));
    expect(m.size).toBe(held.length);
    expect(Buffer.from(m.serialize()).equals(before)).toBe(true);
  });
});
