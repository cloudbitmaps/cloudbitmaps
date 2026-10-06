import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/core/errors';
import { compileCombineMany } from '@/core/combine-many';
import { joinId } from '@/core/bit-route';
import {
  collecting,
  nativeOutput,
  request,
  runBatch,
  seed,
  toNative,
} from '../helpers/combine-many';
import type { Published } from '../helpers/combine-many';

const ids = (chunks: readonly number[], per = 3): number[] =>
  chunks.flatMap((c) => Array.from({ length: per }, (_, i) => joinId(c, i + 1)));

describe('a batch over stored operands', () => {
  it('computes each output the way native Roaring does', async () => {
    const sets = { a: ids([1, 2, 3, 4]), b: ids([2, 3, 4, 9]), c: ids([3, 4, 7]) };
    const specs = [
      { expr: { and: ['a', 'b'] } },
      { expr: { or: ['a', 'c'] } },
      { expr: { andNot: ['a', 'c'] } },
      { expr: { and: ['a', { or: ['b', 'c'] }] }, exclude: ['c'] },
      { expr: 'b' },
    ];
    const { run } = await runBatch(sets, specs);
    const native = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, toNative(v)]));
    run.outputs.forEach((out, i) => {
      expect(out.ok).toBe(true);
      const got = (out as { value: Published }).value;
      expect(got.ids).toEqual(nativeOutput(specs[i]!, native).toArray());
    });
  });

  it('reads each operand chunk once for a group of outputs that share it', async () => {
    const sets = { a: ids([1, 2, 3]), b: ids([1, 2, 3]) };
    const specs = Array.from({ length: 20 }, () => ({ expr: { and: ['a', 'b'] } }));
    const { run, setup } = await runBatch(sets, specs);
    expect(run.stats.groups).toBe(1);
    expect(setup.source.opened.map((s) => s.segment).sort()).toEqual(['a', 'b']);
    expect(run.stats.requests.chunkReads).toBe(6);
  });
});

describe('validation, before any request', () => {
  const sets = { a: ids([1]), b: ids([1]) };
  const compile = (outputs: Parameters<typeof collecting>[0][], extra = {}) => {
    const setup = seed(sets);
    return () => compileCombineMany(request(setup, outputs.map(collecting), extra));
  };
  it.each([
    [
      'an unknown operand name',
      [{ expr: 'zzz' }],
      /outputs\[0\]\.expr: "zzz" does not name an operand/,
    ],
    ['a node with two operators', [{ expr: { and: ['a'], or: ['b'] } as never }], /exactly one of/],
    [
      'an empty list',
      [{ expr: { and: [] } }],
      /outputs\[0\]\.expr\.and: must be a non-empty array/,
    ],
    ['andNot with one entry', [{ expr: { andNot: ['a'] } }], /needs at least two/],
    ['a non-array operator value', [{ expr: { or: 'a' as never } }], /non-empty array/],
    ['a number', [{ expr: 5 as never }], /operand name or an object/],
    ['a bad exclude', [{ expr: 'a', exclude: ['nope'] }], /outputs\[0\]\.exclude\[0\]/],
  ])('refuses %s', (_name, outputs, message) => {
    expect(compile(outputs as never)).toThrow(ValidationError);
    expect(compile(outputs as never)).toThrow(message);
  });

  it('refuses a tree deeper than 64 and one that contains itself', () => {
    let deep: unknown = 'a';
    for (let i = 0; i < 65; i++) deep = { and: [deep] };
    expect(compile([{ expr: deep as never }])).toThrow(/more than 64 operators deep/);
    let ok: unknown = 'a';
    for (let i = 0; i < 64; i++) ok = { and: [ok] };
    expect(compile([{ expr: ok as never }])).not.toThrow();
    const loop: { and: unknown[] } = { and: [] };
    loop.and.push(loop);
    expect(compile([{ expr: loop as never }])).toThrow(/more than 64 operators deep/);
  });

  it('refuses a shared sub-object that would expand past the node cap', () => {
    let shared: unknown = 'a';
    for (let i = 0; i < 20; i++) shared = { and: [shared, shared] };
    expect(compile([{ expr: shared as never }])).toThrow(/more than 4096 nodes/);
  });

  it('refuses no outputs, and bad numbers', () => {
    expect(compile([])).toThrow(/outputs must be a non-empty array/);
    expect(compile([{ expr: 'a' }], { keep: undefined })).toThrow(
      /keep must be a non-negative integer/,
    );
    expect(compile([{ expr: 'a' }], { keep: -1 })).toThrow(/keep/);
    expect(compile([{ expr: 'a', keep: 1.5 }])).toThrow(/outputs\[0\]\.keep/);
    expect(compile([{ expr: 'a' }], { maxBufferedBytes: 0 })).toThrow(/maxBufferedBytes/);
    expect(compile([{ expr: 'a' }], { maxBufferedBytes: 1.5 })).toThrow(/maxBufferedBytes/);
    expect(compile([{ expr: 'a' }], { publishConcurrency: 0 })).toThrow(/publishConcurrency/);
    expect(compile([{ expr: 'a' }], { concurrency: 1025 })).toThrow(/concurrency/);
    expect(compile([{ expr: 'a' }], { after: -1 })).toThrow(/after/);
    expect(compile([{ expr: 'a' }], { through: 2 ** 32 })).toThrow(/through/);
  });
});
