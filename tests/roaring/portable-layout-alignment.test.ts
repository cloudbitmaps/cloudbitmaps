import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { IntegrityError } from '@cloudbitmaps/core';
import { checkPortableLayout } from '@/portable/layout';
import { craftPortable, type CraftedContainer } from '../helpers/portable-bytes';

/**
 * The layout check counts a bitset in place through a typed array when the body sits at a suitable offset of the buffer
 * (through a scratch copy when it does not), and reads every array and run list through the `DataView`. Every case here runs at
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

/** The set bits of one 32-bit word. */
function bitsIn(word: number): number {
  let n = 0;
  for (let w = word >>> 0; w !== 0; w &= w - 1) n++;
  return n;
}

/**
 * A bitset body of whole-word patterns: every byte of every word is non-zero and the words differ from one another, so a
 * copy that is a byte short, or a scratch that still holds the bytes of an earlier body, changes the count. Word
 * `special` holds `value` instead, and `value` is stated in full (a word of all ones, or of nothing but its top byte).
 */
function wordBody(
  seed: number,
  special: number,
  value: number,
): { bits: Uint8Array; card: number } {
  const words = new Uint32Array(2_048);
  let state = seed >>> 0 || 1;
  for (let w = 0; w < words.length; w++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    words[w] = (state | 0x0101_0101) >>> 0;
  }
  words[special] = value >>> 0;
  let card = 0;
  for (const w of words) card += bitsIn(w);
  const bits = new Uint8Array(words.length * 4);
  const view = new DataView(bits.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  return { bits, card };
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

describe('a bitset container is counted the same at every alignment', () => {
  const SPECIALS = [0, 1, 14, 15, 16, 17, 2_046, 2_047];
  for (const special of SPECIALS) {
    for (const before of [0, 1, 2, 3]) {
      it(`with a word of all ones at word ${special}, after ${before} other containers: the right count is accepted and ends at the buffer's end, one more or one fewer is refused`, () => {
        const { bits, card } = wordBody(7 + special, special, 0xffff_ffff);
        const at = (cardinality: number): Uint8Array =>
          craftPortable([...lead(before), { key: before, kind: 'bitset', bits, cardinality }]);
        const ok = at(card);
        expect(everywhere(ok)).toBe(ok.length);
        expect(everywhere(at(card + 1))).toBe(
          `portable roaring: container ${before} (bitmap) holds ${card} values, but its header says ${card + 1}`,
        );
        expect(everywhere(at(card - 1))).toBe(
          `portable roaring: container ${before} (bitmap) holds ${card} values, but its header says ${card - 1}`,
        );
      });
    }
  }

  it('counts the top byte of the last word: a body that is nothing there but that byte is counted whole', () => {
    for (const before of [0, 1, 2, 3]) {
      const { bits, card } = wordBody(99, 2_047, 0x8000_0000);
      const ok = craftPortable([
        ...lead(before),
        { key: before, kind: 'bitset', bits, cardinality: card },
      ]);
      expect(everywhere(ok)).toBe(ok.length);
      const bad = craftPortable([
        ...lead(before),
        { key: before, kind: 'bitset', bits, cardinality: card - 1 },
      ]);
      expect(everywhere(bad)).toBe(
        `portable roaring: container ${before} (bitmap) holds ${card} values, but its header says ${card - 1}`,
      );
    }
  });

  it('counts every word: a bit missing from any one word is refused, with the true count in the message', () => {
    for (const word of [0, 15, 16, 31, 32, 1_000, 2_047]) {
      const { bits, card } = wordBody(5, 3, 0xffff_ffff);
      const view = new DataView(bits.buffer);
      const w = view.getUint32(word * 4, true);
      view.setUint32(word * 4, (w & (w - 1)) >>> 0, true); // the lowest set bit cleared
      const bytes = craftPortable([{ key: 0, kind: 'bitset', bits, cardinality: card }]);
      const held = card - 1;
      expect(everywhere(bytes)).toBe(
        `portable roaring: container 0 (bitmap) holds ${held} values, but its header says ${card}`,
      );
    }
  });

  it('is not fooled by the bytes of an earlier body left in the scratch copy', () => {
    const full = craftPortable([
      { key: 0, kind: 'bitset', bits: new Uint8Array(8_192).fill(0xff), cardinality: 65_536 },
    ]);
    const { bits, card } = wordBody(31, 1_000, 0);
    const sparse = craftPortable([{ key: 0, kind: 'bitset', bits, cardinality: card }]);
    for (const shift of SHIFTS) {
      expect(outcome(placed(full, shift))).toBe(full.length);
      expect(outcome(placed(sparse, shift))).toBe(sparse.length);
      expect(outcome(placed(full, shift))).toBe(full.length);
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
        expect(everywhere(ok)).toBe(ok.length);
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
    it(`${n} runs: accepted when they ascend; a touching or overlong run, or a wrong count, is refused alike`, () => {
      for (const before of [0, 1, 2]) {
        const ok = craftPortable([...lead(before), { key: before, kind: 'run', runs: runsOf(n) }]);
        expect(everywhere(ok)).toBe(ok.length);
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

/** A bitset body of whole-word patterns, and its true count. */
const denseBody = (special: number): { bits: Uint8Array; card: number } =>
  wordBody(special + 1, special, 0xffff_ffff);

describe('the order of refusals and the end of the buffer', () => {
  const badBitset: CraftedContainer = {
    key: 0,
    kind: 'bitset',
    bits: denseBody(5).bits,
    cardinality: denseBody(5).card + 3,
  };
  const badArray = (key: number): CraftedContainer => ({
    key,
    kind: 'array',
    values: [...Array.from({ length: 200 }, (_, v) => v), 3],
  });

  it('names the first defective container, whichever kind it is and whichever comes first', () => {
    expect(everywhere(craftPortable([badBitset, badArray(1)]))).toMatch(
      /container 0 \(bitmap\) holds \d+ values, but its header says \d+$/,
    );
    expect(everywhere(craftPortable([{ ...badArray(0) }, { ...badBitset, key: 1 }]))).toMatch(
      /container 0 \(array\) is not strictly ascending at or after element 200$/,
    );
  });

  it('refuses a body one byte short of the buffer, at every alignment, for each kind', () => {
    const bodies: CraftedContainer[] = [
      { key: 0, kind: 'bitset', bits: denseBody(1).bits },
      { key: 0, kind: 'array', values: Array.from({ length: 300 }, (_, v) => v) },
      {
        key: 0,
        kind: 'run',
        runs: Array.from({ length: 100 }, (_, r) => [8 * r, 3] as [number, number]),
      },
    ];
    for (const c of bodies) {
      const bytes = craftPortable([c]);
      expect(everywhere(bytes)).toBe(bytes.length);
      for (const shift of SHIFTS) {
        const short = placed(bytes, shift).subarray(0, bytes.length - 1);
        expect(() => checkPortableLayout(short)).toThrow(IntegrityError);
        expect(() => checkPortableLayout(short)).toThrow(/needs bytes/);
      }
    }
  });
});

describe('damaged bytes get one answer at every alignment', () => {
  const dense = denseBody(40).bits;
  const sample = craftPortable([
    { key: 0, kind: 'array', values: Array.from({ length: 150 }, (_, v) => 3 * v) },
    { key: 1, kind: 'bitset', bits: dense },
    {
      key: 2,
      kind: 'run',
      runs: Array.from({ length: 80 }, (_, r) => [10 * r, 4] as [number, number]),
    },
    { key: 3, kind: 'array', values: [1, 9, 40] },
    { key: 9, kind: 'bitset', bits: denseBody(2_047).bits },
  ]);

  it('agrees on the undamaged bytes, and the check ends where they end', () => {
    expect(everywhere(sample)).toBe(sample.length);
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

describe('the offset header and the bytes after the bitmap, at every alignment', () => {
  const { bits, card } = denseBody(9);
  const honest = craftPortable([...lead(2), { key: 2, kind: 'bitset', bits, cardinality: card }]);
  /** Where the offset header of the third container is: cookie and count (8), three key pairs (12), two offsets (8). */
  const OFFSET_AT = 8 + 12 + 2 * 4;

  it('refuses an offset that is not where its container starts, naming both', () => {
    const stated = new DataView(honest.buffer, honest.byteOffset).getUint32(OFFSET_AT, true);
    for (const wrong of [stated + 1, stated + 2, stated + 3, stated - 2]) {
      const bytes = honest.slice();
      new DataView(bytes.buffer).setUint32(OFFSET_AT, wrong, true);
      expect(everywhere(bytes)).toBe(
        `portable roaring: the offset header puts container 2 at byte ${wrong}, but it starts at ${stated}`,
      );
    }
  });

  it('ends where the last container ends, however many bytes follow', () => {
    expect(everywhere(honest)).toBe(honest.length);
    for (const extra of [1, 2, 3, 4, 7, 8_192]) {
      const longer = new Uint8Array(honest.length + extra).fill(0xab);
      longer.set(honest);
      expect(everywhere(longer)).toBe(honest.length);
    }
  });
});

describe('bytes that sit in other kinds of storage', () => {
  const { bits, card } = denseBody(3);
  const small = craftPortable([
    { key: 0, kind: 'array', values: Array.from({ length: 300 }, (_, v) => 2 * v) },
    { key: 1, kind: 'array', values: Array.from({ length: 129 }, (_, v) => 3 * v) },
  ]);
  const big = craftPortable([
    { key: 0, kind: 'array', values: Array.from({ length: 300 }, (_, v) => 2 * v) },
    { key: 1, kind: 'bitset', bits, cardinality: card },
    {
      key: 2,
      kind: 'run',
      runs: Array.from({ length: 70 }, (_, r) => [9 * r, 4] as [number, number]),
    },
  ]);

  it('reads a Buffer taken from the pool, which starts at a byte offset other than 0', () => {
    let pooled = Buffer.from(small);
    for (let tries = 0; tries < 8 && pooled.byteOffset === 0; tries++) {
      Buffer.allocUnsafe(3);
      pooled = Buffer.from(small);
    }
    expect(pooled.byteOffset).not.toBe(0);
    expect(checkPortableLayout(pooled)).toBe(small.length);
    const bad = Buffer.from(small);
    bad[bad.length - 2] = 0; // the last value no longer ascends
    bad[bad.length - 1] = 0;
    expect(() => checkPortableLayout(bad)).toThrow(/not strictly ascending/);
  });

  it('reads a Buffer that is a slice at an odd offset of a larger one', () => {
    for (const lead3 of [1, 2, 3, 5]) {
      const whole = Buffer.alloc(lead3 + big.length + 16, 0xff);
      big.forEach((b, i) => (whole[lead3 + i] = b));
      expect(checkPortableLayout(whole.subarray(lead3, lead3 + big.length))).toBe(big.length);
    }
  });

  it.skipIf(typeof SharedArrayBuffer === 'undefined')(
    'reads bytes backed by a SharedArrayBuffer at every shift',
    () => {
      for (const shift of SHIFTS) {
        const shared = new SharedArrayBuffer(shift + big.length + 16);
        const view = new Uint8Array(shared, shift, big.length);
        view.set(big);
        expect(checkPortableLayout(view)).toBe(big.length);
        view[view.length - 2] = (view[view.length - 2] as number) ^ 0xff; // a run's length no longer matches what the header counts
        expect(() => checkPortableLayout(view)).toThrow(IntegrityError);
      }
    },
  );
});

/**
 * The check's answers do not depend on the byte order the machine reports. This machine is little-endian, so this forces
 * the module's own probe to say it is not and holds that the answers are those of the unforced module. It cannot tell a
 * big-endian host's behaviour from this one's: only a big-endian host can.
 */
describe('the check with the byte-order probe forced to big-endian', () => {
  it('gives the same answers, at every shift', async () => {
    const real = Uint16Array;
    const of = vi.spyOn(Uint16Array, 'of').mockImplementation(() => new real([256]) as never);
    vi.resetModules();
    let forced: typeof import('@/portable/layout');
    try {
      forced = await import('@/portable/layout');
    } finally {
      of.mockRestore();
    }
    expect(forced.LITTLE_ENDIAN).toBe(false);
    const cases = [
      craftPortable([
        { key: 0, kind: 'array', values: Array.from({ length: 300 }, (_, v) => 2 * v) },
      ]),
      craftPortable([
        {
          key: 0,
          kind: 'run',
          runs: Array.from({ length: 200 }, (_, r) => [8 * r, 3] as [number, number]),
        },
      ]),
      craftPortable([
        { key: 0, kind: 'array', values: [...Array.from({ length: 300 }, (_, v) => 2 * v), 5] },
      ]),
      craftPortable([
        {
          key: 0,
          kind: 'run',
          runs: [
            ...Array.from({ length: 100 }, (_, r) => [8 * r, 3] as [number, number]),
            [790, 3],
          ],
        },
      ]),
    ];
    const run = (check: (b: Uint8Array) => number, bytes: Uint8Array): number | string => {
      try {
        return check(bytes);
      } catch (err) {
        return (err as Error).message;
      }
    };
    for (const bytes of cases) {
      for (const shift of SHIFTS) {
        const at = placed(bytes, shift);
        expect(run(forced.checkPortableLayout, at)).toBe(run(checkPortableLayout, at));
      }
    }
  });
});
