import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import roaring from 'roaring';
import { RoaringBitmap } from '@/index';
import { TsBitmap, tsRoaringCodec } from '@/ts-roaring/bitmap';

/**
 * The cells of the public bitmap class's bench (`bench/lib/bitmap-api-cells.cjs`) on the three subjects it compares, at
 * the tiny scale of `--check`: every cell that a subject runs gives the same answer on every subject, the cells are the
 * ones the design lists, and each is on the subjects it should be. The class is the one in this tree's source, and the
 * bench itself imports the built package. Nothing here times anything a bound reads.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Api = {
  name: string;
  deserialize: (b: Uint8Array) => unknown;
  combine: (op: string, a: unknown, b: unknown) => unknown;
  toUint32: (b: unknown) => Uint32Array;
  intersects: (a: unknown, b: unknown) => boolean;
};
type Cell = { name: string; method: string; group: string; who: string[] };
const lib = require_('./lib/bitmap-api-cells.cjs') as {
  DATASETS: string[];
  nativeApi: (m: unknown) => Api;
  oursApi: (c: unknown) => Api;
  internalApi: (c: unknown) => Api;
  storedBytesOf: (m: unknown, small: boolean) => Record<string, Uint8Array>;
  dataOf: (dataset: string, small: boolean, bytes: Record<string, Uint8Array>) => unknown;
  cellsOf: (data: unknown) => Cell[];
  coldCellsOf: (data: unknown) => Cell[];
  runsOn: (cell: Cell, api: Api) => boolean;
  timeCell: (
    cell: Cell,
    api: Api,
    o: { warmMs: number; sampleMs: number },
  ) => { ns: number; answer: string };
  timeCold: (cell: Cell, api: Api) => { ns: number; answer: string };
  coldProcessesOf: (small: boolean) => number;
  oneColdSample: (outputs: Array<{ ns: number; cpuNs: number; answer: string }>) => {
    ns: number;
    cpuNs: number;
    answer: string;
  };
  sleptProcesses: (outputs: Array<{ ns: number; cpuNs: number }>) => boolean[];
  takeColdSample: (
    spawn: () => { ns: number; cpuNs: number; answer: string },
    processes: number,
  ) => { sample: { ns: number; cpuNs: number; answer: string }; slept: number };
  bytesToJson: (b: Record<string, Uint8Array>) => string;
  bytesFromJson: (t: string) => Record<string, Uint8Array>;
  digest: (api: Api, value: unknown) => string;
  inventory: () => {
    datasets: string[];
    steady: Array<{ op: string; internal: boolean }>;
    cold: Array<{ op: string }>;
    load: string[];
  };
};

const apis = () => [
  lib.nativeApi(roaring),
  lib.oursApi(RoaringBitmap),
  lib.internalApi(tsRoaringCodec),
];
const bytes = lib.storedBytesOf(roaring, true);

describe('the stored bytes', () => {
  it('round-trip through the text a child reads, for every data set and both operands', () => {
    const back = lib.bytesFromJson(lib.bytesToJson(bytes));
    expect(Object.keys(back).sort()).toEqual(Object.keys(bytes).sort());
    expect(Object.keys(bytes)).toHaveLength(lib.DATASETS.length * 2);
    for (const k of Object.keys(bytes)) expect([...back[k]!]).toEqual([...bytes[k]!]);
  });
});

describe('the cells', () => {
  const names = lib.cellsOf({ some: [], small: true }).map((c) => c.name);

  it('are the ones the design lists, count cells included', () => {
    for (const want of [
      'build array',
      'build Uint32Array',
      'build addMany',
      'build add per id',
      'has',
      'and returning',
      'or returning',
      'xor returning',
      'andNot returning',
      'and in place',
      'or in place',
      'xor in place',
      'andNot in place',
      'write after or',
      'write after xor',
      'write after andNot',
      'serialize',
      'deserialize',
      'runOptimize',
      'iterate',
      'toUint32Array',
      'toArray',
      'orMany 8',
      'orMany 64',
      'clone',
      'clone then write',
      'andCardinality',
      'orCardinality',
      'isSubset',
      'isEqual',
      'intersects overlapping',
      'intersects disjoint',
    ]) {
      expect(names, want).toContain(want);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('run on the subjects that have a counterpart: no codec figure for xorInPlace or orMany', () => {
    const [native, ours, internal] = apis() as [Api, Api, Api];
    const cells = lib.cellsOf({ some: [], small: true });
    const at = (n: string) => cells.find((c) => c.name === n)!;
    expect(lib.runsOn(at('xor in place'), native)).toBe(true);
    expect(lib.runsOn(at('xor in place'), ours)).toBe(true);
    expect(lib.runsOn(at('xor in place'), internal)).toBe(false);
    expect(lib.runsOn(at('orMany 8'), internal)).toBe(false);
    expect(lib.runsOn(at('orMany 8'), ours)).toBe(true);
    expect(lib.runsOn(at('has'), internal)).toBe(true);
    // The codec runs the two counts as build-then-count, and has no counterpart for the rest.
    expect(lib.runsOn(at('andCardinality'), internal)).toBe(true);
    expect(lib.runsOn(at('orCardinality'), internal)).toBe(true);
    for (const n of ['isSubset', 'isEqual', 'intersects overlapping', 'intersects disjoint']) {
      expect(lib.runsOn(at(n), native), n).toBe(true);
      expect(lib.runsOn(at(n), ours), n).toBe(true);
      expect(lib.runsOn(at(n), internal), n).toBe(false);
    }
  });

  for (const dataset of lib.DATASETS) {
    // Budget 10 s per dataset. Measured: 1.1 to 1.6 s on a developer machine, up to 3.3 s on the release job's runner in a
    // single full run; the budget is three times the slower figure.
    it(`give one answer on every subject, on ${dataset}`, () => {
      const data = lib.dataOf(dataset, true, bytes);
      const answers = new Map<string, Map<string, string>>();
      for (const api of apis()) {
        for (const cell of lib.cellsOf(data)) {
          if (!lib.runsOn(cell, api)) continue;
          const got = lib.timeCell(cell, api, { warmMs: 0, sampleMs: 0 });
          expect(got.ns, `${api.name} ${cell.name}`).toBeGreaterThan(0);
          const per = answers.get(cell.name) ?? new Map<string, string>();
          per.set(api.name, got.answer);
          answers.set(cell.name, per);
        }
      }
      expect(answers.size).toBe(names.length);
      // The two comparisons are the full-scan case: both answer true, so neither can end at its first element.
      for (const n of ['isSubset', 'isEqual'])
        expect([...answers.get(n)!.values()], n).toEqual(['true', 'true']);
      // `intersects` has both cases: the stored pair meets at its first shared container, the disjoint pair never.
      expect([...answers.get('intersects overlapping')!.values()]).toEqual(['true', 'true']);
      expect([...answers.get('intersects disjoint')!.values()]).toEqual(['false', 'false']);
      for (const [cell, per] of answers) {
        expect(new Set(per.values()).size, `${dataset} ${cell}: ${JSON.stringify([...per])}`).toBe(
          1,
        );
      }
    }, 10_000);
  }

  it('compare a serialization as bytes: every subject writes the same bytes, and a different byte is a different answer', () => {
    const [native, ours, internal] = apis() as [Api, Api, Api];
    for (const dataset of lib.DATASETS) {
      const data = lib.dataOf(dataset, true, bytes);
      const cell = lib.cellsOf(data).find((c) => c.name === 'serialize')!;
      const answers = [native, ours, internal].map(
        (api) => lib.timeCell(cell, api, { warmMs: 0, sampleMs: 0 }).answer,
      );
      expect(new Set(answers).size, dataset).toBe(1);
    }
    const one = new Uint8Array([1, 2, 3, 4]);
    const other = new Uint8Array([1, 2, 3, 5]);
    expect(lib.digest(native, one)).toBe(lib.digest(ours, new Uint8Array([1, 2, 3, 4])));
    expect(lib.digest(native, one)).not.toBe(lib.digest(native, other));
    expect(lib.digest(native, one)).not.toBe(lib.digest(native, new Uint8Array([1, 2, 3])));
  });

  it('hold a disjoint pair that is not trivial: the second without the first is non-empty and shares its container keys', () => {
    const [native] = apis() as [Api];
    for (const dataset of lib.DATASETS) {
      const a = native.deserialize(bytes[`${dataset} a`]!);
      const b = native.deserialize(bytes[`${dataset} b`]!);
      const apart = native.combine('andNot', b, a);
      expect(native.toUint32(apart).length, dataset).toBeGreaterThan(0);
      expect(native.intersects(a, apart), dataset).toBe(false);
      expect(native.intersects(a, b), dataset).toBe(true);
      const keys = (x: unknown) => new Set([...native.toUint32(x)].map((v) => v >>> 16));
      const shared = [...keys(apart)].filter((k) => keys(a).has(k));
      expect(shared.length, dataset).toBeGreaterThan(0);
    }
  });

  it('list every cell of the full run once, with the codec figure where the codec has a counterpart', () => {
    const inv = lib.inventory();
    expect(inv.steady.map((c) => c.op)).toEqual(names);
    expect(inv.steady.find((c) => c.op === 'xor in place')!.internal).toBe(false);
    expect(inv.steady.find((c) => c.op === 'andCardinality')!.internal).toBe(true);
    expect(inv.steady.find((c) => c.op === 'isSubset')!.internal).toBe(false);
    expect(inv.cold.map((c) => c.op)).toEqual(['first deserialize', 'first build', 'first and']);
    expect(inv.datasets).toEqual(lib.DATASETS);
    expect(inv.load).toEqual(lib.DATASETS);
  });

  it('give one answer for the cold cells on every subject', () => {
    const data = lib.dataOf('mixed', true, bytes);
    for (const cell of lib.coldCellsOf(data)) {
      const answers = apis().map((api) => lib.timeCold(cell, api).answer);
      expect(new Set(answers).size, cell.name).toBe(1);
    }
  });
});

describe('the codec subject decodes detached', () => {
  it('asks the codec for a detached decode, as the public class does, and still decodes the bytes', () => {
    const asked: unknown[] = [];
    const api = lib.internalApi({
      safeDeserialize: (input: Uint8Array, cap: number, options: unknown) => {
        asked.push(options);
        return TsBitmap.safeDeserialize(input, cap, options as { detached: boolean });
      },
    } as never);
    const input = bytes['mixed a'] as Uint8Array;
    const decoded = api.deserialize(input) as { size: number };
    expect(asked).toEqual([{ detached: true }]);
    expect(decoded.size).toBe(TsBitmap.safeDeserialize(input, 1 << 27).size);
  });
});

describe('the cold cells in several fresh processes', () => {
  it('take one process in a tiny-scale run and five at full scale', () => {
    expect(lib.coldProcessesOf(true)).toBe(1);
    expect(lib.coldProcessesOf(false)).toBe(5);
  });

  it('one sample is the median of the processes, with an even count averaged, and one process is itself', () => {
    const o = (ns: number, cpuNs: number, answer = 'x') => ({ ns, cpuNs, answer });
    expect(lib.oneColdSample([o(7, 3)])).toEqual(o(7, 3));
    expect(lib.oneColdSample([o(9, 1), o(1, 9), o(5, 5), o(100, 2), o(2, 4)])).toEqual(o(5, 4));
    expect(lib.oneColdSample([o(4, 8), o(2, 2)])).toEqual(o(3, 5));
    expect(() => lib.oneColdSample([])).toThrow(RangeError);
  });

  it('keeps a disagreement between processes visible in the answer', () => {
    const o = (answer: string) => ({ ns: 1, cpuNs: 1, answer });
    expect(lib.oneColdSample([o('a'), o('a')]).answer).toBe('a');
    expect(lib.oneColdSample([o('a'), o('b'), o('a')]).answer).toBe('a|b|a');
  });
});

describe('the sleep rule on each process of a cold sample', () => {
  const o = (ns: number, cpuNs: number, answer = 'x') => ({ ns, cpuNs, answer });
  const awake = o(1_000, 900);

  it('calls a process slept only when it is over 100 times the sample median and under half on CPU', () => {
    const five = (slow: { ns: number; cpuNs: number }) => [awake, awake, awake, awake, slow];
    expect(lib.sleptProcesses(five(o(100_001, 40_000)))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    // Exactly 100 times, or half on CPU or more: awake. A slow process that burned CPU is slow, not asleep.
    expect(lib.sleptProcesses(five(o(100_000, 40_000)))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(lib.sleptProcesses(five(o(100_001, 50_001)))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(lib.sleptProcesses(five(o(100_001, 99_999)))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('has no median to judge one or two processes by', () => {
    expect(lib.sleptProcesses([o(1e9, 1)])).toEqual([false]);
    expect(lib.sleptProcesses([awake, o(1e9, 1)])).toEqual([false, false]);
  });

  it('sets a slept process aside before the median and runs another in its place', () => {
    const queue = [awake, awake, awake, awake, o(5e8, 10), o(1_200, 1_000)];
    let spawned = 0;
    const taken = lib.takeColdSample(() => queue[spawned++]!, 5);
    expect(spawned).toBe(6);
    expect(taken.slept).toBe(1);
    // The slept figure is in no median: four of 1,000 and one of 1,200 give 1,000, not the 5e8 or a mean with it.
    expect(taken.sample.ns).toBe(1_000);
  });

  it('takes five processes and no more when none slept', () => {
    let spawned = 0;
    const taken = lib.takeColdSample(() => (spawned++, awake), 5);
    expect(spawned).toBe(5);
    expect(taken.slept).toBe(0);
  });

  it('takes one process in a tiny-scale run and judges none of it', () => {
    let spawned = 0;
    const taken = lib.takeColdSample(() => (spawned++, o(1e9, 1)), 1);
    expect(spawned).toBe(1);
    expect(taken.slept).toBe(0);
  });

  it('stops the run when more processes slept than one sample holds', () => {
    let spawned = 0;
    const spawn = () => (spawned++ < 3 ? awake : o(5e8, 10));
    expect(() => lib.takeColdSample(spawn, 5)).toThrow(RangeError);
  });
});
