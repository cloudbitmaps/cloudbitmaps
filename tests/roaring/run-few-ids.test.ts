import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RoaringBitmap32 } from 'roaring';
import { TsBitmap } from '@/ts-roaring/bitmap';
import {
  ARRAY,
  BITSET,
  Container,
  RUN,
  WORDS,
  appendIds,
  bitsetContainer,
  containerAddSorted,
  containerOr,
} from '@/ts-roaring/containers';

/**
 * A group of one to four ids written into a key's container goes in id by id, with no container built for the group:
 * a run container is edited by a search per id, a bitset has its bits set (in place unless it is shared) and an array
 * has each id inserted. The result is what the merge of two containers gives for the same ids, and the cardinality,
 * the kind by the size rule and the sharing rules hold. Held to a plain set at the container level and to CRoaring on
 * whole bitmaps.
 */
const CAP = 1 << 27;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const sortedUnique = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);

function runs(lows: readonly number[], pad = 0): Container {
  const pairs: number[] = [];
  for (let i = 0; i < lows.length;) {
    let j = i;
    while (j + 1 < lows.length && lows[j + 1] === (lows[j] as number) + 1) j++;
    pairs.push(lows[i] as number, (lows[j] as number) - (lows[i] as number));
    i = j + 1;
  }
  const data = new Uint16Array(pad + pairs.length + pad);
  data.set(pairs, pad);
  return new Container(RUN, data, pad, pairs.length / 2, lows.length, true);
}

function arrayOf(lows: readonly number[], pad = 0, shared = false): Container {
  const data = new Uint16Array(pad + lows.length + (shared ? 0 : 4));
  data.set(lows, pad);
  return new Container(ARRAY, data, pad, lows.length, lows.length, shared);
}

function bitsOf(lows: readonly number[], shared: boolean): Container {
  const words = new Uint32Array(WORDS);
  for (const v of lows) words[v >>> 5] = (words[v >>> 5] as number) | (1 << (v & 31));
  const c = bitsetContainer(words, lows.length);
  return shared ? new Container(BITSET, c.data, c.off, c.len, c.card, true) : c;
}

function valuesOf(c: Container): number[] {
  const out = new Uint32Array(c.card);
  expect(appendIds(c, out, 0, 0)).toBe(c.card);
  return Array.from(out);
}

/** The ids of one key's group: the key's high half is `hi`, the low halves `lows`, ascending, duplicates kept. */
const group = (lows: readonly number[], hi = 3): Uint32Array =>
  Uint32Array.from(lows, (l) => hi * 65_536 + l);

function ruleKind(lows: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < lows.length; i++) if (i === 0 || lows[i] !== (lows[i - 1] as number) + 1) n++;
  const plain = lows.length <= 4_096 ? 2 * lows.length : 8_192;
  return 2 + 4 * n < plain ? RUN : lows.length <= 4_096 ? ARRAY : BITSET;
}

const runShaped = fc
  .oneof(
    fc
      .array(fc.tuple(fc.integer({ min: 0, max: 65_535 }), fc.integer({ min: 1, max: 40 })), {
        minLength: 1,
        maxLength: 60,
      })
      .map((rs) => rs.flatMap(([s, n]) => range(s, Math.min(65_536, s + n)))),
    fc.constantFrom(
      range(0, 200).map((v) => v * 2),
      range(0, 200).map((v) => v * 2 + 1),
      [0, 1, 2, 65_533, 65_534, 65_535],
    ),
  )
  .map((v) => sortedUnique(v));

const fewIds = fc
  .oneof(
    fc.array(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 4 }),
    // Near the runs' own values and edges, so ids join, extend and sit inside.
    fc.array(fc.integer({ min: 0, max: 450 }), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom(0, 1, 2, 3, 65_532, 65_533, 65_534, 65_535), {
      minLength: 1,
      maxLength: 4,
    }),
  )
  .map((v) => [...v].sort((x, y) => x - y));

describe('a group of one to four ids written into a container', () => {
  it('a run container: the union, its exact cardinality, the kind by the size rule, what the merge of two containers gives', () => {
    fc.assert(
      fc.property(runShaped, fewIds, fc.integer({ min: 0, max: 3 }), (r, ids, pad) => {
        const want = sortedUnique([...r, ...ids]);
        const run = runs(r, pad);
        const before = Array.from(run.data as Uint16Array);
        const got = containerAddSorted(run, group(ids), 0, ids.length);
        expect(valuesOf(got)).toEqual(want);
        expect(got.card).toBe(want.length);
        // A container the ids add nothing to is itself, whatever its kind; one they add to is in the kind the rule gives.
        if (want.length > r.length) expect(got.kind).toBe(ruleKind(want));
        const merged = containerOr(run, arrayOf(sortedUnique(ids)), true);
        expect(got.kind).toBe(merged.kind);
        expect(valuesOf(got)).toEqual(valuesOf(merged));
        if (got.kind === RUN) expect(got.len).toBe((merged as Container).len);
        // Nothing added: the run container itself. Runs are never written in place.
        expect(got === run).toBe(want.length === r.length);
        expect(Array.from(run.data as Uint16Array)).toEqual(before);
      }),
      { numRuns: 600 },
    );
  });

  it('ids that touch, join, extend, insert, or sit inside runs, and at both ends of the chunk', () => {
    const base = [...range(10, 20), ...range(30, 40), ...range(65_526, 65_536)];
    const cases: Array<[string, number[]]> = [
      ['inside a run', [15]],
      ['already everything', [10, 19, 30, 39]],
      ['extends a run at its end', [20]],
      ['extends a run at its start', [9]],
      ['joins two runs', [20, 21, 22, 23].slice(0, 1).concat([29])],
      ['joins two runs with one id each side', [20, 29]],
      ['bridges a gap of one', [20, 21, 28, 29]],
      ['a new run before the first', [3]],
      ['between runs', [25]],
      ['value 0', [0]],
      ['value 65,535 is present', [65_535]],
      ['a new run after the last', [65_520]],
      ['four apart', [1, 25, 45, 65_000]],
      ['the same id twice', [25, 25]],
    ];
    for (const [label, add] of cases) {
      const ids = [...add].sort((a, b) => a - b);
      const want = sortedUnique([...base, ...ids]);
      const got = containerAddSorted(runs(base, 2), group(ids), 0, ids.length);
      expect(valuesOf(got), label).toEqual(want);
      expect(got.card, label).toBe(want.length);
      expect(got.kind, label).toBe(ruleKind(want));
    }
    const first = containerAddSorted(runs([1, 2, 3]), group([0]), 0, 1);
    expect(valuesOf(first)).toEqual([0, 1, 2, 3]);
    expect(first.len).toBe(1);
  });

  it('a result that leaves the run form: an array when runs are many and short, a bitset past 4,096 values', () => {
    const sparse = range(0, 100).map((i) => i * 5);
    const toArray = containerAddSorted(runs(sparse), group([7, 8]), 0, 2);
    expect(toArray.kind).toBe(ARRAY);
    expect(valuesOf(toArray)).toEqual(sortedUnique([...sparse, 7, 8]));
    // 2,046 runs of 3 values are a run body of 8,186 bytes; two isolated ids more make 8,194 against 8,192.
    const dense = range(0, 2_046).flatMap((i) => [i * 10, i * 10 + 1, i * 10 + 2]);
    expect(containerAddSorted(runs(dense), group([30_000]), 0, 1).kind).toBe(RUN);
    const two = containerAddSorted(runs(dense), group([30_000, 30_010]), 0, 2);
    expect(two.kind).toBe(BITSET);
    expect(valuesOf(two)).toEqual(sortedUnique([...dense, 30_000, 30_010]));
  });

  it.each([
    ['an array', (l: number[]) => arrayOf(l)],
    ['an array that is shared', (l: number[]) => arrayOf(l, 0, true)],
    ['an array at a slab offset', (l: number[]) => arrayOf(l, 3)],
    ['a bitset', (l: number[]) => bitsOf(l, false)],
    ['a bitset that is shared', (l: number[]) => bitsOf(l, true)],
  ])('%s: the union and cardinality, and a shared container is never written', (_name, make) => {
    const shared = _name.includes('shared');
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 300 }),
        fewIds,
        (held, ids) => {
          const have = sortedUnique(held);
          const c = make(have);
          const dataBefore = Array.from(c.data as Uint16Array | Uint32Array);
          const want = sortedUnique([...have, ...ids]);
          const got = containerAddSorted(c, group(ids), 0, ids.length);
          expect(valuesOf(got)).toEqual(want);
          expect(got.card).toBe(want.length);
          if (want.length === have.length) expect(got).toBe(c);
          if (shared) expect(Array.from(c.data as Uint16Array | Uint32Array)).toEqual(dataBefore);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('an array at 4,096 values becomes a bitset on the id that makes 4,097', () => {
    const full = range(0, 4_096).map((v) => v * 2);
    const got = containerAddSorted(arrayOf(full), group([1, 3]), 0, 2);
    expect(got.kind).toBe(BITSET);
    expect(valuesOf(got)).toEqual(sortedUnique([...full, 1, 3]));
    expect(containerAddSorted(arrayOf(full), group([8_192]), 0, 1).kind).toBe(BITSET);
  });

  it('works on a window of a longer ascending list: only ids[from, to) are added', () => {
    const ids = Uint32Array.of(1, 9, 3 * 65_536 + 5, 3 * 65_536 + 6, 3 * 65_536 + 7, 4 * 65_536);
    const got = containerAddSorted(runs([100, 101]), ids, 2, 5);
    expect(valuesOf(got)).toEqual([5, 6, 7, 100, 101]);
  });
});

describe('addMany with one to four ids a key, into containers of every kind', () => {
  const stored = (ids: number[]) => {
    const m = TsBitmap.fromValues(ids);
    m.optimize();
    return TsBitmap.safeDeserialize(m.serialize(), CAP);
  };
  const base = [
    ...range(0, 200).flatMap((i) => range(i * 300, i * 300 + 120)), // key 0: runs
    ...range(65_536 + 5, 65_536 + 600).filter((v) => v % 3 !== 0), // key 1: an array
    ...range(2 * 65_536, 2 * 65_536 + 30_000).filter((v) => v % 5 !== 0), // key 2: a bitset
    ...range(4 * 65_536, 4 * 65_536 + 50_000), // key 4: one run
  ];

  it('a write of a few ids a key agrees with CRoaring, bytes included, and leaves a clone alone', () => {
    const template = stored(base);
    const templateBytes = Buffer.from(template.serialize());
    const nativeTemplate = new RoaringBitmap32(base);
    nativeTemplate.runOptimize();
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 6 }),
            fc.array(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 4 }),
          ),
          { minLength: 1, maxLength: 7 },
        ),
        fc.boolean(),
        (groups, scramble) => {
          const ids = groups.flatMap(([hi, lows]) => lows.map((l) => hi * 65_536 + l));
          const input = scramble ? ids.reverse() : ids;
          const m = template.clone();
          const twin = m.clone();
          m.addMany(input);
          const native = nativeTemplate.clone();
          native.addMany(input);
          expect(m.size).toBe(native.size);
          m.optimize();
          native.runOptimize();
          expect(Buffer.from(m.serialize()).equals(Buffer.from(native.serialize(true)))).toBe(true);
          expect(twin.size).toBe(base.length);
          expect(Buffer.from(twin.serialize()).equals(templateBytes)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('a bitmap built of ids, and a large group beside a small one, still agree with CRoaring', () => {
    const big = range(0, 40).map((v) => 5 * 65_536 + v * 3);
    const small = [9, 65_536 + 9, 2 * 65_536 + 9];
    const m = stored(base);
    m.addMany([...small, ...big]);
    const native = new RoaringBitmap32(base);
    native.addMany([...small, ...big]);
    expect([...m]).toEqual(native.toArray());
    expect(m.size).toBe(native.size);
  });

  it('ids already present change nothing, size included', () => {
    const m = stored(base);
    const before = Buffer.from(m.serialize());
    m.addMany([5, 65_536 + 5 + 1, 4 * 65_536 + 7, 4 * 65_536 + 8]);
    expect(m.size).toBe(base.length);
    expect(Buffer.from(m.serialize()).equals(before)).toBe(true);
  });
});
