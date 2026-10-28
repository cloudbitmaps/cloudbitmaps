import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The brand check that decides whether `addMany` ids are copied first, on a runtime that has no `SharedArrayBuffer`
 * and on one whose `ArrayBuffer` has lost its `byteLength` getter. The check reads its getter when the module loads,
 * so each case loads a fresh copy of the module under the changed runtime.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The array `addMany` handed the codec for an ordinary `Uint32Array`. */
async function handed(): Promise<{ source: Uint32Array; seen: Uint32Array; result: number[] }> {
  const { RoaringBitmap } = await import('@/index');
  const { TsBitmap } = await import('@/ts-roaring/bitmap');
  const source = new Uint32Array(new ArrayBuffer(16));
  source.set([8, 6, 7, 6]);
  const spy = vi.spyOn(TsBitmap.prototype, 'addMany');
  const b = new RoaringBitmap();
  b.addMany(source);
  const seen = spy.mock.calls[0]![0] as Uint32Array;
  return { source, seen, result: b.toArray() };
}

describe('the copy of shared ids, by brand', () => {
  it('a runtime without SharedArrayBuffer reads an ordinary array in place', async () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);
    vi.resetModules();
    const { source, seen, result } = await handed();
    expect(seen).toBe(source);
    expect(result).toEqual([6, 7, 8]);
  });

  it('a missing byteLength getter is read as not ordinary: everything is copied', async () => {
    const real = Object.getOwnPropertyDescriptor;
    vi.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementation(((
      target: object,
      key: PropertyKey,
    ) =>
      target === ArrayBuffer.prototype && key === 'byteLength'
        ? undefined
        : real(target, key)) as typeof Object.getOwnPropertyDescriptor);
    vi.resetModules();
    const { source, seen, result } = await handed();
    expect(seen).not.toBe(source);
    expect(result).toEqual([6, 7, 8]);
  });
});
