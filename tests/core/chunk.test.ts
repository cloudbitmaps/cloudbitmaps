import { SafeBitmap, roaringCodec } from '@/roaring-codec';
import {
  emptyDelta,
  applyAdd,
  applyRemove,
  effective,
  encodeDelta,
  decodeDelta,
  WARM_DELTA_VERSION,
} from '@/core/chunk';
import { IntegrityError, UnsupportedError } from '@/core/errors';

const MAX = 1 << 20;

describe('chunk model', () => {
  it('keeps adds and removes disjoint (I1)', () => {
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 7);
    applyRemove(d, 7); // 7 moves to removes, leaves adds
    expect(d.adds.has(7)).toBe(false);
    expect(d.removes.has(7)).toBe(true);
    applyAdd(d, 7); // re-add clears the tombstone
    expect(d.adds.has(7)).toBe(true);
    expect(d.removes.has(7)).toBe(false);
  });

  it('computes effective = (cold ∪ adds) \\ removes (V5) without mutating inputs', () => {
    const cold = SafeBitmap.fromValues([1, 2, 3]);
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 9);
    applyRemove(d, 2);
    expect(effective(cold, d).toArray()).toEqual([1, 3, 9]);
    expect(cold.toArray()).toEqual([1, 2, 3]); // cold untouched
  });

  it('round-trips a delta through encode → decode', () => {
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 10);
    applyAdd(d, 65535);
    applyRemove(d, 4);
    const decoded = decodeDelta(encodeDelta(d), MAX, roaringCodec);
    expect(decoded.adds.toArray()).toEqual([10, 65535]);
    expect(decoded.removes.toArray()).toEqual([4]);
  });

  it('stamps the current schema version and round-trips it (format freeze)', () => {
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 42);
    const bytes = encodeDelta(d);
    expect(bytes[0]).toBe(WARM_DELTA_VERSION); // 1-byte version prefix
    expect(decodeDelta(bytes, MAX, roaringCodec).adds.toArray()).toEqual([42]);
  });

  it('round-trips an empty delta with the version prefix', () => {
    const bytes = encodeDelta(emptyDelta(roaringCodec));
    expect(bytes[0]).toBe(WARM_DELTA_VERSION);
    const d = decodeDelta(bytes, MAX, roaringCodec);
    expect(d.adds.toArray()).toEqual([]);
    expect(d.removes.toArray()).toEqual([]);
  });

  it('rejects an unrecognized delta schema version with UnsupportedError (fail-closed)', () => {
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 1);
    const future = encodeDelta(d);
    future[0] = WARM_DELTA_VERSION + 1; // bytes from a newer, incompatible writer
    expect(() => decodeDelta(future, MAX, roaringCodec)).toThrow(UnsupportedError);
    const zero = encodeDelta(d);
    zero[0] = 0; // an unstamped / pre-v1 layout
    expect(() => decodeDelta(zero, MAX, roaringCodec)).toThrow(UnsupportedError);
  });

  it('rejects an over-cap delta (total size, not just each half)', () => {
    const d = emptyDelta(roaringCodec);
    d.adds.addMany([1, 2, 3, 4, 5, 6, 7, 8]);
    const bytes = encodeDelta(d);
    // tiny per-bitmap cap → the total cap (2*1 + 1 version + 4 header = 7B) is well below the encoded size
    expect(() => decodeDelta(bytes, 1, roaringCodec)).toThrow(IntegrityError);
  });

  it('rejects malformed delta bytes', () => {
    expect(() => decodeDelta(new Uint8Array([1, 2]), MAX, roaringCodec)).toThrow(IntegrityError); // shorter than the header
    const bad = new Uint8Array(9);
    bad[0] = WARM_DELTA_VERSION; // valid version, so we reach the length check
    new DataView(bad.buffer).setUint32(1, 9999, true); // addsLen larger than the payload
    expect(() => decodeDelta(bad, MAX, roaringCodec)).toThrow(IntegrityError);
  });

  it('accepts a maximal in-spec delta at exactly the total cap (the accept side of the boundary)', () => {
    // The suite previously tested only the *reject* side (over-cap). Mutation testing (T2) surfaced that an
    // off-by-N in `totalCap = 2*maxBitmapBytes + VERSION_BYTES + HEADER_BYTES` — which would reject legitimate
    // near-max Warm deltas as corrupt (an availability bug on the untrusted path) — sailed through. Pin the
    // accept side: a symmetric delta whose total length is *exactly* the cap must decode, not throw.
    const d = emptyDelta(roaringCodec);
    applyAdd(d, 1);
    applyAdd(d, 2);
    applyAdd(d, 3);
    applyRemove(d, 100);
    applyRemove(d, 200);
    applyRemove(d, 300);
    const bytes = encodeDelta(d);
    const half = SafeBitmap.fromValues([1, 2, 3]).serialize().length; // adds & removes serialize equally
    expect(bytes.length).toBe(5 + 2 * half); // 5 = version(1) + addsLen header(4)
    const decoded = decodeDelta(bytes, half, roaringCodec); // maxBitmapBytes = half ⇒ bytes.length === totalCap exactly
    expect(decoded.adds.toArray()).toEqual([1, 2, 3]);
    expect(decoded.removes.toArray()).toEqual([100, 200, 300]);
  });

  it('decodes minimal + lenient in-bounds deltas (the decoder accepts a superset of what encode emits)', () => {
    // A 5-byte delta: version + addsLen=0 + no payload. Zero-byte halves deserialize to empty bitmaps, so this
    // is a valid empty delta at exactly the header length — the too-short guard must NOT reject it (kills the
    // `< → <=` boundary mutant).
    const minimal = decodeDelta(Uint8Array.of(WARM_DELTA_VERSION, 0, 0, 0, 0), MAX, roaringCodec);
    expect(minimal.adds.toArray()).toEqual([]);
    expect(minimal.removes.toArray()).toEqual([]);
    // adds-only: addsLen spans the whole payload, the removes tail omitted → { adds, ∅ } (kills the `> → >=`
    // adds-bounds mutant, which would reject an exactly-fitting addsLen).
    const adds = SafeBitmap.fromValues([7, 8]).serialize();
    const addsOnly = new Uint8Array(5 + adds.length);
    addsOnly[0] = WARM_DELTA_VERSION;
    new DataView(addsOnly.buffer).setUint32(1, adds.length, true);
    addsOnly.set(adds, 5);
    const d = decodeDelta(addsOnly, MAX, roaringCodec);
    expect(d.adds.toArray()).toEqual([7, 8]);
    expect(d.removes.toArray()).toEqual([]);
    // An addsLen that over-declares the payload is still rejected by the bounds guard — even though the clamped
    // slice would itself decode fine (kills the `if (false)` bounds-check mutant, which would return, not throw).
    const over = new Uint8Array(5 + adds.length);
    over[0] = WARM_DELTA_VERSION;
    new DataView(over.buffer).setUint32(1, adds.length + 1, true);
    over.set(adds, 5);
    expect(() => decodeDelta(over, MAX, roaringCodec)).toThrow(IntegrityError);
  });
});
