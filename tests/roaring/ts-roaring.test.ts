import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError, ValidationError } from '@cloudbitmaps/core';
import type { CodecBitmap } from '@cloudbitmaps/core';
import { roaringCodec } from '@/roaring-codec';
import { tsRoaringCodec } from '@/ts-roaring/bitmap';
import { crPlainBytes, prng } from '../helpers/roaring-oracle';

/**
 * What the codec oracle cannot see from outside: the TypeScript codec's own bookkeeping. The oracle holds its answers
 * and its stored bytes to CRoaring's; these hold the cardinality it keeps (never recounted per call), the ids it
 * refuses, and the operands it will not mix.
 */
const CAP = 1 << 24;
const ops = fc.array(
  fc.record({
    op: fc.constantFrom('add', 'remove', 'addMany', 'removeMany', 'or', 'and', 'andNot'),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
    count: fc.integer({ min: 0, max: 600 }),
    base: fc.constantFrom(0, 4_000, 65_000, 65_536, 2 ** 32 - 70_000),
  }),
  { minLength: 1, maxLength: 25 },
);

function ids(seed: number, count: number, base: number): number[] {
  const next = prng(seed);
  return Array.from({ length: count }, () => base + Math.floor(next() * 9_000));
}

describe('the TypeScript codec keeps its own books', () => {
  it('keeps size equal to the true cardinality through every kind change, from a run container and from ids', () => {
    const runs = Array.from({ length: 20_000 }, (_, i) => 100 + i);
    const starts: Array<() => CodecBitmap> = [
      () => tsRoaringCodec.empty(),
      () => tsRoaringCodec.fromValues(runs),
      () => tsRoaringCodec.safeDeserialize(crPlainBytes(runs, 'ranges'), CAP, { whole: true }),
    ];
    for (const start of starts) {
      fc.assert(
        fc.property(ops, (steps) => {
          const bitmap = start();
          const model = new Set<number>(bitmap);
          for (const { op, seed, count, base } of steps) {
            const given = ids(seed, count, base);
            const other = tsRoaringCodec.fromValues(ids(seed + 1, count, base));
            if (op === 'add') {
              for (const v of given) {
                bitmap.add(v);
                model.add(v);
              }
            } else if (op === 'remove') {
              for (const v of given) {
                bitmap.remove(v);
                model.delete(v);
              }
            } else if (op === 'addMany') {
              bitmap.addMany(given);
              for (const v of given) model.add(v);
            } else if (op === 'removeMany') {
              bitmap.removeMany(given);
              for (const v of given) model.delete(v);
            } else if (op === 'or') {
              bitmap.orInPlace(other);
              for (const v of other) model.add(v);
            } else if (op === 'and') {
              bitmap.andInPlace(other);
              const keep = new Set(other);
              for (const v of [...model]) if (!keep.has(v)) model.delete(v);
            } else {
              bitmap.andNotInPlace(other);
              for (const v of other) model.delete(v);
            }
            expect(bitmap.size).toBe(model.size);
            expect(bitmap.isEmpty).toBe(model.size === 0);
            expect(bitmap.toArray()).toEqual([...model].sort((a, b) => a - b));
            const last = [...model].sort((a, b) => a - b).at(-1);
            expect(bitmap.maximum?.()).toBe(last);
          }
        }),
        { numRuns: 60 },
      );
    }
  }, 60_000);

  it('refuses to write an id that is not an integer from 0 to 4,294,967,295, and reads one as absent', () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      const bitmap = tsRoaringCodec.fromValues([1, 2]);
      expect(() => bitmap.add(bad)).toThrow(ValidationError);
      expect(() => bitmap.addMany([3, bad])).toThrow(ValidationError);
      expect(() => tsRoaringCodec.fromValues([bad])).toThrow(ValidationError);
      expect(bitmap.has(bad)).toBe(false);
      bitmap.remove(bad);
      expect(bitmap.toArray(), 'a refused write leaves the bitmap as it was').toEqual([1, 2]);
    }
  });

  it('owns its own bitmaps and nothing else, and combines with its own only', () => {
    const mine = tsRoaringCodec.fromValues([1]);
    const native = roaringCodec.fromValues([1]);
    expect(tsRoaringCodec.owns?.(mine)).toBe(true);
    expect(tsRoaringCodec.owns?.(native)).toBe(false);
    expect(tsRoaringCodec.owns?.({})).toBe(false);
    expect(roaringCodec.owns?.(mine)).toBe(false);
    for (const op of ['orInPlace', 'andInPlace', 'andNotInPlace'] as const) {
      expect(() => mine[op](native)).toThrow(ValidationError);
    }
    expect(mine.toArray()).toEqual([1]);
  });

  it('combines a bitmap with itself', () => {
    const a = tsRoaringCodec.fromValues([1, 2, 70_000]);
    a.orInPlace(a);
    a.andInPlace(a);
    expect(a.toArray()).toEqual([1, 2, 70_000]);
    a.andNotInPlace(a);
    expect(a.isEmpty).toBe(true);
    expect(a.maximum?.()).toBeUndefined();
  });

  it('hands out a toUint32Array the caller owns', () => {
    const bitmap = tsRoaringCodec.fromValues([5, 6, 7]);
    const first = bitmap.toUint32Array?.() as Uint32Array;
    first.fill(0);
    expect([...(bitmap.toUint32Array?.() as Uint32Array)]).toEqual([5, 6, 7]);
    expect(bitmap.toArray()).toEqual([5, 6, 7]);
  });

  const kinds: Record<string, () => CodecBitmap> = {
    array: () => tsRoaringCodec.fromValues([1, 2, 3, 70_000]),
    bitset: () => tsRoaringCodec.fromValues(Array.from({ length: 5_000 }, (_, i) => i * 2)),
    run: () =>
      tsRoaringCodec.safeDeserialize(
        crPlainBytes(
          Array.from({ length: 3_000 }, (_, i) => i + 10),
          'ranges',
        ),
        CAP,
        { whole: true },
      ),
  };

  it.each(Object.keys(kinds))(
    'combines a %s bitmap with itself, in place, for every operation',
    (kind) => {
      const make = kinds[kind] as () => CodecBitmap;
      const before = make().toArray();
      for (const op of ['orInPlace', 'andInPlace'] as const) {
        const a = make();
        a[op](a);
        expect(a.toArray()).toEqual(before);
        expect(a.size).toBe(before.length);
      }
      const a = make();
      a.andNotInPlace(a);
      expect(a.isEmpty).toBe(true);
      expect(a.size).toBe(0);
      expect(a.toArray()).toEqual([]);
    },
  );

  it.each(Object.keys(kinds))('clones a %s bitmap into one that shares nothing with it', (kind) => {
    const original = (kinds[kind] as () => CodecBitmap)();
    const bytes = original.serialize();
    const before = original.toArray();
    const copy = original.clone();
    copy.add(123_456);
    copy.remove(before[0] as number);
    copy.orInPlace(tsRoaringCodec.fromValues([999_999]));
    copy.andNotInPlace(tsRoaringCodec.fromValues([before[1] as number]));
    expect(original.toArray()).toEqual(before);
    expect(original.serialize()).toEqual(bytes);
    original.add(7_777_777);
    expect(copy.has(7_777_777)).toBe(false);
  });

  it('keeps the chunk bytes already handed out when the bitmap changes before they are read', () => {
    const values = [...Array.from({ length: 5_000 }, (_, i) => i * 2), 70_000, 70_001, 200_000];
    const bitmap = tsRoaringCodec.fromValues(values);
    const reference = tsRoaringCodec.fromValues(values);
    const chunks = bitmap.encodeChunks?.() as Iterable<{ payload: Uint8Array; chunkKey: number }>;
    const iterator = chunks[Symbol.iterator]();
    const first = iterator.next().value as { payload: Uint8Array; chunkKey: number };
    bitmap.removeMany(values);
    bitmap.addMany([1, 70_005, 200_001]);
    const rest = [...{ [Symbol.iterator]: () => iterator }];
    const bytes = [first, ...rest];
    const expected = [
      ...(reference.encodeChunks?.() as Iterable<{ payload: Uint8Array; chunkKey: number }>),
    ];
    expect(bytes.map((c) => c.chunkKey)).toEqual(expected.map((c) => c.chunkKey));
    for (let i = 0; i < bytes.length; i++) {
      expect(Array.from((bytes[i] as { payload: Uint8Array }).payload)).toEqual(
        Array.from((expected[i] as { payload: Uint8Array }).payload),
      );
    }
  });

  it('reads the bytes it checked when the buffer changes under it during the load', () => {
    const values = [10, 20, 30, 40, 50];
    const good = tsRoaringCodec.fromValues(values).serialize();
    const shared = new Uint8Array(new SharedArrayBuffer(good.length));
    shared.set(good);
    const live = new Uint8Array(shared.buffer);
    let touched = 0;
    // Every time the loader looks at the buffer's backing store, a "writer" swaps two stored values.
    Object.defineProperty(shared, 'buffer', {
      get() {
        touched++;
        const at = good.length - 10;
        const x = live[at] as number;
        live[at] = live[at + 2] as number;
        live[at + 2] = x;
        return live.buffer;
      },
    });
    const loaded = tsRoaringCodec.safeDeserialize(shared, CAP, { whole: true });
    expect(loaded.toArray()).toEqual(values);
    expect(touched, 'the loader must not need the shared backing store after checking').toBe(0);
  });
});

describe('the TypeScript codec reads hostile bytes as native does', () => {
  const CAP2 = 1 << 30;
  const u32 = (...v: number[]): Uint8Array => {
    const b = new Uint8Array(v.length * 4);
    const d = new DataView(b.buffer);
    v.forEach((x, i) => d.setUint32(i * 4, x >>> 0, true));
    return b;
  };
  const cat = (...a: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of a) {
      out.set(x, at);
      at += x.length;
    }
    return out;
  };
  function verdict(codec: typeof roaringCodec, bytes: Uint8Array, whole: boolean): string {
    try {
      const b = codec.safeDeserialize(bytes, CAP2, { whole });
      return `ok:${b.size}:${b.maximum?.()}`;
    } catch (error) {
      return error instanceof IntegrityError ? 'IntegrityError' : `other:${String(error)}`;
    }
  }
  const same = (bytes: Uint8Array, whole = false): void => {
    const ts = verdict(tsRoaringCodec, bytes, whole);
    expect(ts).toBe(verdict(roaringCodec, bytes, whole));
    expect(ts.startsWith('other')).toBe(false);
  };

  const full = tsRoaringCodec
    .fromValues(Array.from({ length: 5_000 }, (_, i) => i * 2))
    .serialize();
  const badCard = full.slice();
  new DataView(badCard.buffer).setUint16(10, 4_998, true);
  const runHeader = (cardMinusOne: number): Uint8Array =>
    cat(u32(12_347), Uint8Array.of(1), Uint8Array.of(0, 0, cardMinusOne & 255, cardMinusOne >> 8));
  const badOffset = tsRoaringCodec.fromValues([1, 70_000]).serialize().slice();
  new DataView(badOffset.buffer).setUint32(16, 0, true);

  const crafted: Array<[string, Uint8Array, boolean]> = [
    ['count 2^32-1', u32(12_346, 0xffffffff), false],
    ['count 2^31', u32(12_346, 0x80000000), false],
    [
      'run past 65535',
      cat(runHeader(9), Uint8Array.of(1, 0), Uint8Array.of(0xf8, 0xff, 9, 0)),
      false,
    ],
    [
      'run to 65535',
      cat(runHeader(9), Uint8Array.of(1, 0), Uint8Array.of(0xf0, 0xff, 9, 0)),
      false,
    ],
    ['run container of zero runs', cat(runHeader(0), Uint8Array.of(0, 0)), false],
    ['bitset cardinality low', badCard, false],
    ['bitset cardinality right', full, false],
    ['trailing bytes', cat(full, Uint8Array.of(1, 2, 3)), false],
    ['trailing bytes, whole', cat(full, Uint8Array.of(1, 2, 3)), true],
    [
      'flag bits past the count',
      cat(u32(12_347), Uint8Array.of(0xff), u32(0), Uint8Array.of(2, 0, 1, 0)),
      false,
    ],
    ['run cookie, high half 0xffff', u32(12_347 | (0xffff << 16)), false],
    ['run cookie, count 6, nothing after', u32(12_347 | (5 << 16), 0, 0, 0, 0, 0, 0), false],
    ['no-run cookie, count 0, junk, whole', cat(u32(12_346, 0), Uint8Array.of(9, 9)), true],
    ['empty buffer, whole', new Uint8Array(0), true],
    ['three bytes', Uint8Array.of(1, 2, 3), false],
    ['an offset that points nowhere', badOffset, false],
  ];
  it.each(crafted)('answers %s as native does', (_name, bytes, whole) => {
    same(bytes, whole);
  });

  it('answers a truncation at every offset of four samples as native does', () => {
    const runs = tsRoaringCodec.fromValues(Array.from({ length: 3_000 }, (_, i) => i + 10));
    runs.optimize?.();
    const five = tsRoaringCodec.fromValues(
      [0, 2, 4, 6, 8].flatMap((k) => Array.from({ length: 3_000 }, (_, i) => i + 10 + 65_536 * k)),
    );
    five.optimize?.();
    const samples = [
      tsRoaringCodec.fromValues([1, 2, 3, 70_000, 70_001, 900_000_000]).serialize(),
      full,
      runs.serialize(),
      five.serialize(),
    ];
    for (const sample of samples) {
      for (let n = 0; n < sample.length; n++) same(sample.subarray(0, n));
    }
  }, 60_000);
});
