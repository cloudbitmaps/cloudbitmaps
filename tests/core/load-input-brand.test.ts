import { afterEach, describe, expect, it, vi } from 'vitest';
import { storeCodec } from '../helpers/store-codec';
import { craftPortable } from '../helpers/portable-bytes';

/**
 * The brand check that decides whether `{ serialized }` bytes are copied first, on a runtime that has no
 * `SharedArrayBuffer` and on one whose `ArrayBuffer` has lost its `byteLength` getter. The check reads its getter when
 * the module loads, so each case loads a fresh copy of the module under the changed runtime.
 */
const portable = craftPortable([{ key: 0, kind: 'array', values: [1, 2, 3] }]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The bytes the codec was handed, and whether they are the caller's own view. */
async function decoded(view: Uint8Array, load: () => Promise<typeof import('@/core/load-input')>) {
  const { decodeSerialized } = await load();
  const seen: Uint8Array[] = [];
  decodeSerialized(view, {
    ...storeCodec,
    safeDeserialize: (bytes) => {
      seen.push(bytes);
      return storeCodec.empty();
    },
  });
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe('the copy of shared bytes, by brand', () => {
  it('a runtime without SharedArrayBuffer reads an ordinary buffer in place', async () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);
    vi.resetModules();
    const view = new Uint8Array(new ArrayBuffer(portable.length));
    view.set(portable);
    const seen = await decoded(view, () => import('@/core/load-input'));
    expect(seen.buffer).toBe(view.buffer);
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
    const view = new Uint8Array(new ArrayBuffer(portable.length));
    view.set(portable);
    const seen = await decoded(view, () => import('@/core/load-input'));
    vi.restoreAllMocks();
    expect(seen.buffer).not.toBe(view.buffer);
    view.fill(0xff);
    expect([...seen]).toEqual([...portable]);
  });
});
