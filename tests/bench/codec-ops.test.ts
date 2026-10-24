import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CodecBitmap, CodecInterface } from '@cloudbitmaps/core';
import { tsRoaringCodec } from '../../packages/roaring/src/ts-roaring/bitmap';
import { roaringCodec } from '../helpers/native-codec';

/**
 * The per-operation cells of the paired bench (`bench/lib/codec-ops.cjs`): the cells the design names exist, the cold
 * decode is a cell of its own, and every cell gives the same answer on the TypeScript codec and the native one, which
 * is how a harness knows two subjects ran the same work. Nothing here times a comparison.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));

type Cell = {
  name: string;
  unit: number;
  cold: boolean;
  make: (codec: CodecInterface) => () => unknown;
};
const ops = require_('./lib/codec-ops.cjs') as {
  storedBytesOf: (native: CodecInterface) => Record<string, Uint8Array>;
  storedBytesToJson: (bytes: Record<string, Uint8Array>) => string;
  storedBytesFromJson: (text: string) => Record<string, Uint8Array>;
  opCells: (bytes: Record<string, Uint8Array>) => Cell[];
  digest: (value: unknown) => string;
  measureSteady: (
    fn: () => unknown,
    unit?: number,
    o?: { warmMs?: number; sampleMs?: number },
  ) => number;
  measureCold: (fn: () => unknown) => number;
};

const bytes = ops.storedBytesOf(roaringCodec);
const cells = ops.opCells(bytes);
const names = cells.map((c) => c.name);

describe('the per-operation cells', () => {
  it('name every operation the design lists, on every shape that has it', () => {
    const shapes = ['dense', 'sparse', 'run'];
    const want: string[] = [];
    for (const s of [...shapes, 'many']) {
      for (const op of ['has', 'decode', 'decode first', 'serialize', 'iterate', 'toUint32'])
        want.push(`${op} ${s}`);
    }
    for (const s of shapes) {
      for (const op of ['optimize', 'count', 'clone', 'build', 'addMany', 'removeMany'])
        want.push(`${op} ${s}`);
    }
    for (const pair of [
      'dense/dense',
      'sparse/sparse',
      'run/run',
      'sparse/dense',
      'run/dense',
      'skew 64/4000',
    ]) {
      for (const op of ['and', 'or', 'andNot']) want.push(`${op} ${pair}`);
    }
    expect(names.slice().sort()).toEqual(want.sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('has the cold decode as a cell of its own for each shape, and no other cold cell', () => {
    const cold = cells.filter((c) => c.cold).map((c) => c.name);
    expect(cold.sort()).toEqual([
      'decode first dense',
      'decode first many',
      'decode first run',
      'decode first sparse',
    ]);
  });

  it('reports a probe loop per read: has and count stand for 256 reads', () => {
    for (const c of cells) {
      expect(c.unit, c.name).toBe(/^(has|count) /.test(c.name) ? 256 : 1);
    }
  });

  it('gives the same answer on the TypeScript codec and the native one, for every cell', () => {
    for (const c of cells) {
      const ts = ops.digest(c.make(tsRoaringCodec)());
      const native = ops.digest(c.make(roaringCodec)());
      expect(ts, c.name).toBe(native);
    }
  });

  it('decodes the stored bytes the cold cell is timed on: the many-container bitmap is the one it should be', () => {
    const bitmap = cells
      .find((c) => c.name === 'decode first many')!
      .make(tsRoaringCodec)() as CodecBitmap;
    const direct = tsRoaringCodec.safeDeserialize(bytes.many!, 1 << 26) as CodecBitmap;
    expect(bitmap.size).toBe(direct.size);
    expect(bitmap.size).toBeGreaterThan(100_000);
  });

  it('answers differently for different work, so a disagreeing subject would be caught', () => {
    const dense = cells.find((c) => c.name === 'decode dense')!.make(tsRoaringCodec)();
    const sparse = cells.find((c) => c.name === 'decode sparse')!.make(tsRoaringCodec)();
    expect(ops.digest(dense)).not.toBe(ops.digest(sparse));
    expect(ops.digest(new Uint8Array([1, 2, 3]))).not.toBe(ops.digest(new Uint8Array([1, 2, 4])));
    expect(ops.digest(7)).toBe('7');
  });

  it('round-trips its stored bytes through the text a child process reads', () => {
    const back = ops.storedBytesFromJson(ops.storedBytesToJson(bytes));
    expect(Object.keys(back).sort()).toEqual(Object.keys(bytes).sort());
    for (const k of Object.keys(bytes))
      expect(Buffer.from(back[k]!).equals(Buffer.from(bytes[k]!)), k).toBe(true);
  });

  it('times a call: a figure per operation for a warmed one and a figure for a first call', () => {
    let calls = 0;
    const steady = ops.measureSteady(() => ++calls, 4, { warmMs: 0, sampleMs: 0 });
    expect(Number.isFinite(steady) && steady >= 0).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    let first = 0;
    const cold = ops.measureCold(() => ++first);
    expect(first).toBe(1);
    expect(cold).toBeGreaterThanOrEqual(0);
  });
});
