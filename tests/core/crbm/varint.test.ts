import { writeVarint, readVarint } from '@/core/crbm/varint';
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
});
