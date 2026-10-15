import { splitId, joinId, U32_MAX } from '@/core/bit-route';
import { ValidationError } from '@/core/errors';

describe('BitRouteSplitter', () => {
  it('round-trips id ↔ {chunkKey, remainder} across edges', () => {
    for (const id of [0, 1, 0xffff, 0x1_0000, 0x1_2345, 0xabcd_ef01, U32_MAX]) {
      const { chunkKey, remainder } = splitId(id);
      expect(chunkKey).toBeGreaterThanOrEqual(0);
      expect(chunkKey).toBeLessThanOrEqual(0xffff);
      expect(remainder).toBeGreaterThanOrEqual(0);
      expect(remainder).toBeLessThanOrEqual(0xffff);
      expect(joinId(chunkKey, remainder)).toBe(id);
    }
  });

  it('splits the top/bottom 16 bits correctly', () => {
    expect(splitId(0x1_0000)).toEqual({ chunkKey: 1, remainder: 0 });
    expect(splitId(0xffff)).toEqual({ chunkKey: 0, remainder: 0xffff });
  });

  it('masks chunkKey/remainder to their low 16 bits (defensive joinId)', () => {
    // joinId is documented to take 16-bit halves; if a caller passes wider values it must not
    // bleed bits across the boundary — each half is masked to its low 16 bits.
    expect(joinId(0x1_0000, 5)).toBe(5); // chunkKey overflow bit dropped → chunk 0
    expect(joinId(0, 0x1_0000)).toBe(0); // remainder overflow bit dropped → 0
    expect(joinId(0xffff, 0xffff)).toBe(U32_MAX);
  });

  it('rejects non-u32 ids', () => {
    for (const bad of [-1, 1.5, U32_MAX + 1, NaN, Infinity]) {
      expect(() => splitId(bad)).toThrow(ValidationError);
    }
  });

  it('classifies a refused id without repeating it', () => {
    const cases: Array<[unknown, string]> = [
      ['14155551234', 'a string'],
      [14155551234n, 'a bigint'],
      [undefined, 'undefined'],
      [null, 'null'],
      [{}, 'an object'],
      [[1], 'an object'],
      [true, 'a boolean'],
      [() => 1, 'a function'],
      [Symbol('x'), 'a symbol'],
      [-14155551234, 'a negative number'],
      [-0.5, 'a negative number'],
      [1.5, 'a number with a fraction'],
      [Number.NaN, 'NaN or an infinity'],
      [Infinity, 'NaN or an infinity'],
      [-Infinity, 'NaN or an infinity'],
      [U32_MAX + 1, 'a number above 4294967295 (ids are 32-bit)'],
      [5_000_000_000, 'a number above 4294967295 (ids are 32-bit)'],
    ];
    for (const [bad, got] of cases) {
      let message = '';
      try {
        splitId(bad as number);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(`an id must be an integer from 0 to 4294967295; got ${got}`);
    }
  });
});
