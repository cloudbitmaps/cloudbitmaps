import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import roaring from 'roaring';
import { RoaringBitmap } from '@/index';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';

/**
 * The cells of the public bitmap class's bench (`bench/lib/bitmap-api-cells.cjs`) on the three subjects it compares, at
 * the tiny scale of `--check`: every cell that a subject runs gives the same answer on every subject, the cells are the
 * ones the design lists, and each is on the subjects it should be. The class is the one in this tree's source, and the
 * bench itself imports the built package. Nothing here times anything a bound reads.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Api = { name: string };
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
  bytesToJson: (b: Record<string, Uint8Array>) => string;
  bytesFromJson: (t: string) => Record<string, Uint8Array>;
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
      'intersects',
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
    for (const n of ['isSubset', 'isEqual', 'intersects']) {
      expect(lib.runsOn(at(n), native), n).toBe(true);
      expect(lib.runsOn(at(n), ours), n).toBe(true);
      expect(lib.runsOn(at(n), internal), n).toBe(false);
    }
  });

  for (const dataset of lib.DATASETS) {
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
      for (const [cell, per] of answers) {
        expect(new Set(per.values()).size, `${dataset} ${cell}: ${JSON.stringify([...per])}`).toBe(
          1,
        );
      }
    });
  }

  it('give one answer for the cold cells on every subject', () => {
    const data = lib.dataOf('mixed', true, bytes);
    for (const cell of lib.coldCellsOf(data)) {
      const answers = apis().map((api) => lib.timeCold(cell, api).answer);
      expect(new Set(answers).size, cell.name).toBe(1);
    }
  });
});
