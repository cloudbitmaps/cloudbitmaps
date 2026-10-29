import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IntegrityError } from '@cloudbitmaps/core';
import { checkPortableLayout } from '@/portable/layout';
import { bitsetOf, craftPortable, type CraftedContainer } from '../helpers/portable-bytes';

/**
 * The layout check reads a long array, a long run list and every bitset through typed arrays when the body sits at a
 * suitable offset of the buffer, and through a scratch copy or the `DataView` when it does not. Every case here runs at
 * the four alignments a buffer can start at (a view of a larger buffer at byte offset 0 to 3, with the container bodies
 * at offsets of both parities), and holds that the answer and the error text are the same at each: the same refusals in
 * the same order, and no read past the end of the bytes it was given.
 */
const SHIFTS = [0, 1, 2, 3] as const;

/** `bytes` as a view of a larger buffer, starting `shift` bytes in, with room after it that a read past its end would find. */
function placed(bytes: Uint8Array, shift: number): Uint8Array {
  const whole = new Uint8Array(shift + bytes.length + 64).fill(0xff);
  whole.set(bytes, shift);
  return whole.subarray(shift, shift + bytes.length);
}

/** What the check does with `bytes`: where the bitmap ends, or the refusal's text. */
function outcome(bytes: Uint8Array): number | string {
  try {
    return checkPortableLayout(bytes);
  } catch (err) {
    if (!(err instanceof IntegrityError)) throw err;
    return err.message;
  }
}

/** The outcome at every shift, which must be one value. */
function everywhere(bytes: Uint8Array): number | string {
  const first = outcome(placed(bytes, 0));
  for (const shift of SHIFTS) expect(outcome(placed(bytes, shift))).toBe(first);
  return first;
}

/** `lead` small array containers in front, which moves the next body by a multiple of 2 bytes that is not one of 4. */
const lead = (n: number): CraftedContainer[] =>
  Array.from({ length: n }, (_, j) => ({
    key: j,
    kind: 'array' as const,
    values: Array.from({ length: j + 1 }, (_, v) => v),
  }));

/** A bitset body of 4,098 values: two in every word and two more in word `word`. */
function bitsetWithExtraIn(word: number): Uint8Array {
  const values: number[] = [];
  for (let w = 0; w < 2_048; w++) values.push(w * 32, w * 32 + 1);
  values.push(word * 32 + 2, word * 32 + 3);
  return bitsetOf(values);
}

describe('a bitset container is counted the same at every alignment', () => {
  for (const word of [0, 1, 14, 15, 16, 17, 2_046, 2_047]) {
    for (const before of [0, 1, 2, 3]) {
      it(`with its extra values in word ${word}, after ${before} other containers: right count accepted, one more or less refused`, () => {
        const bits = bitsetWithExtraIn(word);
        const at = (cardinality?: number): Uint8Array =>
          craftPortable([
            ...lead(before),
            {
              key: before,
              kind: 'bitset',
              bits,
              ...(cardinality === undefined ? {} : { cardinality }),
            },
          ]);
        expect(typeof everywhere(at())).toBe('number');
        expect(everywhere(at(4_099))).toBe(
          `portable roaring: container ${before} (bitmap) holds 4098 values, but its header says 4099`,
        );
        expect(everywhere(at(4_097))).toMatch(/holds 4098 values, but its header says 4097$/);
      });
    }
  }

  it('counts every word: a single bit moved from one word to another changes nothing, a lost bit is refused', () => {
    for (const word of [0, 15, 16, 31, 32, 2_047]) {
      const values: number[] = [];
      for (let w = 0; w < 2_048; w++) values.push(w * 32, w * 32 + 1);
      values.push(word * 32 + 2, word * 32 + 3);
      const lost = values.slice(0, -1);
      const bytes = craftPortable([
        { key: 0, kind: 'bitset', bits: bitsetOf(lost), cardinality: 4_098 },
      ]);
      expect(everywhere(bytes)).toBe(
        'portable roaring: container 0 (bitmap) holds 4097 values, but its header says 4098',
      );
    }
  });
});

describe('an array container is checked the same at every alignment', () => {
  const ascending = (n: number): number[] => Array.from({ length: n }, (_, v) => 2 * v);
  for (const n of [1, 2, 3, 4, 5, 31, 127, 128, 129, 130, 131, 132, 133, 1_000, 4_096]) {
    it(`${n} values: accepted when they ascend, and the element a defect is reported at does not depend on the alignment`, () => {
      for (const before of [0, 1]) {
        const ok = craftPortable([
          ...lead(before),
          { key: before, kind: 'array', values: ascending(n) },
        ]);
        expect(typeof everywhere(ok)).toBe('number');
        const positions = new Set<number>();
        for (let k = 1; k < Math.min(n, 12); k++) positions.add(k);
        for (let k = Math.max(1, n - 10); k < n; k++) positions.add(k);
        for (const k of positions) {
          const values = ascending(n);
          values[k] = values[k - 1] as number; // repeats its predecessor
          const bytes = craftPortable([...lead(before), { key: before, kind: 'array', values }]);
          // The element named is the first of the pair the defect sits in (an odd one out is its own pair).
          expect(everywhere(bytes)).toBe(
            `portable roaring: container ${before} (array) is not strictly ascending at or after element ${k - (k % 2)}`,
          );
        }
      }
    });
  }

  it('refuses a value that falls from one group of four to the next, and from one pair to the next', () => {
    for (const n of [128, 132]) {
      for (const k of [2, 3, 4, 6, 7, 8]) {
        const values = ascending(n);
        values[k] = 0;
        const bytes = craftPortable([{ key: 0, kind: 'array', values }]);
        expect(everywhere(bytes)).toBe(
          `portable roaring: container 0 (array) is not strictly ascending at or after element ${k - (k % 2)}`,
        );
      }
    }
  });
});

describe('a run container is checked the same at every alignment', () => {
  const runsOf = (n: number): Array<[number, number]> =>
    Array.from({ length: n }, (_, r) => [8 * r, 3] as [number, number]);
  for (const n of [1, 2, 63, 64, 65, 66, 200, 1_000]) {
    it(`${n} runs: accepted when they ascend; a touching, overlapping or overlong run, or a wrong count, is refused alike`, () => {
      for (const before of [0, 1, 2]) {
        const ok = craftPortable([...lead(before), { key: before, kind: 'run', runs: runsOf(n) }]);
        expect(typeof everywhere(ok)).toBe('number');
        const touching = runsOf(n);
        const r = n - 1;
        if (r >= 1) {
          touching[r] = [(touching[r - 1] as [number, number])[0] + 4, 3]; // starts right after the run before ends
          const bytes = craftPortable([
            ...lead(before),
            { key: before, kind: 'run', runs: touching },
          ]);
          expect(everywhere(bytes)).toBe(
            `portable roaring: container ${before} (run) has run ${r} out of order, overlapping or touching the one before`,
          );
        }
        const past = runsOf(n);
        past[n - 1] = [65_530, 10];
        const bytes = craftPortable([...lead(before), { key: before, kind: 'run', runs: past }]);
        expect(everywhere(bytes)).toBe(
          `portable roaring: container ${before} (run) has run ${n - 1} running past the end of the container`,
        );
        const counted = craftPortable([
          ...lead(before),
          { key: before, kind: 'run', runs: runsOf(n), cardinality: 4 * n + 1 },
        ]);
        expect(everywhere(counted)).toBe(
          `portable roaring: container ${before} (run) covers ${4 * n} values, but its header says ${4 * n + 1}`,
        );
      }
    });
  }
});

describe('the order of refusals and the end of the buffer', () => {
  const badBitset: CraftedContainer = {
    key: 0,
    kind: 'bitset',
    bits: bitsetWithExtraIn(5),
    cardinality: 4_101,
  };
  const badArray = (key: number): CraftedContainer => ({
    key,
    kind: 'array',
    values: [...Array.from({ length: 200 }, (_, v) => v), 3],
  });

  it('names the first defective container, whichever kind it is and whichever comes first', () => {
    expect(everywhere(craftPortable([badBitset, badArray(1)]))).toMatch(
      /container 0 \(bitmap\) holds 4098/,
    );
    expect(everywhere(craftPortable([{ ...badArray(0) }, { ...badBitset, key: 1 }]))).toMatch(
      /container 0 \(array\) is not strictly ascending at or after element 200$/,
    );
  });

  it('refuses a body one byte short of the buffer, at every alignment, for each kind', () => {
    const bodies: CraftedContainer[] = [
      { key: 0, kind: 'bitset', bits: bitsetWithExtraIn(1) },
      { key: 0, kind: 'array', values: Array.from({ length: 300 }, (_, v) => v) },
      {
        key: 0,
        kind: 'run',
        runs: Array.from({ length: 100 }, (_, r) => [8 * r, 3] as [number, number]),
      },
    ];
    for (const c of bodies) {
      const bytes = craftPortable([c]);
      expect(typeof everywhere(bytes)).toBe('number');
      for (const shift of SHIFTS) {
        const short = placed(bytes, shift).subarray(0, bytes.length - 1);
        expect(() => checkPortableLayout(short)).toThrow(IntegrityError);
        expect(() => checkPortableLayout(short)).toThrow(/needs bytes/);
      }
    }
  });
});

describe('damaged bytes get one answer at every alignment', () => {
  const dense = bitsetWithExtraIn(40);
  const sample = craftPortable([
    { key: 0, kind: 'array', values: Array.from({ length: 150 }, (_, v) => 3 * v) },
    { key: 1, kind: 'bitset', bits: dense },
    {
      key: 2,
      kind: 'run',
      runs: Array.from({ length: 80 }, (_, r) => [10 * r, 4] as [number, number]),
    },
    { key: 3, kind: 'array', values: [1, 9, 40] },
    { key: 9, kind: 'bitset', bits: bitsetWithExtraIn(2_047) },
  ]);

  it('agrees on the undamaged bytes', () => {
    expect(typeof everywhere(sample)).toBe('number');
  });

  it('agrees on bytes with one to three changed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(sample.length - 1), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 3,
        }),
        (edits) => {
          const bytes = sample.slice();
          for (const [at, value] of edits) bytes[at] = value;
          everywhere(bytes);
        },
      ),
      { numRuns: 600 },
    );
  });

  it('agrees on bytes cut short anywhere', () => {
    fc.assert(
      fc.property(fc.nat(sample.length), (length) => {
        everywhere(sample.slice(0, length));
      }),
      { numRuns: 300 },
    );
  });
});
