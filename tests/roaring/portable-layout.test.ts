import fc from 'fast-check';
import { RoaringBitmap32, SerializationFormat } from 'roaring';
import { IntegrityError } from '@cloudbitmaps/core';
import { SafeBitmap } from '@/roaring-codec';
import { decodePortableRoaring } from '@/portable/decode';
import { bitsetOf, craftPortable, type CraftedContainer } from '../helpers/portable-bytes';

/**
 * The structural check on portable-roaring bytes, held at both of the places bytes are decoded: the native path
 * (`SafeBitmap.safeDeserialize`, which every chunk read goes through) and the pure-JS reader.
 *
 * WHY THE NATIVE PATH NEEDS ONE. `roaring` calls CRoaring's `roaring_bitmap_portable_deserialize_safe`, which
 * bounds every read against the buffer and checks nothing else. CRoaring's own header says the result must then
 * pass `roaring_bitmap_internal_validate` before it is used, and `roaring` never calls it. So bytes that are the
 * right length but the wrong shape decode into a bitmap whose invariants are false: keys out of order, values
 * out of order, runs that overlap, cardinalities that disagree with the bits. The native library accepts every
 * shape below when nothing checks it first, and what it then does is the shape's `consequence`. None of them is
 * caught by a CRC, which proves only that the bytes are the bytes that were written; anyone who can write the
 * bucket writes those.
 *
 * WHY THE READER IS HELD TO THE SAME. It exists to answer the same questions as the native library. A shape one
 * of them refuses and the other answers from is a disagreement, so both must refuse every shape here.
 */
const CAP = 1 << 20;

interface Hostile {
  readonly name: string;
  /** What the native library does with these bytes when nothing checks them first. */
  readonly consequence: string;
  readonly containers: readonly CraftedContainer[];
  readonly offsets?: readonly number[];
}

const allBits = new Uint8Array(8_192).fill(0xff);

const HOSTILE: readonly Hostile[] = [
  {
    name: 'containers out of order',
    consequence:
      'maximum() reads the last container and says 7, so the 16-bit range check passes, and iteration yields 65541',
    containers: [
      { key: 1, kind: 'array', values: [5] },
      { key: 0, kind: 'array', values: [7] },
    ],
  },
  {
    name: 'a container key listed twice',
    consequence: 'iteration yields 5 and 7, and has(5) answers false',
    containers: [
      { key: 0, kind: 'array', values: [5] },
      { key: 0, kind: 'array', values: [7] },
    ],
  },
  {
    name: 'array values out of order',
    consequence: 'iteration yields 9 then 3, has(3) answers false, and maximum() says 3',
    containers: [{ key: 0, kind: 'array', values: [9, 3] }],
  },
  {
    name: 'an array whose odd last value repeats the one before it',
    consequence: 'size says 3 for 2 values, and iteration yields 2 twice',
    containers: [{ key: 0, kind: 'array', values: [1, 2, 2] }],
  },
  {
    name: 'array values out of order from one pair of values to the next',
    consequence: 'iteration yields 1, 5, 3, 7, and has(3) answers false',
    containers: [{ key: 0, kind: 'array', values: [1, 5, 3, 7] }],
  },
  {
    name: 'an array whose last value, an odd one out, is out of order',
    consequence: 'iteration yields 1, 2, 0, and has(0) answers false',
    containers: [{ key: 0, kind: 'array', values: [1, 2, 0] }],
  },
  {
    name: 'an array value listed twice',
    consequence: 'size says 2 and iteration yields 4 twice',
    containers: [{ key: 0, kind: 'array', values: [4, 4] }],
  },
  {
    name: 'runs out of order',
    consequence: 'iteration yields 100, 101, 10, 11, and has(10) answers false',
    containers: [
      {
        key: 0,
        kind: 'run',
        runs: [
          [100, 1],
          [10, 1],
        ],
      },
    ],
  },
  {
    name: 'overlapping runs',
    consequence: 'size says 12 for 8 values, and iteration yields 12 through 15 twice',
    containers: [
      {
        key: 0,
        kind: 'run',
        runs: [
          [10, 5],
          [12, 5],
        ],
      },
    ],
  },
  {
    name: 'adjacent runs a writer would have merged',
    consequence: 'answers correctly, but CRoaring counts it invalid, and nothing writes it',
    containers: [
      {
        key: 0,
        kind: 'run',
        runs: [
          [10, 1],
          [12, 1],
        ],
      },
    ],
  },
  {
    name: 'a run that runs past the end of its container',
    consequence:
      'maximum() wraps to 16, so the 16-bit range check passes, and iteration yields 65536 through 65552',
    containers: [{ key: 0, kind: 'run', runs: [[0xfff0, 0x20]] }],
  },
  {
    name: 'a run that ends one value past the end of its container',
    consequence:
      'maximum() wraps to 0, so the 16-bit range check passes, and iteration yields 65535 and then 65536',
    containers: [{ key: 0, kind: 'run', runs: [[0xffff, 1]] }],
  },
  {
    name: 'a run container with no runs',
    consequence: 'iterating it, or intersecting or unioning with it, crashes the process (SIGSEGV)',
    containers: [{ key: 0, kind: 'run', runs: [], cardinality: 1 }],
  },
  {
    name: 'a run container whose header cardinality disagrees with its runs',
    consequence:
      'the native library ignores the header and says 1; the reader trusts it and counts 500',
    containers: [{ key: 0, kind: 'run', runs: [[10, 0]], cardinality: 500 }],
  },
  {
    name: 'a bitset holding more values than its header says',
    consequence:
      'size says 4097 for 65,536 values, and remove() writes past the array it converts into: heap corruption, then SIGSEGV',
    containers: [{ key: 0, kind: 'bitset', bits: allBits, cardinality: 4_097 }],
  },
  {
    name: 'a bitset holding fewer values than its header says',
    consequence: 'size says 5000 for one value',
    containers: [{ key: 0, kind: 'bitset', bits: bitsetOf([0]), cardinality: 5_000 }],
  },
  {
    name: 'an offset header that points somewhere else',
    consequence:
      'the native library ignores offsets and reads 65538; the reader follows them and reads 65537',
    containers: [
      { key: 0, kind: 'array', values: [1] },
      { key: 1, kind: 'array', values: [2] },
    ],
    // Both offsets name the first container's payload, which starts after the 8-byte cookie and count, two
    // 4-byte descriptive entries and two 4-byte offsets.
    offsets: [24, 24],
  },
  {
    name: 'an offset header that points past where its container starts',
    consequence:
      'the native library ignores offsets and reads 65538; the reader follows them off the end of the buffer',
    containers: [
      { key: 0, kind: 'array', values: [1] },
      { key: 1, kind: 'array', values: [2] },
    ],
    offsets: [1_000, 1_000],
  },
];

describe('the portable-roaring structural check', () => {
  describe.each(HOSTILE.map((h) => [h.name, h] as const))('refuses %s', (_name, h) => {
    const bytes = craftPortable(
      h.containers,
      h.offsets === undefined ? {} : { offsets: h.offsets },
    );

    it(`on the native path, where unchecked ${h.consequence}`, () => {
      expect(() => SafeBitmap.safeDeserialize(bytes, CAP)).toThrow(IntegrityError);
    });

    it('in the pure-JS reader too, so the two cannot disagree', () => {
      expect(() => decodePortableRoaring(bytes)).toThrow(IntegrityError);
    });
  });

  describe.each([
    [
      'a run container whose run count is cut off',
      // The header ends where the container starts, so there is no run count to read.
      craftPortable([{ key: 0, kind: 'run', runs: [[1, 1]] }]).slice(0, 4 + 1 + 4),
    ],
    [
      'a run-cookie header cut off inside its first descriptive entry',
      craftPortable([
        { key: 0, kind: 'run', runs: [[1, 1]] },
        { key: 1, kind: 'array', values: [2] },
        { key: 2, kind: 'array', values: [3] },
      ]).slice(0, 4 + 1 + 3),
    ],
    [
      'a bitset cut off one byte short',
      craftPortable([{ key: 0, kind: 'bitset', bits: allBits }]).slice(0, -1),
    ],
  ])('refuses %s with a typed error, never a RangeError', (_name, bytes) => {
    it('on the native path', () => {
      expect(() => SafeBitmap.safeDeserialize(bytes, CAP)).toThrow(IntegrityError);
    });

    it('in the pure-JS reader', () => {
      expect(() => decodePortableRoaring(bytes)).toThrow(IntegrityError);
    });
  });

  it('writes the bytes the native serializer writes, so each forged field is the only difference', () => {
    // The hostile shapes are only evidence if the helper that builds them is right about everything else.
    const run = (start: number, count: number): number[] =>
      Array.from({ length: count }, (_, i) => start + i);
    const cases: ReadonlyArray<{
      containers: readonly CraftedContainer[];
      ids: number[];
      optimize: boolean;
    }> = [
      {
        containers: [{ key: 0, kind: 'array', values: [1, 2, 3] }],
        ids: [1, 2, 3],
        optimize: false,
      },
      {
        containers: [
          { key: 0, kind: 'array', values: [7] },
          { key: 1, kind: 'array', values: [5] },
        ],
        ids: [7, 65_541],
        optimize: false,
      },
      {
        containers: [
          {
            key: 3,
            kind: 'bitset',
            bits: bitsetOf(Array.from({ length: 5_000 }, (_, i) => i * 2)),
          },
        ],
        ids: Array.from({ length: 5_000 }, (_, i) => 3 * 65_536 + i * 2),
        optimize: false,
      },
      {
        containers: [{ key: 0, kind: 'run', runs: [[1_000, 2_999]] }],
        ids: run(1_000, 3_000),
        optimize: true,
      },
      {
        // Four containers under the run cookie, the smallest count at which it carries an offset header, and
        // an array beside the runs so the run-flag bitmap has a clear bit in it.
        containers: [
          { key: 0, kind: 'run', runs: [[0, 499]] },
          { key: 1, kind: 'array', values: [3, 9] },
          { key: 2, kind: 'run', runs: [[0, 499]] },
          { key: 3, kind: 'run', runs: [[0, 499]] },
        ],
        ids: [...run(0, 500), 65_539, 65_545, ...run(131_072, 500), ...run(196_608, 500)],
        optimize: true,
      },
    ];
    for (const c of cases) {
      const native = RoaringBitmap32.from(c.ids);
      if (c.optimize) native.runOptimize();
      expect(craftPortable(c.containers)).toEqual(
        new Uint8Array(native.serialize(SerializationFormat.portable)),
      );
    }
  });

  it('accepts what a writer writes: the valid twin of each hostile shape, on both decoders', () => {
    // A check that refused everything would pass the table above. These are the same containers put right.
    const twins: ReadonlyArray<{ containers: readonly CraftedContainer[]; ids: number[] }> = [
      {
        containers: [
          { key: 0, kind: 'array', values: [7] },
          { key: 1, kind: 'array', values: [5] },
        ],
        ids: [7, 65_541],
      },
      { containers: [{ key: 0, kind: 'array', values: [3, 5, 7, 9] }], ids: [3, 5, 7, 9] },
      {
        containers: [
          {
            key: 0,
            kind: 'run',
            runs: [
              [10, 1],
              [100, 1],
            ],
          },
        ],
        ids: [10, 11, 100, 101],
      },
      {
        containers: [
          {
            key: 0,
            kind: 'run',
            runs: [
              [10, 1],
              [13, 1],
            ],
          },
        ],
        ids: [10, 11, 13, 14],
      },
      { containers: [{ key: 0, kind: 'run', runs: [[0xffe0, 0x1f]] }], ids: [] },
      { containers: [{ key: 0, kind: 'bitset', bits: allBits }], ids: [] },
    ];
    // Two twins are easier to state as ranges than to list.
    twins[4]!.ids.push(...Array.from({ length: 32 }, (_, i) => 0xffe0 + i));
    twins[5]!.ids.push(...Array.from({ length: 65_536 }, (_, i) => i));

    for (const t of twins) {
      const bytes = craftPortable(t.containers);
      const native = SafeBitmap.safeDeserialize(bytes, CAP);
      const reader = decodePortableRoaring(bytes);
      expect(native.toArray()).toEqual(t.ids);
      expect(reader.count()).toBe(t.ids.length);
      expect(t.ids.every((id) => reader.has(id))).toBe(true);
    }
  });

  it('keeps the two decoders in agreement on mutated real payloads, and whatever both accept is consistent', () => {
    // The table above is shapes someone thought of. This takes bytes a writer really produced, overwrites a few
    // of them, and holds both decoders to one verdict: both refuse, or both accept and give the same answers.
    // Half the overwrites land in the first 48 bytes, where the cookie, the keys, the cardinalities and the
    // offsets are, because a flip in the middle of a bitset is only a different set.
    const ids = fc
      .array(
        fc.oneof(
          fc.integer({ min: 0, max: 4 * 65_536 - 1 }).map((v) => [v]),
          fc
            .tuple(fc.integer({ min: 0, max: 4 * 65_536 - 1 }), fc.integer({ min: 1, max: 5_000 }))
            .map(([start, n]) => Array.from({ length: n }, (_, i) => start + i)),
        ),
        { maxLength: 8 },
      )
      .map((groups) => groups.flat().filter((v) => v < 4 * 65_536));
    const overwrite = fc.tuple(fc.boolean(), fc.nat(), fc.integer({ min: 0, max: 255 }));

    fc.assert(
      fc.property(
        ids,
        fc.boolean(),
        fc.array(overwrite, { minLength: 1, maxLength: 3 }),
        (v, optimize, edits) => {
          const source = RoaringBitmap32.from(v);
          if (optimize) source.runOptimize();
          const bytes = new Uint8Array(source.serialize(SerializationFormat.portable));
          for (const [inHeader, at, byte] of edits) {
            bytes[at % (inHeader ? Math.min(48, bytes.length) : bytes.length)] = byte;
          }

          let native: SafeBitmap | undefined;
          let reader: ReturnType<typeof decodePortableRoaring> | undefined;
          try {
            native = SafeBitmap.safeDeserialize(bytes, CAP);
          } catch (err) {
            expect(err).toBeInstanceOf(IntegrityError);
          }
          try {
            reader = decodePortableRoaring(bytes);
          } catch (err) {
            expect(err).toBeInstanceOf(IntegrityError);
          }
          expect(native === undefined, 'the native path and the reader disagree on accepting').toBe(
            reader === undefined,
          );
          if (native === undefined || reader === undefined) return;

          expect(reader.count()).toBe(native.size);
          let previous = -1;
          let seen = 0;
          for (const value of native) {
            expect(value).toBeGreaterThan(previous);
            if (seen < 1_000) {
              expect(native.has(value)).toBe(true);
              expect(reader.has(value)).toBe(true);
            }
            previous = value;
            seen++;
          }
          expect(seen).toBe(native.size);
        },
      ),
      { numRuns: 400 },
    );
  });
});
