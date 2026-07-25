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
});
