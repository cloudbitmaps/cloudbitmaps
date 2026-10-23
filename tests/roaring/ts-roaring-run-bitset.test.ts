import { describe, expect, it } from 'vitest';
import { roaringCodec as NA } from '@/native-codec';
import { tsRoaringCodec as TS } from '@/ts-roaring/bitmap';

/**
 * A bitset container intersected with a run container: the cases either side of each branch of that kernel, each
 * compared with a plain set and with the native codec's bytes. The branches: a run container of at most 4,096 values
 * writes an array directly, a larger one builds words and counts them once; a result of at most 4,096 values is an
 * array whichever way it was built, a larger one a bitset; runs at the chunk's ends, runs that share a word, and a run
 * that covers the whole chunk.
 */
const CAP = 1 << 27;
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const sorted = (v: number[]) => [...new Set(v)].sort((x, y) => x - y);

/** A bitmap of `ids` whose container is a run container (decoded from stored runs). */
function asRuns(ids: number[]) {
  const m = TS.fromValues(ids);
  m.optimize?.();
  return TS.safeDeserialize(m.serialize(), CAP);
}

/** A bitmap of `ids`, more than 4,096 of them, so its container is a bitset. */
function asBitset(ids: number[]) {
  expect(ids.length).toBeGreaterThan(4096);
  return TS.fromValues(ids);
}

function check(bitsetIds: number[], runIds: number[], label: string) {
  const A = sorted(bitsetIds);
  const R = sorted(runIds);
  const inR = new Set(R);
  const want = A.filter((v) => inR.has(v));
  const n = NA.fromValues(A);
  n.andInPlace(NA.fromValues(R));
  n.optimize?.();
  for (const bitsetFirst of [true, false]) {
    const x = bitsetFirst ? asBitset(A) : asRuns(R);
    const y = bitsetFirst ? asRuns(R) : asBitset(A);
    x.andInPlace(y);
    expect([...x], `${label} bitsetFirst=${bitsetFirst}`).toEqual(want);
    expect(x.size, `${label} size`).toBe(want.length);
    x.optimize?.();
    expect(hex(x.serialize()), `${label} bytes`).toBe(hex(n.serialize()));
  }
}

/** Every even id of the chunk below `to`: more than 4,096 of them once `to` is above 8,192. */
const evens = (to: number) => range(0, to / 2).map((i) => i * 2);

describe('bitset and run container intersection', () => {
  it('a run container of 4,096 values and of 4,097: the array write and the word build', () => {
    const bits = evens(65536);
    check(bits, range(0, 4096), 'runs 4096');
    check(bits, range(0, 4097), 'runs 4097');
    check(bits, range(1000, 1000 + 4096), 'runs 4096 mid');
    check(bits, range(1000, 1000 + 4097), 'runs 4097 mid');
  });

  it('a result of exactly 4,096 values is an array and one of 4,097 a bitset', () => {
    const bits = range(0, 8192);
    check(bits, range(0, 4096), 'result 4096 of 8192');
    check(bits, range(0, 4097), 'result 4097 of 8192');
    check(bits, range(4096, 8192), 'result 4096, upper half');
    check(bits, [...range(0, 2048), ...range(5000, 7048)], 'two runs, 4096 together');
    check(bits, [...range(0, 2048), ...range(5000, 7049)], 'two runs, 4097 together');
  });

  it('no overlap, one value, and a result that is empty', () => {
    const bits = range(0, 5000);
    check(bits, range(10000, 10100), 'disjoint');
    check(bits, [4999], 'last value of the bitset');
    check(bits, [0], 'first value of the bitset');
    check(bits, [5000], 'one past the bitset');
    check(bits, range(6000, 6001), 'one value outside');
  });

  it('a run at each end of the chunk and a run that covers the chunk', () => {
    const bits = evens(65536);
    check(bits, range(0, 64), 'run at 0');
    check(bits, range(65536 - 64, 65536), 'run to 65535');
    check(bits, [65535], 'only 65535');
    check(bits, [65534], 'only 65534');
    check(bits, [...range(0, 100), ...range(65436, 65536)], 'both ends');
    check(bits, range(0, 65536), 'the full chunk');
    check(range(0, 65536), range(0, 65536), 'full against full');
    check(range(0, 65536), range(500, 9000), 'full bitset against one run');
  });

  it('runs that share a word, runs inside one word, and runs that start and end on word edges', () => {
    const bits = range(0, 20000);
    check(bits, [...range(3, 6), ...range(10, 13), ...range(20, 25)], 'three runs in one word');
    check(bits, [...range(0, 32), ...range(33, 64), ...range(65, 96)], 'whole words with gaps');
    check(bits, [...range(31, 33), ...range(63, 65)], 'runs across word edges');
    check(bits, range(32, 64), 'exactly one word');
    check(bits, range(31, 65), 'a word and a bit each side');
    check(
      bits,
      [...range(0, 40), ...range(41, 5000), ...range(5002, 9000)],
      'many words, many runs',
    );
  });

  it('many runs of a stored chunk against a half-full bitset, both sides of the 4,096 line', () => {
    const bits = evens(65536);
    const runs: number[] = [];
    for (let r = 0; r < 150; r++) runs.push(...range(r * 400, r * 400 + 100 + (r % 7) * 30));
    check(bits, runs, 'many runs');
    check(bits, runs.slice(0, 5000), 'many runs, 5000 values');
    check(bits, runs.slice(0, 8200), 'many runs, 8200 values');
    check(
      range(0, 65536).filter((v) => v % 3 !== 0),
      runs,
      'two thirds dense',
    );
  });
});
