import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedError } from '@/core/errors';
import { systemEntropy } from '@/system-entropy';

describe('systemEntropy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the length asked, fresh and non-zero each call', () => {
    for (const length of [1, 12, 16, 300]) expect(systemEntropy(length).length).toBe(length);
    const a = systemEntropy(12);
    const b = systemEntropy(12);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).not.toEqual(new Uint8Array(12));
    expect(a).not.toEqual(b);
    expect(a.buffer).not.toBe(b.buffer);
  });

  it('refuses with UnsupportedError on a runtime with no Web Crypto, and never falls back to Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', undefined);
    expect(() => systemEntropy(12)).toThrow(UnsupportedError);
    vi.stubGlobal('crypto', {});
    expect(() => systemEntropy(12)).toThrow(UnsupportedError);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
