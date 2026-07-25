import { SafeBitmap } from '@/roaring-codec';
import { IntegrityError } from '@/core/errors';

describe('SafeBitmap', () => {
  it('adds, tests, removes, and counts', () => {
    const b = SafeBitmap.empty();
    expect(b.isEmpty).toBe(true);
    b.add(5);
    b.addMany([1, 2, 3]);
    expect(b.has(5)).toBe(true);
    expect(b.has(99)).toBe(false);
    expect(b.size).toBe(4);
    b.remove(5);
    expect(b.has(5)).toBe(false);
    expect(b.toArray()).toEqual([1, 2, 3]);
  });

  it('round-trips through serialize → safeDeserialize', () => {
    const b = SafeBitmap.fromValues([0, 7, 65535, 100000]);
    const bytes = b.serialize();
    const back = SafeBitmap.safeDeserialize(bytes, 1 << 20);
    expect(back.toArray()).toEqual([0, 7, 65535, 100000]);
  });

  it('computes union and difference in place', () => {
    const a = SafeBitmap.fromValues([1, 2, 3]);
    a.orInPlace(SafeBitmap.fromValues([3, 4]));
    expect(a.toArray()).toEqual([1, 2, 3, 4]);
    a.andNotInPlace(SafeBitmap.fromValues([2, 4]));
    expect(a.toArray()).toEqual([1, 3]);
  });

  it('rejects deserializing input over the size cap (S1)', () => {
    const bytes = SafeBitmap.fromValues([1, 2, 3]).serialize();
    expect(() => SafeBitmap.safeDeserialize(bytes, bytes.length - 1)).toThrow(IntegrityError);
  });

  it('rejects malformed bytes as IntegrityError, never crashes', () => {
    expect(() => SafeBitmap.safeDeserialize(new Uint8Array([9, 9, 9, 9, 9, 9]), 1 << 20)).toThrow(
      IntegrityError,
    );
  });
});
