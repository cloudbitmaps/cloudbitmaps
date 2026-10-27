import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ARRAY,
  RUN,
  containerOr,
  expandsRunArray,
  fromSortedIds,
  optimize,
} from '../../packages/roaring/src/ts-roaring/containers';

/**
 * The data sets the paired bench times the store's union on (`bench/lib/codec-data.cjs`): `runsarray`, run chunks
 * with array chunks of 1,000 ids, and `runs1k`, chunks of 1,200 runs with array chunks of 1,500 ids. The shapes are what
 * the cells claim they are, the union of each takes the way the cell says it does, and the earlier data sets are the same
 * ids they were. Nothing here times anything.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const data = require_('./lib/codec-data.cjs') as {
  idsOf: (dataset: string, which: number, scale: Record<string, number>) => number[];
};

/** The ids of one chunk (key `key`) of a list of ids, as low halves. */
const lowsOfKey = (ids: number[], key: number): number[] =>
  ids.filter((id) => Math.floor(id / 65_536) === key).map((id) => id % 65_536);

/** The runs of an ascending list of values: [start, length] pairs. */
function runsOfLows(lows: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const v of lows) {
    const last = out.at(-1);
    if (last !== undefined && last[0] + last[1] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}

const SCALE = { runsarray: 4, runs1k: 4 };

describe('the data set runs1k', () => {
  const a = data.idsOf('runs1k', 0, SCALE);
  const b = data.idsOf('runs1k', 1, SCALE);

  it('holds 1,200 runs of 2 to 30 values, 20 to 30 apart, in every chunk of segment 0', () => {
    for (let chunk = 0; chunk < SCALE.runs1k; chunk++) {
      const runs = runsOfLows(lowsOfKey(a, chunk * 3));
      expect(runs).toHaveLength(1_200);
      for (const [, length] of runs) {
        expect(length).toBeGreaterThanOrEqual(2);
        expect(length).toBeLessThanOrEqual(30);
      }
      for (let i = 1; i < runs.length; i++) {
        const gap =
          (runs[i] as [number, number])[0] -
          ((runs[i - 1] as [number, number])[0] + (runs[i - 1] as [number, number])[1]);
        expect(gap).toBeGreaterThanOrEqual(20);
        expect(gap).toBeLessThanOrEqual(30);
      }
      const card = runs.reduce((n, [, length]) => n + length, 0);
      expect(card).toBeGreaterThan(17_000);
      expect(card).toBeLessThan(21_000);
    }
  });

  it('holds 1,500 ids in every chunk of every other segment, on the same chunk keys', () => {
    for (let chunk = 0; chunk < SCALE.runs1k; chunk++) {
      expect(lowsOfKey(b, chunk * 3)).toHaveLength(1_500);
      expect(lowsOfKey(a, chunk * 3).length).toBeGreaterThan(0);
    }
    expect(new Set(a.map((id) => Math.floor(id / 65_536)))).toEqual(
      new Set(b.map((id) => Math.floor(id / 65_536))),
    );
  });

  it('is the same ids every time', () => {
    expect(data.idsOf('runs1k', 0, SCALE)).toEqual(a);
    expect(data.idsOf('runs1k', 2, SCALE)).not.toEqual(b);
  });

  it('a chunk of it is a run container, its partner an array, and their union is the expansion path', () => {
    const run = optimize(
      fromSortedIds(Uint32Array.from(lowsOfKey(a, 0)), 0, lowsOfKey(a, 0).length),
    );
    const arr = fromSortedIds(Uint32Array.from(lowsOfKey(b, 0)), 0, 1_500);
    expect(run.kind).toBe(RUN);
    expect(run.len).toBe(1_200);
    expect(arr.kind).toBe(ARRAY);
    expect(expandsRunArray(run, arr)).toBe(true);
    expect(containerOr(run, arr, false).card).toBeGreaterThan(run.card);
  });
});

describe('the data set runsarray', () => {
  const a = data.idsOf('runsarray', 0, SCALE);
  const b = data.idsOf('runsarray', 1, SCALE);

  it('holds the run chunks of `runs` in segment 0 and 1,000 ids a chunk in the others', () => {
    for (let chunk = 0; chunk < SCALE.runsarray; chunk++) {
      const runs = runsOfLows(lowsOfKey(a, chunk * 3));
      expect(runs.length).toBeGreaterThan(100);
      expect(runs.length).toBeLessThanOrEqual(150);
      expect(lowsOfKey(b, chunk * 3)).toHaveLength(1_000);
    }
  });

  it('a chunk of it is a run container and an array whose union stays on the merge walk and stays a run container', () => {
    const run = optimize(
      fromSortedIds(Uint32Array.from(lowsOfKey(a, 0)), 0, lowsOfKey(a, 0).length),
    );
    const arr = fromSortedIds(Uint32Array.from(lowsOfKey(b, 0)), 0, 1_000);
    expect(run.kind).toBe(RUN);
    expect(arr.kind).toBe(ARRAY);
    expect(expandsRunArray(run, arr)).toBe(false);
    expect(containerOr(run, arr, false).kind).toBe(RUN);
  });
});

describe('the earlier data sets', () => {
  const EXPECTED: Record<string, string> = {
    'dense/0': '65536:6be21604421e',
    'dense/1': '65536:bbc5a17cedbb',
    'sparse/0': '3000:dbdc17480311',
    'sparse/3': '3000:b3b368288d2d',
    'runs/0': '91184:788f5c0ad3b5',
    'runs/2': '89699:a8a49bcc9999',
    'mixed/0': '128692:af28d83661cd',
    'mixed/3': '130309:271730a50a2e',
    'spread8k/0': '320:8cd5e860b702',
    'spread8k/1': '320:1b7237059ee3',
  };
  const chunks: Record<string, number> = { dense: 2, sparse: 3, runs: 3, mixed: 6, spread8k: 20 };

  it.each(Object.entries(EXPECTED))('%s is the ids it was: %s', (name, want) => {
    const [dataset, which] = name.split('/') as [string, string];
    const ids = data.idsOf(dataset, Number(which), { [dataset]: chunks[dataset] as number });
    const digest = createHash('sha256')
      .update(Buffer.from(Uint32Array.from(ids).buffer))
      .digest('hex')
      .slice(0, 12);
    expect(`${ids.length}:${digest}`).toBe(want);
  });
});
