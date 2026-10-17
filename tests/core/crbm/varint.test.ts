import { readVarint, varintLength, writeVarintAt } from '@/core/crbm/varint';
import { writeVarint } from '../../helpers/varint';
import { IntegrityError } from '@/core/errors';

function roundTrip(value: number): number {
  const out: number[] = [];
  writeVarint(out, value);
  const { value: decoded, next } = readVarint(Uint8Array.from(out), 0);
  expect(next).toBe(out.length);
  return decoded;
}

describe('varint (LEB128 unsigned)', () => {
  it('round-trips boundary values across the u32 range', () => {
    for (const v of [0, 1, 127, 128, 255, 16_383, 16_384, 65_535, 65_536, 0x7fffffff, 0xffffffff]) {
      expect(roundTrip(v)).toBe(v);
    }
  });

  it('uses the minimal number of bytes', () => {
    const lengths = (v: number): number => {
      const out: number[] = [];
      writeVarint(out, v);
      return out.length;
    };
    expect(lengths(0)).toBe(1);
    expect(lengths(127)).toBe(1);
    expect(lengths(128)).toBe(2);
    expect(lengths(0xffffffff)).toBe(5);
  });

  it('decodes from a mid-buffer offset and reports the next position', () => {
    const out: number[] = [];
    writeVarint(out, 300);
    writeVarint(out, 7);
    const buf = Uint8Array.from(out);
    const first = readVarint(buf, 0);
    expect(first.value).toBe(300);
    const second = readVarint(buf, first.next);
    expect(second.value).toBe(7);
    expect(second.next).toBe(buf.length);
  });

  it('rejects encoding a non-u32 value', () => {
    expect(() => writeVarint([], -1)).toThrow(RangeError);
    expect(() => writeVarint([], 0x1_0000_0000)).toThrow(RangeError);
    expect(() => writeVarint([], 1.5)).toThrow(RangeError);
  });

  it('rejects a truncated varint (untrusted bytes)', () => {
    // 0x80 has the continuation bit set but no following byte.
    expect(() => readVarint(Uint8Array.of(0x80), 0)).toThrow(IntegrityError);
  });

  it('rejects an over-long varint that exceeds u32', () => {
    // Six continuation bytes — well past the 5-byte u32 ceiling.
    expect(() => readVarint(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x01), 0)).toThrow(
      IntegrityError,
    );
  });

  it('decodes every width boundary of the u32 range exactly, never as a negative or fractional number', () => {
    const edges = [
      0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 0x0fff_ffff, 0x1000_0000, 0x7fff_ffff,
      0x8000_0000, 0xf000_0000, 0xffff_fffe, 0xffff_ffff,
    ];
    for (const v of edges) {
      const out: number[] = [];
      writeVarint(out, v);
      const read = readVarint(Uint8Array.from(out), 0);
      expect(read.value).toBe(v);
      expect(read.next).toBe(out.length);
    }
  });

  it('rejects a fifth byte that carries more than the last four bits', () => {
    expect(() => readVarint(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x10), 0)).toThrow(
      IntegrityError,
    );
    expect(readVarint(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x0f), 0).value).toBe(0xffff_ffff);
  });
});

describe('varintLength and writeVarintAt', () => {
  const refused = [-1, 1.5, Number.NaN, 2 ** 32, Number.POSITIVE_INFINITY, -0.5];

  it('refuse a value that is not a u32 with the RangeError writeVarint threw', () => {
    for (const v of refused) {
      expect(() => varintLength(v), `varintLength(${v})`).toThrow(RangeError);
      const out = new Uint8Array(8).fill(0xaa);
      expect(() => writeVarintAt(out, 0, v), `writeVarintAt(${v})`).toThrow(RangeError);
      expect(Array.from(out), `nothing written for ${v}`).toEqual(new Array(8).fill(0xaa));
      expect(() => writeVarint([], v)).toThrow(RangeError);
    }
  });

  it('size and write what writeVarint appends, at a nonzero position, into an exact-fit buffer', () => {
    for (const v of [
      0,
      1,
      127,
      128,
      16_383,
      16_384,
      2 ** 21 - 1,
      2 ** 21,
      2 ** 28 - 1,
      2 ** 28,
      2 ** 32 - 1,
    ]) {
      const expected: number[] = [];
      writeVarint(expected, v);
      expect(varintLength(v)).toBe(expected.length);
      const out = new Uint8Array(3 + expected.length);
      expect(writeVarintAt(out, 3, v)).toBe(out.length);
      expect(Array.from(out.subarray(0, 3))).toEqual([0, 0, 0]);
      expect(Array.from(out.subarray(3))).toEqual(expected);
      expect(readVarint(out, 3)).toEqual({ value: v, next: out.length });
    }
  });
});
